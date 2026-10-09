import type { SolutionSave } from '@opravovator/shared';
import {
  deleteLocalTask, listVersions, restoreLocalVersion, saveLocalSolution, solutionDetail, taskDetail, updateTask,
} from './ops';
import { getSession } from './session';
import { versions } from './store';

/** Lokálne úlohy a riešenia majú záporné id – tieto volania nejdú na server. */
export const isLocalUrl = (url: string) => /^\/api\/(tasks|solutions)\/-\d+(\/|$|\?)/.test(url);

/** Rovnaké API ako server, ale nad úložiskom v prehliadači. */
export async function localRequest(method: string, url: string, body: unknown): Promise<unknown> {
  const path = url.split('?')[0];
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/api\/tasks\/(-\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'GET') return taskDetail(id);
    if (method === 'PUT') return updateTask(id, body as never);
    if (method === 'DELETE') { await deleteLocalTask(id); return { ok: true }; }
  }
  if (path.match(/^\/api\/tasks\/-\d+\/presence$/)) return { others: [], rev: null };
  if ((m = path.match(/^\/api\/solutions\/(-\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'GET') return solutionDetail(id);
    if (method === 'PUT') return saveLocalSolution(id, (body || {}) as SolutionSave, (await getSession()).me);
  }
  if ((m = path.match(/^\/api\/solutions\/(-\d+)\/versions$/))) return listVersions(Number(m[1]));
  if ((m = path.match(/^\/api\/solutions\/(-\d+)\/versions\/(\d+)$/))) {
    const v = (await versions.get(Number(m[1]))).find(x => x.id === Number(m![2]));
    if (!v) throw new Error('Verzia neexistuje.');
    return v;
  }
  if ((m = path.match(/^\/api\/solutions\/(-\d+)\/versions\/(\d+)\/restore$/))) {
    return restoreLocalVersion(Number(m[1]), Number(m[2]), (await getSession()).me);
  }
  throw new Error(`Lokálne nepodporované: ${method} ${path}`);
}
