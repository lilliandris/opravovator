import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  BIAS_LABELS, MAX_IMAGE_BYTES, MAX_IMAGE_MB, computePoints, exportFolderNames, exportPoints, formatPoints, normBias, normPages, normRubricMode, normScores,
  type RubricItem, type RubricMode, type Signer, type SolutionDetail, type SolutionSave, type TaskDetail,
  type PresenceResult, type TaskSummary, type User, type VersionItem,
} from '@opravovator/shared';
import { isAdminUser, requireUser } from './auth.js';
import { logActivity } from './activity.js';
import { sql } from './db.js';
import { HttpError } from './http.js';
import * as presence from './presence.js';
import {
  TMP_DIR, addSolutionsZip, assetPath, basePdfPath, deleteTask, ensureRendered, exportOriginalZip, exportZip, importZip, refreshTaskPoints,
  restoreVersion, saveSolution, thumbnail, type SolutionRow, type TaskRow,
} from './storage.js';

type Params = { Params: { id: string } };

const num = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Nenájdené.');
  return n;
};

/** Úloha, ku ktorej má používateľ prístup (vlastník, zdieľaná e-mailom alebo admin). */
async function taskFor(user: User, id: number, ownerOnly = false): Promise<TaskRow & { is_owner: boolean }> {
  const admin = isAdminUser(user);
  const [t] = await sql<(TaskRow & { is_owner: boolean })[]>`
    SELECT t.*, (t.owner_id = ${user.id}) AS is_owner FROM tasks t
    WHERE t.id = ${id} AND (${admin} OR t.owner_id = ${user.id}
      OR EXISTS (SELECT 1 FROM task_shares s WHERE s.task_id = t.id AND s.email = ${user.email}))`;
  if (!t) throw new HttpError(404, 'Úloha neexistuje alebo k nej nemáš prístup.');
  if (ownerOnly && !t.is_owner && !admin) throw new HttpError(403, 'Toto môže urobiť len vlastník úlohy.');
  return t;
}

async function solutionFor(user: User, id: number): Promise<SolutionRow> {
  const [s] = await sql<SolutionRow[]>`SELECT * FROM solutions WHERE id = ${id}`;
  if (!s) throw new HttpError(404, 'Riešenie neexistuje.');
  await taskFor(user, s.task_id);
  return s;
}

function sendFile(reply: FastifyReply, file: string, type: string, cache = 'no-store') {
  reply.header('Content-Type', type).header('Cache-Control', cache);
  return reply.send(fs.createReadStream(file));
}

function attachment(name: string) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function apiRoutes(app: FastifyInstance) {
  /* ---------- úlohy ---------- */

  app.get('/api/tasks', async req => {
    const u = requireUser(req);
    return sql<TaskSummary[]>`
      SELECT t.id, t.name, t.created_at,
        GREATEST(t.created_at, t.updated_at, (SELECT max(s.updated_at) FROM solutions s WHERE s.task_id = t.id)) AS updated_at,
        o.name AS owner, o.email AS owner_email, (t.owner_id = ${u.id}) AS is_owner,
        (SELECT count(*)::int FROM solutions s WHERE s.task_id = t.id) AS total,
        (SELECT coalesce(sum(s.rev), 0)::int FROM solutions s WHERE s.task_id = t.id) AS revs,
        (SELECT count(*)::int FROM solutions s WHERE s.task_id = t.id AND s.points IS NOT NULL) AS graded,
        (SELECT count(*)::int FROM solutions s WHERE s.task_id = t.id AND s.annotations != '[]') AS annotated
      FROM tasks t JOIN users o ON o.id = t.owner_id
      WHERE t.owner_id = ${u.id} OR EXISTS (SELECT 1 FROM task_shares s WHERE s.task_id = t.id AND s.email = ${u.email})
      ORDER BY t.id DESC`;
  });

  // zip sa ukladá na disk prúdom, žiadny limit veľkosti
  app.post('/api/tasks', async req => {
    const u = requireUser(req);
    let tmp: string | null = null, filename = '', name = '';
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (tmp) { part.file.resume(); continue; }
          filename = part.filename;
          tmp = path.join(TMP_DIR, 'upload-' + crypto.randomBytes(8).toString('hex') + '.zip');
          await pipeline(part.file, fs.createWriteStream(tmp));
        } else if (part.fieldname === 'name') {
          name = String(part.value || '');
        }
      }
      if (!tmp) throw new HttpError(400, 'Chýba zip.');
      const id = await importZip(tmp, filename, u.id, name);
      const [t] = await sql<{ name: string }[]>`SELECT name FROM tasks WHERE id = ${id}`;
      logActivity(u.id, 'task_upload', { id, name: t?.name || filename }, filename);
      return { id };
    } finally {
      if (tmp) fsp.rm(tmp, { force: true }).catch(() => {});
    }
  });

  // dodatočné riešenia: zip (celé nové hromadné opravovanie alebo len nové priečinky), páruje sa podľa ID riešiteľa
  app.post<Params>('/api/tasks/:id/solutions', async req => {
    const u = requireUser(req);
    const t = await taskFor(u, num(req.params.id));
    let tmp: string | null = null, filename = '';
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        if (tmp) { part.file.resume(); continue; }
        filename = part.filename;
        tmp = path.join(TMP_DIR, 'add-' + crypto.randomBytes(8).toString('hex') + '.zip');
        await pipeline(part.file, fs.createWriteStream(tmp));
      }
      if (!tmp) throw new HttpError(400, 'Chýba zip.');
      const r = await addSolutionsZip(t.id, tmp);
      logActivity(u.id, 'task_add_solutions', t, `${filename}: +${r.added.length}${r.added.length ? ' (' + r.added.join(', ') + ')' : ''}, ponechaných ${r.kept}`);
      return r;
    } finally {
      if (tmp) fsp.rm(tmp, { force: true }).catch(() => {});
    }
  });

  app.get<Params>('/api/tasks/:id', async req => {
    const u = requireUser(req);
    const t = await taskFor(u, num(req.params.id));
    const solutions = await sql`
      SELECT id, idx, folder, pdf_name, display_name, rocnik, student_id, points, rev, updated_at, bias,
        (annotations != '[]' OR pages IS NOT NULL) AS annotated,
        jsonb_path_exists(annotations, '$[*] ? (@.type != "stamp")') AS commented,
        jsonb_path_exists(annotations, '$[*] ? (@.type == "stamp")') AS stamped
      FROM solutions WHERE task_id = ${t.id} ORDER BY idx`;
    const shares = t.is_owner
      ? (await sql<{ email: string }[]>`SELECT email FROM task_shares WHERE task_id = ${t.id} ORDER BY email`).map(r => r.email)
      : [];
    const out: TaskDetail = {
      id: t.id, name: t.name, root_folder: t.root_folder, comment_text: t.comment_text,
      comment_filename: t.comment_filename, max_points: t.max_points, rubric: t.rubric,
      is_owner: t.is_owner, shares, solutions: solutions as unknown as TaskDetail['solutions'],
      rubric_mode: normRubricMode(t.rubric_mode), signers: Array.isArray(t.signers) ? t.signers : [],
    };
    return out;
  });

  // zdieľaná úloha: podpisy všetkých, čo k nej majú prístup (vlastník + nazdieľaní s účtom), podľa ich nastavení
  app.get<Params>('/api/tasks/:id/signers', async req => {
    const u = requireUser(req);
    const t = await taskFor(u, num(req.params.id));
    const rows = await sql<(User & { owner: boolean })[]>`
      SELECT u.id, u.email, u.name, u.stamp_name, u.stamp_font, u.stamp_image, u.stamp_image_scale, u.stamp_color,
        u.stamp_points_font, u.stamp_points_color, (u.id = ${t.owner_id}) AS owner
      FROM users u WHERE u.id = ${t.owner_id} OR u.email IN (SELECT email FROM task_shares WHERE task_id = ${t.id})
      ORDER BY (u.id = ${t.owner_id}) DESC, u.name`;
    return rows.map((r): Signer => ({
      id: r.id, name: r.name, email: r.email,
      sig: r.stamp_image
        ? { assetId: r.stamp_image, imgScale: r.stamp_image_scale || undefined }
        // bez vlastného písma / farby podpisu: ako jeho body
        : { name: r.stamp_name || r.name, nameFont: r.stamp_font || r.stamp_points_font || undefined, color: r.stamp_color || r.stamp_points_color || undefined },
    }));
  });

  app.put<Params & { Body: { name?: string; comment_text?: string; max_points?: number | string | null; rubric?: RubricItem[]; rubric_mode?: RubricMode; signers?: number[] } }>(
    '/api/tasks/:id', async req => {
      const u = requireUser(req);
      const t = await taskFor(u, num(req.params.id));
      const b = req.body || {};
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : t.name;
      const comment = typeof b.comment_text === 'string' ? b.comment_text : t.comment_text;
      const max = 'max_points' in b ? (b.max_points === null || b.max_points === '' ? null : Number(b.max_points)) : t.max_points;
      const rubric = Array.isArray(b.rubric)
        ? b.rubric.map(i => ({
          id: String(i.id || crypto.randomBytes(5).toString('hex')).slice(0, 40),
          label: String(i.label || ''),
          points: Number(i.points) || 0,
        }))
        : t.rubric;
      const mode = 'rubric_mode' in b ? normRubricMode(b.rubric_mode) : normRubricMode(t.rubric_mode);
      const signers = Array.isArray(b.signers) ? [...new Set(b.signers.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 20) : t.signers;
      await sql`UPDATE tasks SET name = ${name}, comment_text = ${comment}, max_points = ${max},
        rubric = ${sql.json(rubric as never)}, rubric_mode = ${mode}, signers = ${sql.json(signers)},
        updated_at = CASE WHEN name IS DISTINCT FROM ${name} OR comment_text IS DISTINCT FROM ${comment}
          OR max_points IS DISTINCT FROM ${max} OR rubric IS DISTINCT FROM ${sql.json(rubric as never)}
          OR rubric_mode IS DISTINCT FROM ${mode} THEN now() ELSE updated_at END
        WHERE id = ${t.id}`;
      await refreshTaskPoints(t.id);
      return { ok: true };
    });

  app.delete<Params>('/api/tasks/:id', async req => {
    const u = requireUser(req);
    const t = await taskFor(u, num(req.params.id), true);
    await deleteTask(t.id);
    logActivity(u.id, t.is_owner ? 'task_delete' : 'admin_task_delete', t);
    return { ok: true };
  });

  app.get<Params>('/api/tasks/:id/download', async (req, reply) => {
    const u = requireUser(req);
    const t = await taskFor(u, num(req.params.id));
    logActivity(u.id, 'task_download_zip', t);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': attachment((t.root_folder || t.name) + '.zip'),
      'Cache-Control': 'no-store',
    });
    try {
      await exportZip(t.id, res);
    } catch (e) {
      console.error(e);
      res.destroy(e as Error);
    }
  });

  // pôvodný zip bez vygenerovaných súborov – na stiahnutie úlohy do lokálneho režimu
  app.get<Params>('/api/tasks/:id/original.zip', async (req, reply) => {
    const u = requireUser(req);
    const t = await taskFor(u, num(req.params.id));
    logActivity(u.id, 'task_download_device', t);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store' });
    try { await exportOriginalZip(t.id, reply.raw); } catch (e) { console.error(e); reply.raw.destroy(e as Error); }
  });

  app.get<Params>('/api/tasks/:id/points.csv', async (req, reply) => {
    const u = requireUser(req);
    const t = await taskFor(u, num(req.params.id));
    logActivity(u.id, 'task_download_csv', t);
    const rows = await sql<SolutionRow[]>`SELECT * FROM solutions WHERE task_id = ${t.id} ORDER BY idx`;
    const folders = exportFolderNames(rows);
    const esc = (v: unknown) => {
      const s = String(v ?? '');
      return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [['#', 'Meno', 'Ročník', 'ID', 'Priečinok', 'Body', 'Opravené v PDF', ...BIAS_LABELS.map(b => b.label)].join(';')];
    for (const s of rows) {
      lines.push([s.idx, s.display_name, s.rocnik, s.student_id, folders.get(s.folder) || s.folder,
        s.points === null ? '' : String(exportPoints(s.points)), s.annotations.length || s.pages ? 'áno' : '',
      ...normBias(s.bias).map(v => formatPoints(v).replace('.', ','))].map(esc).join(';'));
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', attachment(t.name + ' – body.csv'));
    return '﻿' + lines.join('\r\n') + '\r\n'; // BOM, aby Excel spoznal UTF-8
  });

  /* ---------- kto má čo otvorené ---------- */

  // editor sa ozýva každých pár sekúnd; vráti ostatných v úlohe a aktuálny rev otvoreného riešenia
  app.post<Params & { Body: { solId?: number | null; leave?: boolean } }>('/api/tasks/:id/presence', async req => {
    const u = requireUser(req);
    const t = await taskFor(u, num(req.params.id));
    if (req.body?.leave) { presence.leave(t, u.id); return { others: [], rev: null }; }
    const solId = Number(req.body?.solId) || null;
    let rev: number | null = null;
    if (solId) {
      const [s] = await sql<{ rev: number }[]>`SELECT rev FROM solutions WHERE id = ${solId} AND task_id = ${t.id}`;
      rev = s ? s.rev : null;
    }
    presence.touch(t, u.id, u.name, rev === null ? null : solId);
    const out: PresenceResult = { others: presence.others(t.id, u.id), rev };
    return out;
  });

  /* ---------- zdieľanie ---------- */

  app.post<Params & { Body: { email?: string } }>('/api/tasks/:id/shares', async req => {
    const u = requireUser(req);
    const t = await taskFor(u, num(req.params.id), true);
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Zadaj platný e-mail.');
    if (email === u.email) throw new HttpError(400, 'Úlohu vlastníš, nemusíš ju zdieľať sám so sebou.');
    const added = await sql`INSERT INTO task_shares (task_id, email) VALUES (${t.id}, ${email}) ON CONFLICT DO NOTHING`;
    if (added.count) logActivity(u.id, 'task_share', t, email);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; email: string } }>('/api/tasks/:id/shares/:email', async req => {
    const u = requireUser(req);
    const t = await taskFor(u, num(req.params.id));
    const email = req.params.email.toLowerCase();
    // vlastník môže odobrať hocikoho, ostatní len seba (odísť zo zdieľanej úlohy)
    if (!t.is_owner && !isAdminUser(u) && email !== u.email) throw new HttpError(403, 'Toto môže urobiť len vlastník úlohy.');
    const removed = await sql`DELETE FROM task_shares WHERE task_id = ${t.id} AND email = ${email}`;
    if (removed.count) logActivity(u.id, 'task_unshare', t, email);
    return { ok: true };
  });

  /* ---------- riešenia ---------- */

  app.get<Params>('/api/solutions/:id', async req => {
    const s = await solutionFor(requireUser(req), num(req.params.id));
    const [u] = s.updated_by ? await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${s.updated_by}` : [];
    const out: SolutionDetail = {
      id: s.id, task_id: s.task_id, idx: s.idx, folder: s.folder, pdf_name: s.pdf_name,
      display_name: s.display_name, rocnik: s.rocnik, student_id: s.student_id,
      annotations: s.annotations, checks: s.checks, manual_points: s.manual_points, points: s.points,
      rev: s.rev, updated_at: s.updated_at ? s.updated_at.toISOString() : null, updated_by: u ? u.name : null,
      bias: normBias(s.bias), bias_comment: s.bias_comment, pages: normPages(s.pages), scores: normScores(s.scores),
    };
    return out;
  });

  // pôvodné PDF, na ktoré editor kreslí; nemení sa, dá sa dlho cachovať (aj offline)
  app.get<Params>('/api/solutions/:id/pdf', async (req, reply) => {
    const s = await solutionFor(requireUser(req), num(req.params.id));
    const file = basePdfPath(s);
    if (!file || !fs.existsSync(file)) throw new HttpError(404, 'PDF chýba.');
    return sendFile(reply, file, 'application/pdf', 'private, max-age=31536000, immutable');
  });

  // výsledné PDF (meno.komentar.pdf); názov súboru môže byť na konci adresy, aby ho prehliadač použil pri stiahnutí
  app.get<Params>('/api/solutions/:id/result/:name', (req, reply) => resultPdf(req, reply));
  app.get<Params>('/api/solutions/:id/result', (req, reply) => resultPdf(req, reply));
  async function resultPdf(req: FastifyRequest<Params>, reply: FastifyReply) {
    const s = await solutionFor(requireUser(req), num(req.params.id));
    const file = (await ensureRendered(s.id)) || basePdfPath(s);
    if (!file || !fs.existsSync(file)) throw new HttpError(404, 'PDF chýba.');
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(s.pdf_name ? s.pdf_name.replace(/\.pdf$/i, '.komentar.pdf') : 'riesenie.pdf')}`);
    return sendFile(reply, file, 'application/pdf');
  }

  app.get<Params>('/api/solutions/:id/thumb', async (req, reply) => {
    const s = await solutionFor(requireUser(req), num(req.params.id));
    const file = await thumbnail(s.id);
    if (!file) throw new HttpError(404, 'Miniatúra nie je k dispozícii.');
    return sendFile(reply, file, 'image/png', 'private, max-age=31536000, immutable');
  });

  app.put<Params & { Body: SolutionSave }>('/api/solutions/:id', async req => {
    const u = requireUser(req);
    const s = await solutionFor(u, num(req.params.id));
    return saveSolution(s.id, req.body || {}, u);
  });

  app.get<Params>('/api/solutions/:id/versions', async req => {
    const s = await solutionFor(requireUser(req), num(req.params.id));
    return sql<VersionItem[]>`
      SELECT v.id, v.rev, v.updated_at AS created_at, u.name AS user, v.points, jsonb_array_length(v.annotations) AS count, v.changes
      FROM solution_versions v LEFT JOIN users u ON u.id = v.user_id
      WHERE v.solution_id = ${s.id} ORDER BY v.id DESC LIMIT 200`;
  });

  app.get<{ Params: { id: string; vid: string } }>('/api/solutions/:id/versions/:vid', async req => {
    const s = await solutionFor(requireUser(req), num(req.params.id));
    const [v] = await sql`SELECT annotations, checks, manual_points, rocnik, bias, bias_comment, pages, scores FROM solution_versions
      WHERE id = ${num(req.params.vid)} AND solution_id = ${s.id}`;
    if (!v) throw new HttpError(404, 'Verzia neexistuje.');
    const [t] = await sql<TaskRow[]>`SELECT rubric, max_points, rubric_mode FROM tasks WHERE id = ${s.task_id}`;
    return { ...v, points: computePoints(t.rubric, v.checks, v.manual_points, t.max_points, v.scores, t.rubric_mode) };
  });

  app.post<{ Params: { id: string; vid: string } }>('/api/solutions/:id/versions/:vid/restore', async req => {
    const u = requireUser(req);
    const s = await solutionFor(u, num(req.params.id));
    return restoreVersion(s.id, num(req.params.vid), u);
  });

  /* ---------- obrázky / podpisy ---------- */

  app.get('/api/assets', async req => {
    const u = requireUser(req);
    return sql`SELECT id, name FROM assets WHERE user_id = ${u.id} AND NOT deleted ORDER BY id DESC`;
  });

  app.post('/api/assets', async req => {
    const u = requireUser(req);
    const file = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES } });
    if (!file) throw new HttpError(400, 'Chýba obrázok.');
    const mime = file.mimetype === 'image/jpeg' ? 'image/jpeg' : file.mimetype === 'image/png' ? 'image/png' : null;
    if (!mime) { file.file.resume(); throw new HttpError(400, 'Podporované sú PNG a JPEG.'); }
    const [a] = await sql<{ id: number }[]>`
      INSERT INTO assets (user_id, name, mime) VALUES (${u.id}, ${(file.filename || 'obrázok').slice(0, 200)}, ${mime}) RETURNING id`;
    await pipeline(file.file, fs.createWriteStream(assetPath(a.id)));
    if (file.file.truncated) {
      await sql`DELETE FROM assets WHERE id = ${a.id}`;
      await fsp.rm(assetPath(a.id), { force: true });
      throw new HttpError(413, `Obrázok je príliš veľký, maximum je ${MAX_IMAGE_MB} MB.`);
    }
    await fsp.writeFile(assetPath(a.id) + '.mime', mime);
    logActivity(u.id, 'asset_upload', null, `${file.filename || 'obrázok'} (#${a.id})`);
    return { id: a.id };
  });

  // obrázok vidí jeho vlastník a každý, kto má prístup k úlohe, v ktorej je použitý (aj ako jeden z podpisov),
  // a podpis (obrázok z profilu) aj ostatní, s ktorými má jeho vlastník spoločnú úlohu
  app.get<Params>('/api/assets/:id', async (req, reply) => {
    const u = requireUser(req);
    const id = num(req.params.id);
    const [a] = await sql<{ id: number; mime: string }[]>`
      SELECT a.id, a.mime FROM assets a WHERE a.id = ${id} AND (${isAdminUser(u)} OR a.user_id = ${u.id} OR EXISTS (
        SELECT 1 FROM solutions s JOIN tasks t ON t.id = s.task_id
        WHERE (s.annotations @> ${sql.json([{ assetId: id }])} OR s.annotations @> ${sql.json([{ sigs: [{ assetId: id }] }])})
          AND (t.owner_id = ${u.id} OR EXISTS (SELECT 1 FROM task_shares sh WHERE sh.task_id = t.id AND sh.email = ${u.email})))
      OR EXISTS (
        SELECT 1 FROM users su JOIN tasks t ON (t.owner_id = su.id OR EXISTS (SELECT 1 FROM task_shares x WHERE x.task_id = t.id AND x.email = su.email))
        WHERE su.stamp_image = ${id} AND su.id = a.user_id
          AND (t.owner_id = ${u.id} OR EXISTS (SELECT 1 FROM task_shares sh WHERE sh.task_id = t.id AND sh.email = ${u.email}))))`;
    if (!a || !fs.existsSync(assetPath(a.id))) throw new HttpError(404, 'Obrázok neexistuje.');
    return sendFile(reply, assetPath(a.id), a.mime, 'private, max-age=31536000, immutable');
  });

  // z knižnice zmizne, ale súbor ostane, lebo ho môžu používať existujúce opravy
  app.delete<Params>('/api/assets/:id', async req => {
    const u = requireUser(req);
    await sql`UPDATE assets SET deleted = true WHERE id = ${num(req.params.id)} AND user_id = ${u.id}`;
    return { ok: true };
  });
}
