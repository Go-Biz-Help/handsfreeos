import { Stack } from 'expo-router';

import { colors, useThemeName } from '@/theme';

/**
 * The businesses (/app/w/<business>). A layout of its own makes each business its own route (`[workspaceId]`), so
 * opening another business replaces this one: Expo Router only compares a route's params when its name is the
 * parameter alone, not `w/[workspaceId]`.
 */
export default function BusinessesLayout() {
  const theme = useThemeName();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
    />
  );
}
