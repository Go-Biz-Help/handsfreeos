import { View } from 'react-native';

import { CloudCheck, CloudDownload, CloudOff } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { lineText, useSyncStatus } from '@/lib/sync-status';
import { cn } from '@/lib/utils';

/**
 * The quiet status line on Home and in More: "Up to date" once this phone's copy is in step and every change made on
 * it has reached HandsFreeOS, "As of 8:58 AM" with no signal (or no connection), "Updating…" while it catches up, or
 * how many changes are still to go. `compact` for the end of a list row, where "3 to send" leaves room for the row's
 * own words.
 */
export function UpToDate({ className, compact }: { className?: string; compact?: boolean }) {
  const status = useSyncStatus();
  const text = lineText(status, Date.now(), compact);
  const [icon, tone] =
    status.connection === 'offline' || status.connection === 'unreachable'
      ? [CloudOff, 'text-warning-text']
      : status.waiting > 0
        ? [CloudCheck, 'text-accent-text']
        : status.connection === 'updating'
          ? [CloudDownload, 'text-text-3']
          : [CloudCheck, 'text-success-text'];
  return (
    <View className={cn('flex-row items-center gap-1.5', className)} testID="up-to-date">
      <Icon as={icon} className={cn('size-3.5', tone)} />
      <Text className={cn('text-[12.5px] font-medium', tone)}>{text}</Text>
    </View>
  );
}
