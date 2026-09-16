import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { BusinessProvider } from '@/components/shell/business-context';
import { BusinessSwitcher } from '@/components/shell/business-switcher';
import { useSession } from '@/lib/auth';
import { rememberOpened, useMe } from '@/lib/businesses';
import { colors, useThemeName } from '@/theme';

/** One business, as /app/w/<business> on the web: its tabs, Ask HandsFreeOS, and Changes on this phone. */
export default function BusinessLayout() {
  const state = useSession();
  if (state.status !== 'signedIn') return null;
  return <Business userId={state.person.userId} />;
}

function Business({ userId }: { userId: string }) {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const { me } = useMe(userId);
  const theme = useThemeName();
  const [switcher, setSwitcher] = React.useState(false);
  const business = me?.businesses.find((b) => b.id === workspaceId) ?? null;

  React.useEffect(() => {
    if (business) rememberOpened(userId, business.id);
  }, [business, userId]);

  const value = React.useMemo(
    () => (me && business ? { userId, me, business, openSwitcher: () => setSwitcher(true) } : null),
    [me, business, userId],
  );

  // Not one of this person's businesses (removed, or a link from someone else's): open theirs instead.
  if (!me || !business || !value) return <Redirect href="/app" />;

  return (
    <BusinessProvider value={value}>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors[theme].bg } }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="ask" options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="changes" options={{ presentation: 'fullScreenModal' }} />
      </Stack>
      <BusinessSwitcher
        open={switcher}
        onClose={() => setSwitcher(false)}
        userId={userId}
        me={me}
        currentId={business.id}
      />
    </BusinessProvider>
  );
}
