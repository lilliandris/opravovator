import { useEffect, useState } from 'react';
import { APP_VERSION, CHANGELOG, type ReleaseInfo } from '@opravovator/shared';
import { api } from '../api';
import { refreshStatus, useStatus } from '../status';
import { Dialog, formatDate } from './common';

const SEEN_KEY = 'opravovator-seen-version';

/** Bez účtu (lokálny režim): nová verzia oproti tej, ktorú tu niekto naposledy videl. */
function localUpdate() {
  try {
    const seen = localStorage.getItem(SEEN_KEY);
    if (!seen) { localStorage.setItem(SEEN_KEY, APP_VERSION); return false; }
    return seen !== APP_VERSION;
  } catch { return false; }
}

/**
 * Farebné tlačidlo „Aktualizácia“ vedľa loga – len ak bola od prihlásenia nasadená nová verzia
 * (a zoznam zmien si ešte neotvoril). Otvorí zoznam zmien s časom nasadenia.
 */
export function UpdateButton({ server }: { server: boolean }) {
  const { status } = useStatus();
  const [open, setOpen] = useState(false);
  const [local] = useState(() => !server && localUpdate());
  const show = server ? !!status?.update : local;
  if (!show && !open) return null;
  return <>
    <button className="btn primary update-btn" onClick={() => setOpen(true)} title="Čo je nové v tejto verzii">Aktualizácia</button>
    {open && <ChangelogDialog onClose={async () => {
      setOpen(false);
      if (server) await api('/api/changelog/seen', { method: 'POST' }).catch(() => {});
      try { localStorage.setItem(SEEN_KEY, APP_VERSION); } catch { /* */ }
      await refreshStatus();
    }} />}
  </>;
}

export function ChangelogDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ReleaseInfo[] | null>(null);
  useEffect(() => {
    api<ReleaseInfo[]>('/api/changelog').then(setList)
      .catch(() => setList(CHANGELOG.map(r => ({ ...r, deployed_at: null })))); // offline: zoznam z aplikácie
  }, []);
  return (
    <Dialog open onClose={onClose} title="Čo je nové" wide>
      {!list && <p className="muted">Načítavam…</p>}
      {list?.map((r, i) => {
        const areas = [...new Set(r.items.map(x => x.area))];
        return (
          <section key={r.version} className={'release' + (i ? ' old' : '')}>
            <h4>Verzia {r.version}{r.deployed_at && <span className="muted"> · nasadená {formatDate(r.deployed_at)}</span>}</h4>
            {areas.map(a => (
              <div key={a} className="rel-area">
                <span className="rel-tag">{a}</span>
                <ul>{r.items.filter(x => x.area === a).map((x, j) => <li key={j}>{x.text}</li>)}</ul>
              </div>
            ))}
          </section>
        );
      })}
      <div className="row"><button className="btn primary" onClick={onClose}>Rozumiem</button></div>
    </Dialog>
  );
}
