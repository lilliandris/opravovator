const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const yauzl = require('yauzl');
const db = require('./db');
const cfg = require('./config');
const S = require('../public/js/shared');
const { renderPdf } = require('./render');

const TASKS_DIR = path.join(cfg.DATA_DIR, 'tasks');
fs.mkdirSync(TASKS_DIR, { recursive: true });

const COMMENT_RE = /^koment[aá]r\.txt$/i;

function safeSeg(s) {
  const v = String(s).replace(/[\\/\0]/g, '_').trim();
  if (!v || v === '.' || v === '..') return '_';
  return v;
}
function writeAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function titleCase(s) {
  return s.split(/[-_\s]+/).filter(Boolean)
    .map(w => w.charAt(0).toLocaleUpperCase('sk') + w.slice(1)).join(' ');
}

// "xxx-meno-priezvisko-ID" → { prefix, name, id }
function parseFolder(folder) {
  const parts = folder.split('-');
  if (parts.length >= 3) {
    return { prefix: parts[0], nameParts: parts.slice(1, -1).join('-'), id: parts[parts.length - 1] };
  }
  return { prefix: '', nameParts: folder, id: '' };
}

function taskRoot(task) { return path.join(TASKS_DIR, String(task.id), safeSeg(task.root_folder)); }
function baseDir(task) { return path.join(TASKS_DIR, String(task.id), '_base'); }
function solDir(task, sol) { return path.join(taskRoot(task), safeSeg(sol.folder)); }
function basePdfPath(task, sol) { return path.join(baseDir(task), sol.id + '.pdf'); }

function listZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zf) => {
      if (err) return reject(new Error('Súbor sa nedá otvoriť ako zip.'));
      const entries = [];
      zf.on('entry', e => { entries.push(e); zf.readEntry(); });
      zf.on('end', () => resolve({ zf, entries }));
      zf.on('error', () => reject(new Error('Zip je poškodený.')));
      zf.readEntry();
    });
  });
}

function extractEntry(zf, entry, dest) {
  return new Promise((resolve, reject) => {
    zf.openReadStream(entry, (err, rs) => {
      if (err) return reject(err);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const ws = fs.createWriteStream(dest);
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
  });
}

// zip sa číta priamo z disku po súboroch, takže nezáleží na jeho veľkosti
async function importZip(zipPath, zipName, userId, nameOverride) {
  const { zf, entries: raw } = await listZip(zipPath);
  try {
    const entries = raw.filter(e => !/\/$/.test(e.fileName))
      .map(e => ({ e, parts: e.fileName.replace(/\\/g, '/').split('/').filter(Boolean) }))
      .filter(x => x.parts.length && !x.parts.includes('__MACOSX') && !x.parts[x.parts.length - 1].startsWith('.'));
    if (!entries.length) throw new Error('Zip je prázdny.');

    const solDirs = new Map();
    for (const x of entries) {
      const file = x.parts[x.parts.length - 1];
      if (x.parts.length < 2) continue;
      if (/\.pdf$/i.test(file) || file.toLowerCase() === cfg.POINTS_FILENAME) {
        solDirs.set(x.parts.slice(0, -1).join('/'), x.parts.slice(0, -1));
      }
    }
    if (!solDirs.size) throw new Error('V zipe som nenašiel žiadne riešenia (priečinky s PDF).');

    const dirs = [...solDirs.values()];
    let common = dirs[0].slice(0, -1);
    for (const d of dirs) {
      let i = 0;
      while (i < common.length && i < d.length - 1 && common[i] === d[i]) i++;
      common = common.slice(0, i);
    }
    const zipBase = String(zipName || 'Uloha').replace(/\.zip$/i, '');
    const rootFolder = common.length ? common[common.length - 1] : zipBase;
    const taskName = (nameOverride || '').trim() || rootFolder;

    const taskId = db.prepare(`INSERT INTO tasks (name, dir, root_folder, comment_text, comment_filename, created_by)
      VALUES (?,?,?,?,?,?)`).run(taskName, '', rootFolder, '', cfg.COMMENT_FILENAME, userId).lastInsertRowid;
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    const root = taskRoot(task);
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(baseDir(task), { recursive: true });

      let commentFilename = cfg.COMMENT_FILENAME, commentText = '';
      for (const x of entries) {
        const rel = x.parts.slice(common.length).map(safeSeg);
        if (!rel.length) continue;
        const dest = path.join(root, ...rel);
        if (!dest.startsWith(root + path.sep)) continue;
        await extractEntry(zf, x.e, dest);
        const f = rel[rel.length - 1];
        if (COMMENT_RE.test(f)) {
          commentFilename = f;
          const t = fs.readFileSync(dest, 'utf8').trim();
          if (t && !commentText) commentText = t;
        }
      }
      db.prepare('UPDATE tasks SET comment_text = ?, comment_filename = ? WHERE id = ?').run(commentText, commentFilename, taskId);

      const sorted = dirs.map(d => d.slice(common.length).join('/'))
        .filter(rel => rel && !rel.includes('/'))
        .sort((a, b) => a.localeCompare(b, 'sk', { numeric: true }));

      const insert = db.prepare(`INSERT INTO solutions (task_id, idx, folder, pdf_name, display_name, rocnik, student_id, manual_points, points, modified)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      db.transaction(() => {
        sorted.forEach((folder, i) => {
          const dir = path.join(root, safeSeg(folder));
          const files = fs.readdirSync(dir);
          const pdfs = files.filter(f => /\.pdf$/i.test(f) && !f.startsWith(cfg.ORIGINAL_PREFIX));
          const pdfName = pdfs[0] || null;
          const hasOriginal = pdfName && files.includes(cfg.ORIGINAL_PREFIX + pdfName);
          const pf = parseFolder(folder);
          const display = titleCase(pdfName ? pdfName.replace(/\.pdf$/i, '') : pf.nameParts) || folder;
          const rocnik = pf.prefix && pf.prefix.length <= 4 ? pf.prefix : '';
          let pts = null;
          const bodyFile = files.find(f => f.toLowerCase() === cfg.POINTS_FILENAME);
          if (bodyFile) {
            const t = fs.readFileSync(path.join(dir, bodyFile), 'utf8').trim().replace(',', '.');
            if (t !== '' && !isNaN(Number(t))) pts = Number(t);
          }
          const solId = insert.run(taskId, i + 1, folder, pdfName, display, rocnik, pf.id, pts, pts, hasOriginal ? 1 : 0).lastInsertRowid;
          if (pdfName) fs.copyFileSync(path.join(dir, pdfName), path.join(baseDir(task), solId + '.pdf'));
        });
      })();
    } catch (e) {
      deleteTask(task);
      throw e;
    }
    return taskId;
  } finally {
    zf.close();
  }
}

function writeComment(task, sol) {
  const dir = solDir(task, sol);
  if (!fs.existsSync(dir)) return;
  writeAtomic(path.join(dir, safeSeg(task.comment_filename)), task.comment_text || '');
}

function writePoints(task, sol, points) {
  const dir = solDir(task, sol);
  const file = path.join(dir, cfg.POINTS_FILENAME);
  if (points === null || points === undefined) {
    if (fs.existsSync(file)) writeAtomic(file, '');
  } else {
    writeAtomic(file, S.formatPoints(points));
  }
}

function getAsset(id) {
  return db.prepare('SELECT mime, data FROM assets WHERE id = ?').get(id);
}

// serializácia zápisov pre jedno riešenie
const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

async function writeSolutionFiles(task, sol, points, correctorName) {
  writePoints(task, sol, points);
  writeComment(task, sol);
  const annotations = JSON.parse(sol.annotations_json || '[]');
  if (!sol.pdf_name) return;
  const base = basePdfPath(task, sol);
  if (!fs.existsSync(base)) return;
  if (!annotations.length && !sol.modified) return;
  const dir = solDir(task, sol);
  const original = path.join(dir, cfg.ORIGINAL_PREFIX + sol.pdf_name);
  if (!fs.existsSync(original)) fs.copyFileSync(base, original);
  const out = await renderPdf(fs.readFileSync(base), annotations, { points, correctorName, getAsset });
  writeAtomic(path.join(dir, sol.pdf_name), out);
}

function saveSolution(solId, data, user) {
  return enqueue(solId, async () => {
    const sol = db.prepare('SELECT * FROM solutions WHERE id = ?').get(solId);
    if (!sol) throw new Error('Riešenie neexistuje.');
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(sol.task_id);
    const rubric = JSON.parse(task.rubric_json || '[]');

    const annotations = Array.isArray(data.annotations) ? data.annotations : JSON.parse(sol.annotations_json);
    const checks = Array.isArray(data.checks) ? data.checks : JSON.parse(sol.checks_json);
    const manual = 'manual_points' in data
      ? (data.manual_points === null || data.manual_points === '' ? null : Number(data.manual_points))
      : sol.manual_points;
    const rocnik = typeof data.rocnik === 'string' ? data.rocnik.trim().slice(0, 10) : sol.rocnik;
    const points = S.computePoints(rubric, checks, manual, task.max_points);
    const modified = sol.modified || annotations.length > 0 ? 1 : 0;

    db.prepare(`UPDATE solutions SET annotations_json=?, checks_json=?, manual_points=?, points=?, rocnik=?,
      modified=?, updated_at=datetime('now'), updated_by=? WHERE id=?`)
      .run(JSON.stringify(annotations), JSON.stringify(checks), manual, points, rocnik, modified, user.id, solId);
    const fresh = db.prepare('SELECT * FROM solutions WHERE id = ?').get(solId);
    await writeSolutionFiles(task, fresh, points, user.name);
    return { points, rocnik };
  });
}

// po zmene rubriky / max bodov / komentára prepočítaj a prepíš súbory všetkých riešení
async function refreshTask(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const rubric = JSON.parse(task.rubric_json || '[]');
  const sols = db.prepare('SELECT * FROM solutions WHERE task_id = ?').all(taskId);
  for (const s of sols) {
    await enqueue(s.id, async () => {
      const sol = db.prepare('SELECT * FROM solutions WHERE id = ?').get(s.id);
      const points = S.computePoints(rubric, JSON.parse(sol.checks_json), sol.manual_points, task.max_points);
      const changed = points !== sol.points;
      if (changed) db.prepare('UPDATE solutions SET points = ? WHERE id = ?').run(points, sol.id);
      const hasStamp = JSON.parse(sol.annotations_json).some(a => a.type === 'stamp');
      if (changed && hasStamp) {
        const u = sol.updated_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(sol.updated_by) : null;
        await writeSolutionFiles(task, sol, points, u ? u.name : '');
      } else {
        if (changed) writePoints(task, sol, points);
        writeComment(task, sol);
      }
    });
  }
}

// zip sa streamuje priamo do odpovede, bez načítania do pamäte
function exportZip(task, out) {
  const archive = archiver('zip', { zlib: { level: 1 } }); // PDF sa už ďalej nekomprimujú
  archive.on('warning', e => console.warn(e));
  archive.on('error', e => out.destroy(e));
  archive.pipe(out);
  archive.glob('**/*', { cwd: taskRoot(task), ignore: ['**/*.tmp-*'], dot: false }, { prefix: task.root_folder });
  return archive.finalize();
}

function deleteTask(task) {
  fs.rmSync(path.join(TASKS_DIR, String(task.id)), { recursive: true, force: true });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
}

module.exports = { importZip, saveSolution, refreshTask, exportZip, deleteTask, basePdfPath, solDir };
