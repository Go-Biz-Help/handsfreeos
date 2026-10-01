import type { PushSwitch, PushSwitches } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { View } from 'react-native';

import { DESK_PHONE_WORDS } from '@/admin/words';
import { deskHref, useDesk } from '@/components/admin/staff-context';
import { Info } from '@/components/icons';
import { ListLabel } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { ThisPhone } from '@/components/shell/this-phone';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { change } from '@/changes';
import { usePushRegistration } from '@/push/hooks';
import { NOTIFICATION_ROWS, pushSwitchesFrom, savedWords } from '@/push/switches';

/**
 * The support desk's own Notifications: whether this phone gets them, and the switches only support people have
 * (New support tickets). Somebody who answers support and is in no business has no business's Settings to find
 * them in, so they are here too. They are the person's switches, the same ones a business's Settings → Notifications
 * and the web's Settings → Account show, so they need signal to save, and the person's profile brings them back.
 */
export default function DeskNotifications() {
  const { userId } = useDesk();
  const registration = usePushRegistration();
  const { data: profile } = useQuery<{ settings: string | null }>(
    'SELECT settings FROM my_profile WHERE id = ?',
    [userId],
  );
  const settings = profile[0]?.settings ?? null;
  const synced = React.useMemo(() => pushSwitchesFrom(settings), [settings]);
  // What was just switched, shown until the profile syncs back with it.
  const [push, setPush] = React.useState<PushSwitches | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (push && (Object.keys(push) as PushSwitch[]).every((k) => push[k] === synced[k]))
      setPush(null);
  }, [push, synced]);

  const shown = push ?? synced;
  const rows = NOTIFICATION_ROWS.filter((row) => row.staffOnly && row.push);

  const toggle = async (row: (typeof rows)[number], key: PushSwitch, on: boolean) => {
    const next = { ...shown, [key]: on };
    setPush(next);
    setSaving(true);
    try {
      await change('user.update_profile', { settings: { push: next } });
      toast.show(savedWords(row, 'push', on));
    } catch (error) {
      setPush(null);
      toast.error(error instanceof Error ? error.message : 'Something went wrong. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      title={DESK_PHONE_WORDS.notifications}
      leading="back"
      back={deskHref()}
      testID="desk-notifications"
    >
      <ListLabel>{DESK_PHONE_WORDS.thisPhone}</ListLabel>
      <ThisPhone registration={registration} />

      <ListLabel>{DESK_PHONE_WORDS.support}</ListLabel>
      <View className="overflow-hidden rounded-card border border-border bg-card">
        {rows.map((row, i) => (
          <View
            key={row.title}
            className={`flex-row items-center gap-2.5 px-3.5 py-[11px] ${i > 0 ? 'border-t border-border' : ''}`}
          >
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-[15px] font-medium leading-5">{row.title}</Text>
              <Text className="text-[12.5px] leading-[17px] text-text-3">{row.detail}</Text>
            </View>
            <Switch
              label={`${row.title}: push`}
              checked={shown[row.push!]}
              disabled={saving}
              onCheckedChange={(on) => void toggle(row, row.push!, on)}
              testID={`push-${row.push}`}
            />
          </View>
        ))}
      </View>

      <View className="flex-row items-start gap-[9px] rounded-[10px] bg-card-2 px-3 py-[11px]">
        <Icon as={Info} className="mt-px size-4 text-text-2" />
        <Text className="flex-1 text-[13.5px] leading-[19px] text-text-2">
          {DESK_PHONE_WORDS.notificationsNote}
        </Text>
      </View>
    </Screen>
  );
}
