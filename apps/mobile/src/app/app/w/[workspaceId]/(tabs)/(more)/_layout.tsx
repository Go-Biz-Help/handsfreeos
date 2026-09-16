import { Stack } from 'expo-router';

import { colors, useThemeName } from '@/theme';

/** More opens the screens that don't fit five tabs, each at the web's own address (/app/w/<business>/customers…). */
export const unstable_settings = { initialRouteName: 'more' };

export default function MoreLayout() {
  const theme = useThemeName();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
    />
  );
}
