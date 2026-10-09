import { BlobReader, BlobWriter, TextWriter, ZipReader, ZipWriter, configure, type FileEntry } from '@zip.js/zip.js';
import {
  BIAS_COMMENT_FILENAME, BIAS_LABELS, BIAS_FILENAME, COMMENT_FILENAME, COMMENT_RE, DEFAULT_MAX_POINTS, MAX_IMAGE_BYTES, MAX_IMAGE_MB, POINTS_FILENAME, commentedName, computePoints, formatPoints, formatPointsFile,
  countChanges, exportFolderNames, exportPoints, orderByStudentId, type AddSolutionsResult, formatBiasFile, normBias, normPages, normRubricMode, normScores, parseBiasText, parsePointsText, planZip, safeSeg, same, solState, solutionFlags, solutionMeta,
  type SaveResult, type SolState, type SolutionDetail, type SolutionListItem, type SolutionSave, type TaskDetail,
  type TaskSummary, type User, type VersionItem,
} from '@opravovator/shared';
import { assets, files, nextId, persistStorage, sols, tasks, versions, type LocalSol, type LocalTask, type TaskSettings } from './store';

configure({ useWebWorkers: false });

const now = () => new Date().toISOString();
const VERSION_MERGE_MINUTES = 10;

export class LocalError extends Error {}

async function mustTask(id: number) {
  const t = await tasks.get(id);
  if (!t) throw new LocalError('Lokálna úloha neexistuje.');
  return t;
}
async function mustSol(id: number) {
  const s = await sols.get(id);
  if (!s) throw new LocalError('Riešenie neexistuje.');
  return s;
}

const flags = (s: LocalSol) => solutionFlags(s.annotations, normPages(s.pages));
/** riešenie má niečo, čo mení výsledné PDF (opravy alebo upravené strany) */
const edited = (s: LocalSol) => s.annotations.length > 0 || !!normPages(s.pages);

/* ================= zoznam a detail ================= */

export type LocalTaskSummary = TaskSummary & { remote: { taskId: number; syncedAt: string; baseRevs: number } | null };

export async function listLocalTasks(me: User): Promise<LocalTaskSummary[]> {
  const all = (await tasks.all()).sort((a, b) => a.id - b.id);
  const out: LocalTaskSummary[] = [];
  for (const t of all) {
    const ss = await sols.many(t.solIds);
    const updated_at = [t.created_at, t.updated_at, ...ss.map(s => s.updated_at)]
      .reduce<string>((m, d) => (d && d > m ? d : m), t.created_at);
    out.push({
      id: t.id, name: t.name, created_at: t.created_at, updated_at, owner: me.name, owner_email: me.email, is_owner: true,
      total: ss.length, graded: ss.filter(s => s.points !== null).length, annotated: ss.filter(edited).length,
      revs: ss.reduce((n, s) => n + s.rev, 0),
      remote: t.remote ? {
        taskId: t.remote.taskId, syncedAt: t.remote.syncedAt,
        baseRevs: Object.values(t.remote.sols).reduce((n, m) => n + m.baseRev, 0),
      } : null,
    });
  }
  return out;
}

export async function taskDetail(id: number): Promise<TaskDetail & { remote: LocalTask['remote'] }> {
  const t = await mustTask(id);
  const ss = await sols.many(t.solIds);
  const solutions: SolutionListItem[] = ss.sort((a, b) => a.idx - b.idx).map(s => ({
    id: s.id, idx: s.idx, folder: s.folder, pdf_name: s.pdf_name, display_name: s.display_name, rocnik: s.rocnik,
    student_id: s.student_id, points: s.points, rev: s.rev, updated_at: s.updated_at, bias: normBias(s.bias), ...flags(s),
  }));
  return {
    id: t.id, name: t.name, root_folder: t.root_folder, comment_text: t.comment_text, comment_filename: t.comment_filename,
    max_points: t.max_points, rubric: t.rubric, is_owner: true, shares: [], solutions, remote: t.remote,
    rubric_mode: normRubricMode(t.rubric_mode), signers: [],
  };
}

export async function solutionDetail(id: number): Promise<SolutionDetail> {
  const s = await mustSol(id);
  return {
    id: s.id, task_id: s.task_id, idx: s.idx, folder: s.folder, pdf_name: s.pdf_name, display_name: s.display_name,
    rocnik: s.rocnik, student_id: s.student_id, annotations: s.annotations, checks: s.checks,
    manual_points: s.manual_points, points: s.points, rev: s.rev, updated_at: s.updated_at, updated_by: s.updated_by,
    bias: normBias(s.bias), bias_comment: s.bias_comment ?? '', pages: normPages(s.pages), scores: normScores(s.scores),
  };
}

/* ================= import zipu ================= */

/** Rozbalí zip do prehliadača a vytvorí lokálnu úlohu. */
export async function importLocalZip(zip: Blob, zipName: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  persistStorage();
  const reader = new ZipReader(new BlobReader(zip));
  try {
    let entries;
    try { entries = await reader.getEntries(); } catch { throw new LocalError('Súbor sa nedá otvoriť ako zip.'); }
    let plan;
    try { plan = planZip(entries.map(e => e.filename + (e.directory ? '/' : ''))); } catch (e) { throw new LocalError((e as Error).message); }

    const taskId = await nextId();
    const rels: string[] = [];
    let commentFilename = COMMENT_FILENAME, commentText = '';
    try {
      for (const [i, f] of plan.files.entries()) {
        const entry = entries[f.index] as FileEntry;
        const rel = f.rel.join('/');
        const blob = await entry.getData(new BlobWriter());
        await files.put(taskId, rel, blob);
        rels.push(rel);
        const name = f.rel[f.rel.length - 1];
        if (COMMENT_RE.test(name)) {
          commentFilename = name;
          const t = (await blob.text()).trim();
          if (t && !commentText) commentText = t;
        }
        onProgress?.(i + 1, plan.files.length);
      }

      const solIds: number[] = [];
      for (const [i, folder] of plan.folders.entries()) {
        const inFolder = rels.filter(r => r.startsWith(safeSeg(folder) + '/') && r.split('/').length === 2).map(r => r.split('/')[1]);
        const { bodyFile, biasFile, biasCommentFile, ...meta } = solutionMeta(folder, inFolder);
        const read = async (name: string | null) => (name ? (await files.get(taskId, `${safeSeg(folder)}/${name}`))?.text() : undefined);
        const body = await read(bodyFile);
        const pts = body !== undefined ? parsePointsText(body) : null;
        // interné body zo zipu sú len pri opätovnom nahratí vlastného exportu
        const biasText = await read(biasFile);
        const id = await nextId();
        await sols.put({
          id, task_id: taskId, idx: i + 1, folder, ...meta, had_points_file: !!bodyFile,
          annotations: [], checks: [], manual_points: pts, points: pts, rev: 0, updated_at: null, updated_by: null, pages: null, scores: {},
          bias: biasText !== undefined ? parseBiasText(biasText) : normBias(null), bias_comment: ((await read(biasCommentFile)) ?? '').trim(),
        });
        solIds.push(id);
      }
      await tasks.put({
        id: taskId, name: plan.rootFolder || zipName.replace(/\.zip$/i, '') || 'Úloha', root_folder: plan.rootFolder,
        comment_text: commentText, comment_filename: commentFilename, max_points: DEFAULT_MAX_POINTS, rubric: [],
        created_at: now(), solIds, files: rels, remote: null,
      });
    } catch (e) {
      await deleteLocalTask(taskId);
      throw e;
    }
    return taskId;
  } finally {
    await reader.close();
  }
}

/**
 * Dodatočné riešenia do lokálnej úlohy – rovnako ako na serveri: párovanie podľa ID riešiteľa,
 * existujúce riešenia sa nemenia, pribudnú nové a poradie sa zoradí podľa ID.
 */
export async function addLocalSolutions(taskId: number, zip: Blob): Promise<AddSolutionsResult> {
  const t = await mustTask(taskId);
  if (t.remote) throw new LocalError('Úloha je prepojená so serverom – riešenia pridaj na serveri a potom synchronizuj.');
  const reader = new ZipReader(new BlobReader(zip));
  try {
    let entries;
    try { entries = await reader.getEntries(); } catch { throw new LocalError('Súbor sa nedá otvoriť ako zip.'); }
    let plan;
    try { plan = planZip(entries.map(e => e.filename + (e.directory ? '/' : ''))); } catch (e) { throw new LocalError((e as Error).message); }
    const existing = await sols.many(t.solIds);
    const byId = new Map(existing.filter(s => s.student_id).map(s => [s.student_id, s]));
    const folders = new Set(existing.map(s => safeSeg(s.folder)));
    const result: AddSolutionsResult = { added: [], kept: 0, changedPdf: [] };
    const zipFiles = new Map<string, Blob>(); // súbory zo zipu (priečinok/súbor)
    for (const f of plan.files) {
      if (f.rel.length !== 2) continue;
      zipFiles.set(f.rel.join('/'), await (entries[f.index] as FileEntry).getData(new BlobWriter()));
    }
    const newSols: LocalSol[] = [];
    for (const folder of plan.folders) {
      const seg = safeSeg(folder);
      const inFolder = [...zipFiles.keys()].filter(r => r.startsWith(seg + '/')).map(r => r.split('/')[1]);
      const { bodyFile, biasFile, biasCommentFile, ...meta } = solutionMeta(folder, inFolder);
      const ex = (meta.student_id && byId.get(meta.student_id)) || existing.find(s => s.folder === folder);
      if (ex) {
        result.kept++;
        const a = ex.pdf_name ? await files.get(taskId, `${safeSeg(ex.folder)}/${ex.pdf_name}`) : null;
        const b = meta.pdf_name ? zipFiles.get(`${seg}/${meta.pdf_name}`) : null;
        if (a && b && a.size !== b.size) result.changedPdf.push(ex.display_name);
        // nové poradové číslo z hromadného opravovania: len názov pre export, súbory ostávajú, kde sú
        if (seg !== safeSeg(ex.export_folder || ex.folder)) { ex.export_folder = seg; await sols.put(ex); }
        continue;
      }
      let target = seg;
      for (let n = 2; folders.has(target); n++) target = `${seg}-${n}`;
      folders.add(target);
      for (const name of inFolder) {
        const rel = `${target}/${name}`;
        await files.put(taskId, rel, zipFiles.get(`${seg}/${name}`)!);
        t.files.push(rel);
      }
      const read = async (name: string | null) => (name ? zipFiles.get(`${seg}/${name}`)?.text() : undefined);
      const body = await read(bodyFile);
      const pts = body !== undefined ? parsePointsText(body) : null;
      const biasText = await read(biasFile);
      newSols.push({
        id: await nextId(), task_id: taskId, idx: 1e9, folder: target, ...meta, had_points_file: !!bodyFile,
        annotations: [], checks: [], manual_points: pts, points: pts, rev: 0, updated_at: null, updated_by: null, pages: null, scores: {},
        bias: biasText !== undefined ? parseBiasText(biasText) : normBias(null), bias_comment: ((await read(biasCommentFile)) ?? '').trim(),
      });
      result.added.push(meta.display_name);
    }
    // poradie podľa ID riešiteľa
    const all = orderByStudentId([...existing, ...newSols]);
    for (const [i, s] of all.entries()) if (s.idx !== i + 1 || newSols.includes(s)) await sols.put({ ...s, idx: i + 1 });
    await tasks.put({ ...t, solIds: all.map(s => s.id), ...(newSols.length ? { updated_at: now() } : {}) });
    return result;
  } finally {
    await reader.close();
  }
}

export async function deleteLocalTask(id: number) {
  const t = await tasks.get(id);
  if (t) {
    await sols.delMany(t.solIds);
    await versions.delMany(t.solIds);
  }
  await files.delTask(id);
  await tasks.del(id);
}

/* ================= nastavenia úlohy ================= */

export async function updateTask(id: number, patch: Partial<TaskSettings>) {
  const t = await mustTask(id);
  const next: LocalTask = {
    ...t,
    name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : t.name,
    comment_text: typeof patch.comment_text === 'string' ? patch.comment_text : t.comment_text,
    max_points: 'max_points' in patch ? (patch.max_points === null || (patch.max_points as unknown) === '' ? null : Number(patch.max_points)) : t.max_points,
    rubric: Array.isArray(patch.rubric) ? patch.rubric.map(i => ({ id: String(i.id), label: String(i.label || ''), points: Number(i.points) || 0 })) : t.rubric,
    rubric_mode: 'rubric_mode' in patch ? normRubricMode(patch.rubric_mode) : normRubricMode(t.rubric_mode),
  };
  const keys = ['name', 'comment_text', 'max_points', 'rubric', 'rubric_mode'] as const;
  if (keys.some(k => !same(next[k] ?? null, t[k] ?? (k === 'rubric_mode' ? 'checks' : null)))) next.updated_at = now();
  await tasks.put(next);
  // body všetkých riešení podľa novej rubriky / maxima / spôsobu bodovania
  for (const s of await sols.many(t.solIds)) {
    const points = computePoints(next.rubric, s.checks, s.manual_points, next.max_points, normScores(s.scores), next.rubric_mode);
    if (points !== s.points) await sols.put({ ...s, points, rev: s.rev + 1 });
  }
  return { ok: true };
}

/* ================= ukladanie a história ================= */

export async function saveLocalSolution(id: number, data: SolutionSave, user: User, newVersion = false): Promise<SaveResult> {
  const s = await mustSol(id);
  const t = await mustTask(s.task_id);
  const annotations = Array.isArray(data.annotations) ? data.annotations : s.annotations;
  const checks = Array.isArray(data.checks) ? data.checks.map(String) : s.checks;
  const manual = 'manual_points' in data ? (data.manual_points === null ? null : Number(data.manual_points)) : s.manual_points;
  const rocnik = typeof data.rocnik === 'string' ? data.rocnik.trim().slice(0, 20) : s.rocnik;
  const bias = normBias(Array.isArray(data.bias) ? data.bias : s.bias);
  const bias_comment = typeof data.bias_comment === 'string' ? data.bias_comment : s.bias_comment ?? '';
  const pages = normPages('pages' in data ? data.pages : s.pages);
  const scores = normScores(data.scores !== undefined ? data.scores : s.scores);
  const points = computePoints(t.rubric, checks, manual, t.max_points, scores, normRubricMode(t.rubric_mode));
  const changes = countChanges(solState(s), { annotations, checks, manual_points: manual, rocnik, bias, bias_comment, pages, scores });
  const rev = s.rev + 1, at = now();
  await sols.put({ ...s, annotations, checks, manual_points: manual, rocnik, bias, bias_comment, pages, scores, points, rev, updated_at: at, updated_by: user.name });

  const list = await versions.get(id);
  const last = list[list.length - 1];
  const entry = { rev, annotations, checks, manual_points: manual, rocnik, bias, bias_comment, pages, scores, points, updated_at: at };
  if (!newVersion && last && last.user_id === user.id && Date.now() - Date.parse(last.updated_at) < VERSION_MERGE_MINUTES * 60e3) {
    Object.assign(last, entry, { changes: (last.changes || 0) + changes });
  } else {
    list.push({ id: (last?.id || 0) + 1, created_at: at, user: user.name, user_id: user.id, ...entry, changes });
  }
  await versions.put(id, list);
  return { ok: true, points, rocnik, rev, conflict: false };
}

export async function listVersions(id: number): Promise<VersionItem[]> {
  return (await versions.get(id)).slice().reverse().slice(0, 200)
    .map(v => ({ id: v.id, rev: v.rev, created_at: v.updated_at, user: v.user, points: v.points, count: v.annotations.length, changes: v.changes || 0 }));
}

export async function restoreLocalVersion(id: number, vid: number, user: User) {
  const v = (await versions.get(id)).find(x => x.id === vid);
  if (!v) throw new LocalError('Verzia neexistuje.');
  return saveLocalSolution(id, solState(v), user, true);
}

/** Zapíše stav zo servera (synchronizácia) – ako novú verziu. */
export async function applyRemoteState(id: number, st: SolState, by: string | null) {
  await saveLocalSolution(id, st, {
    id: -1, email: '', name: by || 'server', picture: null, stamp_name: null, stamp_font: null, accent: null, pen_color: null,
    stamp_image: null, stamp_image_scale: null, stamp_color: null, stamp_pos: null,
    stamp_points_font: null, stamp_points_color: null, stamp_points_size: null,
  }, true);
}

export async function localState(id: number): Promise<SolState> {
  return solState(await mustSol(id));
}

/* ================= PDF, vypálenie, miniatúry ================= */

export async function localPdfBlob(solId: number): Promise<Blob | null> {
  const s = await mustSol(solId);
  if (!s.pdf_name) return null;
  return (await files.get(s.task_id, `${safeSeg(s.folder)}/${s.pdf_name}`)) || null;
}

const fontCache = new Map<string, Promise<Uint8Array>>();
function fontBytes(file: string) {
  if (!fontCache.has(file)) {
    fontCache.set(file, fetch(`/fonts/${file}`).then(r => {
      if (!r.ok) throw new Error('Písmo sa nepodarilo načítať.');
      return r.arrayBuffer();
    }).then(b => new Uint8Array(b)));
  }
  return fontCache.get(file)!;
}

async function getAsset(id: number) {
  const a = await assets.get(id);
  return a ? { mime: a.mime, data: new Uint8Array(await a.blob.arrayBuffer()) } : null;
}

/** meno.komentar.pdf – vypáli sa v prehliadači tým istým kódom ako na serveri. */
export async function localRendered(solId: number): Promise<Blob | null> {
  const s = await mustSol(solId);
  if (!edited(s)) return null;
  const key = `thumb:${s.task_id}:render-${s.id}-${s.rev}`;
  const cached = await files.getKey(key);
  if (cached) return cached;
  const base = await localPdfBlob(solId);
  if (!base) return null;
  const { renderPdf } = await import('@opravovator/shared/render');
  const bytes = await renderPdf(await base.arrayBuffer(), s.annotations, {
    points: s.points, correctorName: s.updated_by || '', fontBytes, getAsset, pages: normPages(s.pages),
  });
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  await files.putKey(key, blob);
  return blob;
}

export async function localResult(solId: number): Promise<Blob | null> {
  return (await localRendered(solId)) || localPdfBlob(solId);
}

let thumbQueue: Promise<unknown> = Promise.resolve();
/** PNG miniatúra prvej strany (s opravami). Generuje sa po jednej, aby to nezaťažilo prehliadač. */
export function localThumb(solId: number): Promise<Blob | null> {
  const job = thumbQueue.then(async () => {
    const s = await mustSol(solId);
    const key = `thumb:${s.task_id}:${s.id}-${edited(s) ? s.rev : 0}`;
    const cached = await files.getKey(key);
    if (cached) return cached;
    const src = await localResult(solId);
    if (!src) return null;
    const { pdfjs } = await import('../pdf');
    const task = pdfjs.getDocument({ data: await src.arrayBuffer() });
    try {
      const doc = await task.promise;
      const page = await doc.getPage(1);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 240 / Math.max(vp1.width, vp1.height) });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await page.render({ canvas: c, canvasContext: c.getContext('2d')!, viewport: vp }).promise;
      const png = await new Promise<Blob | null>(r => c.toBlob(r, 'image/png'));
      if (png) await files.putKey(key, png);
      return png;
    } finally {
      task.destroy();
    }
  });
  thumbQueue = job.catch(() => {});
  return job;
}

/* ================= export ================= */

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60e3);
}

/** Pôvodné súbory úlohy (ako v nahratom zipe) – na nahratie na server. */
export async function localOriginalZip(taskId: number): Promise<Blob> {
  const t = await mustTask(taskId);
  const prefix = t.root_folder ? safeSeg(t.root_folder) + '/' : '';
  const zw = new ZipWriter(new BlobWriter('application/zip'));
  for (const rel of t.files) {
    const b = await files.get(taskId, rel);
    if (b) await zw.add(prefix + rel, new BlobReader(b), { level: 0 });
  }
  return zw.close();
}

/** Zip v pôvodnej štruktúre s meno.komentar.pdf, body.txt, komentárom a internými bias súbormi – ako export zo servera. */
export async function localExportZip(taskId: number, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const t = await mustTask(taskId);
  const ss = (await sols.many(t.solIds)).sort((a, b) => a.idx - b.idx);
  const prefix = t.root_folder ? safeSeg(t.root_folder) + '/' : '';
  const generated = new Map<string, Blob>();
  const replaced = new Set<string>();
  // priečinky s poradovým číslom podľa ID (po pridaní dodatočných riešení prečíslované)
  const names = exportFolderNames(ss.map(s => ({ folder: safeSeg(s.folder), idx: s.idx, export_folder: s.export_folder })));
  const rename = (rel: string) => {
    const i = rel.indexOf('/');
    return i > 0 && names.has(rel.slice(0, i)) ? names.get(rel.slice(0, i)) + rel.slice(i) : rel;
  };
  for (const [i, s] of ss.entries()) {
    const folder = safeSeg(s.folder);
    const rendered = await localRendered(s.id);
    if (rendered && s.pdf_name) {
      const rel = `${folder}/${commentedName(s.pdf_name)}`;
      replaced.add(rel); generated.set(rel, rendered);
    }
    const pointsRel = `${folder}/${POINTS_FILENAME}`;
    if (s.points !== null) generated.set(pointsRel, new Blob([formatPointsFile(s.points)]));
    else if (s.had_points_file) generated.set(pointsRel, new Blob(['']));
    replaced.add(pointsRel);
    const commentRel = `${folder}/${safeSeg(t.comment_filename)}`;
    if (t.comment_text || t.files.includes(commentRel)) generated.set(commentRel, new Blob([t.comment_text]));
    replaced.add(commentRel);
    for (const [name, content] of [[BIAS_FILENAME, formatBiasFile(normBias(s.bias))], [BIAS_COMMENT_FILENAME, s.bias_comment ?? '']]) {
      const rel = `${folder}/${name}`;
      generated.set(rel, new Blob([content]));
      replaced.add(rel);
    }
    onProgress?.(i + 1, ss.length);
  }
  const zw = new ZipWriter(new BlobWriter('application/zip'));
  for (const rel of t.files) {
    if (replaced.has(rel)) continue;
    const b = await files.get(taskId, rel);
    if (b) await zw.add(prefix + rename(rel), new BlobReader(b), { level: 0 });
  }
  for (const [rel, b] of generated) await zw.add(prefix + rename(rel), new BlobReader(b), { level: 1 });
  return zw.close();
}

export async function localCsv(taskId: number): Promise<Blob> {
  const t = await mustTask(taskId);
  const ss = (await sols.many(t.solIds)).sort((a, b) => a.idx - b.idx);
  const folders = exportFolderNames(ss);
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [['#', 'Meno', 'Ročník', 'ID', 'Priečinok', 'Body', 'Opravené v PDF', ...BIAS_LABELS.map(b => b.label)].join(';')];
  for (const s of ss) {
    lines.push([s.idx, s.display_name, s.rocnik, s.student_id, folders.get(s.folder) || s.folder,
      s.points === null ? '' : String(exportPoints(s.points)), edited(s) ? 'áno' : '',
      ...normBias(s.bias).map(v => formatPoints(v).replace('.', ','))].map(esc).join(';'));
  }
  return new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
}

/* ================= obrázky / podpisy ================= */

export async function listLocalAssets() {
  return (await assets.all()).filter(a => a.id < 0 && !a.deleted).sort((a, b) => a.id - b.id).map(a => ({ id: a.id, name: a.name }));
}

export async function addLocalAsset(blob: Blob, name: string) {
  if (blob.size > MAX_IMAGE_BYTES) throw new LocalError(`Obrázok je príliš veľký, maximum je ${MAX_IMAGE_MB} MB.`);
  persistStorage();
  const id = await nextId();
  await assets.put({ id, name, mime: blob.type || 'image/png', blob });
  return id;
}

export async function deleteLocalAsset(id: number) {
  const a = await assets.get(id);
  if (a) await assets.put({ ...a, deleted: true }); // v existujúcich opravách ostáva
}

const assetUrls = new Map<number, string>();
/** Object URL obrázka uloženého v zariadení (lokálneho aj stiahnutého zo servera). */
export async function localAssetUrl(id: number): Promise<string | null> {
  if (assetUrls.has(id)) return assetUrls.get(id)!;
  const a = await assets.get(id);
  if (!a) return null;
  const url = URL.createObjectURL(a.blob);
  assetUrls.set(id, url);
  return url;
}
