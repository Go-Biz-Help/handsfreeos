export type ThemeChoice = 'light' | 'dark' | 'system';
export const THEME_COOKIE = 'hfos-theme';

export function parseTheme(value: unknown): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** `data-theme` for <html>: explicit choices pin a theme; `system` leaves it to prefers-color-scheme. */
export function themeAttr(theme: ThemeChoice): 'light' | 'dark' | undefined {
  return theme === 'system' ? undefined : theme;
}
