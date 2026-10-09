import { useSyncExternalStore } from 'react';
import type { ServerStatus } from '@opravovator/shared';
import { api } from './api';

/*
 * Stav servera: verzia, čas nasadenia a plánovaný reštart. Zisťuje sa pravidelne
 * (keď je okno viditeľné); pred oznámeným reštartom častejšie.
 */

export interface StatusState {
  status: ServerStatus | null;
  /** posledná požiadavka zlyhala (server nedostupný / reštartuje sa / offline) */
  down: boolean;
}

let state: StatusState = { status: null, down: false };
const listeners = new Set<() => void>();
const set = (s: Partial<StatusState>) => { state = { ...state, ...s }; listeners.forEach(l => l()); };

type Saver = (final: boolean) => Promise<unknown>;
const savers = new Set<Saver>();
/** Otvorený editor sa prihlási, aby ho bolo možné pred reštartom požiadať o uloženie. */
export function registerSaver(fn: Saver) { savers.add(fn); return () => { savers.delete(fn); }; }
/** Ulož všetko teraz (final = tesne pred reštartom, ukonči aj rozpísaný text) a odošli offline frontu. */
export async function saveAll(final: boolean) {
  await Promise.all([...savers].map(f => f(final).catch(() => {})));
  const { flushOutbox } = await import('./offline');
  await flushOutbox().catch(() => {});
}

let timer: ReturnType<typeof setTimeout> | undefined;
export async function refreshStatus() {
  clearTimeout(timer);
  try {
    set({ status: await api<ServerStatus>('/api/status'), down: false });
  } catch {
    set({ down: true });
  }
  const m = state.status?.maintenance;
  const soon = m && Date.parse(m.at) - Date.now() < 3 * 60e3;
  timer = setTimeout(() => { if (document.visibilityState === 'visible') void refreshStatus(); else schedule(); }, soon || state.down ? 5000 : 30000);
}
function schedule() { timer = setTimeout(() => refreshStatus(), 30000); }

export function startStatus() {
  void refreshStatus();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshStatus(); });
  addEventListener('online', () => void refreshStatus());
}

export function useStatus() {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state);
}
