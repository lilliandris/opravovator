import { useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '@opravovator/shared';
import { usePendingCount } from '../offline';
import { saveAll, useStatus } from '../status';

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Pruh hore: oznámený reštart servera (odpočet, zmeny sa samy uložia), prebiehajúci reštart
 * a nová verzia po aktualizácii (obnovenie stránky až po uložení všetkého).
 */
export function MaintenanceBanner() {
  const { status, down } = useStatus();
  const pending = usePendingCount();
  const [now, setNow] = useState(Date.now());
  const done = useRef<{ at: string; first: boolean; final: boolean } | null>(null);
  const [reloading, setReloading] = useState(false);
  const m = status?.maintenance || null;
  const left = m ? Date.parse(m.at) - now : 0;

  useEffect(() => {
    if (!m) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [m]);

  // uloženie: hneď po oznámení a ešte raz tesne pred reštartom (vtedy aj rozpísaný text)
  useEffect(() => {
    if (!m) return;
    if (done.current?.at !== m.at) done.current = { at: m.at, first: false, final: false };
    if (!done.current.first) { done.current.first = true; void saveAll(false); }
    if (left < 20e3 && !done.current.final) { done.current.final = true; void saveAll(true); }
  }, [m, left]);

  const newVersion = !!status && status.version !== APP_VERSION && !down;
  if (newVersion) {
    return (
      <div className="mbanner ok" role="status">
        <span>Je nainštalovaná nová verzia opravOVÁTORA. {pending ? `Odosielam ${pending} zmien…` : 'Všetky zmeny sú uložené.'}</span>
        <button className="btn small" disabled={reloading} onClick={async () => {
          setReloading(true);
          await saveAll(true);
          location.reload();
        }}>{reloading ? 'Ukladám…' : 'Obnoviť stránku'}</button>
      </div>
    );
  }
  if (!m) return null;
  if (left > 0 && !down) {
    return (
      <div className="mbanner warn" role="alert">
        <b>Server sa o {mmss(left)} reštartuje (aktualizácia).</b>
        <span>{m.message ? m.message + ' ' : ''}Zmeny sa ukladajú samy, pred reštartom sa uloží všetko – rozpísaný text radšej dokonči.</span>
      </div>
    );
  }
  return (
    <div className="mbanner warn" role="status">
      <b>Prebieha reštart servera…</b>
      <span>Môžeš pracovať ďalej: zmeny sa ukladajú do zariadenia{pending ? ` (čaká ${pending})` : ''} a odošlú sa, hneď ako server nabehne.</span>
    </div>
  );
}
