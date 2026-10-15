import { Stack } from 'expo-router';

import { AddonGate } from '@/addons/gate';
import { colors, useThemeName } from '@/theme';

/**
 * AI Sales Coach's screen on the phone, at the web's own address (/app/w/<business>/a/salescoach) and inside More, so
 * the tab bar stays. Listed in `src/links/addon-screens.ts`. Only for someone holding `salescoach.use`, which they
 * hold only while it runs here.
 */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

export default function SalescoachLayout() {
  const theme = useThemeName();
  return (
    <AddonGate addonId="salescoach" permission="salescoach.use">
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
      />
    </AddonGate>
  );
}
