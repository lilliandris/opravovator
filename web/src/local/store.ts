import { createStore, del, delMany, entries, get, getMany, keys, set, update, type UseStore } from 'idb-keyval';
import type { Annotation, Bias, PageSpec, RubricItem, RubricMode, Scores, SolState } from '@opravovator/shared';

/*
 * Lokálne úložisko v IndexedDB. Lokálne úlohy, riešenia aj obrázky majú záporné id,
 * aby sa nikdy nezrazili so serverovými (kladnými). Súbory zo zipu sú Blob-y, takže
 * prehliadač ich drží na disku, nie v pamäti.
 */

const db = (name: string): UseStore => createStore('opravovator-local-' + name, 'kv');
const S = {
  tasks: db('tasks'),
  sols: db('solutions'),
  files: db('files'),
  versions: db('versions'),
  assets: db('assets'),
  meta: db('meta'),
};

// rubric_mode v starších úlohách chýba (= zaškrtávanie)
export interface TaskSettings { name: string; comment_text: string; max_points: number | null; rubric: RubricItem[]; rubric_mode?: RubricMode }

/** Prepojenie lokálnej úlohy so serverom (po nahratí alebo stiahnutí). */
export interface RemoteLink {
  taskId: number;
  /** lokálne id riešenia → serverové id + posledný spoločný stav (základ na zlúčenie) */
  sols: Record<number, { id: number; baseRev: number; base: SolState }>;
  settingsBase: TaskSettings;
  syncedAt: string;
}

export interface LocalTask extends TaskSettings {
  id: number;
  root_folder: string | null;
  comment_filename: string;
  created_at: string;
  /** posledná zmena nastavení úlohy (zmeny riešení majú vlastné updated_at) */
  updated_at?: string;
  solIds: number[];
  /** relatívne cesty všetkých súborov zo zipu */
  files: string[];
  remote: RemoteLink | null;
}

// bias / bias_comment / pages / scores môžu v starších záznamoch chýbať – čítať cez solState / normBias
export interface LocalSol extends SolState {
  id: number; task_id: number; idx: number; folder: string; pdf_name: string | null; display_name: string;
  student_id: string; had_points_file: boolean; points: number | null; rev: number;
  updated_at: string | null; updated_by: string | null;
  /** názov priečinka v exporte podľa najnovšieho hromadného opravovania (súbory ostávajú vo folder) */ export_folder?: string | null;
}

export interface LocalVersion {
  id: number; rev: number; created_at: string; updated_at: string; user: string | null; user_id: number | null;
  /** počet zmien vo verzii (staršie verzie ho nemajú) */ changes?: number;
  annotations: Annotation[]; checks: string[]; manual_points: number | null; rocnik: string; points: number | null;
  /** interné body (staršie verzie ich nemajú) */ bias?: Bias; bias_comment?: string;
  /** strany a intervalové body (staršie verzie ich nemajú) */ pages?: PageSpec[] | null; scores?: Scores;
}

export interface LocalAsset { id: number; name: string; mime: string; blob: Blob; deleted?: boolean; serverId?: number }

export async function nextId(): Promise<number> {
  let id = -1;
  await update<number>('nextId', v => { id = (v ?? 0) - 1; return id; }, S.meta);
  return id;
}

export const tasks = {
  get: (id: number) => get<LocalTask>(id, S.tasks),
  put: (t: LocalTask) => set(t.id, t, S.tasks),
  all: async () => (await entries<number, LocalTask>(S.tasks)).map(([, t]) => t),
  del: (id: number) => del(id, S.tasks),
};

export const sols = {
  get: (id: number) => get<LocalSol>(id, S.sols),
  many: async (ids: number[]) => (await getMany<LocalSol>(ids, S.sols)).filter(Boolean) as LocalSol[],
  put: (s: LocalSol) => set(s.id, s, S.sols),
  delMany: (ids: number[]) => delMany(ids, S.sols),
};

const fileKey = (taskId: number, rel: string) => `${taskId}:${rel}`;
export const files = {
  get: (taskId: number, rel: string) => get<Blob>(fileKey(taskId, rel), S.files),
  put: (taskId: number, rel: string, b: Blob) => set(fileKey(taskId, rel), b, S.files),
  getKey: (key: string) => get<Blob>(key, S.files),
  putKey: (key: string, b: Blob) => set(key, b, S.files),
  async delTask(taskId: number) {
    const ks = (await keys<string>(S.files)).filter(k => k.startsWith(taskId + ':') || k.startsWith(`thumb:${taskId}:`));
    await delMany(ks, S.files);
  },
};

export const versions = {
  get: async (solId: number) => (await get<LocalVersion[]>(solId, S.versions)) || [],
  put: (solId: number, v: LocalVersion[]) => set(solId, v, S.versions),
  delMany: (ids: number[]) => delMany(ids, S.versions),
};

export const assets = {
  get: (id: number) => get<LocalAsset>(id, S.assets),
  put: (a: LocalAsset) => set(a.id, a, S.assets),
  all: async () => (await entries<number, LocalAsset>(S.assets)).map(([, a]) => a),
};

/** Požiada prehliadač, aby lokálne dáta nemazal pri nedostatku miesta. */
export function persistStorage() {
  navigator.storage?.persist?.().catch(() => {});
}
