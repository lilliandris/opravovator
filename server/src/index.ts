import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { cfg } from './config.js';
import { migrate, sql, waitForDb } from './db.js';
import { authRoutes, loadUser } from './auth.js';
import { apiRoutes } from './routes.js';
import { adminRoutes } from './admin.js';
import { registerRelease, releaseRoutes } from './release.js';
import { HttpError } from './http.js';
import { closeAll } from './presence.js';

const INF = Number.MAX_SAFE_INTEGER;

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: true,
  // žiadne limity na veľkosť požiadaviek ani na čas nahrávania
  bodyLimit: INF,
  requestTimeout: 0,
  connectionTimeout: 0,
});

await app.register(cookie);
await app.register(multipart, {
  limits: { fileSize: INF, files: INF, fields: INF, fieldSize: INF, parts: INF, headerPairs: INF },
});

app.addHook('onRequest', async req => {
  if (req.url.startsWith('/api/')) await loadUser(req);
});

app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
  if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
  req.log.error(err);
  return reply.status(500).send({ error: 'Chyba servera: ' + (err.message || 'neznáma') });
});

authRoutes(app);
apiRoutes(app);
adminRoutes(app);
releaseRoutes(app);

app.get('/api/health', async () => ({ ok: true }));

// frontend (Vite build) + SPA fallback
if (fs.existsSync(cfg.WEB_DIR)) {
  await app.register(fastifyStatic, {
    root: cfg.WEB_DIR,
    setHeaders(res, file) {
      // súbory s hashom v názve sa môžu cachovať navždy, index a service worker nie
      if (file.includes(`${path.sep}assets${path.sep}`)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
      else res.header('Cache-Control', 'no-cache');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0];
    // chýbajúci súbor (napr. starý JS po aktualizácii) nesmie dostať index.html
    if (pathname.startsWith('/api/') || req.method !== 'GET' || /\.[a-z0-9]+$/i.test(pathname)) {
      return reply.status(404).send({ error: 'Nenájdené.' });
    }
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
} else {
  app.log.warn(`Frontend nie je zostavený (${cfg.WEB_DIR}), beží len API.`);
}

await waitForDb();
await migrate();
await registerRelease();
if (cfg.DEV_LOGIN) app.log.warn('DEV_LOGIN=1 – prihlásenie bez Google je zapnuté. Nepoužívaj na verejnom serveri!');
if (!cfg.GOOGLE_CLIENT_ID && !cfg.DEV_LOGIN) app.log.warn('Chýba GOOGLE_CLIENT_ID – nikto sa nebude môcť prihlásiť.');

await app.listen({ port: cfg.PORT, host: cfg.HOST });

// docker stop / fly deploy / Ctrl+C: nové požiadavky už neprijme, rozbehnuté (ukladanie) dokončí a zavrie databázu.
// Prehliadače, ktorým sa medzitým uloženie nepodarí, si zmenu nechajú v zariadení a pošlú ju po štarte.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    app.log.info(`${sig}, vypínam…`);
    setTimeout(() => process.exit(0), 25000).unref();
    await app.close().catch(() => {});
    await closeAll();
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(0);
  });
}
