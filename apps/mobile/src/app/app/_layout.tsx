import { Stack } from 'expo-router';

import { PhoneCopyGate } from '@/components/copy/copy-gate';
import { colors, useThemeName } from '@/theme';

/** The signed-in app, mirroring the web's /app, reading the person's copy of their businesses on this phone. */
export default function AppLayout() {
  const theme = useThemeName();
  return (
    <PhoneCopyGate>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
      />
    </PhoneCopyGate>
  );
}
