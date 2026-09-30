import type { PushSwitch, PushSwitches } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { Linking, View } from 'react-native';

import { useStaff } from '@/admin/staff';
import { BellRing, Info, Smartphone } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { change } from '@/changes';
import { usePushRegistration } from '@/push/hooks';
import { pushRegistration } from '@/push/device';
import type { RegistrationSnapshot } from '@/push/registration';
import {
  EMAIL_ONLY_ROWS,
  emailSwitchesFrom,
  managesAnAgency,
  NOTIFICATION_ROWS,
  phonesWords,
  pushSwitchesFrom,
  savedWords,
  type EmailSwitch,
  type EmailSwitches,
  type NotificationRow,
} from '@/push/switches';

/**
 * Settings → Notifications (design/m10/More.dc.html): whether this phone gets notifications, then a push switch for
 * each moment beside today's email switches. The switches are the person's, the same as the web's Settings → Account,
 * so they need signal to save ("This needs signal."), and a change made on the web shows here as the person's profile
 * syncs. Someone who answers HandsFreeOS support also has New support tickets.
 */
export default function NotificationSettings() {
  const { me, business, userId } = useBusiness();
  const registration = usePushRegistration();
  const { data: profile } = useQuery<{ settings: string | null }>(
    'SELECT settings FROM my_profile WHERE id = ?',
    [userId],
  );
  const { data: phones } = useQuery<{ n: number }>(
    'SELECT count(*) AS n FROM push_devices WHERE disabled_at IS NULL',
  );
  const settings = profile[0]?.settings ?? null;
  const syncedPush = React.useMemo(() => pushSwitchesFrom(settings), [settings]);
  const syncedEmail = React.useMemo(() => emailSwitchesFrom(settings), [settings]);
  // What was just switched, shown until the profile syncs back with it.
  const [push, setPush] = React.useState<PushSwitches | null>(null);
  const [email, setEmail] = React.useState<EmailSwitches | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (push && sameSwitches(push, syncedPush)) setPush(null);
  }, [push, syncedPush]);
  React.useEffect(() => {
    if (email && sameSwitches(email, syncedEmail)) setEmail(null);
  }, [email, syncedEmail]);

  const shownPush = push ?? syncedPush;
  const shownEmail = email ?? syncedEmail;
  const agency = managesAnAgency(me);
  const { staff } = useStaff(userId);

  const save = async (
    settingsPatch: { push: PushSwitches } | { notifications: EmailSwitches },
    words: string,
    undo: () => void,
  ) => {
    setSaving(true);
    try {
      await change('user.update_profile', { settings: settingsPatch });
      toast.show(words);
    } catch (error) {
      undo();
      toast.error(error instanceof Error ? error.message : 'Something went wrong. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const togglePush = (row: NotificationRow, key: PushSwitch, on: boolean) => {
    const next = { ...shownPush, [key]: on };
    setPush(next);
    void save({ push: next }, savedWords(row, 'push', on), () => setPush(null));
  };
  const toggleEmail = (row: NotificationRow, key: EmailSwitch, on: boolean) => {
    const next = { ...shownEmail, [key]: on };
    setEmail(next);
    void save({ notifications: next }, savedWords(row, 'email', on), () => setEmail(null));
  };

  const count = phones[0]?.n ?? 0;
  return (
    <Screen
      title="Notifications"
      leading="back"
      back={businessHref(business.id, 'settings')}
      testID="notification-settings"
    >
      <ListLabel>This phone</ListLabel>
      <ThisPhone registration={registration} />

      <View className="flex-row items-center justify-between gap-2 px-1 pt-2">
        <Text variant="group">Push and email</Text>
        <Badge variant={count > 0 ? 'accent' : 'gray'} testID="notification-phones">
          <Icon
            as={Smartphone}
            className={count > 0 ? 'size-[13px] text-accent-text' : 'size-[13px] text-text-2'}
          />
          <Text>{phonesWords(count)}</Text>
        </Badge>
      </View>
      <Grid
        rows={NOTIFICATION_ROWS.filter((row) => staff || !row.staffOnly)}
        push={shownPush}
        email={shownEmail}
        disabled={saving}
        onPush={togglePush}
        onEmail={toggleEmail}
        testID="notification-grid"
      />

      <ListLabel>Email only</ListLabel>
      <Grid
        rows={EMAIL_ONLY_ROWS.filter((row) => agency || !row.agencyOnly)}
        push={shownPush}
        email={shownEmail}
        disabled={saving}
        onPush={togglePush}
        onEmail={toggleEmail}
        header={false}
        testID="notification-email-only"
      />

      <View className="flex-row items-start gap-[9px] rounded-[10px] bg-card-2 px-3 py-[11px]">
        <Icon as={Info} className="mt-px size-4 text-text-2" />
        <Text className="flex-1 text-[13.5px] leading-[19px] text-text-2">
          Push goes to every phone you’re signed in on. The same switches are on the web, under
          Settings → Account.
        </Text>
      </View>
    </Screen>
  );
}

function sameSwitches<T extends object>(a: T, b: T): boolean {
  return (Object.keys(a) as (keyof T)[]).every((k) => a[k] === b[k]);
}

/** Whether this phone gets notifications, and the way to turn them on. */
function ThisPhone({ registration }: { registration: RegistrationSnapshot }) {
  const [asking, setAsking] = React.useState(false);
  const { status, permission, canAskAgain } = registration;
  const [label, detail] =
    status === 'no-project'
      ? [
          'Not in this build',
          'This build of the app isn’t set up for notifications, so this phone gets none.',
        ]
      : permission === 'denied' || (permission !== 'granted' && !canAskAgain)
        ? ['Off', 'Notifications for HandsFreeOS are turned off in this phone’s settings.']
        : permission !== 'granted'
          ? [
              'Not turned on',
              'Turn them on to hear about customers, urgent items and approvals here.',
            ]
          : status === 'registered'
            ? ['On', 'This phone gets the notifications you have on below.']
            : status === 'waiting-for-signal'
              ? ['Waiting for signal', 'This phone is added to your phones once there’s signal.']
              : status === 'failed'
                ? [
                    'Not added',
                    registration.message ?? 'HandsFreeOS couldn’t add this phone. Try again.',
                  ]
                : ['Setting up', 'Adding this phone to your phones…'];

  const turnOn = async () => {
    setAsking(true);
    try {
      const answer = await pushRegistration.ask();
      if (answer !== 'granted') toast.show('Notifications stay off on this phone.');
    } finally {
      setAsking(false);
    }
  };

  const action =
    status === 'failed' ? (
      <Button
        variant="secondary"
        onPress={() => void pushRegistration.sync()}
        testID="add-this-phone"
      >
        Try again
      </Button>
    ) : status === 'no-project' ||
      permission === 'granted' ||
      permission === null ? null : canAskAgain && permission !== 'denied' ? (
      <Button
        variant="secondary"
        loading={asking}
        onPress={() => void turnOn()}
        testID="turn-on-notifications"
      >
        Turn on notifications
      </Button>
    ) : (
      <Button
        variant="secondary"
        onPress={() => void Linking.openSettings()}
        testID="open-phone-settings"
      >
        Open the phone’s settings
      </Button>
    );

  return (
    <List>
      <View>
        <ListRow
          icon={BellRing}
          label="Notifications on this phone"
          detail={detail}
          end={
            <Text className="text-sm text-text-3" testID="this-phone-notifications">
              {label}
            </Text>
          }
          testID="this-phone-row"
        />
        {action ? <View className="px-4 pb-3">{action}</View> : null}
      </View>
    </List>
  );
}

/** "When · Push · Email", one row per moment, with a switch, "Always" or a dash in each column. */
function Grid({
  rows,
  push,
  email,
  disabled,
  onPush,
  onEmail,
  header = true,
  testID,
}: {
  rows: readonly NotificationRow[];
  push: PushSwitches;
  email: EmailSwitches;
  disabled: boolean;
  onPush: (row: NotificationRow, key: PushSwitch, on: boolean) => void;
  onEmail: (row: NotificationRow, key: EmailSwitch, on: boolean) => void;
  header?: boolean;
  testID?: string;
}) {
  return (
    <View className="overflow-hidden rounded-card border border-border bg-card" testID={testID}>
      {header ? (
        <View className="flex-row items-center gap-2.5 border-b border-border bg-card-2 px-3.5 py-2">
          <Text variant="group" className="flex-1">
            When
          </Text>
          <Text variant="group" className="w-[46px] text-center">
            Push
          </Text>
          <Text variant="group" className="w-[46px] text-center">
            Email
          </Text>
        </View>
      ) : null}
      {rows.map((row, i) => (
        <View
          key={row.title}
          className={`flex-row items-center gap-2.5 px-3.5 py-[11px] ${i > 0 ? 'border-t border-border' : ''}`}
        >
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-[15px] font-medium leading-5">{row.title}</Text>
            <Text className="text-[12.5px] leading-[17px] text-text-3">{row.detail}</Text>
          </View>
          <View className="w-[46px] items-center">
            {row.push ? (
              <Switch
                size="sm"
                label={`${row.title}: push`}
                checked={push[row.push]}
                disabled={disabled}
                onCheckedChange={(on) => onPush(row, row.push!, on)}
                testID={`push-${row.push}`}
              />
            ) : (
              <Text className="text-sm text-text-3">—</Text>
            )}
          </View>
          <View className="w-[46px] items-center">
            {row.email === 'always' ? (
              <Text className="text-[13px] text-text-3">Always</Text>
            ) : row.email ? (
              <Switch
                size="sm"
                label={`${row.title}: email`}
                checked={email[row.email]}
                disabled={disabled}
                onCheckedChange={(on) => onEmail(row, row.email as EmailSwitch, on)}
                testID={`email-${row.email}`}
              />
            ) : (
              <Text className="text-sm text-text-3">—</Text>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}
