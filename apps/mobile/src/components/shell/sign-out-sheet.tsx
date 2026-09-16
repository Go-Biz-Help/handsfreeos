import * as React from 'react';
import { View } from 'react-native';

import { LogOut } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { session } from '@/lib/auth';
import { lock } from '@/lib/lock';
import { changesWord, useWaitingCount } from '@/lib/sync-status';

/**
 * "Sign out?" Signing out never throws work away: changes that haven't gone stay on the phone, locked to this person,
 * and go when they sign back in here (someone else signing in first deletes them). The list of those changes arrives
 * with the queue (M10 step 10); until then the sheet gives the count.
 */
export function SignOutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const waiting = useWaitingCount();
  const [busy, setBusy] = React.useState(false);
  const signOut = async () => {
    setBusy(true);
    await session.signOut();
    lock.unlock();
    setBusy(false);
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} testID="sign-out-sheet">
      <View className="flex-row items-start gap-3">
        <View className="size-10 items-center justify-center rounded-menu bg-warning-soft">
          <Icon as={LogOut} className="size-5 text-warning-text" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text variant="sheetTitle">Sign out?</Text>
          <Text className="text-sm leading-5 text-text-2" testID="sign-out-summary">
            {waiting > 0
              ? `${changesWord(waiting)} ${waiting === 1 ? 'hasn’t' : 'haven’t'} been sent. They stay safely on this phone for you.`
              : 'You’ll sign in again with your email next time.'}
          </Text>
        </View>
      </View>
      {waiting > 0 ? (
        <Text className="mt-3 text-[12.5px] leading-[18px] text-text-3">
          They go when you sign back in on this phone. If someone else signs in here first, they are
          deleted.
        </Text>
      ) : null}
      <View className="mt-4 gap-2">
        <Button onPress={onClose} testID="stay-signed-in">
          Stay signed in
        </Button>
        <Button
          variant="dangerOutline"
          loading={busy}
          onPress={() => void signOut()}
          testID="confirm-sign-out"
        >
          Sign out
        </Button>
      </View>
    </Sheet>
  );
}
