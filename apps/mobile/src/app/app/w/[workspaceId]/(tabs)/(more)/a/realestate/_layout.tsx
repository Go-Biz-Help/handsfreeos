import { Stack } from 'expo-router';

import { AddonGate } from '@/addons/gate';
import { colors, useThemeName } from '@/theme';

/**
 * Real Estate Agent's screens on the phone (round six), at the web's own addresses (/app/w/<business>/a/realestate/…)
 * and inside More, so the tab bar stays. Each is listed in `src/links/addon-screens.ts` once it's built, and links to
 * it open here from then on. Only for someone holding `realestate.use`, which they hold only while it runs here.
 */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

export default function RealestateLayout() {
  const theme = useThemeName();
  return (
    <AddonGate addonId="realestate" permission="realestate.use">
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
      />
    </AddonGate>
  );
}
