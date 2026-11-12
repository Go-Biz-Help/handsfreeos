import { Stack } from 'expo-router';

import { AddonGate } from '@/addons/gate';
import { colors, useThemeName } from '@/theme';

/**
 * Contractor Operations' screens on the phone (docs/contractor.md, "On the phone"), at the web's own addresses
 * (/app/w/<business>/a/contractor/jobs/<job>) and inside More, so the tab bar stays. Listed in
 * `src/links/addon-screens.ts`. Only for someone holding `contractor.use`, which they hold only while it runs here.
 */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

export default function ContractorLayout() {
  const theme = useThemeName();
  return (
    <AddonGate addonId="contractor" permission="contractor.use">
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
      />
    </AddonGate>
  );
}
