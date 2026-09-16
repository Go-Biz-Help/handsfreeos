import { View } from 'react-native';

import { CloudCheck, CloudOff } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { changesWord, useSyncStatus } from '@/lib/sync-status';

/**
 * Changes on this phone. The list (Needs you, Waiting, Sent just now) arrives with the queue of changes in M10 step
 * 10; for now the screen says whether everything has gone.
 */
export default function Changes() {
  const status = useSyncStatus();
  const [title, line] = status.upToDate
    ? ['Up to date', 'Every change made on this phone has reached HandsFreeOS.']
    : status.waiting > 0
      ? [
          `${changesWord(status.waiting)} waiting to send`,
          status.online
            ? 'They’re going now.'
            : 'No signal: they go on their own when the phone is back online.',
        ]
      : ['No signal', 'Anything you change waits on this phone and goes when there’s signal.'];
  return (
    <Screen title="Changes on this phone" leading="close" testID="changes">
      <View className="gap-1 px-1 pb-1 pt-1.5">
        <View className="flex-row items-center gap-2">
          <Icon
            as={status.online ? CloudCheck : CloudOff}
            className={status.upToDate ? 'size-6 text-success-text' : 'size-6 text-warning-text'}
          />
          <Text className="text-2xl font-semibold tracking-[-0.36px]" testID="changes-title">
            {title}
          </Text>
        </View>
        <Text className="text-[13.5px] leading-5 text-text-2">{line}</Text>
      </View>
      <View className="rounded-menu bg-card-2 px-3 py-[11px]">
        <Text className="text-[13.5px] leading-5 text-text-2">
          The list of changes arrives with the queue: what’s waiting, what went, and anything that
          needs you.
        </Text>
      </View>
    </Screen>
  );
}
