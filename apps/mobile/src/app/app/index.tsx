import { Redirect } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useStaff } from '@/admin/staff';
import { CreateBusiness } from '@/components/onboarding-setup/create-business';
import { SignOutSheet } from '@/components/shell/sign-out-sheet';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { errorMessage } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { chooseBusiness, lastOpenedBusiness, useMe } from '@/lib/businesses';
import { useNetwork } from '@/lib/network';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { useColors } from '@/theme';

/**
 * Opens the business the person had open last (or their first), once the phone knows their businesses. Somebody who
 * answers HandsFreeOS support and is in no business goes to the Support desk instead, as the web sends them to /admin.
 * Anyone else in no business, as straight after signing up, makes theirs here: the setup's first screen
 * (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8), which then opens the rest of the setup.
 */
export default function ChooseBusiness() {
  const state = useSession();
  if (state.status !== 'signedIn') return null;
  return <Chooser userId={state.person.userId} />;
}

function Chooser({ userId }: { userId: string }) {
  const { me, status, error, reload } = useMe(userId);
  const { staff, status: staffStatus } = useStaff(userId);
  const { online } = useNetwork();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [signingOut, setSigningOut] = React.useState(false);
  // The business being made here opens on its setup, not on Home, once it joins the list.
  const [making, setMaking] = React.useState(false);
  // Back from the browser, where an invitation may have just been accepted: the businesses are asked for again.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') reload();
    });
    return () => sub.remove();
  }, [reload]);

  if (me && !making) {
    const business = chooseBusiness(me.businesses, lastOpenedBusiness(userId));
    if (business) return <Redirect href={`/app/w/${business.id}`} />;
    if (staff) return <Redirect href="/app/admin" />;
  }

  // Somebody in no business may yet be on the support desk: they wait for that answer, while there's a signal to get it.
  const noBusiness = Boolean(me) && !(online && staffStatus === 'loading');
  const waiting = me ? !noBusiness : status === 'loading';
  const signOut = <SignOutSheet open={signingOut} onClose={() => setSigningOut(false)} />;

  if (noBusiness || making)
    return (
      <View className="flex-1 bg-bg" testID="choose-business">
        <CreateBusiness
          userId={userId}
          onMaking={setMaking}
          trailing={
            <Button
              variant="ghost"
              size="sm"
              onPress={() => setSigningOut(true)}
              testID="choose-business-sign-out"
            >
              {P.signOut}
            </Button>
          }
        />
        {signOut}
      </View>
    );

  return (
    <View
      className="flex-1 items-center justify-center gap-3 bg-bg px-8"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      testID="choose-business"
    >
      {waiting ? (
        <>
          <ActivityIndicator color={colors.accent} />
          <Text className="text-text-2">Getting your businesses…</Text>
        </>
      ) : (
        <>
          <Text variant="heading" className="text-center">
            Your businesses didn’t load
          </Text>
          <Text className="text-center leading-[22px] text-text-2">{errorMessage(error)}</Text>
          <Button onPress={reload} testID="retry-businesses">
            Try again
          </Button>
          <Button
            variant="ghost"
            onPress={() => setSigningOut(true)}
            testID="choose-business-sign-out"
          >
            {P.signOut}
          </Button>
        </>
      )}
      {signOut}
    </View>
  );
}
