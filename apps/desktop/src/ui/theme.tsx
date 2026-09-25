import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SegmentKind } from '../timelineModel.js';

/**
 * Design tokens. Styles are inline objects rather than a stylesheet:
 * the CSP (`default-src 'self'`) blocks the <style> tags Vite injects
 * in dev, while style properties set through React are allowed.
 */
export interface Theme {
  mode: 'light' | 'dark';
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentHover: string;
  onAccent: string;
  /** One distinct colour per timeline segment kind. */
  kind: Record<SegmentKind, string>;
  danger: string;
  /** Clock in (green) and clock out (red) buttons. */
  go: string;
  goHover: string;
  stop: string;
  stopHover: string;
  warnBg: string;
  warnText: string;
  /** Dial face: working (green), on a break (amber), clocked out (grey). */
  tint: Record<'working' | 'break' | 'off', string>;
  font: string;
}

const font = '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif';

export const light: Theme = {
  mode: 'light',
  bg: '#f4f5f8',
  surface: '#ffffff',
  surfaceAlt: '#eef0f4',
  border: '#dfe3ea',
  text: '#161a21',
  muted: '#5d6675',
  accent: '#4f46e5',
  accentHover: '#4338ca',
  onAccent: '#ffffff',
  kind: {
    working: '#4f46e5', // indigo
    call_teams: '#7c3aed', // purple
    call_zoom: '#0ea5e9', // sky
    call_other: '#f97316', // orange
    bio_break: '#0d9488', // teal
    meal_break: '#d97706', // amber
    other_break: '#65a30d', // lime
    away_meeting: '#c026d3', // fuchsia
    away_phone: '#e11d48', // rose
    away_working: '#475569', // slate
    prompt: '#9ca3af', // grey
  },
  danger: '#c0262d',
  go: '#15803d',
  goHover: '#166534',
  stop: '#c62828',
  stopHover: '#a61b1b',
  warnBg: '#fff4e0',
  warnText: '#7a4a00',
  tint: { working: '#e7f6ec', break: '#fff3dc', off: '#f1f2f5' },
  font,
};

export const dark: Theme = {
  mode: 'dark',
  bg: '#0f1115',
  surface: '#171a21',
  surfaceAlt: '#1f232c',
  border: '#2a303b',
  text: '#e8ebf1',
  muted: '#9aa3b2',
  accent: '#8b93ff',
  accentHover: '#a5abff',
  onAccent: '#0b0e14',
  kind: {
    working: '#8b93ff',
    call_teams: '#a78bfa',
    call_zoom: '#38bdf8',
    call_other: '#fb923c',
    bio_break: '#2dd4bf',
    meal_break: '#fbbf24',
    other_break: '#a3e635',
    away_meeting: '#e879f9',
    away_phone: '#fb7185',
    away_working: '#94a3b8',
    prompt: '#6b7280',
  },
  danger: '#ff6b6b',
  go: '#16a34a',
  goHover: '#15803d',
  stop: '#dc2626',
  stopHover: '#b91c1c',
  warnBg: '#3a2a10',
  warnText: '#ffd28a',
  tint: { working: '#12281b', break: '#2e2410', off: '#1b1e25' },
  font,
};

const ThemeContext = createContext<Theme>(light);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

function prefersDark(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

/** Follows the OS light/dark setting and paints the page background. */
export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [isDark, setIsDark] = useState(prefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => setIsDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const theme = isDark ? dark : light;

  useEffect(() => {
    document.body.style.margin = '0';
    document.body.style.background = theme.bg;
    document.body.style.color = theme.text;
    document.body.style.fontFamily = theme.font;
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  }, [theme, isDark]);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}
