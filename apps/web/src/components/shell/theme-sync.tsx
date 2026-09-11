'use client';
import { useEffect } from 'react';
import { THEME_COOKIE, themeAttr, type ThemeChoice } from '@/lib/theme';

/** Applies the user's saved theme on this device (the cookie is what the server renders from). */
export function ThemeSync({ theme }: { theme: ThemeChoice }) {
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return null;
}

export function applyTheme(theme: ThemeChoice): void {
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
  const attr = themeAttr(theme);
  if (attr) document.documentElement.setAttribute('data-theme', attr);
  else document.documentElement.removeAttribute('data-theme');
}
