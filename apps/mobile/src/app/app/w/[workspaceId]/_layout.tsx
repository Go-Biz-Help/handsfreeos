import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { AskFromNotification } from '@/components/changes/ask-from-notification';
import { OpenBusiness } from '@/components/copy/copy-gate';
import { FinishOnTheWeb } from '@/components/founding/finish-on-web';
import { CallSheetHost } from '@/components/inbox/call-sheet';
import { BusinessProvider } from '@/components/shell/business-context';
import { BusinessSwitcher } from '@/components/shell/business-switcher';
import { useSession } from '@/lib/auth';
import { rememberOpened, useMe } from '@/lib/businesses';
import { colors, useThemeName } from '@/theme';
import { KeepViewFresh } from '@/components/view-as/view-strip';
import { useView } from '@/view-as/state';

/** A business screen that can't draw shows why instead of closing the app. */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

/**
 * One business, as /app/w/<business> on the web: its tabs, Ask HandsFreeOS, Search everything, the AI teammate's test
 * console and quick setup, setting the business up, Changes on this phone, and (test builds) This phone's copy. The
 * call sheet sits over all of them (`startCall`).
 */
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
  const view = useView(userId, workspaceId);

  React.useEffect(() => {
    if (business) rememberOpened(userId, business.id);
  }, [business, userId]);

  const value = React.useMemo(() => {
    if (!me || !business) return null;
    const openSwitcher = () => setSwitcher(true);
    if (!view) return { userId, me, business, openSwitcher, viewing: null };
    // Viewing as a teammate (20261018000100): the screens are for them, with their role and what they may do.
    return {
      userId,
      me: {
        ...me,
        user: { id: view.person.userId, email: view.person.email, fullName: view.person.fullName },
      },
      business: { ...business, role: view.person.role, permissions: view.person.permissions },
      openSwitcher,
      viewing: view,
    };
  }, [me, business, userId, view]);

  // Not one of this person's businesses (removed, or a link from someone else's): open theirs instead.
  if (!me || !business || !value) return <Redirect href="/app" />;
  // Made while founding spots are on sale, and not paid for yet: it's finished on the web (20261027012700). Support
  // viewing as a teammate sees it as it is.
  const unpaid = business.needsPlan === true && !view;

  return (
    <BusinessProvider value={value}>
      {unpaid ? (
        <FinishOnTheWeb />
      ) : (
        <>
          <OpenBusiness businessId={business.id} />
          {view ? <KeepViewFresh view={view} /> : null}
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors[theme].bg },
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="ask" options={{ presentation: 'fullScreenModal' }} />
            <Stack.Screen name="search" options={{ presentation: 'fullScreenModal' }} />
            <Stack.Screen name="ai-test" options={{ presentation: 'fullScreenModal' }} />
            <Stack.Screen name="ai-setup" options={{ presentation: 'fullScreenModal' }} />
            <Stack.Screen name="setup" options={{ presentation: 'fullScreenModal' }} />
            <Stack.Screen name="changes" options={{ presentation: 'fullScreenModal' }} />
            <Stack.Screen name="phone-copy" options={{ presentation: 'fullScreenModal' }} />
          </Stack>
          <AskFromNotification />
          <CallSheetHost />
        </>
      )}
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
