import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { APP_VERSION, CHANGELOG, type Maintenance, type ReleaseInfo, type ServerStatus } from '@opravovator/shared';
import { isAdminUser, requireUser } from './auth.js';
import { logActivity } from './activity.js';
import { cfg } from './config.js';
import { sql } from './db.js';
import { HttpError } from './http.js';

/*
 * Aktualizácie bez straty dát:
 *  - pred reštartom admin (alebo deploy skript s DEPLOY_TOKEN) oznámi reštart o N minút,
 *  - prehliadače online ľudí to zistia z /api/status (pýtajú sa pravidelne), ukážu odpočet a samy uložia zmeny,
 *  - čo sa počas reštartu nepodarí odoslať, počká v zariadení (offline fronta) a odošle sa po spustení,
 *  - po štarte novej verzie sa zapíše čas nasadenia a ľuďom sa ukáže tlačidlo „Aktualizácia“ so zoznamom zmien.
 * Oznámenie je len v pamäti – reštart ho sám zruší.
 */

let maintenance: Maintenance | null = null;
/** kto mal naposledy otvorenú appku (ozýva sa cez /api/status) */
const seen = new Map<number, { name: string; at: number }>();
const ONLINE_MS = 90e3;

/** Zapíše čas nasadenia tejto verzie (pri prvom štarte). */
export async function registerRelease() {
  await sql`INSERT INTO releases (version) VALUES (${APP_VERSION}) ON CONFLICT DO NOTHING`;
}

async function deployedAt(): Promise<Date | null> {
  const [r] = await sql<{ deployed_at: Date }[]>`SELECT deployed_at FROM releases WHERE version = ${APP_VERSION}`;
  return r ? r.deployed_at : null;
}

/** Admin v prehliadači, alebo deploy skript s hlavičkou `Authorization: Bearer <DEPLOY_TOKEN>`. */
function requireDeployer(req: FastifyRequest) {
  const auth = String(req.headers.authorization || '');
  if (cfg.DEPLOY_TOKEN && auth.startsWith('Bearer ')) {
    const a = Buffer.from(auth.slice(7)), b = Buffer.from(cfg.DEPLOY_TOKEN);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return null;
    throw new HttpError(403, 'Nesprávny DEPLOY_TOKEN.');
  }
  const u = requireUser(req);
  if (!isAdminUser(u)) throw new HttpError(403, 'Nemáš prístup.');
  return u;
}

const online = () => {
  const now = Date.now();
  return [...seen.values()].filter(x => now - x.at < ONLINE_MS).map(x => x.name).sort((a, b) => a.localeCompare(b, 'sk'));
};

export function releaseRoutes(app: FastifyInstance) {
  app.get('/api/status', async req => {
    // oznámenie, po ktorom sa reštart neudial (zrušený / zlyhaný deploy), po 15 minútach zmizne
    if (maintenance && Date.parse(maintenance.at) < Date.now() - 15 * 60e3) maintenance = null;
    const at = await deployedAt();
    let update = false;
    if (req.user) {
      seen.set(req.user.id, { name: req.user.name, at: Date.now() });
      if (at && req.sessionToken) {
        const [x] = await sql<{ show: boolean }[]>`
          SELECT (s.created_at < ${at} AND (u.changelog_seen_at IS NULL OR u.changelog_seen_at < ${at})) AS show
          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ${req.sessionToken}`;
        update = !!x?.show;
      }
    }
    const out: ServerStatus = { version: APP_VERSION, deployed_at: at ? at.toISOString() : null, maintenance, update };
    return out;
  });

  app.get('/api/changelog', async () => {
    const rows = await sql<{ version: string; deployed_at: Date }[]>`SELECT version, deployed_at FROM releases`;
    const at = new Map(rows.map(r => [r.version, r.deployed_at.toISOString()]));
    // len nasadené verzie (staršie ako záznamy v tabuľke sa ukážu bez času)
    return CHANGELOG.map((r): ReleaseInfo => ({ ...r, deployed_at: at.get(r.version) || null }));
  });

  app.post('/api/changelog/seen', async req => {
    const u = requireUser(req);
    await sql`UPDATE users SET changelog_seen_at = now() WHERE id = ${u.id}`;
    return { ok: true };
  });

  // oznámenie reštartu: { minutes, message? }; minutes 0 = hneď
  app.post<{ Body: { minutes?: number; message?: string } }>('/api/admin/maintenance', async req => {
    const u = requireDeployer(req);
    const minutes = Math.max(0, Math.min(120, Number(req.body?.minutes ?? 5) || 0));
    const message = String(req.body?.message || '').trim().slice(0, 300);
    maintenance = { at: new Date(Date.now() + minutes * 60e3).toISOString(), message };
    if (u) logActivity(u.id, 'admin_maintenance', null, `o ${minutes} min${message ? ': ' + message : ''}`);
    req.log.warn(`Oznámený reštart o ${minutes} min`);
    return { ok: true, maintenance, online: online() };
  });

  app.delete('/api/admin/maintenance', async req => {
    const u = requireDeployer(req);
    maintenance = null;
    if (u) logActivity(u.id, 'admin_maintenance', null, 'zrušené');
    return { ok: true };
  });

  // pre deploy skript / admin: kto je práve online a či je oznámený reštart
  app.get('/api/admin/maintenance', async req => {
    requireDeployer(req);
    return { maintenance, online: online() };
  });
}
