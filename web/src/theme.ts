import { useEffect, useState } from 'react';
import { accentById } from '@opravovator/shared';

export type ThemeChoice = 'auto' | 'light' | 'dark';
const KEY = 'opravovator-theme';
const listeners = new Set<() => void>();

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch { return 'auto'; }
}

/** Skutočne použitá téma (auto → podľa systému). */
export function resolvedTheme(): 'light' | 'dark' {
  const t = getTheme();
  if (t !== 'auto') return t;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const ACCENT_KEY = 'opravovator-accent';
const ACCENT_VARS_KEY = 'opravovator-accent-vars';

export function getAccent(): string | null {
  try { return localStorage.getItem(ACCENT_KEY); } catch { return null; }
}

function soft(hex: string, alpha: number) {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}

/** Nastaví farbu tlačidiel a názvu (id z ACCENTS); bez parametra použije uloženú. */
export function applyAccent(id?: string | null) {
  if (id !== undefined) {
    try {
      if (id) localStorage.setItem(ACCENT_KEY, id); else localStorage.removeItem(ACCENT_KEY);
      const a = accentById(id);
      // pre skript v index.html, ktorý farbu nastaví ešte pred vykreslením
      localStorage.setItem(ACCENT_VARS_KEY, JSON.stringify({ dark: a.dark, light: a.light }));
    } catch { /* */ }
  }
  const a = accentById(getAccent());
  const light = resolvedTheme() === 'light';
  const c = light ? a.light : a.dark;
  const st = document.documentElement.style;
  st.setProperty('--pen', c.pen);
  st.setProperty('--on-pen', c.on);
  st.setProperty('--pen-soft', soft(c.pen, light ? 0.11 : 0.16));
}

export function applyTheme() {
  const t = getTheme();
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  // farba lišty okna nainštalovanej aplikácie
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', resolvedTheme() === 'light' ? '#f7f8fb' : '#1b212b');
  applyAccent();
  listeners.forEach(l => l());
}

export function setTheme(t: ThemeChoice) {
  try { if (t === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* */ }
  applyTheme();
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

export function useResolvedTheme() {
  const [t, set] = useState(resolvedTheme);
  useEffect(() => {
    const l = () => set(resolvedTheme());
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return t;
}

export function useThemeChoice() {
  const [t, set] = useState(getTheme);
  useEffect(() => {
    const l = () => set(getTheme());
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return t;
}
