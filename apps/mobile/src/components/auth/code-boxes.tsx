import * as React from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

export const CODE_LENGTH = 6;

/**
 * The 6-digit code as six boxes. One real field sits over them, so the phone can fill the code in from the email
 * (iOS offers it above the keyboard) and a pasted code lands whole.
 */
export function CodeBoxes({
  value,
  onChange,
  invalid,
  editable = true,
  autoFocus,
}: {
  value: string;
  onChange: (code: string) => void;
  invalid?: boolean;
  editable?: boolean;
  autoFocus?: boolean;
}) {
  const colors = useColors();
  const input = React.useRef<TextInput>(null);
  const [focused, setFocused] = React.useState(false);
  const digits = value.split('');
  const current = Math.min(value.length, CODE_LENGTH - 1);
  return (
    <Pressable onPress={() => input.current?.focus()} accessible={false}>
      <View className="flex-row gap-2">
        {Array.from({ length: CODE_LENGTH }, (_, i) => {
          const active = focused && i === current && value.length < CODE_LENGTH;
          return (
            <View
              key={i}
              className={cn(
                'h-[58px] flex-1 items-center justify-center rounded-menu border bg-card',
                invalid ? 'border-danger' : active ? 'border-accent' : 'border-border-strong',
              )}
              style={active ? { boxShadow: `0 0 0 3px ${colors.ring}` } : undefined}
            >
              {digits[i] ? (
                <Text className="text-[26px] font-semibold">{digits[i]}</Text>
              ) : active ? (
                <View className="h-7 w-0.5 bg-accent" />
              ) : null}
            </View>
          );
        })}
      </View>
      <TextInput
        ref={input}
        testID="code-input"
        accessibilityLabel="The 6-digit code"
        value={value}
        onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, CODE_LENGTH))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        editable={editable}
        autoFocus={autoFocus}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={CODE_LENGTH}
        caretHidden
        className="absolute inset-0 text-transparent"
        style={{ color: 'transparent', opacity: 0.02 }}
      />
    </Pressable>
  );
}
