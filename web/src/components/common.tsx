import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { useOnline, usePendingCount } from '../offline';
import { setTheme, useThemeChoice, type ThemeChoice } from '../theme';

/** Modálne okno nad natívnym <dialog>. */
export function Dialog({ open, onClose, title, children, wide }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={wide ? 'wide' : ''} onClose={onClose} onCancel={e => { e.preventDefault(); onClose(); }}>
      {open && <>
        <h3>{title}</h3>
        {children}
      </>}
    </dialog>
  );
}

type Confirm = { title: string; body: ReactNode; ok: string; danger?: boolean; resolve: (v: boolean) => void };

/** Potvrdzovacie okno ako Promise: `if (!await ask({...})) return;` */
export function useConfirm() {
  const [c, setC] = useState<Confirm | null>(null);
  const ask = useCallback((o: Omit<Confirm, 'resolve'>) => new Promise<boolean>(resolve => setC({ ...o, resolve })), []);
  const close = (v: boolean) => { c?.resolve(v); setC(null); };
  const node = (
    <Dialog open={!!c} onClose={() => close(false)} title={c?.title || ''}>
      <div className="confirm-body">{c?.body}</div>
      <div className="row">
        <button className="btn" onClick={() => close(false)}>Zrušiť</button>
        <button className={'btn ' + (c?.danger ? 'danger-fill' : 'primary')} autoFocus onClick={() => close(true)}>{c?.ok}</button>
      </div>
    </Dialog>
  );
  return [ask, node] as const;
}
export type Ask = ReturnType<typeof useConfirm>[0];

/** Stav pripojenia a počet zmien čakajúcich na odoslanie. */
export function NetStatus() {
  const online = useOnline();
  const pending = usePendingCount();
  if (online && !pending) return null;
  return (
    <span className={'net ' + (online ? 'sync' : 'off')} title={pending ? 'Zmeny uložené v zariadení sa odošlú po pripojení.' : ''}>
      {online ? `Odosielam ${pending} zmien…` : `Offline${pending ? ` · ${pending} neodoslaných` : ''}`}
    </span>
  );
}

interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
let deferred: InstallEvent | null = null;
const installListeners = new Set<() => void>();
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferred = e as InstallEvent;
  installListeners.forEach(l => l());
});

/** Tlačidlo „Nainštalovať“ (PWA), zobrazí sa len keď to prehliadač ponúka. */
export function InstallButton() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force(x => x + 1);
    installListeners.add(l);
    return () => { installListeners.delete(l); };
  }, []);
  if (!deferred) return null;
  return (
    <button className="btn" title="Nainštalovať ako aplikáciu do počítača" onClick={async () => {
      await deferred!.prompt();
      deferred = null;
      force(x => x + 1);
    }}>Nainštalovať appku</button>
  );
}

export async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
}

export function formatDate(s: string | null | undefined) {
  if (!s) return '';
  return new Date(s).toLocaleString('sk', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Logo „opravOVÁTOR“: „oprav“ ručne písané (Kalam), „OVÁTOR“ úzke veľké (Bebas Neue). */
export function Brand({ big, title }: { big?: boolean; title?: string }) {
  const inner = <><img className="b-logo" src="/logo.png" alt="" /><span className="b-oprav">oprav</span><span className="b-ovator">OVÁTOR</span></>;
  if (big) return <h1 className="brand big" aria-label="Opravovátor">{inner}</h1>;
  return <Link className="brand" to="/" title={title} aria-label="Opravovátor">{inner}</Link>;
}

const NEXT: Record<ThemeChoice, ThemeChoice> = { auto: 'light', light: 'dark', dark: 'auto' };
const LABEL: Record<ThemeChoice, string> = { auto: 'Téma: podľa systému', light: 'Téma: svetlá', dark: 'Téma: tmavá' };
const ICON: Record<ThemeChoice, ReactNode> = {
  auto: <><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 010 16z" fill="currentColor" /></>,
  light: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  dark: <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />,
};

/** Prepínač témy: podľa systému → svetlá → tmavá. */
export function ThemeButton() {
  const t = useThemeChoice();
  return (
    <button className="btn theme-btn" title={`${LABEL[t]} (klikni na zmenu)`} aria-label={LABEL[t]} onClick={() => setTheme(NEXT[t])}>
      <svg viewBox="0 0 24 24">{ICON[t]}</svg>
    </button>
  );
}
