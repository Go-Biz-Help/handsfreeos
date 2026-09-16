import { View } from 'react-native';

import { CloudCheck, CloudOff } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { changesWord, useSyncStatus } from '@/lib/sync-status';
import { cn } from '@/lib/utils';

/** "8:58 AM", in the phone's own time: when this phone last had signal. */
export function clockTime(ms: number): string {
  return new Date(ms)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(/[\u202f\u00a0]/g, ' ');
}

/**
 * The quiet status line on Home and in More: "Up to date" when every change made on this phone has reached
 * HandsFreeOS, "As of 8:58 AM" with no signal, or how many changes are still to go. `compact` for the end of a list
 * row, where "3 to send" leaves room for the row's own words.
 */
export function UpToDate({ className, compact }: { className?: string; compact?: boolean }) {
  const status = useSyncStatus();
  const [icon, text, tone] = !status.online
    ? [CloudOff, `As of ${clockTime(status.asOf)}`, 'text-warning-text']
    : status.waiting > 0
      ? [
          CloudCheck,
          compact ? `${status.waiting} to send` : `${changesWord(status.waiting)} to send`,
          'text-accent-text',
        ]
      : [CloudCheck, 'Up to date', 'text-success-text'];
  return (
    <View className={cn('flex-row items-center gap-1.5', className)} testID="up-to-date">
      <Icon as={icon} className={cn('size-3.5', tone)} />
      <Text className={cn('text-[12.5px] font-medium', tone)}>{text}</Text>
    </View>
  );
}
