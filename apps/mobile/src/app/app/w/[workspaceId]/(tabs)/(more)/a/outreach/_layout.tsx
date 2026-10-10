import { Stack } from 'expo-router';

import { AddonGate } from '@/addons/gate';
import { colors, useThemeName } from '@/theme';

/**
 * Social Outreach's screens on the phone (decision 44), at the web's own addresses (/app/w/<business>/a/outreach?view=…
 * and a playbook's) and inside More, so the tab bar stays. Each is listed in `src/links/addon-screens.ts`. Only for
 * someone holding `outreach.use`, which they hold only while it runs here.
 */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

export default function OutreachLayout() {
  const theme = useThemeName();
  return (
    <AddonGate addonId="outreach" permission="outreach.use">
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
      />
    </AddonGate>
  );
}
