import { Stack } from 'expo-router';

import { colors, useThemeName } from '@/theme';

/** The signed-in app, mirroring the web's /app. */
export default function AppLayout() {
  const theme = useThemeName();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
    />
  );
}
