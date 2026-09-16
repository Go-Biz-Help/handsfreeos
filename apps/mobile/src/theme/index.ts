import { DarkTheme, DefaultTheme, type Theme } from 'expo-router';
import { useUniwind } from 'uniwind';

import { colors, type ThemeName } from './tokens';

export { colors, fonts, radius, type ColorToken, type ThemeName } from './tokens';

/** The theme showing now (light or dark), whether it was chosen or follows the phone. */
export function useThemeName(): ThemeName {
  const { theme } = useUniwind();
  return theme === 'dark' ? 'dark' : 'light';
}

/** The web's colours for the theme showing now, for props that take a value instead of a class. */
export function useColors() {
  return colors[useThemeName()];
}

/**
 * The navigation theme, from the same tokens: the screens behind a transition and the navigators' own surfaces use
 * it. Without it they stay white in dark (spike 1a).
 */
export const NAV_THEME: Record<ThemeName, Theme> = {
  light: {
    ...DefaultTheme,
    colors: {
      background: colors.light.bg,
      border: colors.light.border,
      card: colors.light.card,
      notification: colors.light.danger,
      primary: colors.light.accent,
      text: colors.light.text,
    },
  },
  dark: {
    ...DarkTheme,
    colors: {
      background: colors.dark.bg,
      border: colors.dark.border,
      card: colors.dark.card,
      notification: colors.dark.danger,
      primary: colors.dark.accent,
      text: colors.dark.text,
    },
  },
};
