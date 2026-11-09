import { Stack } from 'expo-router';

import { AddonGate } from '@/addons/gate';
import { colors, useThemeName } from '@/theme';

/**
 * AI Social Media Content Creator's screens on the phone (docs/socialcontent.md, part 5), at the web's own addresses
 * (/app/w/<business>/a/socialcontent/creators) and inside More, so the tab bar stays. Listed in
 * `src/links/addon-screens.ts`. Only for someone holding `socialcontent.use`, which they hold only while it runs here.
 */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

export default function SocialcontentLayout() {
  const theme = useThemeName();
  return (
    <AddonGate addonId="socialcontent" permission="socialcontent.use">
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
      />
    </AddonGate>
  );
}
