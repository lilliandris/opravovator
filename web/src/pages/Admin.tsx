import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  ACTIVITY_LABELS, formatPoints, type Maintenance, type ActivityAction, type AdminStats, type ActivityItem, type AdminEntry, type AdminSolutionHit, type AdminTask, type AdminUser,
} from '@opravovator/shared';
import { ApiError, api } from '../api';
import { refreshStatus } from '../status';
import { Brand, Dialog, ThemeButton, formatDate, useConfirm, type Ask } from '../components/common';

/* Admin panel – dostupný len priamo na /admin, nikde naň nevedie tlačidlo. */

type Tab = 'users' | 'logs' | 'admins' | 'restart';

const fmtTime = (s: string) => new Date(s).toLocaleString('sk', {
  day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function Admin() {
  const [state, setState] = useState<'loading' | 'login' | 'denied' | 'ok'>('loading');
  const [me, setMe] = useState('');
  const [tab, setTab] = useState<Tab>('users');
  const [logUser, setLogUser] = useState<number | ''>('');
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState('');
  const [ask, confirmNode] = useConfirm();

  const loadUsers = useCallback(() => api<AdminUser[]>('/api/admin/users').then(setUsers).catch(e => setError(e.message)), []);

  useEffect(() => {
    document.title = 'Admin · opravOVÁTOR';
    (async () => {
      try { await api('/api/me'); } catch { setState('login'); return; }
      try {
        const r = await api<{ email: string }>('/api/admin/me');
        setMe(r.email);
        setState('ok');
        loadUsers();
      } catch (e) { setState(e instanceof ApiError && e.status === 403 ? 'denied' : 'login'); }
    })();
    return () => { document.title = 'opravOVÁTOR'; };
  }, [loadUsers]);

  if (state !== 'ok') {
    return (
      <div className="auth">
        <ThemeButton />
        <div className="auth-card">
          <Brand big />
          {state === 'loading' && <p className="muted">Načítavam…</p>}
          {state === 'login' && <p>Najprv sa <Link to="/login?next=/admin">prihlás</Link>.</p>}
          {state === 'denied' && <p className="error">Na túto stránku nemáš prístup. <Link to="/">Späť</Link></p>}
        </div>
      </div>
    );
  }

  const showLogs = (userId: number) => { setLogUser(userId); setTab('logs'); };

  return (
    <>
      <header className="top">
        <Brand />
        <span className="admin-chip">ADMIN</span>
        <span className="spacer" />
        <DbUsage />
        <span className="muted small">{me}</span>
        <ThemeButton />
        <Link className="btn" to="/">Späť do aplikácie</Link>
      </header>
      <main className="home admin">
        <div className="seg admin-tabs" role="tablist">
          <button role="tab" className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>Vedúci{users ? ` (${users.length})` : ''}</button>
          <button role="tab" className={tab === 'logs' ? 'on' : ''} onClick={() => setTab('logs')}>Logy</button>
          <button role="tab" className={tab === 'admins' ? 'on' : ''} onClick={() => setTab('admins')}>Admini</button>
          <button role="tab" className={tab === 'restart' ? 'on' : ''} onClick={() => setTab('restart')}>Reštart</button>
        </div>
        <p className="error">{error}</p>
        {tab === 'users' && <UsersTab users={users} reload={loadUsers} ask={ask} onLogs={showLogs} />}
        {tab === 'logs' && <LogsTab users={users || []} user={logUser} setUser={setLogUser} />}
        {tab === 'admins' && <AdminsTab me={me} ask={ask} />}
        {tab === 'restart' && <RestartTab ask={ask} />}
      </main>
      {confirmNode}
    </>
  );
}

const fmtBytes = (b: number) => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB'
  : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' kB';

/** Veľkosť databázy v hornej lište, obnovuje sa každú minútu. */
function DbUsage() {
  const [s, setS] = useState<AdminStats | null>(null);
  useEffect(() => {
    const load = () => api<AdminStats>('/api/admin/stats').then(setS).catch(() => {});
    load();
    const t = setInterval(load, 60e3);
    return () => clearInterval(t);
  }, []);
  if (!s) return null;
  const pct = s.db_limit_bytes ? Math.min(100, s.db_bytes / s.db_limit_bytes * 100) : null;
  const level = pct === null ? '' : pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
  return (
    <span className={'db-usage ' + level} title={pct === null ? 'Veľkosť databázy' : `Veľkosť databázy: ${pct.toFixed(1)} % limitu`}>
      Databáza: <b>{fmtBytes(s.db_bytes)}</b>{s.db_limit_bytes && <> z {fmtBytes(s.db_limit_bytes)}</>}
      {pct !== null && <i className="db-bar"><i style={{ width: pct + '%' }} /></i>}
    </span>
  );
}

/* ================= vedúci a ich úlohy ================= */

function UsersTab({ users, reload, ask, onLogs }: { users: AdminUser[] | null; reload: () => void; ask: Ask; onLogs: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<AdminSolutionHit[] | null>(null);
  const [edit, setEdit] = useState<{ task: AdminTask; owner: AdminUser } | null>(null);
  const [error, setError] = useState('');

  // riešenia hľadá server (môže ich byť veľa), vedúcich a úlohy filtrujeme tu
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setHits(null); return; }
    const t = setTimeout(() => {
      api<AdminSolutionHit[]>(`/api/admin/solutions?q=${encodeURIComponent(s)}`).then(setHits).catch(() => setHits(null));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const filtered = useMemo(() => {
    if (!users) return null;
    const s = norm(q.trim());
    if (!s) return users.map(u => ({ u, tasks: u.tasks }));
    return users.flatMap(u => {
      if (norm(u.name).includes(s) || norm(u.email).includes(s)) return [{ u, tasks: u.tasks }];
      const tasks = u.tasks.filter(t => norm(t.name).includes(s) || t.shares.some(e => norm(e).includes(s)));
      return tasks.length ? [{ u, tasks }] : [];
    });
  }, [users, q]);

  async function openTask(taskId: number, taskName: string, owner: string, solId?: number) {
    if (!await ask({
      title: 'Otvoriť cudziu úlohu?',
      body: <p>Úloha <b>„{taskName}“</b> patrí vedúcemu <b>{owner}</b>. V editore môžeš meniť opravy a body a zmeny sa uložia priamo do jeho úlohy.</p>,
      ok: 'Otvoriť v editore',
    })) return;
    window.open(`/task/${taskId}${solId ? `#sol=${solId}` : ''}`, '_blank', 'noopener');
  }

  async function remove(t: AdminTask, owner: AdminUser) {
    setError('');
    if (!await ask({
      title: 'Zmazať úlohu?',
      body: <>
        <p>Naozaj zmazať úlohu <b>„{t.name}“</b> vedúceho <b>{owner.name}</b> ({owner.email})?</p>
        <p>Zmaže sa aj {t.total} riešení so všetkými opravami a históriou. <b>Toto sa nedá vrátiť.</b></p>
      </>,
      ok: 'Zmazať natrvalo', danger: true,
    })) return;
    try { await api(`/api/admin/tasks/${t.id}`, { method: 'DELETE' }); reload(); } catch (e) { setError((e as Error).message); }
  }

  const taskCount = filtered?.reduce((n, x) => n + x.tasks.length, 0) ?? 0;

  return (
    <>
      <input className="input admin-search" type="search" placeholder="Hľadať vedúceho, úlohu alebo riešiteľa…" value={q} onChange={e => setQ(e.target.value)} autoFocus />
      <p className="error">{error}</p>

      {hits && hits.length > 0 && <>
        <h2>Riešenia <span className="muted small">({hits.length}{hits.length === 200 ? '+' : ''})</span></h2>
        <div className="tasklist admin-hits">
          {hits.map(h => (
            <div className="taskrow" key={h.id}>
              <div className="info">
                <span className="name">{h.display_name}</span>
                <div className="meta">{h.task_name} · <b>{h.owner}</b> · {h.folder}{h.rocnik && ` · ${h.rocnik}`}</div>
              </div>
              <div className="stat"><span className="hit-pts">{h.points === null ? '–' : formatPoints(h.points)}</span></div>
              <div className="actions">
                <button className="btn" onClick={() => openTask(h.task_id, h.task_name, h.owner, h.id)}>Otvoriť</button>
              </div>
            </div>
          ))}
        </div>
      </>}

      {!(filtered && !filtered.length && hits?.length) && <>
        <h2>Vedúci <span className="muted small">{filtered ? `(${filtered.length} · ${taskCount} úloh)` : ''}</span></h2>
        {!filtered && <div className="tasklist"><div className="empty">Načítavam…</div></div>}
        {filtered && !filtered.length && <div className="tasklist"><div className="empty">Nič sa nenašlo</div></div>}
      </>}
      {filtered?.map(({ u, tasks }) => (
        <section className="leader" key={u.id}>
          <div className="leader-head">
            {u.picture ? <img className="avatar big" src={u.picture} alt="" referrerPolicy="no-referrer" /> : <span className="avatar big ph">{u.name.slice(0, 1).toUpperCase()}</span>}
            <div className="info">
              <div className="leader-name">{u.name} {u.is_admin && <span className="admin-chip small">admin</span>}</div>
              <div className="meta">{u.email} · prvé prihlásenie {formatDate(u.created_at)} · posledné {formatDate(u.last_login_at)}</div>
            </div>
            <button className="btn small" onClick={() => onLogs(u.id)}>Logy</button>
          </div>
          <div className="tasklist">
            {!tasks.length && <div className="empty small">Žiadne úlohy na serveri</div>}
            {tasks.map(t => (
              <div className="taskrow" key={t.id}>
                <div className="info">
                  <span className="name">{t.name}</span>
                  <div className="meta">
                    vytvorené {formatDate(t.created_at)} · upravené {formatDate(t.updated_at)}
                    {t.shares.length > 0 && <> · zdieľa s {t.shares.join(', ')}</>}
                  </div>
                </div>
                <div className="stat">
                  <div className="meta">{t.graded} z {t.total} obodovaných · {t.annotated} opravených</div>
                  <div className="progress"><i style={{ width: (t.total ? Math.round(t.graded / t.total * 100) : 0) + '%' }} /></div>
                </div>
                <div className="actions">
                  <button className="btn" onClick={() => openTask(t.id, t.name, u.name)}>Otvoriť</button>
                  <button className="btn" onClick={() => setEdit({ task: t, owner: u })}>Upraviť</button>
                  <a className="btn" href={`/api/tasks/${t.id}/download`}>Zip</a>
                  <a className="btn" href={`/api/tasks/${t.id}/points.csv`}>CSV</a>
                  <button className="btn danger" onClick={() => remove(t, u)}>Zmazať</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {edit && <EditTask task={edit.task} owner={edit.owner} ask={ask} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function EditTask({ task, owner, ask, onClose, onSaved }: { task: AdminTask; owner: AdminUser; ask: Ask; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(task.name);
  const [comment, setComment] = useState(task.comment_text);
  const [max, setMax] = useState(task.max_points === null ? '' : String(task.max_points));
  const [shares, setShares] = useState(task.shares);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sharesChanged = useRef(false);

  const origMax = task.max_points === null ? '' : String(task.max_points);
  const changes = [
    name.trim() !== task.name && <li key="n">názov: „{task.name}“ → „{name.trim()}“</li>,
    comment !== task.comment_text && <li key="c">komentár úlohy</li>,
    max.trim() !== origMax && <li key="m">maximum bodov: {origMax || '–'} → {max.trim() || '–'}</li>,
  ].filter(Boolean);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!changes.length) { if (sharesChanged.current) onSaved(); else onClose(); return; }
    if (!await ask({
      title: 'Uložiť zmeny?',
      body: <><p>V úlohe vedúceho <b>{owner.name}</b> sa zmení:</p><ul>{changes}</ul></>,
      ok: 'Uložiť zmeny',
    })) return;
    setBusy(true);
    try {
      await api(`/api/admin/tasks/${task.id}`, { method: 'PUT', body: { name, comment_text: comment, max_points: max.trim() } });
      onSaved();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  async function addShare(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const em = email.trim().toLowerCase();
    if (!await ask({ title: 'Nazdieľať úlohu?', body: <p>Úloha <b>„{task.name}“</b> sa nazdieľa s <b>{em}</b>.</p>, ok: 'Nazdieľať' })) return;
    try {
      await api(`/api/tasks/${task.id}/shares`, { method: 'POST', body: { email: em } });
      setShares(s => [...new Set([...s, em])].sort());
      setEmail('');
      sharesChanged.current = true;
    } catch (err) { setError((err as Error).message); }
  }

  async function removeShare(em: string) {
    setError('');
    if (!await ask({ title: 'Zrušiť zdieľanie?', body: <p><b>{em}</b> stratí prístup k úlohe <b>„{task.name}“</b>.</p>, ok: 'Zrušiť zdieľanie', danger: true })) return;
    try {
      await api(`/api/tasks/${task.id}/shares/${encodeURIComponent(em)}`, { method: 'DELETE' });
      setShares(s => s.filter(x => x !== em));
      sharesChanged.current = true;
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <Dialog open wide onClose={() => (sharesChanged.current ? onSaved() : onClose())} title={`Upraviť úlohu – ${owner.name}`}>
      <form onSubmit={save}>
        <label className="field"><span>Názov</span><input className="input" value={name} onChange={e => setName(e.target.value)} required /></label>
        <label className="field"><span>Maximum bodov</span><input className="input" inputMode="decimal" value={max} onChange={e => setMax(e.target.value)} placeholder="bez maxima" /></label>
        <label className="field"><span>Komentár úlohy</span><textarea className="input" value={comment} onChange={e => setComment(e.target.value)} /></label>
        <div className="row">
          <button type="button" className="btn" onClick={() => (sharesChanged.current ? onSaved() : onClose())}>Zavrieť</button>
          <button className="btn primary" disabled={busy || !changes.length}>Uložiť…</button>
        </div>
      </form>
      <h4 className="admin-sub">Zdieľanie</h4>
      <form className="inline" onSubmit={addShare}>
        <input className="input" type="email" placeholder="e-mail@trojsten.sk" value={email} onChange={e => setEmail(e.target.value)} required />
        <button className="btn">Pridať</button>
      </form>
      <ul className="shares">
        {!shares.length && <li className="muted">Nezdieľané</li>}
        {shares.map(s => <li key={s}>{s}<button className="btn danger small" onClick={() => removeShare(s)}>Odobrať</button></li>)}
      </ul>
      <p className="error">{error}</p>
    </Dialog>
  );
}

/* ================= logy ================= */

const ACTION_KIND: Partial<Record<ActivityAction, string>> = {
  task_delete: 'bad', admin_task_delete: 'bad', admin_remove: 'bad', task_unshare: 'bad',
  task_upload: 'ok', asset_upload: 'ok', task_share: 'ok',
  task_download_device: 'info', task_download_zip: 'info', task_download_csv: 'info',
  admin_task_edit: 'warn', admin_add: 'warn', admin_maintenance: 'warn',
  login: 'muted', logout: 'muted', task_close: 'muted',
};

function LogsTab({ users, user, setUser }: { users: AdminUser[]; user: number | ''; setUser: (u: number | '') => void }) {
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');

  const url = useCallback((before?: number) => {
    const p = new URLSearchParams();
    if (user) p.set('user', String(user));
    if (action) p.set('action', action);
    if (q.trim()) p.set('q', q.trim());
    if (before) p.set('before', String(before));
    return `/api/admin/activity?${p}`;
  }, [user, action, q]);

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api<ActivityItem[]>(url());
      setItems(r);
      setMore(r.length === 200);
    } catch (e) { setError((e as Error).message); }
  }, [url]);

  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  async function loadMore() {
    if (!items?.length) return;
    const r = await api<ActivityItem[]>(url(items[items.length - 1].id));
    setItems([...items, ...r]);
    setMore(r.length === 200);
  }

  return (
    <>
      <div className="log-filters">
        <select className="input" value={user} onChange={e => setUser(e.target.value ? Number(e.target.value) : '')} aria-label="Vedúci">
          <option value="">Všetci vedúci</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
        </select>
        <select className="input" value={action} onChange={e => setAction(e.target.value)} aria-label="Akcia">
          <option value="">Všetky akcie</option>
          {Object.entries(ACTIVITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="input" type="search" placeholder="Hľadať v úlohe, detaile, mene…" value={q} onChange={e => setQ(e.target.value)} />
        <button className="btn" onClick={load}>Obnoviť</button>
      </div>
      <p className="error">{error}</p>
      <div className="log-wrap">
        <table className="versions log">
          <thead><tr><th>Čas</th><th>Kto</th><th>Akcia</th><th>Úloha</th><th>Detail</th></tr></thead>
          <tbody>
            {!items && <tr><td colSpan={5} className="muted">Načítavam…</td></tr>}
            {items && !items.length && <tr><td colSpan={5} className="muted">Žiadne záznamy</td></tr>}
            {items?.map(l => (
              <tr key={l.id}>
                <td className="nowrap">{fmtTime(l.at)}</td>
                <td title={l.email || ''}>{l.user ?? <span className="muted">zmazaný</span>}</td>
                <td><span className={'act ' + (ACTION_KIND[l.action] || '')}>{ACTIVITY_LABELS[l.action] || l.action}</span></td>
                <td>{l.task_name}{l.task_id && <span className="muted small"> #{l.task_id}</span>}</td>
                <td className="muted">{l.details}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more && <div className="row center"><button className="btn" onClick={loadMore}>Načítať staršie</button></div>}
    </>
  );
}

/* ================= admini ================= */

/** Oznámenie reštartu servera (pred aktualizáciou) – online ľuďom sa ukáže odpočet a zmeny sa im samy uložia. */
function RestartTab({ ask }: { ask: Ask }) {
  const [info, setInfo] = useState<{ maintenance: Maintenance | null; online: string[] } | null>(null);
  const [minutes, setMinutes] = useState(5);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => api<{ maintenance: Maintenance | null; online: string[] }>('/api/admin/maintenance').then(setInfo).catch(e => setError(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  async function announce(e: React.FormEvent) {
    e.preventDefault();
    if (!await ask({
      title: `Oznámiť reštart o ${minutes} min?`,
      body: <p>Všetkým, čo majú appku otvorenú, sa ukáže odpočet. Ich zmeny sa uložia hneď a ešte raz tesne pred reštartom.
        Samotný reštart (deploy) urobíš potom – oznámenie sám nič nereštartuje.</p>,
      ok: 'Oznámiť',
    })) return;
    try { await api('/api/admin/maintenance', { method: 'POST', body: { minutes, message } }); await load(); void refreshStatus(); } catch (err) { setError((err as Error).message); }
  }
  async function cancel() {
    try { await api('/api/admin/maintenance', { method: 'DELETE' }); await load(); void refreshStatus(); } catch (err) { setError((err as Error).message); }
  }

  const m = info?.maintenance;
  return (
    <>
      <h2>Reštart servera</h2>
      {m
        ? <p>Oznámený reštart: <b>{fmtTime(m.at)}</b>{m.message && <> – „{m.message}“</>} <button className="btn small danger" onClick={cancel}>Zrušiť oznámenie</button></p>
        : <p className="muted">Žiadny reštart nie je oznámený.</p>}
      <form className="restart-form" onSubmit={announce}>
        <label className="field"><span>O koľko minút</span>
          <input className="input" type="number" min={0} max={120} value={minutes} onChange={e => setMinutes(Number(e.target.value))} /></label>
        <label className="field grow"><span>Správa (nepovinná)</span>
          <input className="input" value={message} maxLength={300} placeholder="napr. Nová verzia s intervalovým bodovaním" onChange={e => setMessage(e.target.value)} /></label>
        <button className="btn primary">Oznámiť reštart…</button>
      </form>
      <p className="error">{error}</p>
      <h2>Práve online {info && <span className="muted">({info.online.length})</span>}</h2>
      <p>{info?.online.length ? info.online.join(', ') : <span className="muted">nikto</span>}</p>
      <p className="hint">Online = appka otvorená za posledných 90 s. Postup aktualizácie je v README (scripts/deploy.sh to urobí celé samo).</p>
    </>
  );
}

function AdminsTab({ me, ask }: { me: string; ask: Ask }) {
  const [list, setList] = useState<AdminEntry[] | null>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => api<AdminEntry[]>('/api/admin/admins').then(setList).catch(e => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const em = email.trim().toLowerCase();
    if (!await ask({
      title: 'Pridať admina?',
      body: <p><b>{em}</b> uvidí všetkých vedúcich, ich úlohy a logy, bude môcť úlohy upravovať a mazať a pridávať ďalších adminov.</p>,
      ok: 'Pridať admina',
    })) return;
    try { await api('/api/admin/admins', { method: 'POST', body: { email: em } }); setEmail(''); load(); } catch (err) { setError((err as Error).message); }
  }

  async function remove(em: string) {
    setError('');
    if (!await ask({ title: 'Odobrať admina?', body: <p><b>{em}</b> stratí prístup do admin panelu.</p>, ok: 'Odobrať', danger: true })) return;
    try { await api(`/api/admin/admins/${encodeURIComponent(em)}`, { method: 'DELETE' }); load(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <h2>Pridať admina</h2>
      <form className="inline admin-add" onSubmit={add}>
        <input className="input" type="email" placeholder="e-mail@trojsten.sk" value={email} onChange={e => setEmail(e.target.value)} required />
        <button className="btn primary">Pridať…</button>
      </form>
      <p className="hint">E-mail stačí zadať, aj keď sa ten človek ešte neprihlásil.</p>
      <p className="error">{error}</p>
      <h2>Admini</h2>
      <div className="tasklist">
        {!list && <div className="empty">Načítavam…</div>}
        {list?.map(a => (
          <div className="taskrow" key={a.email}>
            <div className="info">
              <span className="name">{a.name || a.email}{a.email === me && <span className="muted small"> (ty)</span>}</span>
              <div className="meta">{a.email} · {a.added_by ? `pridal ${a.added_by}, ` : ''}{formatDate(a.created_at)}{!a.name && ' · ešte sa neprihlásil'}</div>
            </div>
            <span />
            <div className="actions">
              {a.email !== me && <button className="btn danger" onClick={() => remove(a.email)}>Odobrať</button>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
