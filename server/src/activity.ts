import type { ActivityAction } from '@opravovator/shared';
import { sql } from './db.js';

/** Zapíše záznam do logu aktivity; chyba logovania nesmie pokaziť samotnú požiadavku. */
export function logActivity(userId: number | null, action: ActivityAction, task?: { id: number; name: string } | null, details = '') {
  sql`INSERT INTO activity_log (user_id, action, task_id, task_name, details)
    VALUES (${userId}, ${action}, ${task?.id ?? null}, ${task?.name ?? null}, ${details})`
    .catch(e => console.error('activity log:', e));
}
