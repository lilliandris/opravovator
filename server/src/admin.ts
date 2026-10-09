import type { FastifyInstance } from 'fastify';
import type { AdminStats, ActivityItem, AdminEntry, AdminSolutionHit, AdminUser } from '@opravovator/shared';
import { requireAdmin } from './auth.js';
import { logActivity } from './activity.js';
import { cfg } from './config.js';
import { sql } from './db.js';
import { HttpError } from './http.js';
import { deleteTask, refreshTaskPoints, type TaskRow } from './storage.js';

const num = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Nenájdené.');
  return n;
};

/** % a _ v hľadanom texte sú obyčajné znaky, nie zástupné; hľadá sa bez ohľadu na diakritiku. */
const like = (q: string) => '%' + fold(q).replace(/[\\%_]/g, m => '\\' + m) + '%';
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** SQL výraz bez diakritiky a malými písmenami (slovenské a české znaky). */
const folded = (col: ReturnType<typeof sql>) =>
  sql`translate(lower(${col}), 'áäčďéěíĺľňóôŕřšťúůýžöü', 'aacdeeillnoorrstuuyzou')`;

/** Admin panel (/admin): prehľad vedúcich a ich úloh, log aktivity, správa adminov. */
export function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/me', async req => ({ email: requireAdmin(req).email }));

  // koľko miesta práve zaberá databáza
  app.get('/api/admin/stats', async req => {
    requireAdmin(req);
    const [r] = await sql<{ bytes: string }[]>`SELECT pg_database_size(current_database())::text AS bytes`;
    const out: AdminStats = { db_bytes: Number(r.bytes), db_limit_bytes: cfg.DB_LIMIT_MB ? cfg.DB_LIMIT_MB * 1048576 : null };
    return out;
  });

  // všetci, čo sa aspoň raz prihlásili, a pod každým jeho úlohy na serveri
  app.get('/api/admin/users', async req => {
    requireAdmin(req);
    return sql<AdminUser[]>`
      SELECT u.id, u.email, u.name, u.picture, u.created_at, u.last_login_at,
        EXISTS (SELECT 1 FROM admins a WHERE a.email = u.email) AS is_admin,
        coalesce((
          SELECT json_agg(json_build_object(
            'id', t.id, 'name', t.name, 'created_at', t.created_at,
            'updated_at', GREATEST(t.created_at, t.updated_at, (SELECT max(s.updated_at) FROM solutions s WHERE s.task_id = t.id)),
            'comment_text', t.comment_text, 'max_points', t.max_points,
            'total', (SELECT count(*) FROM solutions s WHERE s.task_id = t.id),
            'graded', (SELECT count(*) FROM solutions s WHERE s.task_id = t.id AND s.points IS NOT NULL),
            'annotated', (SELECT count(*) FROM solutions s WHERE s.task_id = t.id AND s.annotations != '[]'),
            'shares', coalesce((SELECT json_agg(sh.email ORDER BY sh.email) FROM task_shares sh WHERE sh.task_id = t.id), '[]')
          ) ORDER BY t.id DESC) FROM tasks t WHERE t.owner_id = u.id), '[]') AS tasks
      FROM users u
      ORDER BY u.last_login_at DESC NULLS LAST, u.id DESC`;
  });

  // hľadanie v riešeniach (meno riešiteľa, priečinok, ID) naprieč všetkými úlohami
  app.get<{ Querystring: { q?: string } }>('/api/admin/solutions', async req => {
    requireAdmin(req);
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return [];
    return sql<AdminSolutionHit[]>`
      SELECT s.id, s.display_name, s.folder, s.rocnik, s.points, t.id AS task_id, t.name AS task_name,
        o.name AS owner, o.email AS owner_email
      FROM solutions s JOIN tasks t ON t.id = s.task_id JOIN users o ON o.id = t.owner_id
      WHERE ${folded(sql`s.display_name`)} LIKE ${like(q)} OR ${folded(sql`s.folder`)} LIKE ${like(q)} OR s.student_id = ${q}
      ORDER BY t.id DESC, s.idx LIMIT 200`;
  });

  // log aktivity, najnovšie prvé; „before“ = id posledného načítaného záznamu (stránkovanie)
  app.get<{ Querystring: { user?: string; action?: string; q?: string; before?: string } }>('/api/admin/activity', async req => {
    requireAdmin(req);
    const { user, action, q, before } = req.query;
    const userId = Number(user) || null;
    const beforeId = Number(before) || null;
    const text = String(q || '').trim();
    return sql<ActivityItem[]>`
      SELECT l.id, l.at, l.user_id, u.name AS user, u.email, l.action, l.task_id, l.task_name, l.details
      FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
      WHERE true
        ${userId ? sql`AND l.user_id = ${userId}` : sql``}
        ${action ? sql`AND l.action = ${String(action)}` : sql``}
        ${beforeId ? sql`AND l.id < ${beforeId}` : sql``}
        ${text ? sql`AND (${folded(sql`l.task_name`)} LIKE ${like(text)} OR ${folded(sql`l.details`)} LIKE ${like(text)} OR ${folded(sql`u.name`)} LIKE ${like(text)} OR u.email ILIKE ${like(text)})` : sql``}
      ORDER BY l.id DESC LIMIT 200`;
  });

  /* ---------- úlohy ---------- */

  app.put<{ Params: { id: string }; Body: { name?: string; comment_text?: string; max_points?: number | string | null } }>(
    '/api/admin/tasks/:id', async req => {
      const u = requireAdmin(req);
      const [t] = await sql<TaskRow[]>`SELECT * FROM tasks WHERE id = ${num(req.params.id)}`;
      if (!t) throw new HttpError(404, 'Úloha neexistuje.');
      const b = req.body || {};
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : t.name;
      const comment = typeof b.comment_text === 'string' ? b.comment_text : t.comment_text;
      let max = t.max_points;
      if ('max_points' in b) {
        max = b.max_points === null || b.max_points === '' ? null : Number(b.max_points);
        if (max !== null && !Number.isFinite(max)) throw new HttpError(400, 'Maximum bodov musí byť číslo.');
      }
      const changed = [
        name !== t.name && `názov: „${t.name}“ → „${name}“`,
        comment !== t.comment_text && 'komentár',
        max !== t.max_points && `maximum: ${t.max_points ?? '–'} → ${max ?? '–'}`,
      ].filter(Boolean);
      if (!changed.length) return { ok: true };
      await sql`UPDATE tasks SET name = ${name}, comment_text = ${comment}, max_points = ${max}, updated_at = now() WHERE id = ${t.id}`;
      await refreshTaskPoints(t.id);
      logActivity(u.id, 'admin_task_edit', { id: t.id, name }, changed.join(', '));
      return { ok: true };
    });

  app.delete<{ Params: { id: string } }>('/api/admin/tasks/:id', async req => {
    const u = requireAdmin(req);
    const [t] = await sql<TaskRow[]>`SELECT * FROM tasks WHERE id = ${num(req.params.id)}`;
    if (!t) throw new HttpError(404, 'Úloha neexistuje.');
    await deleteTask(t.id);
    const [o] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${t.owner_id}`;
    logActivity(u.id, 'admin_task_delete', t, o ? `vlastník ${o.email}` : '');
    return { ok: true };
  });

  /* ---------- admini ---------- */

  app.get('/api/admin/admins', async req => {
    requireAdmin(req);
    return sql<AdminEntry[]>`
      SELECT a.email, a.added_by, a.created_at, u.name FROM admins a LEFT JOIN users u ON u.email = a.email
      ORDER BY a.created_at, a.email`;
  });

  app.post<{ Body: { email?: string } }>('/api/admin/admins', async req => {
    const u = requireAdmin(req);
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Zadaj platný e-mail.');
    const r = await sql`INSERT INTO admins (email, added_by) VALUES (${email}, ${u.email}) ON CONFLICT DO NOTHING`;
    if (!r.count) throw new HttpError(400, 'Tento e-mail už je admin.');
    logActivity(u.id, 'admin_add', null, email);
    return { ok: true };
  });

  app.delete<{ Params: { email: string } }>('/api/admin/admins/:email', async req => {
    const u = requireAdmin(req);
    const email = req.params.email.toLowerCase();
    if (email === u.email) throw new HttpError(400, 'Seba odobrať nemôžeš (aby nezostal panel bez admina).');
    const r = await sql`DELETE FROM admins WHERE email = ${email}`;
    if (r.count) logActivity(u.id, 'admin_remove', null, email);
    return { ok: true };
  });
}
