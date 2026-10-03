import {
  APPEARANCE_WORDS,
  BALANCE_WORDS,
  formatPhone,
  keptBusinessesLine,
  MY_CELL_WORDS,
  PHONE_SETTINGS_WORDS,
  SAFETY_PHONE_WORDS,
} from '@hfos/core';
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
  ShieldCheck,
  Smartphone,
  User,
  UserX,
  Wallet,
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
import { useMoneyRole } from '@/money/use-money';
import { useWorksOffline } from '@/sync/hooks';

/**
 * Settings on the phone are about you and this phone: Face ID, the businesses kept here, the changes waiting, how it
 * looks, signing out and deleting the account. Setting the business up — texting, payments, members, calendars —
 * stays on the web; its balance does not, because running out of it stops the texts and calls this app is for, and
 * nor do its add-ons, which owners and admins manage on the phone too (the owner's decision, 2026-09-28).
 */
export default function Settings() {
  const { me, business, userId } = useBusiness();
  const appearance = useAppearance();
  const choices = useKeepChoices(userId);
  const worksOffline = useWorksOffline(userId);
  const { cell } = useMyCell();
  // The business's balance is for whoever manages its money here (0106).
  const { whole } = useMoneyRole();
  // Add-ons are for whoever may install them (0108); nobody else sees the row.
  const [info, setInfo] = React.useState<BiometricInfo | null>(null);
  const [lockOn, setLockOn] = React.useState(() => lockEnabledFor(userId));
  const [appearanceOpen, setAppearanceOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  React.useEffect(() => {
    void biometrics.info().then(setInfo);
  }, []);

  const kept = me.businesses.filter((b) => isKept(choices, b.id));
  const coming = kept.filter((b) => !worksOffline(b.id)).length;
  const keptDetail = keptBusinessesLine(kept, coming);

  const toggleLock = async (next: boolean) => {
    // Turning the lock on or off asks first, so it can't be switched off by whoever picks the phone up.
    const result = await biometrics.authenticate(
      next ? PHONE_SETTINGS_WORDS.lockOn : PHONE_SETTINGS_WORDS.lockOff,
    );
    if (result !== 'unlocked') {
      if (result === 'failed') toast.error(PHONE_SETTINGS_WORDS.lockRefused);
      return;
    }
    setLockEnabledFor(userId, next);
    setLockOn(next);
  };

  const method = info?.method ?? 'Face ID';
  return (
    <Screen
      title={PHONE_SETTINGS_WORDS.title}
      leading="back"
      back={businessHref(business.id, 'more')}
      testID="settings"
      contentClassName="gap-2"
    >
      <ListLabel>{PHONE_SETTINGS_WORDS.thisPhone}</ListLabel>
      <List>
        <ListRow
          icon={Smartphone}
          label={MY_CELL_WORDS.title}
          detail={
            cell?.verifiedAt
              ? `${formatPhone(cell.e164)} · ${MY_CELL_WORDS.verified}`
              : cell
                ? `${formatPhone(cell.e164)} · ${MY_CELL_WORDS.notVerified}`
                : PHONE_SETTINGS_WORDS.myCellDetail
          }
          onPress={() => router.push(businessHref(business.id, 'settings/my-cell'))}
          testID="setting-my-cell"
        />
        <ListRow
          icon={method === 'fingerprint' || method === 'Touch ID' ? Fingerprint : ScanFace}
          label={unlockLabel(method)}
          detail={
            info && !info.available
              ? PHONE_SETTINGS_WORDS.lockUnavailable
              : PHONE_SETTINGS_WORDS.lockDetail
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
          label={PHONE_SETTINGS_WORDS.businesses}
          detail={keptDetail}
          onPress={() => router.push(businessHref(business.id, 'settings/businesses'))}
          testID="setting-businesses"
        />
        <ListRow
          icon={CloudCheck}
          label={PHONE_SETTINGS_WORDS.changes}
          end={<UpToDate compact />}
          onPress={() => router.push(businessHref(business.id, 'changes'))}
          testID="setting-changes"
        />
      </List>

      {whole ? (
        <>
          <ListLabel>{PHONE_SETTINGS_WORDS.thisBusiness}</ListLabel>
          <List>
            {whole ? (
              <ListRow
                icon={Wallet}
                label={BALANCE_WORDS.title}
                detail={BALANCE_WORDS.phoneSettingsDetail}
                onPress={() => router.push(businessHref(business.id, 'settings/usage'))}
                testID="setting-usage"
              />
            ) : null}
          </List>
        </>
      ) : null}

      <ListLabel>{PHONE_SETTINGS_WORDS.you}</ListLabel>
      <List>
        <ListRow
          icon={ShieldCheck}
          label={SAFETY_PHONE_WORDS.mySafety}
          detail={SAFETY_PHONE_WORDS.mySafetyDetail}
          onPress={() => router.push(businessHref(business.id, 'settings/safety'))}
          testID="setting-my-safety"
        />
        <ListRow
          icon={Bell}
          label={PHONE_SETTINGS_WORDS.notifications}
          detail={PHONE_SETTINGS_WORDS.notificationsDetail}
          onPress={() => router.push(businessHref(business.id, 'settings/notifications'))}
          testID="setting-notifications"
        />
        <ListRow
          icon={User}
          label={PHONE_SETTINGS_WORDS.profile}
          detail={me.user.email}
          external
          onPress={() => void openWeb(`/app/w/${business.id}/settings`)}
          testID="setting-profile"
        />
        <ListRow
          icon={Moon}
          label={APPEARANCE_WORDS.title}
          end={APPEARANCE_LABELS[appearance]}
          onPress={() => setAppearanceOpen(true)}
          testID="setting-appearance"
        />
      </List>

      <View className="h-2" />
      <List>
        <ListRow
          icon={LogOut}
          label={PHONE_SETTINGS_WORDS.signOut}
          onPress={() => setSigningOut(true)}
          testID="setting-sign-out"
        />
        <ListRow
          icon={UserX}
          label={PHONE_SETTINGS_WORDS.deleteAccount}
          danger
          onPress={() => router.push(businessHref(business.id, 'settings/delete-account'))}
          testID="setting-delete-account"
        />
      </List>
      <Text className="px-1 text-[12.5px] leading-[18px] text-text-3">
        {PHONE_SETTINGS_WORDS.footnote}
      </Text>

      {testToolsEnabled ? <TestTools /> : null}

      <Sheet
        open={appearanceOpen}
        onClose={() => setAppearanceOpen(false)}
        title={APPEARANCE_WORDS.title}
        testID="appearance-sheet"
      >
        <Text className="mb-3 mt-1 text-sm text-text-2">{APPEARANCE_WORDS.phone}</Text>
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
          {APPEARANCE_WORDS.done}
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
