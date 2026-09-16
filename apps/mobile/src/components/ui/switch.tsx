import * as SwitchPrimitives from '@rn-primitives/switch';
import * as React from 'react';
import { View } from 'react-native';

import { cn } from '@/lib/utils';

/**
 * An on/off switch for settings that save the moment they're flipped, drawn as the phone boards draw it (46 × 28, or
 * 40 × 24 for `size="sm"`). `label` names it for screen readers; the visible words sit beside it in the row. The touch
 * area is at least 44 px.
 */
function Switch({
  className,
  size = 'md',
  label,
  checked,
  disabled,
  ...props
}: React.ComponentProps<typeof SwitchPrimitives.Root> & { size?: 'sm' | 'md'; label: string }) {
  const sm = size === 'sm';
  return (
    <SwitchPrimitives.Root
      accessibilityLabel={label}
      checked={checked}
      disabled={disabled}
      hitSlop={
        sm ? { top: 10, bottom: 10, left: 4, right: 4 } : { top: 8, bottom: 8, left: 2, right: 2 }
      }
      className={cn(
        'shrink-0 flex-row items-center rounded-full p-0.5',
        sm ? 'h-6 w-10' : 'h-7 w-[46px]',
        checked ? 'bg-accent' : 'bg-border-strong',
        disabled && 'opacity-50',
        className,
      )}
      {...props}
    >
      <View className={cn('flex-row', checked ? 'flex-1 justify-end' : 'justify-start')}>
        <SwitchPrimitives.Thumb
          className={cn('rounded-full bg-white', sm ? 'size-5' : 'size-6')}
          style={{ boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)' }}
        />
      </View>
    </SwitchPrimitives.Root>
  );
}

export { Switch };
