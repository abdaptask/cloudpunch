import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SegmentKind } from '../timelineModel.js';

/**
 * Design tokens. Styles are inline objects rather than a stylesheet:
 * the CSP (`default-src 'self'`) blocks the <style> tags Vite injects
 * in dev, while style properties set through React are allowed.
 */
export interface Theme {
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
  warnBg: string;
  warnText: string;
  font: string;
}

const font = '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif';

export const light: Theme = {
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
    on_call: '#e11d48', // rose
    bio_break: '#0d9488', // teal
    meal_break: '#d97706', // amber
    other_break: '#65a30d', // lime
    away_meeting: '#c026d3', // fuchsia
    away_phone: '#0284c7', // sky
    away_working: '#6d28d9', // violet
    prompt: '#9ca3af', // grey
  },
  danger: '#c0262d',
  warnBg: '#fff4e0',
  warnText: '#7a4a00',
  font,
};

export const dark: Theme = {
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
    on_call: '#fb7185',
    bio_break: '#2dd4bf',
    meal_break: '#fbbf24',
    other_break: '#a3e635',
    away_meeting: '#e879f9',
    away_phone: '#38bdf8',
    away_working: '#a78bfa',
    prompt: '#6b7280',
  },
  danger: '#ff6b6b',
  warnBg: '#3a2a10',
  warnText: '#ffd28a',
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
