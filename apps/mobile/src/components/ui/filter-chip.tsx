import * as React from 'react';
import { Pressable } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * A chip that filters a list: on or off, its words, an icon before them and a count after when it has them. The
 * Inbox's statuses and boxes, Approvals' filters and search's kinds share it. One that can't be picked (a kind that
 * waits for signal) shows greyed and says so to screen readers.
 */
export function FilterChip({
  label,
  on,
  onPress,
  icon,
  count,
  disabled,
  testID,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  icon?: React.ReactNode;
  /** A number after the words ("Contacts 7"), quieter than them. */
  count?: string | number | null;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityState={{ selected: on, disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: 6, bottom: 6 }}
      testID={testID}
      className={cn(
        'h-8 flex-row items-center gap-1.5 rounded-full border px-3',
        on ? 'border-accent-soft-2 bg-accent-soft' : 'border-border-strong bg-card',
        disabled && 'opacity-50',
      )}
    >
      {icon}
      <Text className={cn('text-[13.5px] font-medium', on ? 'text-accent-text' : 'text-text-2')}>
        {label}
      </Text>
      {count !== undefined && count !== null ? (
        <Text className={cn('text-[13px]', on ? 'text-accent-text' : 'text-text-3')}>
          {String(count)}
        </Text>
      ) : null}
    </Pressable>
  );
}
