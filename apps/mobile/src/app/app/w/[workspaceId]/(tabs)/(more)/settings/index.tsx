import { formatPhone, MY_CELL_WORDS } from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import {
  Bell,
  CloudCheck,
  Fingerprint,
  Layers,
  LogOut,
  Moon,
  ScanFace,
  Smartphone,
  User,
  UserX,
} from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { SignOutSheet } from '@/components/shell/sign-out-sheet';
import { UpToDate } from '@/components/shell/up-to-date';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { APPEARANCE_LABELS, setAppearance, useAppearance, type Appearance } from '@/lib/appearance';
import { biometrics, unlockLabel, type BiometricInfo } from '@/lib/biometrics';
import { useMyCell } from '@/inbox/cell';
import { isKept, useKeepChoices } from '@/lib/businesses';
import { testToolsEnabled } from '@/lib/config';
import { lockEnabledFor, setLockEnabledFor } from '@/lib/lock';
import { isTestOffline, setTestOffline, useNetwork } from '@/lib/network';
import { openWeb } from '@/lib/open-web';
import { expireSavedSignIn } from '@/lib/test-tools';
import { useWorksOffline } from '@/sync/hooks';

/**
 * Settings on the phone are about you and this phone: Face ID, the businesses kept here, the changes waiting, how it
 * looks, signing out and deleting the account. Everything about the business stays on the web.
 */
export default function Settings() {
  const { me, business, userId } = useBusiness();
  const appearance = useAppearance();
  const choices = useKeepChoices(userId);
  const worksOffline = useWorksOffline(userId);
  const { cell } = useMyCell();
  const [info, setInfo] = React.useState<BiometricInfo | null>(null);
  const [lockOn, setLockOn] = React.useState(() => lockEnabledFor(userId));
  const [appearanceOpen, setAppearanceOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  React.useEffect(() => {
    void biometrics.info().then(setInfo);
  }, []);

  const kept = me.businesses.filter((b) => isKept(choices, b.id));
  const coming = kept.filter((b) => !worksOffline(b.id)).length;
  const keptDetail =
    kept.length === 0
      ? 'None: every business opens only with signal'
      : coming > 0
        ? `Getting ${coming === 1 ? 'one' : coming} onto this phone…`
        : kept.length === 1
          ? `${kept[0]!.name} · works with no signal`
          : `${kept.length} businesses · work with no signal`;

  const toggleLock = async (next: boolean) => {
    // Turning the lock on or off asks first, so it can't be switched off by whoever picks the phone up.
    const result = await biometrics.authenticate(next ? 'Turn on the lock' : 'Turn off the lock');
    if (result !== 'unlocked') {
      if (result === 'failed') toast.error('That didn’t match, so nothing changed.');
      return;
    }
    setLockEnabledFor(userId, next);
    setLockOn(next);
  };

  const method = info?.method ?? 'Face ID';
  return (
    <Screen
      title="Settings"
      leading="back"
      back={businessHref(business.id, 'more')}
      testID="settings"
      contentClassName="gap-2"
    >
      <ListLabel>This phone</ListLabel>
      <List>
        <ListRow
          icon={method === 'fingerprint' || method === 'Touch ID' ? Fingerprint : ScanFace}
          label={unlockLabel(method)}
          detail={
            info && !info.available
              ? 'Set up Face ID, a fingerprint or a passcode on this phone first'
              : 'Asks when you open the app'
          }
          end={
            <Switch
              label={unlockLabel(method)}
              testID="setting-lock"
              checked={Boolean(info?.available) && lockOn}
              disabled={!info?.available}
              onCheckedChange={(next) => void toggleLock(next)}
            />
          }
        />
        <ListRow
          icon={Layers}
          label="Businesses on this phone"
          detail={keptDetail}
          onPress={() => router.push(businessHref(business.id, 'settings/businesses'))}
          testID="setting-businesses"
        />
        <ListRow
          icon={CloudCheck}
          label="Changes on this phone"
          end={<UpToDate compact />}
          onPress={() => router.push(businessHref(business.id, 'changes'))}
          testID="setting-changes"
        />
      </List>

      <ListLabel>You</ListLabel>
      <List>
        <ListRow
          icon={Bell}
          label="Notifications"
          detail="Push and email"
          onPress={() => router.push(businessHref(business.id, 'settings/notifications'))}
          testID="setting-notifications"
        />
        <ListRow
          icon={Smartphone}
          label={MY_CELL_WORDS.title}
          detail={
            cell?.verifiedAt
              ? `${formatPhone(cell.e164)} · ${MY_CELL_WORDS.verified}`
              : cell
                ? `${formatPhone(cell.e164)} · ${MY_CELL_WORDS.notVerified}`
                : 'Where Call rings you first'
          }
          onPress={() => router.push(businessHref(business.id, 'settings/my-cell'))}
          testID="setting-my-cell"
        />
        <ListRow
          icon={User}
          label="Profile and sign-in"
          detail={me.user.email}
          external
          onPress={() => void openWeb(`/app/w/${business.id}/settings`)}
          testID="setting-profile"
        />
        <ListRow
          icon={Moon}
          label="Appearance"
          end={APPEARANCE_LABELS[appearance]}
          onPress={() => setAppearanceOpen(true)}
          testID="setting-appearance"
        />
      </List>

      <View className="h-2" />
      <List>
        <ListRow
          icon={LogOut}
          label="Sign out"
          onPress={() => setSigningOut(true)}
          testID="setting-sign-out"
        />
        <ListRow
          icon={UserX}
          label="Delete my account"
          danger
          onPress={() => router.push(businessHref(business.id, 'settings/delete-account'))}
          testID="setting-delete-account"
        />
      </List>
      <Text className="px-1 text-[12.5px] leading-[18px] text-text-3">
        Business settings, texting, payments and members are on the web.
      </Text>

      {testToolsEnabled ? <TestTools /> : null}

      <Sheet
        open={appearanceOpen}
        onClose={() => setAppearanceOpen(false)}
        title="Appearance"
        testID="appearance-sheet"
      >
        <Text className="mb-3 mt-1 text-sm text-text-2">
          System follows this phone’s own light or dark setting.
        </Text>
        <Segmented<Appearance>
          label="Appearance"
          value={appearance}
          onChange={setAppearance}
          options={[
            { value: 'system', label: 'System', testID: 'appearance-system' },
            { value: 'light', label: 'Light', testID: 'appearance-light' },
            { value: 'dark', label: 'Dark', testID: 'appearance-dark' },
          ]}
        />
        <Button
          variant="secondary"
          className="mt-4"
          onPress={() => setAppearanceOpen(false)}
          testID="appearance-done"
        >
          Done
        </Button>
      </Sheet>
      <SignOutSheet open={signingOut} onClose={() => setSigningOut(false)} />
    </Screen>
  );
}

/**
 * Development and test builds: pretend there's no signal, make changes to see the queue work, and This phone's copy,
 * for what's kept here.
 */
function TestTools() {
  const { business } = useBusiness();
  const { online } = useNetwork();
  const [offline, setOffline] = React.useState(isTestOffline());
  return (
    <>
      <ListLabel>Test tools</ListLabel>
      <List testID="test-tools">
        <ListRow
          label="This phone’s copy"
          detail="What’s kept here, the key and the last sync"
          onPress={() => router.push(businessHref(business.id, 'phone-copy'))}
          testID="test-phone-copy"
        />
        <ListRow
          label="Test changes"
          detail="Make changes the screens will make, with no signal or late at night"
          onPress={() => router.push(businessHref(business.id, 'test-changes'))}
          testID="test-changes"
        />
        <ListRow
          label="Test notifications"
          detail="What the worker’s stand-in sent this phone, shown as a real push is"
          onPress={() => router.push(businessHref(business.id, 'test-notifications'))}
          testID="test-notifications"
        />
        <ListRow
          label="No signal"
          detail={online ? 'Every request fails, as in a dead zone' : 'The phone has no signal now'}
          end={
            <Switch
              label="No signal"
              testID="test-no-signal"
              checked={offline}
              onCheckedChange={(next) => {
                setTestOffline(next);
                setOffline(next);
              }}
            />
          }
        />
        <ListRow
          label="Access token expired"
          detail="As after an hour with no signal"
          onPress={() =>
            void expireSavedSignIn().then(() =>
              toast.show('The saved sign-in now looks an hour old.'),
            )
          }
          testID="test-expire-sign-in"
        />
        <ListRow
          label="Self-test"
          detail="Time zones and dates on this phone"
          onPress={() => router.push('/self-test')}
          testID="test-self-test"
        />
      </List>
    </>
  );
}
