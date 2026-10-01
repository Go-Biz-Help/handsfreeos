import { Redirect } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useStaff } from '@/admin/staff';
import { SignOutSheet } from '@/components/shell/sign-out-sheet';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { errorMessage } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { chooseBusiness, lastOpenedBusiness, useMe } from '@/lib/businesses';
import { useNetwork } from '@/lib/network';
import { openWeb } from '@/lib/open-web';
import { useColors } from '@/theme';

/**
 * Opens the business the person had open last (or their first), once the phone knows their businesses. Somebody who
 * answers HandsFreeOS support and is in no business goes to the Support desk instead, as the web sends them to /admin.
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

  if (me) {
    const business = chooseBusiness(me.businesses, lastOpenedBusiness(userId));
    if (business) return <Redirect href={`/app/w/${business.id}`} />;
    if (staff) return <Redirect href="/app/admin" />;
  }

  // Somebody in no business may yet be on the support desk: they wait for that answer, while there's a signal to get it.
  const noBusiness = Boolean(me) && !(online && staffStatus === 'loading');
  const waiting = me ? !noBusiness : status === 'loading';
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
            {noBusiness ? 'No business yet' : 'Your businesses didn’t load'}
          </Text>
          <Text className="text-center leading-[22px] text-text-2">
            {noBusiness
              ? 'You aren’t part of a business yet. Businesses are set up on the web, and an invitation brings you in.'
              : errorMessage(error)}
          </Text>
          {noBusiness ? (
            <Button variant="secondary" onPress={() => void openWeb('/app')}>
              Open HandsFreeOS on the web
            </Button>
          ) : (
            <Button onPress={reload} testID="retry-businesses">
              Try again
            </Button>
          )}
          <Button variant="ghost" onPress={() => setSigningOut(true)}>
            Sign out
          </Button>
        </>
      )}
      <SignOutSheet open={signingOut} onClose={() => setSigningOut(false)} />
    </View>
  );
}
