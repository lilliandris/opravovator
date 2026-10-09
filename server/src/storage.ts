import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Writable } from 'node:stream';
import { ZipArchive, type ArchiverError } from 'archiver';
import yauzl from 'yauzl';
import {
  BIAS_COMMENT_FILENAME, BIAS_FILENAME, COMMENT_RE, commentedName, exportFolderNames, orderByStudentId, type AddSolutionsResult, computePoints, countChanges, formatBiasFile, formatPointsFile,
  mergeStates, normBias, normPages, normScores, parseBiasText, parsePointsText, planZip, safeSeg, solState, solutionMeta,
  type Annotation, type Bias, type PageSpec, type RubricItem, type RubricMode, type Scores, type SolState, type SolutionSave, type SaveResult, type User,
} from '@opravovator/shared';
import { renderPdf } from '@opravovator/shared/render';
import { cfg } from './config.js';
import { sql } from './db.js';
import { enqueue, limiter, HttpError } from './http.js';

const run = promisify(execFile);

export const TASKS_DIR = path.join(cfg.DATA_DIR, 'tasks');
export const ASSETS_DIR = path.join(cfg.DATA_DIR, 'assets');
export const TMP_DIR = path.join(cfg.DATA_DIR, 'tmp');
for (const d of [TASKS_DIR, ASSETS_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

export interface TaskRow {
  id: number; owner_id: number; name: string; root_folder: string | null; comment_text: string;
  comment_filename: string; max_points: number | null; rubric: RubricItem[]; created_at: Date; updated_at: Date | null;
  rubric_mode: RubricMode; signers: number[];
}
export interface SolutionRow {
  id: number; task_id: number; idx: number; folder: string; pdf_name: string | null; display_name: string;
  rocnik: string; student_id: string; had_points_file: boolean; annotations: Annotation[]; checks: string[];
  manual_points: number | null; points: number | null; rev: number; rendered_rev: number;
  updated_at: Date | null; updated_by: number | null; bias: Bias; bias_comment: string;
  pages: PageSpec[] | null; scores: Scores; export_folder: string | null;
}

/* ================= cesty ================= */

const taskDir = (taskId: number) => path.join(TASKS_DIR, String(taskId));
const filesDir = (taskId: number) => path.join(taskDir(taskId), 'files');
export const solDir = (s: Pick<SolutionRow, 'task_id' | 'folder'>) => path.join(filesDir(s.task_id), safeSeg(s.folder));
export const basePdfPath = (s: SolutionRow) => (s.pdf_name ? path.join(solDir(s), s.pdf_name) : null);
const outPath = (s: SolutionRow) => path.join(taskDir(s.task_id), 'out', s.id + '.pdf');
const thumbPath = (s: SolutionRow, key: number) => path.join(taskDir(s.task_id), 'thumbs', `${s.id}-${key}.png`);
export const assetPath = (id: number) => path.join(ASSETS_DIR, String(id));

async function writeAtomic(file: string, data: Buffer | string) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

/* ================= import zipu ================= */

function openZip(file: string): Promise<{ zf: yauzl.ZipFile; entries: yauzl.Entry[] }> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (err, zf) => {
      if (err || !zf) return reject(new HttpError(400, 'Súbor sa nedá otvoriť ako zip.'));
      const entries: yauzl.Entry[] = [];
      zf.on('entry', (e: yauzl.Entry) => { entries.push(e); zf.readEntry(); });
      zf.on('end', () => resolve({ zf, entries }));
      zf.on('error', () => reject(new HttpError(400, 'Zip je poškodený.')));
      zf.readEntry();
    });
  });
}

function extractEntry(zf: yauzl.ZipFile, entry: yauzl.Entry, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    zf.openReadStream(entry, (err, rs) => {
      if (err || !rs) return reject(err);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const ws = fs.createWriteStream(dest);
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => resolve());
      rs.pipe(ws);
    });
  });
}

/** Rozbalí zip (po súboroch z disku, bez ohľadu na veľkosť) a vytvorí úlohu s riešeniami. */
export async function importZip(zipPath: string, zipName: string, ownerId: number, nameOverride?: string): Promise<number> {
  const { zf, entries: raw } = await openZip(zipPath);
  try {
    let plan;
    try { plan = planZip(raw.map(e => e.fileName), cfg.POINTS_FILENAME); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const rootFolder = plan.rootFolder;
    const taskName = (nameOverride || '').trim() || rootFolder || String(zipName || 'Úloha').replace(/\.zip$/i, '');

    const [task] = await sql<{ id: number }[]>`
      INSERT INTO tasks (owner_id, name, root_folder, comment_filename)
      VALUES (${ownerId}, ${taskName}, ${rootFolder}, ${cfg.COMMENT_FILENAME}) RETURNING id`;
    const root = filesDir(task.id);
    try {
      await fsp.mkdir(root, { recursive: true });
      let commentFilename = cfg.COMMENT_FILENAME, commentText = '';
      for (const f of plan.files) {
        const dest = path.join(root, ...f.rel);
        if (!dest.startsWith(root + path.sep)) continue;
        await extractEntry(zf, raw[f.index], dest);
        const name = f.rel[f.rel.length - 1];
        if (COMMENT_RE.test(name)) {
          commentFilename = name;
          const t = (await fsp.readFile(dest, 'utf8')).trim();
          if (t && !commentText) commentText = t;
        }
      }

      const rows = [];
      for (const [i, folder] of plan.folders.entries()) {
        const dir = path.join(root, safeSeg(folder));
        const { bodyFile, biasFile, biasCommentFile, ...meta } = solutionMeta(folder, await fsp.readdir(dir), cfg.POINTS_FILENAME);
        const pts = bodyFile ? parsePointsText(await fsp.readFile(path.join(dir, bodyFile), 'utf8')) : null;
        // interné body zo zipu sú len pri opätovnom nahratí vlastného exportu
        const bias = biasFile ? parseBiasText(await fsp.readFile(path.join(dir, biasFile), 'utf8')) : normBias(null);
        const biasComment = biasCommentFile ? (await fsp.readFile(path.join(dir, biasCommentFile), 'utf8')).trim() : '';
        rows.push({
          task_id: task.id, idx: i + 1, folder, ...meta, had_points_file: !!bodyFile, manual_points: pts, points: pts,
          bias: sql.json(bias), bias_comment: biasComment,
        });
      }
      for (let i = 0; i < rows.length; i += 500) {
        await sql`INSERT INTO solutions ${sql(rows.slice(i, i + 500))}`;
      }
      await sql`UPDATE tasks SET comment_text = ${commentText}, comment_filename = ${commentFilename} WHERE id = ${task.id}`;
    } catch (e) {
      await deleteTask(task.id);
      throw e;
    }
    return task.id;
  } finally {
    zf.close();
  }
}

/* ================= dodatočné riešenia ================= */

/**
 * Pridá do úlohy riešenia zo zipu (celé nové hromadné opravovanie, alebo len nové priečinky).
 * Riešenia sa párujú podľa ID riešiteľa (číslo na konci priečinka), nie podľa názvu – hromadné
 * opravovanie čísluje priečinky podľa ID, takže dodatočné riešenie posunie čísla ostatným.
 * Existujúce riešenia sa nemenia (ani súbory, ani opravy), pribudnú len nové; potom sa poradie zoradí podľa ID.
 */
export function addSolutionsZip(taskId: number, zipPath: string): Promise<AddSolutionsResult> {
  return enqueue('add-solutions:' + taskId, async () => {
    const { zf, entries: raw } = await openZip(zipPath);
    const tmp = path.join(TMP_DIR, 'add-' + crypto.randomBytes(6).toString('hex'));
    try {
      let plan;
      try { plan = planZip(raw.map(e => e.fileName), cfg.POINTS_FILENAME); } catch (e) { throw new HttpError(400, (e as Error).message); }
      const existing = await sql<SolutionRow[]>`SELECT id, idx, folder, export_folder, student_id, pdf_name, display_name, task_id FROM solutions WHERE task_id = ${taskId}`;
      const byId = new Map(existing.filter(s => s.student_id).map(s => [s.student_id, s]));
      const byFolder = new Map(existing.map(s => [s.folder, s]));
      // najprv všetko do dočasného priečinka – do úlohy sa presunú len nové riešenia
      for (const f of plan.files) {
        const dest = path.join(tmp, ...f.rel);
        if (!dest.startsWith(tmp + path.sep)) continue;
        await extractEntry(zf, raw[f.index], dest);
      }
      const root = filesDir(taskId);
      const result: AddSolutionsResult = { added: [], kept: 0, changedPdf: [] };
      const rows: Record<string, unknown>[] = [];
      const renames: { id: number; folder: string }[] = [];
      const moved: string[] = []; // nové priečinky presunuté do úlohy (pri chybe sa vrátia preč)
      for (const folder of plan.folders) {
        const dir = path.join(tmp, safeSeg(folder));
        const names = await fsp.readdir(dir);
        const { bodyFile, biasFile, biasCommentFile, ...meta } = solutionMeta(folder, names, cfg.POINTS_FILENAME);
        const ex = (meta.student_id && byId.get(meta.student_id)) || byFolder.get(folder);
        if (ex) {
          result.kept++;
          const a = ex.pdf_name ? await fsp.stat(path.join(solDir(ex), ex.pdf_name)).catch(() => null) : null;
          const b = meta.pdf_name ? await fsp.stat(path.join(dir, meta.pdf_name)).catch(() => null) : null;
          if (a && b && a.size !== b.size) result.changedPdf.push(ex.display_name);
          // nové poradové číslo z hromadného opravovania (napr. 016-… → 017-…): zapíše sa len názov pre export,
          // súbory na disku sa nepremenúvajú (žiadne riziko, že databáza a disk prestanú sedieť)
          if (safeSeg(folder) !== safeSeg(ex.export_folder || ex.folder)) renames.push({ id: ex.id, folder: safeSeg(folder) });
          continue;
        }
        // názov priečinka na disku musí byť jedinečný (obsah sa pri exporte aj tak prečísluje)
        let target = safeSeg(folder);
        for (let n = 2; byFolder.has(target) || fs.existsSync(path.join(root, target)); n++) target = `${safeSeg(folder)}-${n}`;
        await fsp.mkdir(root, { recursive: true });
        await fsp.rename(dir, path.join(root, target));
        moved.push(path.join(root, target));
        byFolder.set(target, { folder: target } as SolutionRow);
        const tdir = path.join(root, target);
        const pts = bodyFile ? parsePointsText(await fsp.readFile(path.join(tdir, bodyFile), 'utf8')) : null;
        const bias = biasFile ? parseBiasText(await fsp.readFile(path.join(tdir, biasFile), 'utf8')) : normBias(null);
        const biasComment = biasCommentFile ? (await fsp.readFile(path.join(tdir, biasCommentFile), 'utf8')).trim() : '';
        rows.push({
          task_id: taskId, idx: 0, folder: target, ...meta, had_points_file: !!bodyFile, manual_points: pts, points: pts,
          bias: sql.json(bias), bias_comment: biasComment,
        });
        result.added.push(meta.display_name);
      }
      try {
        await sql.begin(async tx => {
          if (rows.length) await tx`INSERT INTO solutions ${tx(rows as never)}`;
          for (const r of renames) await tx`UPDATE solutions SET export_folder = ${r.folder} WHERE id = ${r.id}`;
          // poradie podľa ID riešiteľa (ako v hromadnom opravovaní)
          const all = await tx<{ id: number; idx: number; student_id: string }[]>`SELECT id, idx, student_id FROM solutions WHERE task_id = ${taskId}`;
          for (const [i, s] of orderByStudentId(all.map(s => ({ ...s, idx: s.idx || 1e9 }))).entries()) {
            if (s.idx !== i + 1) await tx`UPDATE solutions SET idx = ${i + 1} WHERE id = ${s.id}`;
          }
          if (rows.length) await tx`UPDATE tasks SET updated_at = now() WHERE id = ${taskId}`;
        });
      } catch (e) {
        // zápis do databázy zlyhal → nové priečinky preč, úloha ostane presne ako pred pridaním
        for (const d of moved) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      return result;
    } finally {
      zf.close();
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/* ================= vypálené PDF ================= */

async function correctorName(s: SolutionRow) {
  if (!s.updated_by) return '';
  const [u] = await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${s.updated_by}`;
  return u ? u.name : '';
}

async function readAsset(id: number) {
  try {
    return { mime: await fsp.readFile(assetPath(id) + '.mime', 'utf8'), data: await fsp.readFile(assetPath(id)) };
  } catch {
    return null;
  }
}

const fontCache = new Map<string, Promise<Uint8Array>>();
function fontBytes(file: string) {
  if (!fontCache.has(file)) fontCache.set(file, fsp.readFile(path.join(cfg.FONTS_DIR, file)));
  return fontCache.get(file)!;
}

/**
 * Cesta k PDF, ktoré sa odovzdá ako „meno.komentar.pdf“. Ak riešenie nemá žiadne
 * anotácie, vráti null (nič sa negeneruje). Vypaľuje sa vždy z pôvodného PDF.
 */
export function ensureRendered(solId: number): Promise<string | null> {
  return enqueue('render:' + solId, async () => {
    const [s] = await sql<SolutionRow[]>`SELECT * FROM solutions WHERE id = ${solId}`;
    if (!s || (!s.annotations.length && !s.pages)) return null;
    const base = basePdfPath(s);
    if (!base || !fs.existsSync(base)) return null;
    const out = outPath(s);
    if (s.rendered_rev === s.rev && fs.existsSync(out)) return out;
    const bytes = await renderPdf(await fsp.readFile(base), s.annotations, {
      points: s.points, correctorName: await correctorName(s), getAsset: readAsset, fontBytes, pages: s.pages,
    });
    await writeAtomic(out, Buffer.from(bytes));
    await sql`UPDATE solutions SET rendered_rev = ${s.rev} WHERE id = ${s.id} AND rev = ${s.rev}`;
    return out;
  });
}

// po uložení sa PDF vypáli na pozadí, aby bol export zipu rýchly
const renderTimers = new Map<number, NodeJS.Timeout>();
function scheduleRender(solId: number) {
  clearTimeout(renderTimers.get(solId));
  renderTimers.set(solId, setTimeout(() => {
    renderTimers.delete(solId);
    ensureRendered(solId).catch(e => console.error('Vypálenie PDF zlyhalo', solId, e));
  }, 3000));
}

/* ================= miniatúry ================= */

const thumbLimit = limiter(2);
let pdftoppmMissing = false;

/** PNG miniatúra prvej strany (s opravami, ak nejaké sú). */
export async function thumbnail(solId: number): Promise<string | null> {
  if (pdftoppmMissing) return null;
  const [s] = await sql<SolutionRow[]>`SELECT * FROM solutions WHERE id = ${solId}`;
  if (!s) return null;
  const key = s.annotations.length || s.pages ? s.rev : 0;
  const file = thumbPath(s, key);
  if (fs.existsSync(file)) return file;
  const src = (await ensureRendered(s.id)) || basePdfPath(s);
  if (!src || !fs.existsSync(src)) return null;
  return thumbLimit(() => enqueue('thumb:' + s.id, async () => {
    if (fs.existsSync(file)) return file;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmpBase = path.join(TMP_DIR, `thumb-${s.id}-${Date.now()}`);
    try {
      await run('pdftoppm', ['-f', '1', '-l', '1', '-png', '-scale-to', '240', '-singlefile', src, tmpBase], { timeout: 60000 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        pdftoppmMissing = true;
        console.warn('pdftoppm (poppler-utils) nie je nainštalovaný, miniatúry nebudú.');
      }
      return null;
    }
    // staré miniatúry toho istého riešenia preč
    for (const f of await fsp.readdir(path.dirname(file))) {
      if (f.startsWith(s.id + '-')) await fsp.rm(path.join(path.dirname(file), f), { force: true });
    }
    await fsp.rename(tmpBase + '.png', file);
    return file;
  }));
}

/* ================= ukladanie a história ================= */

const VERSION_MERGE_MINUTES = 10;

export function saveSolution(solId: number, data: SolutionSave, user: User, newVersion = false): Promise<SaveResult> {
  return enqueue('save:' + solId, async () => {
    const result = await sql.begin(async tx => {
      const [s] = await tx<SolutionRow[]>`SELECT * FROM solutions WHERE id = ${solId} FOR UPDATE`;
      if (!s) throw new HttpError(404, 'Riešenie neexistuje.');
      const [task] = await tx<TaskRow[]>`SELECT * FROM tasks WHERE id = ${s.task_id}`;

      let annotations = Array.isArray(data.annotations) ? data.annotations : s.annotations;
      let checks = Array.isArray(data.checks) ? data.checks.map(String) : s.checks;
      let manual = 'manual_points' in data
        ? (data.manual_points === null || (data.manual_points as unknown) === '' ? null : Number(data.manual_points))
        : s.manual_points;
      let rocnik = typeof data.rocnik === 'string' ? data.rocnik.trim().slice(0, 20) : s.rocnik;
      let bias = Array.isArray(data.bias) ? normBias(data.bias) : normBias(s.bias);
      let biasComment = typeof data.bias_comment === 'string' ? data.bias_comment : s.bias_comment;
      let pages = 'pages' in data ? normPages(data.pages) : normPages(s.pages);
      let scores = data.scores !== undefined ? normScores(data.scores) : normScores(s.scores);
      const conflict = typeof data.baseRev === 'number' && data.baseRev !== s.rev;

      // súbeh: niekto medzitým uložil inú verziu → zlúč moje a jeho zmeny oproti spoločnému základu
      let merged: SolState | null = null, mergedWith: string | null = null;
      if (conflict && data.base) {
        merged = mergeStates(solState(data.base), { annotations, checks, manual_points: manual, rocnik, bias, bias_comment: biasComment, pages, scores }, solState(s));
        ({ annotations, checks, manual_points: manual, rocnik, bias, bias_comment: biasComment, pages, scores } = merged);
        if (s.updated_by) {
          const [u] = await tx<{ name: string }[]>`SELECT name FROM users WHERE id = ${s.updated_by}`;
          mergedWith = u ? u.name : null;
        }
      }
      const points = computePoints(task.rubric, checks, manual, task.max_points, scores, task.rubric_mode);
      const rev = s.rev + 1;
      const changes = countChanges(solState(s), { annotations, checks, manual_points: manual, rocnik, bias, bias_comment: biasComment, pages, scores });
      const pagesJson = pages ? tx.json(pages as never) : null;

      await tx`UPDATE solutions SET annotations = ${tx.json(annotations as never)}, checks = ${tx.json(checks)},
        manual_points = ${manual}, points = ${points}, rocnik = ${rocnik}, rev = ${rev},
        bias = ${tx.json(bias)}, bias_comment = ${biasComment}, pages = ${pagesJson}, scores = ${tx.json(scores)},
        updated_at = now(), updated_by = ${user.id} WHERE id = ${solId}`;

      // pri konflikte (napr. offline zmeny) vždy nová verzia, aby sa nič nestratilo
      const [last] = await tx<{ id: number; user_id: number | null; updated_at: Date }[]>`
        SELECT id, user_id, updated_at FROM solution_versions WHERE solution_id = ${solId} ORDER BY id DESC LIMIT 1`;
      const sameVersion = !conflict && !newVersion && last && last.user_id === user.id &&
        Date.now() - last.updated_at.getTime() < VERSION_MERGE_MINUTES * 60e3;
      if (sameVersion) {
        await tx`UPDATE solution_versions SET rev = ${rev}, annotations = ${tx.json(annotations as never)},
          checks = ${tx.json(checks)}, manual_points = ${manual}, points = ${points}, rocnik = ${rocnik},
          bias = ${tx.json(bias)}, bias_comment = ${biasComment}, pages = ${pagesJson}, scores = ${tx.json(scores)},
          changes = changes + ${changes}, updated_at = now() WHERE id = ${last.id}`;
      } else {
        await tx`INSERT INTO solution_versions (solution_id, rev, annotations, checks, manual_points, points, rocnik, bias, bias_comment, pages, scores, user_id, changes)
          VALUES (${solId}, ${rev}, ${tx.json(annotations as never)}, ${tx.json(checks)}, ${manual}, ${points}, ${rocnik},
            ${tx.json(bias)}, ${biasComment}, ${pagesJson}, ${tx.json(scores)}, ${user.id}, ${changes})`;
      }
      return { ok: true as const, points, rocnik, rev, conflict, merged, mergedWith };
    });
    scheduleRender(solId);
    return result;
  });
}

export async function restoreVersion(solId: number, versionId: number, user: User): Promise<SaveResult> {
  const [v] = await sql<SolState[]>`
    SELECT annotations, checks, manual_points, rocnik, bias, bias_comment, pages, scores FROM solution_versions WHERE id = ${versionId} AND solution_id = ${solId}`;
  if (!v) throw new HttpError(404, 'Verzia neexistuje.');
  // obnovenie je samo osebe nová verzia, takže sa dá vrátiť späť
  return saveSolution(solId, solState(v), user, true);
}

/** Po zmene bodovania / maxima prepočíta body všetkých riešení. */
export async function refreshTaskPoints(taskId: number) {
  const [task] = await sql<TaskRow[]>`SELECT * FROM tasks WHERE id = ${taskId}`;
  const sols = await sql<SolutionRow[]>`SELECT id, checks, manual_points, points, annotations, scores FROM solutions WHERE task_id = ${taskId}`;
  for (const s of sols) {
    const points = computePoints(task.rubric, s.checks, s.manual_points, task.max_points, s.scores, task.rubric_mode);
    if (points === s.points) continue;
    // pečiatka v PDF ukazuje body, preto sa mení aj rev (nové vypálenie)
    await sql`UPDATE solutions SET points = ${points}, rev = rev + 1 WHERE id = ${s.id}`;
    if (s.annotations.some(a => a.type === 'stamp')) scheduleRender(s.id);
  }
}

/* ================= export ================= */

async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.includes('.tmp-')) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...await walk(path.join(dir, e.name), r));
    else out.push(r);
  }
  return out;
}

/**
 * Streamuje zip v pôvodnej štruktúre: ku každému riešeniu pridá meno.komentar.pdf
 * (ak má opravy), body.txt, komentár a interné bias.txt + bias_komentar.txt. Pôvodné PDF zostáva nezmenené.
 */
export async function exportZip(taskId: number, out: Writable) {
  const [task] = await sql<TaskRow[]>`SELECT * FROM tasks WHERE id = ${taskId}`;
  const sols = await sql<SolutionRow[]>`SELECT * FROM solutions WHERE task_id = ${taskId} ORDER BY idx`;
  const root = filesDir(taskId);
  const prefix = task.root_folder ? safeSeg(task.root_folder) + '/' : '';

  const generated = new Map<string, Buffer | string>(); // relatívna cesta → obsah
  const replaced = new Set<string>();
  // priečinky v zipe s poradovým číslom podľa ID (po pridaní dodatočných riešení prečíslované)
  const names = exportFolderNames(sols.map(s => ({ folder: safeSeg(s.folder), idx: s.idx, export_folder: s.export_folder })));
  const rename = (rel: string) => {
    const i = rel.indexOf('/');
    return i > 0 && names.has(rel.slice(0, i)) ? names.get(rel.slice(0, i)) + rel.slice(i) : rel;
  };
  for (const s of sols) {
    const folder = safeSeg(s.folder);
    const rendered = await ensureRendered(s.id);
    if (rendered && s.pdf_name) {
      const rel = `${folder}/${commentedName(s.pdf_name)}`;
      replaced.add(rel);
      generated.set(rel, rendered); // cesta k súboru, pridá sa ako súbor
    }
    const pointsRel = `${folder}/${cfg.POINTS_FILENAME}`;
    if (s.points !== null) generated.set(pointsRel, Buffer.from(formatPointsFile(s.points)));
    else if (s.had_points_file) generated.set(pointsRel, Buffer.from(''));
    replaced.add(pointsRel);
    const commentRel = `${folder}/${safeSeg(task.comment_filename)}`;
    const hadComment = fs.existsSync(path.join(root, commentRel));
    if (task.comment_text || hadComment) generated.set(commentRel, Buffer.from(task.comment_text));
    replaced.add(commentRel);
    for (const [name, content] of [[BIAS_FILENAME, formatBiasFile(s.bias)], [BIAS_COMMENT_FILENAME, s.bias_comment]]) {
      const rel = `${folder}/${name}`;
      generated.set(rel, Buffer.from(content));
      replaced.add(rel);
    }
  }

  const archive = new ZipArchive({ zlib: { level: 1 } }); // PDF sa už ďalej nekomprimujú
  archive.on('warning', (e: ArchiverError) => console.warn(e));
  archive.on('error', (e: ArchiverError) => out.destroy(e));
  archive.pipe(out);
  for (const rel of await walk(root)) {
    if (replaced.has(rel)) continue;
    archive.file(path.join(root, rel), { name: prefix + rename(rel) });
  }
  for (const [rel, content] of generated) {
    if (typeof content === 'string') archive.file(content, { name: prefix + rename(rel) });
    else archive.append(content, { name: prefix + rename(rel) });
  }
  await archive.finalize();
}

/** Pôvodné súbory úlohy presne tak, ako boli v nahratom zipe (na stiahnutie do lokálneho režimu). */
export async function exportOriginalZip(taskId: number, out: Writable) {
  const [task] = await sql<TaskRow[]>`SELECT * FROM tasks WHERE id = ${taskId}`;
  const root = filesDir(taskId);
  const prefix = task.root_folder ? safeSeg(task.root_folder) + '/' : '';
  const archive = new ZipArchive({ zlib: { level: 1 } });
  archive.on('warning', (e: ArchiverError) => console.warn(e));
  archive.on('error', (e: ArchiverError) => out.destroy(e));
  archive.pipe(out);
  for (const rel of await walk(root)) archive.file(path.join(root, rel), { name: prefix + rel });
  await archive.finalize();
}

export async function deleteTask(taskId: number) {
  await sql`DELETE FROM tasks WHERE id = ${taskId}`;
  await fsp.rm(taskDir(taskId), { recursive: true, force: true });
}
