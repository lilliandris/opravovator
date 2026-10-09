import type { PresenceItem } from '@opravovator/shared';
import { logActivity } from './activity.js';
import { sql } from './db.js';

/**
 * Kto má práve otvorenú ktorú úlohu/riešenie. Drží sa len v pamäti servera
 * (stačí jedna inštancia); prehliadač sa ozýva každých pár sekúnd.
 * Príchod a odchod sa zapisuje do logu aktivity (otvoril / zavrel úlohu).
 */
const TTL = 20e3;
type Entry = PresenceItem & { at: number; taskName: string };
const byTask = new Map<number, Map<number, Entry>>();

export function touch(task: { id: number; name: string }, userId: number, name: string, solId: number | null) {
  let m = byTask.get(task.id);
  if (!m) byTask.set(task.id, m = new Map());
  const prev = m.get(userId);
  if (prev && Date.now() - prev.at > TTL) logActivity(userId, 'task_close', task, 'bez odozvy');
  if (!prev || Date.now() - prev.at > TTL) logActivity(userId, 'task_open', task);
  m.set(userId, { user_id: userId, name, sol_id: solId, at: Date.now(), taskName: task.name });
}

export function leave(task: { id: number; name: string }, userId: number) {
  const m = byTask.get(task.id);
  if (m?.delete(userId)) logActivity(userId, 'task_close', task);
}

export function others(taskId: number, userId: number): PresenceItem[] {
  const m = byTask.get(taskId);
  if (!m) return [];
  const now = Date.now();
  const out: PresenceItem[] = [];
  for (const [uid, p] of m) {
    if (now - p.at > TTL) continue;
    if (uid !== userId) out.push({ user_id: p.user_id, name: p.name, sol_id: p.sol_id });
  }
  return out;
}

// kto sa prestal ozývať (zavrel okno, stratil internet), ten úlohu zavrel
setInterval(() => {
  const now = Date.now();
  for (const [taskId, m] of byTask) {
    for (const [uid, p] of m) {
      if (now - p.at <= TTL) continue;
      m.delete(uid);
      logActivity(uid, 'task_close', { id: taskId, name: p.taskName }, 'bez odozvy');
    }
    if (!m.size) byTask.delete(taskId);
  }
}, 10e3).unref();

/** Pri vypnutí servera: všetci, čo mali niečo otvorené, to „zavreli“. */
export async function closeAll() {
  const rows = [...byTask].flatMap(([taskId, m]) => [...m].map(([uid, p]) => ({
    user_id: uid, action: 'task_close', task_id: taskId, task_name: p.taskName, details: 'server sa vypol',
  })));
  byTask.clear();
  if (rows.length) await sql`INSERT INTO activity_log ${sql(rows)}`.catch(e => console.error('activity log:', e));
}
