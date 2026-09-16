import { Stack } from 'expo-router';

import { colors, useThemeName } from '@/theme';

/** Signing in: the email first, then a code or a password. No Create an account: new accounts start on the web. */
export default function AuthLayout() {
  const theme = useThemeName();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
    />
  );
}
