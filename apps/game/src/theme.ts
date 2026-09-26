/** Light / dark / follow-the-system theme, remembered per browser when storage is available. */
export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'er-shift-theme';

export function loadTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: ThemeChoice) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

export const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
export const THEME_LABEL: Record<ThemeChoice, string> = { system: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' };
