import { Stack } from 'expo-router';

import { colors, useThemeName } from '@/theme';

/** Signing in (Apple, Google, or the email then a code or a password), and creating an account. */
export default function AuthLayout() {
  const theme = useThemeName();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
    />
  );
}
