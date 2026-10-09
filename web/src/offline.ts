import { useEffect, useState, useSyncExternalStore } from 'react';
import { createStore, del, entries, get, set } from 'idb-keyval';
import type { SaveResult, SolutionSave } from '@opravovator/shared';
import { ApiError, api, isNetworkError } from './api';

/*
 * Offline režim: zmeny, ktoré sa nepodarilo odoslať, čakajú v IndexedDB („outbox“)
 * a odošlú sa hneď, ako je server znova dostupný. Pre každé riešenie sa drží len
 * posledný stav. Server si pri konflikte ponechá aj predchádzajúcu verziu v histórii.
 */

export interface Pending { solId: number; taskId: number; body: SolutionSave; at: number }

const store = createStore('opravovator', 'outbox');
const listeners = new Set<() => void>();
let pendingCount = 0;
const emit = () => listeners.forEach(l => l());

async function recount() {
  pendingCount = (await entries(store)).length;
  emit();
}

export const outbox = {
  get: (solId: number) => get<Pending>(solId, store),
  async put(p: Pending) {
    await set(p.solId, p, store);
    await recount();
  },
  async remove(solId: number, at?: number) {
    const cur = await get<Pending>(solId, store);
    // neodstráň novší stav, ktorý pribudol počas odosielania
    if (cur && (at === undefined || cur.at === at)) await del(solId, store);
    await recount();
  },
};

export function usePendingCount() {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => pendingCount);
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    addEventListener('online', on);
    addEventListener('offline', off);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); };
  }, []);
  return online;
}

type SavedListener = (solId: number, r: SaveResult, sent: SolutionSave) => void;
const savedListeners = new Set<SavedListener>();
/** Dá vedieť (napr. otvorenému editoru), že server prijal zmenu z offline fronty. */
export function onOutboxSaved(l: SavedListener) {
  savedListeners.add(l);
  return () => { savedListeners.delete(l); };
}

let flushing: Promise<void> | null = null;
/** Pokúsi sa odoslať všetky čakajúce zmeny. */
export function flushOutbox(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    for (const [, p] of await entries<number, Pending>(store)) {
      try {
        const r = await api<SaveResult>(`/api/solutions/${p.solId}`, { method: 'PUT', body: p.body });
        await outbox.remove(p.solId, p.at);
        savedListeners.forEach(l => l(p.solId, r, p.body));
      } catch (e) {
        if (isNetworkError(e)) break; // stále offline / server sa reštartuje
        // neprihlásený (vypršalo prihlásenie): zmena ostáva v zariadení a odošle sa po prihlásení
        if (e instanceof ApiError && e.status === 401) break;
        // server zmenu odmietol (riešenie zmazané, bez prístupu) – nemá zmysel skúšať znova
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
          console.error('Offline zmenu sa nepodarilo uložiť', p, e);
          await outbox.remove(p.solId, p.at);
        }
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

export function startOutboxSync() {
  recount();
  addEventListener('online', () => flushOutbox());
  setInterval(() => { if (navigator.onLine) flushOutbox(); }, 20000);
  flushOutbox();
}
