import type { User } from '@opravovator/shared';
import { ApiError, api, isNetworkError } from '../api';

/*
 * Lokálny režim: dá sa pracovať úplne bez účtu (všetko v prehliadači). Server a Google
 * účet sú potrebné len na nahratie / synchronizáciu úloh. Lokálny „používateľ“ má id 0.
 */

const LOCAL_KEY = 'opravovator-local';
const PROFILE_KEY = 'opravovator-local-profile';

export const LOCAL_USER_ID = 0;

export function localEnabled() {
  try { return localStorage.getItem(LOCAL_KEY) === '1'; } catch { return false; }
}
export function enableLocal(on = true) {
  try { if (on) localStorage.setItem(LOCAL_KEY, '1'); else localStorage.removeItem(LOCAL_KEY); } catch { /* */ }
}

function localProfile(): User {
  let p: Partial<User> = {};
  try { p = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); } catch { /* */ }
  return {
    id: LOCAL_USER_ID, email: '', name: p.name || 'Opravovateľ', picture: null,
    stamp_name: p.stamp_name ?? null, stamp_font: p.stamp_font ?? null, accent: p.accent ?? null,
    pen_color: p.pen_color ?? null, stamp_image: p.stamp_image ?? null, stamp_image_scale: p.stamp_image_scale ?? null,
    stamp_color: p.stamp_color ?? null, stamp_pos: p.stamp_pos ?? null,
    stamp_points_font: p.stamp_points_font ?? null, stamp_points_color: p.stamp_points_color ?? null, stamp_points_size: p.stamp_points_size ?? null,
  };
}

export interface Session {
  /** prihlásený používateľ na serveri, alebo null */
  server: User | null;
  /** kto opravuje (server, inak lokálny profil) */
  me: User;
}

let cached: Promise<Session> | null = null;

/** Zistí, či je používateľ prihlásený na serveri; výsledok sa drží počas načítania stránky. */
export function getSession(refresh = false): Promise<Session> {
  if (!cached || refresh) {
    cached = api<User>('/api/me')
      .then(u => ({ server: u, me: u }))
      .catch(e => {
        if (!(e instanceof ApiError && e.status === 401) && !isNetworkError(e)) throw e;
        return { server: null, me: localProfile() };
      });
  }
  return cached;
}

/** Uloží profil – na server, alebo lokálne (bez účtu). */
type ProfilePatch = Partial<Pick<User, 'name' | 'stamp_name' | 'stamp_font' | 'accent' | 'pen_color' | 'stamp_image' | 'stamp_image_scale' | 'stamp_color' | 'stamp_pos'
  | 'stamp_points_font' | 'stamp_points_color' | 'stamp_points_size'>>;
export async function saveMe(patch: ProfilePatch): Promise<User> {
  const s = await getSession();
  if (s.server) {
    const u = await api<User>('/api/me', { method: 'PUT', body: patch });
    cached = Promise.resolve({ server: u, me: u });
    return u;
  }
  const u = { ...localProfile(), ...patch };
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({
      name: u.name, stamp_name: u.stamp_name, stamp_font: u.stamp_font, accent: u.accent, pen_color: u.pen_color,
      stamp_image: u.stamp_image, stamp_image_scale: u.stamp_image_scale, stamp_color: u.stamp_color, stamp_pos: u.stamp_pos,
      stamp_points_font: u.stamp_points_font, stamp_points_color: u.stamp_points_color, stamp_points_size: u.stamp_points_size,
    }));
  } catch { /* */ }
  cached = Promise.resolve({ server: null, me: u });
  return u;
}
