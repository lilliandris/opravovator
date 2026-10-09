import {
  countChanges, normRubricMode, safeSeg, same, solState, type Annotation, type SaveResult, type SolState, type SolutionDetail, type TaskDetail,
} from '@opravovator/shared';
import { ApiError, api, uploadWithProgress } from '../api';
import { LocalError, applyRemoteState, importLocalZip, localOriginalZip, updateTask } from './ops';
import { getSession } from './session';
import { assets, files, nextId, sols, tasks, type LocalTask, type RemoteLink, type TaskSettings } from './store';

/*
 * Prepojenie lokálnych úloh so serverom (vyžaduje prihlásenie cez Google):
 *  - nahratie lokálnej úlohy na server,
 *  - stiahnutie úlohy zo servera do zariadenia,
 *  - obojsmerná synchronizácia – zmeny na oboch stranách sa zlúčia (rovnako ako pri súbehu).
 */

export type Progress = (text: string) => void;

const now = () => new Date().toISOString();
const settingsOf = (t: Pick<LocalTask, 'name' | 'comment_text' | 'max_points' | 'rubric' | 'rubric_mode'>): TaskSettings =>
  ({ name: t.name, comment_text: t.comment_text, max_points: t.max_points, rubric: t.rubric, rubric_mode: normRubricMode(t.rubric_mode) });

async function requireServer() {
  const s = await getSession(true);
  if (!s.server) throw new LocalError('Na prácu so serverom sa prihlás cez Google.');
  return s.server;
}

/** Id obrázkov v anotácii (obrázok, obrázkový podpis na pečiatke, aj viac podpisov). */
const annAssets = (a: Annotation): number[] => {
  if (a.type === 'image') return [a.assetId];
  if (a.type !== 'stamp') return [];
  return [a.assetId, ...(a.sigs || []).map(s => s.assetId)].filter((x): x is number => !!x);
};

/** Lokálny obrázok (záporné id) nahrá na server, vráti serverové id. */
async function pushAsset(aid: number): Promise<number> {
  if (aid > 0) return aid;
  const la = await assets.get(aid);
  if (!la) return aid;
  let serverId = la.serverId;
  if (!serverId) {
    const fd = new FormData();
    fd.append('file', la.blob, la.name.replace(/\.[^.]+$/, '') + (la.mime === 'image/jpeg' ? '.jpg' : '.png'));
    serverId = (await api<{ id: number }>('/api/assets', { method: 'POST', body: fd })).id;
    await assets.put({ ...la, serverId });
    await assets.put({ ...la, id: serverId, serverId }); // kópia pod serverovým id, aby sa dala vykresliť
  }
  return serverId;
}

/** Lokálne obrázky (záporné id) nahrá na server a v anotáciách ich nahradí serverovými id. */
async function pushAssets(anns: Annotation[]): Promise<Annotation[]> {
  const out: Annotation[] = [];
  for (const a of anns) {
    if (!annAssets(a).some(id => id < 0)) { out.push(a); continue; }
    const b = { ...a } as Annotation;
    if ((b.type === 'image' || b.type === 'stamp') && b.assetId) b.assetId = await pushAsset(b.assetId);
    if (b.type === 'stamp' && b.sigs) b.sigs = await Promise.all(b.sigs.map(async s => (s.assetId ? { ...s, assetId: await pushAsset(s.assetId) } : s)));
    out.push(b);
  }
  return out;
}

/** Obrázky zo servera, ktoré ešte nie sú v zariadení, stiahne (kvôli offline práci a vypáleniu). */
async function pullAssets(anns: Annotation[]) {
  for (const a of anns) for (const id of annAssets(a)) await cacheServerAsset(id);
}

/** Serverový obrázok uloží do zariadenia (ak tam ešte nie je), aby sa dal použiť v lokálnej úlohe. */
export async function cacheServerAsset(id: number) {
  if (id < 0 || await assets.get(id)) return;
  const res = await fetch(`/api/assets/${id}`, { credentials: 'same-origin' });
  if (!res.ok) return;
  const blob = await res.blob();
  await assets.put({ id, name: 'obrázok', mime: blob.type || 'image/png', blob, deleted: true, serverId: id });
}

/** Nahrá lokálnu úlohu na server ako novú úlohu a prepojí ich. */
export async function uploadTask(localId: number, progress: Progress): Promise<number> {
  await requireServer();
  const t = await tasks.get(localId);
  if (!t) throw new LocalError('Lokálna úloha neexistuje.');
  if (t.remote) throw new LocalError('Úloha už je na serveri, použi Synchronizovať.');

  progress('Balím súbory…');
  const zip = await localOriginalZip(localId);
  const fd = new FormData();
  fd.append('name', t.name);
  fd.append('zip', new File([zip], (t.root_folder || t.name) + '.zip', { type: 'application/zip' }));
  const { id: serverId } = await uploadWithProgress<{ id: number }>('/api/tasks', fd, (l, n) =>
    progress(l < n ? `Nahrávam ${Math.round(l / n * 100)} %` : 'Server rozbaľuje…'));

  await api(`/api/tasks/${serverId}`, { method: 'PUT', body: settingsOf(t) });
  const remote = await api<TaskDetail>(`/api/tasks/${serverId}`);
  const byFolder = new Map(remote.solutions.map(s => [s.folder, s]));
  const link: RemoteLink = { taskId: serverId, sols: {}, settingsBase: settingsOf(t), syncedAt: now() };

  const local = await sols.many(t.solIds);
  for (const [i, ls] of local.entries()) {
    progress(`Posielam opravy ${i + 1}/${local.length}`);
    const rs = byFolder.get(ls.folder);
    if (!rs) continue;
    const st = solState(ls);
    const pushed: SolState = { ...st, annotations: await pushAssets(st.annotations) };
    const r = await api<SaveResult>(`/api/solutions/${rs.id}`, { method: 'PUT', body: { ...pushed, baseRev: rs.rev } });
    if (!same(pushed.annotations, st.annotations)) await sols.put({ ...ls, annotations: pushed.annotations });
    link.sols[ls.id] = { id: rs.id, baseRev: r.rev, base: pushed };
  }
  await tasks.put({ ...(await tasks.get(localId))!, remote: link });
  return serverId;
}

/** Stiahne úlohu zo servera do zariadenia (so všetkými opravami). Ak už v zariadení je, len ju zosynchronizuje. */
export async function downloadTask(serverId: number, progress: Progress): Promise<number> {
  await requireServer();
  const existing = (await tasks.all()).find(t => t.remote?.taskId === serverId);
  if (existing) { await syncTask(existing.id, progress); return existing.id; }

  const remote = await api<TaskDetail>(`/api/tasks/${serverId}`);
  progress('Sťahujem súbory…');
  const res = await fetch(`/api/tasks/${serverId}/original.zip`, { credentials: 'same-origin' });
  if (!res.ok) throw new LocalError('Súbory úlohy sa nepodarilo stiahnuť.');
  const localId = await importLocalZip(await res.blob(), remote.name + '.zip', (d, n) => progress(`Ukladám súbory ${d}/${n}`));

  const settings = settingsOf(remote);
  await updateTask(localId, settings);
  const t = (await tasks.get(localId))!;
  await tasks.put({ ...t, comment_filename: remote.comment_filename });
  const byFolder = new Map((await sols.many(t.solIds)).map(s => [s.folder, s]));
  const link: RemoteLink = { taskId: serverId, sols: {}, settingsBase: settings, syncedAt: now() };

  for (const [i, rs] of remote.solutions.entries()) {
    progress(`Sťahujem opravy ${i + 1}/${remote.solutions.length}`);
    const ls = byFolder.get(rs.folder);
    if (!ls) continue;
    const sd = await api<SolutionDetail>(`/api/solutions/${rs.id}`);
    const st = solState(sd);
    await pullAssets(st.annotations);
    if (!same(st, solState(ls))) await applyRemoteState(ls.id, st, sd.updated_by);
    link.sols[ls.id] = { id: rs.id, baseRev: sd.rev, base: st };
  }
  await tasks.put({ ...(await tasks.get(localId))!, remote: link });
  return localId;
}

export interface SyncStats { pushed: number; pulled: number; merged: number }

/** Obojsmerná synchronizácia prepojenej úlohy. */
export async function syncTask(localId: number, progress: Progress): Promise<SyncStats> {
  await requireServer();
  const t = await tasks.get(localId);
  if (!t?.remote) throw new LocalError('Úloha nie je prepojená so serverom.');
  const link = t.remote;
  let remote: TaskDetail;
  try {
    remote = await api<TaskDetail>(`/api/tasks/${link.taskId}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new LocalError('Úloha na serveri už neexistuje alebo k nej nemáš prístup.');
    throw e;
  }

  // nastavenia úlohy: po poliach – moja zmena vyhrá, inak platí server
  progress('Nastavenia úlohy…');
  // staršie prepojenia nemajú v základe rubric_mode → settingsOf ho doplní (zaškrtávanie)
  const L = settingsOf(t), B = settingsOf(link.settingsBase), R = settingsOf(remote);
  const pick = <K extends keyof TaskSettings>(k: K): TaskSettings[K] => (same(L[k], B[k]) ? R[k] : L[k]);
  const merged: TaskSettings = { name: pick('name'), comment_text: pick('comment_text'), max_points: pick('max_points'), rubric: pick('rubric'), rubric_mode: pick('rubric_mode') };
  if (!same(merged, R)) {
    await api(`/api/tasks/${link.taskId}`, { method: 'PUT', body: merged });
    // nové bodovanie mohlo na serveri prepočítať body (a rev) riešení
    remote = await api<TaskDetail>(`/api/tasks/${link.taskId}`);
  }
  if (!same(merged, L)) await updateTask(localId, merged);
  link.settingsBase = merged;

  const stats: SyncStats = { pushed: 0, pulled: 0, merged: 0 };
  const remoteById = new Map(remote.solutions.map(s => [s.id, s]));
  const entries = Object.entries(link.sols);
  for (const [i, [lid, m]] of entries.entries()) {
    progress(`Riešenie ${i + 1}/${entries.length}`);
    const ls = await sols.get(Number(lid));
    const rItem = remoteById.get(m.id);
    if (!ls || !rItem) continue;
    const st = solState(ls);
    // základ zo staršej verzie nemá nové polia (strany, intervaly) → doplniť, inak by sa rátal ako zmena
    if (!same(st, solState(m.base))) {
      // moje zmeny → server (server ich zlúči s cudzími, ak nejaké sú)
      const pushed: SolState = { ...st, annotations: await pushAssets(st.annotations) };
      const r = await api<SaveResult>(`/api/solutions/${m.id}`, { method: 'PUT', body: { ...pushed, baseRev: m.baseRev, base: m.base } });
      const final = r.merged || pushed;
      if (r.merged) { stats.merged++; await pullAssets(final.annotations); }
      if (!same(final, st)) await applyRemoteState(ls.id, final, r.mergedWith || null);
      link.sols[ls.id] = { id: m.id, baseRev: r.rev, base: final };
      stats.pushed++;
    } else if (rItem.rev !== m.baseRev) {
      // zmeny zo servera → zariadenie
      const sd = await api<SolutionDetail>(`/api/solutions/${m.id}`);
      const rs = solState(sd);
      await pullAssets(rs.annotations);
      if (!same(rs, st)) { await applyRemoteState(ls.id, rs, sd.updated_by); stats.pulled++; }
      link.sols[ls.id] = { id: m.id, baseRev: sd.rev, base: rs };
    }
  }
  // na serveri pribudli dodatočné riešenia → stiahnu sa aj do zariadenia; poradie ako na serveri
  const t2 = (await tasks.get(localId))!;
  const linked = new Map(Object.entries(link.sols).map(([lid, m]) => [m.id, Number(lid)]));
  for (const rs of remote.solutions) {
    const lid = linked.get(rs.id);
    if (lid !== undefined) {
      const ls = await sols.get(lid);
      if (ls && ls.idx !== rs.idx) await sols.put({ ...ls, idx: rs.idx });
      continue;
    }
    progress(`Nové riešenie: ${rs.display_name}`);
    const sd = await api<SolutionDetail>(`/api/solutions/${rs.id}`);
    if (sd.pdf_name) {
      const res = await fetch(`/api/solutions/${rs.id}/pdf`, { credentials: 'same-origin' });
      if (!res.ok) continue;
      const rel = `${safeSeg(sd.folder)}/${sd.pdf_name}`;
      await files.put(localId, rel, await res.blob());
      if (!t2.files.includes(rel)) t2.files.push(rel);
    }
    const st = solState(sd);
    await pullAssets(st.annotations);
    const id = await nextId();
    await sols.put({
      id, task_id: localId, idx: rs.idx, folder: sd.folder, pdf_name: sd.pdf_name, display_name: sd.display_name, student_id: sd.student_id,
      had_points_file: false, ...st, points: sd.points, rev: 0, updated_at: sd.updated_at, updated_by: sd.updated_by,
    });
    t2.solIds.push(id);
    link.sols[id] = { id: rs.id, baseRev: sd.rev, base: st };
    stats.pulled++;
  }
  link.syncedAt = now();
  await tasks.put({ ...t2, remote: link });
  return stats;
}

export interface Unsynced { changes: number; solutions: number }

/**
 * Koľko zmien je v zariadení oproti poslednej synchronizácii so serverom. Ráta sa každá
 * zmena objektu (aj len oprava textu), nie len pridané objekty; plus zmeny nastavení úlohy.
 */
export async function unsyncedCount(localId: number): Promise<Unsynced> {
  const out: Unsynced = { changes: 0, solutions: 0 };
  const t = await tasks.get(localId);
  if (!t?.remote) return out;
  for (const [lid, m] of Object.entries(t.remote.sols)) {
    const ls = await sols.get(Number(lid));
    if (!ls) continue;
    const n = countChanges(solState(m.base), solState(ls));
    if (n) { out.changes += n; out.solutions++; }
  }
  const L = settingsOf(t), B = settingsOf(t.remote.settingsBase);
  for (const k of ['name', 'comment_text', 'max_points', 'rubric', 'rubric_mode'] as const) if (!same(L[k], B[k])) out.changes++;
  return out;
}
