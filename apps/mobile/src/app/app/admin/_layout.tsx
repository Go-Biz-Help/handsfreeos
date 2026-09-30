import { router, Stack } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useStaff } from '@/admin/staff';
import { DESK_PHONE_WORDS } from '@/admin/words';
import { DeskNeedSignal } from '@/components/admin/bits';
import { DeskProvider } from '@/components/admin/staff-context';
import { SignOutSheet } from '@/components/shell/sign-out-sheet';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { errorMessage } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { useMe } from '@/lib/businesses';
import { colors, useColors, useThemeName } from '@/theme';

/** A desk screen that can't draw shows why, and the rest of the app still works. */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

/**
 * HandsFreeOS's own support desk on the phone (the web's /admin, M13), at /app/admin. It belongs to no business, so it
 * sits beside /app/w rather than in one, behind one question: does this person work here? Anyone else is told this
 * isn't for them, with a way back; the API refuses every desk query and command for them anyway.
 */
export default function AdminLayout() {
  const state = useSession();
  if (state.status !== 'signedIn') return null;
  return <StaffGate userId={state.person.userId} />;
}

function StaffGate({ userId }: { userId: string }) {
  const theme = useThemeName();
  const { staff, status, error, reload } = useStaff(userId);
  const desk = React.useMemo(() => (staff ? { userId, staff } : null), [userId, staff]);

  if (desk)
    return (
      <DeskProvider value={desk}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors[theme].bg },
          }}
        />
      </DeskProvider>
    );
  if (status === 'ready') return <NotStaff userId={userId} />;
  return <Checking error={status === 'error' ? errorMessage(error) : null} onRetry={reload} />;
}

function Checking({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View
      className="flex-1 items-center justify-center gap-3 bg-bg px-6"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      testID="desk-checking"
    >
      {error ? (
        <DeskNeedSignal error={error} onRetry={onRetry} />
      ) : (
        <>
          <ActivityIndicator color={colors.accent} />
          <Text className="text-text-2">{DESK_PHONE_WORDS.checking}</Text>
        </>
      )}
    </View>
  );
}

/** Someone who doesn't answer support, here from an old link or a phone that remembered them as staff. */
function NotStaff({ userId }: { userId: string }) {
  const insets = useSafeAreaInsets();
  const { me } = useMe(userId);
  const [signingOut, setSigningOut] = React.useState(false);
  const hasBusiness = (me?.businesses.length ?? 0) > 0;
  return (
    <View
      className="flex-1 items-center justify-center gap-3 bg-bg px-8"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      testID="desk-not-staff"
    >
      <Text variant="heading" className="text-center">
        {DESK_PHONE_WORDS.title}
      </Text>
      <Text className="text-center leading-[22px] text-text-2">{DESK_PHONE_WORDS.notStaff}</Text>
      {hasBusiness ? (
        <Button onPress={() => router.replace('/app')} testID="desk-back-to-business">
          {DESK_PHONE_WORDS.backToBusiness}
        </Button>
      ) : null}
      <Button variant="ghost" onPress={() => setSigningOut(true)}>
        {DESK_PHONE_WORDS.signOut}
      </Button>
      <SignOutSheet open={signingOut} onClose={() => setSigningOut(false)} />
    </View>
  );
}
