import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { cfg } from './config.js';

export const sql = postgres(cfg.DATABASE_URL, {
  max: 10,
  // nečinné spojenia zatvor skôr, než ich zruší uspávajúca sa databáza (Neon po 5 min)
  idle_timeout: 60,
  connect_timeout: 30,
  onnotice: () => {},
  transform: { undefined: null },
});

export type Sql = typeof sql;

/** Aplikuje nové SQL súbory z priečinka migrations v abecednom poradí. */
export async function migrate() {
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(4242)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    const done = new Set((await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map(r => r.name));
    const files = fs.readdirSync(cfg.MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      await tx.unsafe(fs.readFileSync(path.join(cfg.MIGRATIONS_DIR, f), 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${f})`;
      console.log('Migrácia', f);
    }
  });
}

/** Počká na databázu (pri štarte v docker compose môže ešte nabiehať). */
export async function waitForDb(tries = 30) {
  for (let i = 1; ; i++) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (e) {
      if (i >= tries) throw e;
      console.log(`Čakám na databázu (${i}/${tries})…`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
