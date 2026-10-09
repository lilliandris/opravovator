import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const env = process.env;
const list = (v: string | undefined) => (v || '').split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);

export const cfg = {
  PORT: parseInt(env.PORT || '3000', 10),
  HOST: env.HOST || '0.0.0.0',
  DATABASE_URL: env.DATABASE_URL || 'postgres://opravovator:opravovator@localhost:5432/opravovator',
  DATA_DIR: path.resolve(env.DATA_DIR || path.join(root, 'data')),
  WEB_DIR: path.resolve(env.WEB_DIR || path.join(root, 'web', 'dist')),
  FONTS_DIR: path.resolve(env.FONTS_DIR || path.join(root, 'web', 'public', 'fonts')),
  MIGRATIONS_DIR: path.resolve(env.MIGRATIONS_DIR || path.join(root, 'server', 'migrations')),
  // Google OAuth Client ID (typ „Web application“)
  GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID || '',
  // Povolené domény e-mailov oddelené čiarkou, prázdne = hocijaký Google účet
  ALLOWED_DOMAINS: list(env.ALLOWED_DOMAINS),
  // Len na lokálny vývoj/testovanie: prihlásenie bez Google zadaním e-mailu
  DEV_LOGIN: env.DEV_LOGIN === '1',
  // 'auto' = Secure cookie, keď požiadavka prišla cez HTTPS (aj za proxy)
  COOKIE_SECURE: (env.COOKIE_SECURE || 'auto') as 'auto' | '0' | '1',
  SESSION_DAYS: parseInt(env.SESSION_DAYS || '60', 10),
  // limit veľkosti databázy v MB (napr. 512 pre bezplatný Neon), len na zobrazenie v admin paneli; 0 = bez limitu
  DB_LIMIT_MB: parseFloat(env.DB_LIMIT_MB || '0') || 0,
  // tajný kľúč pre deploy skript (oznámenie reštartu bez prihlásenia), prázdne = len admin v prehliadači
  DEPLOY_TOKEN: env.DEPLOY_TOKEN || '',
  POINTS_FILENAME: env.POINTS_FILENAME || 'body.txt',
  COMMENT_FILENAME: env.COMMENT_FILENAME || 'komentar.txt',
  COMMENTED_SUFFIX: '.komentar.pdf',
};

export function emailAllowed(email: string): boolean {
  if (!cfg.ALLOWED_DOMAINS.length) return true;
  const domain = email.toLowerCase().split('@').pop() || '';
  return cfg.ALLOWED_DOMAINS.includes(domain);
}
