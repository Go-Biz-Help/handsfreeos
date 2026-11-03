import { Stack } from 'expo-router';

import { opensFirst } from '@/components/shell/first-screen';
import { colors, useThemeName } from '@/theme';

/**
 * More opens the screens that don't fit five tabs, each at the web's own address (/app/w/<business>/customers…). Its
 * list stays at the bottom, so Back from one opened from another tab (Home's bell, a notification) comes to the list
 * rather than leaving the screen on top of More.
 */
export const unstable_settings = { initialRouteName: 'more' };

const MORE_FIRST = opensFirst({ name: 'more' });

/** A More screen that can't draw shows why, and the other tabs still work. */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

export default function MoreLayout() {
  const theme = useThemeName();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
      screenListeners={MORE_FIRST}
    />
  );
}
