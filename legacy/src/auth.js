const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const cfg = require('./config');

const COOKIE = 'opr_session';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// min. 8 znakov, malé aj veľké písmeno, číslica a špeciálny znak
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Heslo musí mať aspoň 8 znakov.';
  if (!/[a-z]/.test(pw)) return 'Heslo musí obsahovať malé písmeno.';
  if (!/[A-Z]/.test(pw)) return 'Heslo musí obsahovať veľké písmeno.';
  if (!/[0-9]/.test(pw)) return 'Heslo musí obsahovať číslicu.';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Heslo musí obsahovať špeciálny znak.';
  return null;
}
function emailAllowed(email) {
  return typeof email === 'string' &&
    /^[^\s@]+@[^\s@]+$/.test(email) &&
    email.toLowerCase().endsWith('@' + cfg.ALLOWED_DOMAIN);
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + cfg.SESSION_DAYS * 86400e3;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: cfg.COOKIE_SECURE,
    maxAge: cfg.SESSION_DAYS * 86400e3, path: '/',
  });
}

function loadUser(req, _res, next) {
  const token = parseCookies(req)[COOKIE];
  req.user = null;
  if (token) {
    const row = db.prepare(`SELECT u.id, u.email, u.name, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
    if (row && row.expires_at > Date.now()) {
      req.user = { id: row.id, email: row.email, name: row.name };
      req.sessionToken = token;
    } else if (row) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }
  }
  next();
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Nie si prihlásený.' });
  return res.redirect('/login.html');
}

// jednoduchý rate-limit pre login/register
const attempts = new Map();
function rateLimited(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter(t => now - t < 15 * 60e3);
  list.push(now);
  attempts.set(key, list);
  return list.length > 20;
}

const router = express.Router();

router.get('/config', (_req, res) => {
  res.json({ googleClientId: cfg.GOOGLE_CLIENT_ID || null, domain: cfg.ALLOWED_DOMAIN });
});

router.post('/register', (req, res) => {
  if (rateLimited('r:' + req.ip)) return res.status(429).json({ error: 'Priveľa pokusov, skús neskôr.' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();
  const password = req.body.password;
  if (!emailAllowed(email)) return res.status(400).json({ error: `Použi e-mail @${cfg.ALLOWED_DOMAIN}.` });
  if (!name) return res.status(400).json({ error: 'Zadaj meno (zobrazuje sa pri bodoch).' });
  const prob = passwordProblem(password);
  if (prob) return res.status(400).json({ error: prob });
  const existing = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  if (existing && existing.password_hash) return res.status(409).json({ error: 'Účet s týmto e-mailom už existuje.' });
  if (existing) {
    // účet vznikol cez Google, dovoľ nastaviť heslo len prihlásenému vlastníkovi
    return res.status(409).json({ error: 'Účet existuje cez Google. Prihlás sa cez Google.' });
  }
  const info = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)')
    .run(email, name, hashPassword(password));
  createSession(res, info.lastInsertRowid);
  res.json({ ok: true });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (rateLimited('l:' + req.ip) || rateLimited('e:' + email)) return res.status(429).json({ error: 'Priveľa pokusov, skús neskôr.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Nesprávny e-mail alebo heslo.' });
  }
  createSession(res, user.id);
  res.json({ ok: true });
});

router.post('/google', async (req, res) => {
  if (!cfg.GOOGLE_CLIENT_ID) return res.status(400).json({ error: 'Google prihlásenie nie je nastavené.' });
  try {
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(cfg.GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken: req.body.credential, audience: cfg.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    const email = String(p.email || '').toLowerCase();
    if (!p.email_verified || !emailAllowed(email)) {
      return res.status(403).json({ error: `Prihlásiť sa dá len účtom @${cfg.ALLOWED_DOMAIN}.` });
    }
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      const info = db.prepare('INSERT INTO users (email, name, google_sub) VALUES (?,?,?)')
        .run(email, p.given_name || p.name || email.split('@')[0], p.sub);
      user = { id: info.lastInsertRowid };
    } else if (!user.google_sub) {
      db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(p.sub, user.id);
    }
    createSession(res, user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(401).json({ error: 'Google token sa nepodarilo overiť.' });
  }
});

router.post('/logout', (req, res) => {
  if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Nie si prihlásený.' });
  res.json(req.user);
});

router.put('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Nie si prihlásený.' });
  const name = String(req.body.name || '').trim();
  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  if (req.body.password) {
    const prob = passwordProblem(req.body.password);
    if (prob) return res.status(400).json({ error: prob });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), req.user.id);
  }
  res.json({ ok: true });
});

module.exports = { router, loadUser, requireUser, passwordProblem, emailAllowed };
