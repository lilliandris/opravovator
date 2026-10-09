import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { Brand, ThemeButton } from '../components/common';
import { useResolvedTheme } from '../theme';
import { enableLocal } from '../local/session';

interface AuthConfig { googleClientId: string | null; domains: string[]; devLogin: boolean }

declare global {
  interface Window {
    google?: { accounts: { id: {
      initialize(o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: string }): void;
      renderButton(el: HTMLElement, o: Record<string, unknown>): void;
    } } };
  }
}

function loadGsi(): Promise<void> {
  if (window.google?.accounts) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Google prihlásenie sa nepodarilo načítať (si online?).'));
    document.head.append(s);
  });
}

export function Login() {
  const nav = useNavigate();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [error, setError] = useState('');
  const btn = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();
  // kam ísť po prihlásení (napr. ?next=/admin), len adresy v rámci appky
  const next = new URLSearchParams(location.search).get('next');
  const dest = next && /^\/(?!\/)/.test(next) ? next : '/';

  useEffect(() => {
    api('/api/me').then(() => nav(dest, { replace: true })).catch(() => {});
    api<AuthConfig>('/api/auth/config').then(setCfg).catch(() => {}); // bez servera ostane len lokálny režim
  }, [nav, dest]);

  useEffect(() => {
    if (!cfg?.googleClientId || !btn.current) return;
    loadGsi().then(() => {
      window.google!.accounts.id.initialize({
        client_id: cfg.googleClientId!,
        callback: async r => {
          setError('');
          try {
            await api('/api/auth/google', { method: 'POST', body: { credential: r.credential } });
            nav(dest, { replace: true });
          } catch (e) { setError((e as Error).message); }
        },
      });
      window.google!.accounts.id.renderButton(btn.current!, { theme: theme === 'light' ? 'outline' : 'filled_black', size: 'large', text: 'signin_with', shape: 'pill', locale: 'sk' });
    }).catch(e => setError(e.message));
  }, [cfg, nav, theme, dest]);

  async function devLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/api/auth/dev', { method: 'POST', body: { email: f.get('email'), name: f.get('name') } });
      nav(dest, { replace: true });
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="auth">
      <ThemeButton />
      <div className="auth-card">
        <Brand big />
        {cfg?.googleClientId && <div ref={btn} className="gbtn" />}
        <button className="btn local-btn" onClick={() => { enableLocal(); nav('/'); }}>Pracovať lokálne</button>
        {cfg && !cfg.googleClientId && !cfg.devLogin && (
          <p className="error">Server nemá nastavené GOOGLE_CLIENT_ID – prihlásenie nie je možné. Pozri README.</p>
        )}
        {cfg?.devLogin && (
          <form onSubmit={devLogin} className="devlogin">
            <div className="or">testovacie prihlásenie (DEV_LOGIN)</div>
            <label className="field"><span>E-mail</span><input className="input" name="email" type="email" required /></label>
            <label className="field"><span>Meno</span><input className="input" name="name" /></label>
            <button className="btn primary">Prihlásiť</button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
