import * as React from 'react';
import { AppState, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CloudOff, Fingerprint, ScanFace } from '@/components/icons';
import { Brand } from '@/components/shell/brand';
import { SignOutSheet } from '@/components/shell/sign-out-sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { SignedInPerson } from '@/lib/auth';
import { biometrics, unlockLabel, type UnlockMethod } from '@/lib/biometrics';
import { cachedMe, lastOpenedBusiness } from '@/lib/businesses';
import { lock } from '@/lib/lock';
import { useNetwork } from '@/lib/network';

/**
 * "HandsFreeOS is locked": Face ID, a fingerprint or the phone's passcode opens it. Works the same with no signal,
 * because it only checks the person holding the phone; the sign-in itself is checked again once signal is back.
 */
export function LockScreen({ person }: { person: SignedInPerson }) {
  const insets = useSafeAreaInsets();
  const { online } = useNetwork();
  const [method, setMethod] = React.useState<UnlockMethod>('Face ID');
  const [asking, setAsking] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [signingOut, setSigningOut] = React.useState(false);
  const asked = React.useRef(false);

  const me = cachedMe(person.userId);
  const name = me?.user.fullName || person.name || person.email;
  const lastId = lastOpenedBusiness(person.userId);
  const business = me?.businesses.find((b) => b.id === lastId) ?? me?.businesses[0];

  const unlock = React.useCallback(async () => {
    setAsking(true);
    setMessage(null);
    const result = await biometrics.authenticate('Unlock HandsFreeOS');
    setAsking(false);
    if (result === 'unlocked') lock.unlock();
    else if (result === 'failed') setMessage('That didn’t match. Try again.');
    else if (result === 'unavailable')
      setMessage(
        'Face ID and the phone’s passcode are turned off on this phone, so it can’t be locked.',
      );
  }, []);

  React.useEffect(() => {
    void biometrics.info().then((info) => setMethod(info.method));
    // Ask once when the lock appears with the app in front; after that the button asks again.
    if (!asked.current && AppState.currentState === 'active') {
      asked.current = true;
      void unlock();
    }
  }, [unlock]);

  return (
    <View
      className="absolute inset-0 bg-bg px-[22px]"
      style={{ paddingTop: insets.top + 28, paddingBottom: Math.max(insets.bottom, 16) + 24 }}
      testID="lock-screen"
      accessibilityViewIsModal
    >
      <View className="mt-[60px] items-center gap-3.5">
        <Brand />
        <View className="mt-2.5 items-center gap-1">
          <Text className="text-center text-[22px] font-semibold" role="heading">
            HandsFreeOS is locked
          </Text>
          <Text className="text-center text-[15.5px] text-text-2" numberOfLines={2}>
            {business ? `${name} · ${business.name}` : name}
          </Text>
        </View>
        <View className="mt-[18px] size-[92px] items-center justify-center rounded-[24px] bg-accent-soft">
          <Icon
            as={method === 'fingerprint' || method === 'Touch ID' ? Fingerprint : ScanFace}
            strokeWidth={1.25}
            className="size-[52px] text-accent-text"
          />
        </View>
      </View>
      <View className="flex-1" />
      {!online ? (
        <View
          className="mb-4 flex-row items-start gap-2.5 rounded-menu bg-card-2 px-3 py-[11px]"
          testID="lock-offline-note"
        >
          <Icon as={CloudOff} className="mt-px size-4 text-text-2" />
          <Text className="flex-1 text-[13.5px] leading-5 text-text-2">
            No signal, and still signed in. Your changes wait on the phone, and your sign-in is
            checked again once you’re back online.
          </Text>
        </View>
      ) : null}
      {message ? (
        <Text role="alert" className="mb-3 text-center text-[13.5px] text-danger-text">
          {message}
        </Text>
      ) : null}
      <View className="gap-2">
        <Button
          icon={method === 'fingerprint' || method === 'Touch ID' ? Fingerprint : ScanFace}
          loading={asking}
          onPress={() => void unlock()}
          testID="unlock"
        >
          {unlockLabel(method)}
        </Button>
        <Button variant="ghost" onPress={() => setSigningOut(true)} testID="lock-sign-out">
          Sign out
        </Button>
      </View>
      <SignOutSheet open={signingOut} onClose={() => setSigningOut(false)} />
    </View>
  );
}
