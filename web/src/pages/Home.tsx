import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { TaskDetail, TaskSummary, User } from '@opravovator/shared';
import { api, uploadWithProgress } from '../api';
import { applyAccent } from '../theme';
import { GearIcon, SettingsDialog } from '../components/Settings';
import { UpdateButton } from '../components/Changelog';
import { Brand, Dialog, InstallButton, NetStatus, ThemeButton, formatDate, logout, useConfirm } from '../components/common';
import { deleteLocalTask, downloadBlob, importLocalZip, listLocalTasks, localCsv, localExportZip, type LocalTaskSummary } from '../local/ops';
import { getSession, localEnabled } from '../local/session';
import { downloadTask, syncTask, unsyncedCount, uploadTask, type Unsynced } from '../local/sync';

type Target = 'server' | 'local';
const TARGET_KEY = 'opravovator-upload-target';

export function Home() {
  const nav = useNavigate();
  const [me, setMe] = useState<User | null>(null);
  const [server, setServer] = useState<User | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [local, setLocal] = useState<(LocalTaskSummary & { unsynced: Unsynced })[] | null>(null);
  const [error, setError] = useState('');
  const [upload, setUpload] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [share, setShare] = useState<TaskSummary | null>(null);
  const [profile, setProfile] = useState(false);
  const [busy, setBusy] = useState<Record<number, string>>({});
  const [target, setTargetState] = useState<Target>(() => (localStorage.getItem(TARGET_KEY) === 'local' ? 'local' : 'server'));
  const fileIn = useRef<HTMLInputElement>(null);
  const [ask, confirmNode] = useConfirm();
  const setTarget = (t: Target) => { setTargetState(t); try { localStorage.setItem(TARGET_KEY, t); } catch { /* */ } };
  const status = (id: number, text: string | null) => setBusy(b => { const n = { ...b }; if (text) n[id] = text; else delete n[id]; return n; });

  const load = useCallback(async () => {
    const s = await getSession(true);
    if (!s.server && !localEnabled()) { nav('/login', { replace: true }); return; }
    setMe(s.me); setServer(s.server); applyAccent(s.me.accent);
    const loc = await listLocalTasks(s.me);
    setLocal(await Promise.all(loc.map(async t => ({ ...t, unsynced: await unsyncedCount(t.id) }))));
    if (s.server) {
      try { setTasks(await api<TaskSummary[]>('/api/tasks')); } catch (e) { setError((e as Error).message); }
    } else setTasks(null);
  }, [nav]);

  useEffect(() => { load().catch(e => setError((e as Error).message)); }, [load]);

  const where: Target = server ? target : 'local';

  async function uploadZip(file: File) {
    setError('');
    if (!/\.zip$/i.test(file.name)) { setError('Toto nie je zip súbor.'); return; }
    const mb = (file.size / 1048576).toFixed(0);
    try {
      if (where === 'local') {
        setUpload('Rozbaľujem…');
        const id = await importLocalZip(file, file.name, (d, n) => setUpload(`Rozbaľujem ${d}/${n}`));
        nav(`/task/${id}`);
        return;
      }
      const fd = new FormData();
      fd.append('zip', file);
      setUpload('Nahrávam…');
      const r = await uploadWithProgress<{ id: number }>('/api/tasks', fd, (l, t) =>
        setUpload(l < t ? `Nahrávam ${Math.round(l / t * 100)} % z ${mb} MB` : 'Rozbaľujem riešenia…'));
      nav(`/task/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
      setUpload(null);
    }
  }

  async function run(id: number, fn: () => Promise<unknown>) {
    setError('');
    try { await fn(); status(id, null); await load(); } catch (e) { status(id, null); setError((e as Error).message); }
  }

  async function remove(t: TaskSummary) {
    if (t.is_owner) {
      if (!await ask({
        title: 'Zmazať úlohu?',
        body: <>
          <p>Naozaj zmazať úlohu <b>„{t.name}“</b>?</p>
          <p>Zmaže sa aj {t.total} riešení so všetkými opravami a históriou. <b>Toto sa nedá vrátiť.</b></p>
        </>,
        ok: 'Zmazať natrvalo', danger: true,
      })) return;
      await api(`/api/tasks/${t.id}`, { method: 'DELETE' });
    } else {
      if (!await ask({
        title: 'Odísť zo zdieľanej úlohy?',
        body: <p>Úloha <b>„{t.name}“</b> ti zmizne zo zoznamu. Vlastník ({t.owner}) ťa môže pridať znova.</p>,
        ok: 'Odísť', danger: true,
      })) return;
      await api(`/api/tasks/${t.id}/shares/${encodeURIComponent(me!.email)}`, { method: 'DELETE' });
    }
    load();
  }

  async function removeLocal(t: LocalTaskSummary & { unsynced: Unsynced }) {
    if (!await ask(t.remote
      ? {
        title: 'Zmazať kópiu zo zariadenia?',
        body: <p>Úloha <b>„{t.name}“</b> sa zmaže z tohto zariadenia, na serveri ostane.
          {t.unsynced.changes > 0 && <> <b className="warnc">{changesText(t.unsynced.changes)} sa stratí.</b></>}</p>,
        ok: 'Zmazať zo zariadenia', danger: true,
      }
      : {
        title: 'Zmazať úlohu?',
        body: <><p>Naozaj zmazať úlohu <b>„{t.name}“</b>?</p><p>Je len v tomto zariadení. <b>Toto sa nedá vrátiť.</b></p></>,
        ok: 'Zmazať natrvalo', danger: true,
      })) return;
    await deleteLocalTask(t.id);
    load();
  }

  const downloadedIds = new Set((local || []).map(t => t.remote?.taskId).filter(Boolean));
  const serverById = new Map((tasks || []).map(t => [t.id, t]));

  return (
    <>
      <header className="top">
        <Brand />
        {me && <UpdateButton server={!!server} />}
        <span className="spacer" />
        <NetStatus />
        <InstallButton />
        <ThemeButton />
        {me && <button className="btn ghost" onClick={() => setProfile(true)} title={server ? `${server.email} – nastavenia` : 'Nastavenia'}>
          {me.picture && <img className="avatar" src={me.picture} alt="" referrerPolicy="no-referrer" />}{me.name}
        </button>}
        {me && <button className="btn theme-btn settings-btn" onClick={() => setProfile(true)} title="Nastavenia" aria-label="Nastavenia"><GearIcon /></button>}
        {server
          ? <button className="btn" onClick={logout}>Odhlásiť</button>
          : <Link className="btn primary" to="/login">Prihlásiť</Link>}
      </header>
      <main className="home">
        <h2>Nová úloha</h2>
        {server && (
          <div className="seg narrow" role="radiogroup" aria-label="Kam uložiť novú úlohu">
            <button type="button" className={where === 'server' ? 'on' : ''} onClick={() => setTarget('server')}>Na server</button>
            <button type="button" className={where === 'local' ? 'on' : ''} onClick={() => setTarget('local')}>Do zariadenia</button>
          </div>
        )}
        <div
          className={'dropzone' + (over ? ' over' : '')}
          onDragOver={e => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) uploadZip(f); }}
        >
          <input ref={fileIn} type="file" accept=".zip,application/zip" hidden onChange={e => { const f = e.target.files?.[0]; if (f) uploadZip(f); e.target.value = ''; }} />
          <button className="btn primary" disabled={!!upload} onClick={() => fileIn.current?.click()}>{upload || 'Vybrať zip'}</button>
          {!upload && <p className="muted small drop-hint">alebo sem zip potiahni myšou</p>}
          <p className="error">{error}</p>
        </div>

        {server && <>
          <h2>Na serveri</h2>
          <div className="tasklist">
            {!tasks && <div className="empty">Načítavam…</div>}
            {tasks && !tasks.length && <div className="empty">Žiadne úlohy</div>}
            {tasks?.map(t => (
              <div className="taskrow" key={t.id}>
                <div className="info">
                  <Link className="name" to={`/task/${t.id}`}>{t.name}</Link>
                  <div className="meta">
                    {t.is_owner ? 'Moja úloha' : <>Zdieľa <b>{t.owner}</b></>} · <span title={`Vytvorené ${formatDate(t.created_at)}`}>upravené {formatDate(t.updated_at)}</span>
                    {busy[t.id] && <> · <span className="okc">{busy[t.id]}</span></>}
                  </div>
                </div>
                <Progress t={t} />
                <div className="actions">
                  <a className="btn" href={`/api/tasks/${t.id}/download`} title="Zip s meno.komentar.pdf, body.txt a komentárom">Zip</a>
                  <a className="btn" href={`/api/tasks/${t.id}/points.csv`} title="Tabuľka bodov">CSV</a>
                  <button className="btn" disabled={!!busy[t.id]} title="Kópia v zariadení – funguje úplne bez internetu, zmeny sa dajú synchronizovať"
                    onClick={() => run(t.id, () => downloadTask(t.id, x => status(t.id, x)))}>
                    {downloadedIds.has(t.id) ? 'Synchronizovať kópiu' : 'Do zariadenia'}
                  </button>
                  {t.is_owner && <button className="btn" onClick={() => setShare(t)}>Zdieľať</button>}
                  <button className="btn danger" onClick={() => remove(t)}>{t.is_owner ? 'Zmazať' : 'Odísť'}</button>
                </div>
              </div>
            ))}
          </div>
        </>}

        <h2>V zariadení</h2>
        <div className="tasklist">
          {!local && <div className="empty">Načítavam…</div>}
          {local && !local.length && <div className="empty">Žiadne úlohy</div>}
          {local?.map(t => {
            const srv = t.remote && serverById.get(t.remote.taskId);
            const serverNewer = !!srv && srv.revs !== t.remote!.baseRevs;
            return (
            <div className="taskrow" key={t.id}>
              <div className="info">
                <Link className="name" to={`/task/${t.id}`}>{t.name}</Link>
                <div className="meta">
                  {t.remote ? 'Prepojené so serverom' : 'Len v zariadení'}
                  {' · '}<span title={`Vytvorené ${formatDate(t.created_at)}`}>upravené {formatDate(t.updated_at)}</span>
                  {t.remote && <>
                    {' · '}synchronizované {formatDate(t.remote.syncedAt)}
                    {t.unsynced.changes > 0
                      ? <> · <b className="warnc" title={`Zmenené riešenia: ${t.unsynced.solutions}`}>{changesText(t.unsynced.changes)}</b></>
                      : !serverNewer && <> · <span className="okc">aktuálne</span></>}
                    {serverNewer && <> · <b className="warnc">na serveri sú novšie zmeny</b></>}
                  </>}
                  {busy[t.id] && <> · <span className="okc">{busy[t.id]}</span></>}
                </div>
              </div>
              <Progress t={t} />
              <div className="actions">
                <button className="btn" onClick={() => run(t.id, async () => {
                  status(t.id, 'Balím zip…');
                  downloadBlob(await localExportZip(t.id, (d, n) => status(t.id, `Vypaľujem ${d}/${n}`)), `${t.name}.zip`);
                })}>Zip</button>
                <button className="btn" onClick={() => run(t.id, async () => downloadBlob(await localCsv(t.id), `${t.name} – body.csv`))}>CSV</button>
                {t.remote
                  ? <button className="btn" disabled={!server || !!busy[t.id]} title={server ? '' : 'Prihlás sa'}
                    onClick={() => run(t.id, () => syncTask(t.id, x => status(t.id, x)))}>Synchronizovať</button>
                  : <button className="btn" disabled={!!busy[t.id]}
                    onClick={() => (server ? run(t.id, () => uploadTask(t.id, x => status(t.id, x))) : nav('/login'))}>Nahrať na server</button>}
                <button className="btn danger" onClick={() => removeLocal(t)}>Zmazať</button>
              </div>
            </div>
            );
          })}
        </div>
      </main>

      {share && <ShareDialog task={share} onClose={() => setShare(null)} />}
      {confirmNode}
      {me && <SettingsDialog open={profile} me={me} onClose={() => setProfile(false)} onSaved={setMe} />}
    </>
  );
}

/** „1 neposlaná zmena“, „3 neposlané zmeny“, „5 neposlaných zmien“ */
function changesText(n: number) {
  if (n === 1) return '1 neposlaná zmena';
  if (n >= 2 && n <= 4) return `${n} neposlané zmeny`;
  return `${n} neposlaných zmien`;
}

function Progress({ t }: { t: TaskSummary }) {
  const pct = t.total ? Math.round(t.graded / t.total * 100) : 0;
  return (
    <div className="stat">
      <div className="meta">{t.graded} z {t.total} obodovaných · {t.annotated} opravených</div>
      <div className="progress"><i style={{ width: pct + '%' }} /></div>
    </div>
  );
}

function ShareDialog({ task, onClose }: { task: TaskSummary; onClose: () => void }) {
  const [shares, setShares] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => api<TaskDetail>(`/api/tasks/${task.id}`).then(t => setShares(t.shares)), [task.id]);
  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api(`/api/tasks/${task.id}/shares`, { method: 'POST', body: { email } });
      setEmail('');
      load();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <Dialog open onClose={onClose} title={`Zdieľať „${task.name}“`}>
      <form className="inline" onSubmit={add}>
        <input className="input" type="email" placeholder="e-mail@trojsten.sk" value={email} onChange={e => setEmail(e.target.value)} required />
        <button className="btn primary">Pridať</button>
      </form>
      <p className="error">{error}</p>
      <ul className="shares">
        {!shares.length && <li className="muted">Nezdieľané</li>}
        {shares.map(s => (
          <li key={s}>{s}
            <button className="btn danger small" onClick={async () => { await api(`/api/tasks/${task.id}/shares/${encodeURIComponent(s)}`, { method: 'DELETE' }); load(); }}>Odobrať</button>
          </li>
        ))}
      </ul>
      <div className="row"><button className="btn" onClick={onClose}>Hotovo</button></div>
    </Dialog>
  );
}
