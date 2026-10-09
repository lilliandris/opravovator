const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cfg = require('./config');
const db = require('./db');
const auth = require('./auth');
const storage = require('./storage');
const fonts = require('./fonts');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20mb' }));
app.use(auth.loadUser);

const PUB = path.join(__dirname, '..', 'public');
const TMP = path.join(cfg.DATA_DIR, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const upload = multer({ dest: TMP, limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024 } });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use('/api/auth', auth.router);

// chránené stránky
app.get(['/', '/index.html'], auth.requireUser, (_q, r) => r.sendFile(path.join(PUB, 'index.html')));
app.get('/editor.html', auth.requireUser, (_q, r) => r.sendFile(path.join(PUB, 'editor.html')));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build')));
app.use(express.static(PUB, { index: false }));

const api = express.Router();
api.use(auth.requireUser);

api.get('/fonts', (_q, res) => res.json(fonts.publicList()));

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}
function taskOut(t) {
  return {
    id: t.id, name: t.name, root_folder: t.root_folder, comment_text: t.comment_text,
    comment_filename: t.comment_filename, max_points: t.max_points,
    rubric: JSON.parse(t.rubric_json || '[]'), created_at: t.created_at,
  };
}

api.get('/tasks', (_q, res) => {
  const rows = db.prepare(`SELECT t.*, u.name AS creator,
      (SELECT COUNT(*) FROM solutions s WHERE s.task_id = t.id) AS total,
      (SELECT COUNT(*) FROM solutions s WHERE s.task_id = t.id AND s.points IS NOT NULL) AS graded
    FROM tasks t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.id DESC`).all();
  res.json(rows.map(r => ({ ...taskOut(r), creator: r.creator, total: r.total, graded: r.graded })));
});

api.post('/tasks', upload.single('zip'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chýba zip.' });
  let id;
  try {
    id = await storage.importZip(req.file.path, req.file.originalname, req.user.id, req.body.name);
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Zip sa nepodarilo načítať.' });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
  await storage.refreshTask(id); // doplní komentáre do všetkých priečinkov
  res.json({ id });
}));

api.get('/tasks/:id', (req, res) => {
  const t = getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'Úloha neexistuje.' });
  const sols = db.prepare(`SELECT id, idx, folder, pdf_name, display_name, rocnik, student_id, points, modified,
      (annotations_json != '[]') AS annotated, updated_at FROM solutions WHERE task_id = ? ORDER BY idx`).all(t.id);
  res.json({ ...taskOut(t), solutions: sols });
});

api.put('/tasks/:id', wrap(async (req, res) => {
  const t = getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'Úloha neexistuje.' });
  const b = req.body;
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : t.name;
  const comment = typeof b.comment_text === 'string' ? b.comment_text : t.comment_text;
  const max = 'max_points' in b ? (b.max_points === null || b.max_points === '' ? null : Number(b.max_points)) : t.max_points;
  let rubric = JSON.parse(t.rubric_json);
  if (Array.isArray(b.rubric)) {
    rubric = b.rubric.map(i => ({
      id: String(i.id || Math.random().toString(36).slice(2, 10)).slice(0, 40),
      label: String(i.label || '').slice(0, 200),
      points: Number(i.points) || 0,
    }));
  }
  db.prepare('UPDATE tasks SET name=?, comment_text=?, max_points=?, rubric_json=? WHERE id=?')
    .run(name, comment, max, JSON.stringify(rubric), t.id);
  await storage.refreshTask(t.id);
  res.json(taskOut(getTask(t.id)));
}));

api.delete('/tasks/:id', (req, res) => {
  const t = getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'Úloha neexistuje.' });
  storage.deleteTask(t);
  res.json({ ok: true });
});

api.get('/tasks/:id/download', wrap(async (req, res) => {
  const t = getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'Úloha neexistuje.' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(t.root_folder)}.zip`);
  await storage.exportZip(t, res);
}));

function getSol(id) { return db.prepare('SELECT * FROM solutions WHERE id = ?').get(id); }

api.get('/solutions/:id', (req, res) => {
  const s = getSol(req.params.id);
  if (!s) return res.status(404).json({ error: 'Riešenie neexistuje.' });
  const u = s.updated_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(s.updated_by) : null;
  res.json({
    id: s.id, task_id: s.task_id, idx: s.idx, folder: s.folder, pdf_name: s.pdf_name,
    display_name: s.display_name, rocnik: s.rocnik, student_id: s.student_id,
    annotations: JSON.parse(s.annotations_json), checks: JSON.parse(s.checks_json),
    manual_points: s.manual_points, points: s.points, updated_at: s.updated_at, updated_by: u ? u.name : null,
  });
});

// podkladové (neupravené) PDF, na ktoré editor kreslí
api.get('/solutions/:id/pdf', (req, res) => {
  const s = getSol(req.params.id);
  if (!s) return res.status(404).end();
  const t = getTask(s.task_id);
  const file = req.query.variant === 'result' && s.pdf_name
    ? path.join(storage.solDir(t, s), s.pdf_name)
    : storage.basePdfPath(t, s);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'PDF chýba.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file);
});

api.put('/solutions/:id', wrap(async (req, res) => {
  if (!getSol(req.params.id)) return res.status(404).json({ error: 'Riešenie neexistuje.' });
  const out = await storage.saveSolution(Number(req.params.id), req.body || {}, req.user);
  res.json({ ok: true, ...out });
}));

// obrázky (podpisy) – každý používateľ má svoju knižnicu
api.get('/assets', (req, res) => {
  res.json(db.prepare('SELECT id, name FROM assets WHERE user_id = ? ORDER BY id DESC').all(req.user.id));
});
api.post('/assets', (req, res) => {
  const m = /^data:(image\/(png|jpeg));base64,(.+)$/.exec(req.body.dataUrl || '');
  if (!m) return res.status(400).json({ error: 'Podporované sú PNG a JPEG.' });
  const data = Buffer.from(m[3], 'base64');
  if (data.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Obrázok je väčší ako 5 MB.' });
  const id = db.prepare('INSERT INTO assets (user_id, name, mime, data) VALUES (?,?,?,?)')
    .run(req.user.id, String(req.body.name || 'obrázok').slice(0, 100), m[1], data).lastInsertRowid;
  res.json({ id });
});
api.get('/assets/:id', (req, res) => {
  const a = db.prepare('SELECT mime, data FROM assets WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).end();
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(a.data);
});
api.delete('/assets/:id', (req, res) => {
  db.prepare('DELETE FROM assets WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.use('/api', api);

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `Zip je väčší ako povolený limit ${cfg.MAX_UPLOAD_MB} MB (zvýš MAX_UPLOAD_MB).`
      : `Chyba pri nahrávaní (${err.code}).`;
    return res.status(413).json({ error: msg });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Neplatné dáta.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Požiadavka je príliš veľká.' });
  res.status(500).json({ error: 'Chyba servera: ' + (err.message || 'neznáma') });
});

app.listen(cfg.PORT, () => console.log(`Opravovač beží na http://localhost:${cfg.PORT}`));
