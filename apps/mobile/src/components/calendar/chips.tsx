import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Check } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** A row of 44 px choice chips that scrolls sideways, the picked one ticked: New appointment's and the zone pick's. */
export function Chips({
  options,
  value,
  onChange,
  testID,
}: {
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  testID?: string;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} testID={testID}>
      <View className="flex-row gap-1.5 pr-3">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable
              key={o.value}
              role="button"
              accessibilityState={{ selected: on }}
              testID={`${testID}-${o.value}`}
              onPress={() => onChange(o.value)}
              className={cn(
                'h-11 flex-row items-center gap-1.5 rounded-full border px-3.5',
                on ? 'border-transparent bg-accent-soft' : 'border-border-strong bg-card',
              )}
            >
              {on ? <Icon as={Check} className="size-3.5 text-accent-text" /> : null}
              <Text
                className={cn('text-[13px] font-medium', on ? 'text-accent-text' : 'text-text-2')}
              >
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}
