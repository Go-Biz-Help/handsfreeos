'use client';
import { useEffect } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { MY_SETTINGS_CHANGED } from '@/components/shell/menu-provider';
import { parseTheme, THEME_COOKIE, themeAttr, type ThemeChoice } from '@/lib/theme';

/**
 * Applies the user's saved theme on this device (the cookie is what the server renders from). The Assistant can
 * change it too, so it reads the saved theme again when their settings change on this page.
 */
export function ThemeSync({ theme }: { theme: ThemeChoice }) {
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(() => {
    const onChanged = () =>
      void apiBrowser()
        .POST('/v1/queries/account.me', { body: {} })
        .then((r) => {
          const settings = unwrap(r).user.settings as { theme?: unknown };
          applyTheme(parseTheme(settings.theme));
        })
        // The next page load reads it anyway.
        .catch(() => undefined);
    window.addEventListener(MY_SETTINGS_CHANGED, onChanged);
    return () => window.removeEventListener(MY_SETTINGS_CHANGED, onChanged);
  }, []);
  return null;
}

export function applyTheme(theme: ThemeChoice): void {
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
  const attr = themeAttr(theme);
  if (attr) document.documentElement.setAttribute('data-theme', attr);
  else document.documentElement.removeAttribute('data-theme');
}
