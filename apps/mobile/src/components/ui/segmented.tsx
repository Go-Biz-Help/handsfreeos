import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeName } from '@/theme';
import { shadows } from '@/theme/tokens';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly testID?: string;
  /** Shown but not choosable. */
  readonly disabled?: boolean;
}

/**
 * The web's Segmented (Mine / Everyone, System / Light / Dark) at phone size: a card-2 track with the chosen option
 * raised on the card colour. Each option is 34 px tall inside a 40 px track, with a 44 px touch area.
 */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  testID,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** Names the group for screen readers ("Appearance"). */
  label: string;
  className?: string;
  testID?: string;
}) {
  const theme = useThemeName();
  return (
    <View
      role="tablist"
      accessibilityLabel={label}
      testID={testID}
      className={cn('flex-row gap-0.5 rounded-[9px] bg-card-2 p-[3px]', className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            role="tab"
            testID={option.testID}
            accessibilityState={{ selected, disabled: option.disabled }}
            disabled={option.disabled}
            hitSlop={{ top: 5, bottom: 5 }}
            onPress={() => {
              if (!selected) onChange(option.value);
            }}
            className={cn(
              'h-[34px] min-w-0 flex-1 items-center justify-center rounded-[7px] px-2',
              selected && 'bg-card',
              option.disabled && 'opacity-50',
            )}
            style={selected ? { boxShadow: shadows[theme].shadow1 } : undefined}
          >
            <Text
              numberOfLines={1}
              className={cn('text-sm font-medium', selected ? 'text-text' : 'text-text-2')}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export { Segmented };
