import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { ACCENTS, FONTS, clampImgScale, isHexColor, isSigPos, type SigPos, type User } from '@opravovator/shared';
import { cfg, emailAllowed } from './config.js';
import { sql } from './db.js';
import { HttpError } from './http.js';
import { logActivity } from './activity.js';

const COOKIE = 'opravovator_session';

declare module 'fastify' {
  interface FastifyRequest { user: User | null; sessionToken: string | null }
}

async function createSession(req: FastifyRequest, reply: FastifyReply, userId: number) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + cfg.SESSION_DAYS * 86400e3);
  await sql`INSERT INTO sessions (token, user_id, expires_at) VALUES (${token}, ${userId}, ${expires})`;
  const secure = cfg.COOKIE_SECURE === 'auto' ? req.protocol === 'https' : cfg.COOKIE_SECURE === '1';
  reply.setCookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: cfg.SESSION_DAYS * 86400,
  });
}

/** Nájde alebo vytvorí používateľa podľa e-mailu. */
async function upsertUser(email: string, name: string, googleSub: string | null, picture: string | null): Promise<number> {
  const [u] = await sql<{ id: number }[]>`
    INSERT INTO users (email, name, google_sub, picture, last_login_at) VALUES (${email}, ${name}, ${googleSub}, ${picture}, now())
    ON CONFLICT (email) DO UPDATE SET
      google_sub = COALESCE(users.google_sub, EXCLUDED.google_sub),
      picture = COALESCE(EXCLUDED.picture, users.picture),
      last_login_at = now()
    RETURNING id`;
  logActivity(u.id, 'login', null, googleSub ? 'Google' : 'DEV_LOGIN');
  return u.id;
}

// admini sa zisťujú pri načítaní používateľa; do /api/me sa táto informácia nedostane
const adminUsers = new WeakSet<User>();
export const isAdminUser = (u: User) => adminUsers.has(u);

export function requireAdmin(req: FastifyRequest): User {
  const u = requireUser(req);
  if (!isAdminUser(u)) throw new HttpError(403, 'Nemáš prístup.');
  return u;
}

export async function loadUser(req: FastifyRequest) {
  req.user = null;
  req.sessionToken = null;
  const token = req.cookies[COOKIE];
  if (!token) return;
  const [row] = await sql<(User & { expires_at: Date; is_admin: boolean })[]>`
    SELECT u.id, u.email, u.name, u.picture, u.stamp_name, u.stamp_font, u.accent, u.pen_color, u.stamp_image, u.stamp_image_scale, u.stamp_color, u.stamp_pos, u.stamp_points_font, u.stamp_points_color, u.stamp_points_size, s.expires_at,
      EXISTS (SELECT 1 FROM admins a WHERE a.email = u.email) AS is_admin FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token = ${token}`;
  if (!row) return;
  if (row.expires_at.getTime() < Date.now()) {
    await sql`DELETE FROM sessions WHERE token = ${token}`;
    return;
  }
  req.user = { id: row.id, email: row.email, name: row.name, picture: row.picture, stamp_name: row.stamp_name, stamp_font: row.stamp_font, accent: row.accent, pen_color: row.pen_color, stamp_image: row.stamp_image, stamp_image_scale: row.stamp_image_scale, stamp_color: row.stamp_color, stamp_pos: isSigPos(row.stamp_pos) ? row.stamp_pos : null,
    stamp_points_font: row.stamp_points_font, stamp_points_color: row.stamp_points_color, stamp_points_size: row.stamp_points_size };
  if (row.is_admin) adminUsers.add(req.user);
  req.sessionToken = token;
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, 'Nie si prihlásený.');
  return req.user;
}

export function authRoutes(app: FastifyInstance) {
  const google = cfg.GOOGLE_CLIENT_ID ? new OAuth2Client(cfg.GOOGLE_CLIENT_ID) : null;

  app.get('/api/auth/config', async () => ({
    googleClientId: cfg.GOOGLE_CLIENT_ID || null,
    domains: cfg.ALLOWED_DOMAINS,
    devLogin: cfg.DEV_LOGIN,
  }));

  app.post<{ Body: { credential?: string } }>('/api/auth/google', async (req, reply) => {
    if (!google) throw new HttpError(400, 'Google prihlásenie nie je nastavené (chýba GOOGLE_CLIENT_ID).');
    let p;
    try {
      const ticket = await google.verifyIdToken({ idToken: String(req.body?.credential || ''), audience: cfg.GOOGLE_CLIENT_ID });
      p = ticket.getPayload();
    } catch {
      throw new HttpError(401, 'Google token sa nepodarilo overiť.');
    }
    const email = String(p?.email || '').toLowerCase();
    if (!p || !p.email_verified || !email) throw new HttpError(403, 'Google účet nemá overený e-mail.');
    if (!emailAllowed(email)) {
      throw new HttpError(403, `Prihlásiť sa dá len účtom z domén: ${cfg.ALLOWED_DOMAINS.map(d => '@' + d).join(', ')}.`);
    }
    const id = await upsertUser(email, p.given_name || p.name || email.split('@')[0], p.sub, p.picture || null);
    await createSession(req, reply, id);
    return { ok: true };
  });

  app.post<{ Body: { email?: string; name?: string } }>('/api/auth/dev', async (req, reply) => {
    if (!cfg.DEV_LOGIN) throw new HttpError(404, 'Nenájdené.');
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'Zadaj e-mail.');
    if (!emailAllowed(email)) throw new HttpError(403, 'Táto doména nie je povolená.');
    const id = await upsertUser(email, String(req.body?.name || '').trim() || email.split('@')[0], null, null);
    await createSession(req, reply, id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.sessionToken) await sql`DELETE FROM sessions WHERE token = ${req.sessionToken}`;
    if (req.user) logActivity(req.user.id, 'logout');
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async req => requireUser(req));

  app.put<{ Body: { name?: string; stamp_name?: string | null; stamp_font?: string | null; accent?: string | null; pen_color?: string | null; stamp_image?: number | null; stamp_image_scale?: number | null; stamp_color?: string | null; stamp_pos?: SigPos | null;
    stamp_points_font?: string | null; stamp_points_color?: string | null; stamp_points_size?: number | null; } }>('/api/me', async req => {
    const u = requireUser(req);
    const b = req.body || {};
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 100) : u.name;
    if (!name) throw new HttpError(400, 'Meno nemôže byť prázdne.');
    const stampName = 'stamp_name' in b ? (String(b.stamp_name ?? '').trim().slice(0, 100) || null) : u.stamp_name;
    const stampFont = 'stamp_font' in b ? (FONTS.some(f => f.id === b.stamp_font) ? String(b.stamp_font) : null) : u.stamp_font;
    const accent = 'accent' in b ? (ACCENTS.some(a => a.id === b.accent) ? String(b.accent) : null) : u.accent;
    const penColor = 'pen_color' in b ? (isHexColor(b.pen_color) ? b.pen_color.toLowerCase() : null) : u.pen_color;
    let stampImage = u.stamp_image;
    if ('stamp_image' in b) {
      // len vlastný obrázok z knižnice
      const id = Number(b.stamp_image);
      const [a] = Number.isInteger(id) && id > 0
        ? await sql`SELECT id FROM assets WHERE id = ${id} AND user_id = ${u.id} AND NOT deleted` : [];
      stampImage = a ? id : null;
    }
    const imgScale = 'stamp_image_scale' in b ? (b.stamp_image_scale == null ? null : clampImgScale(b.stamp_image_scale)) : u.stamp_image_scale;
    const stampColor = 'stamp_color' in b ? (isHexColor(b.stamp_color) ? b.stamp_color.toLowerCase() : null) : u.stamp_color;
    const stampPos = 'stamp_pos' in b ? (isSigPos(b.stamp_pos) && b.stamp_pos !== 'below' ? b.stamp_pos : null) : u.stamp_pos;
    const ptsFont = 'stamp_points_font' in b ? (FONTS.some(f => f.id === b.stamp_points_font) ? String(b.stamp_points_font) : null) : u.stamp_points_font;
    const ptsColor = 'stamp_points_color' in b ? (isHexColor(b.stamp_points_color) ? b.stamp_points_color.toLowerCase() : null) : u.stamp_points_color;
    const ptsSize = 'stamp_points_size' in b ? (Number(b.stamp_points_size) >= 6 && Number(b.stamp_points_size) <= 400 ? Number(b.stamp_points_size) : null) : u.stamp_points_size;
    await sql`UPDATE users SET name = ${name}, stamp_name = ${stampName}, stamp_font = ${stampFont}, accent = ${accent},
      pen_color = ${penColor}, stamp_image = ${stampImage}, stamp_image_scale = ${imgScale}, stamp_color = ${stampColor}, stamp_pos = ${stampPos},
      stamp_points_font = ${ptsFont}, stamp_points_color = ${ptsColor}, stamp_points_size = ${ptsSize} WHERE id = ${u.id}`;
    return {
      ...u, name, stamp_name: stampName, stamp_font: stampFont, accent, pen_color: penColor, stamp_image: stampImage, stamp_image_scale: imgScale,
      stamp_color: stampColor, stamp_pos: stampPos, stamp_points_font: ptsFont, stamp_points_color: ptsColor, stamp_points_size: ptsSize,
    };
  });
}
