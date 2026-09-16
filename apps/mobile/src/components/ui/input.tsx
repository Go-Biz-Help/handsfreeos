import * as React from 'react';
import { TextInput, View } from 'react-native';

import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

type InputProps = React.ComponentProps<typeof TextInput> & {
  invalid?: boolean;
  /** Drawn inside the field at its end, such as the password's Show button. */
  trailing?: React.ReactNode;
};

/**
 * The web's input at phone size (48 px tall, 16 px text so iOS never zooms): border-strong, the accent border and
 * ring while focused, the danger border when the value was refused. `className` styles the field's box.
 *
 * The border, fill and ring belong to the box, not the text field: on Android, giving a text field a box shadow
 * replaces its background, and that puts its padding back to the theme's 4 dp, so focusing it would push the text
 * against the border.
 */
function Input({
  className,
  invalid,
  trailing,
  onFocus,
  onBlur,
  editable,
  style,
  ...props
}: InputProps) {
  const colors = useColors();
  const [focused, setFocused] = React.useState(false);
  return (
    <View
      className={cn(
        'h-12 w-full flex-row items-center rounded-menu border border-border-strong bg-card',
        focused && 'border-accent',
        invalid && 'border-danger',
        editable === false && 'bg-card-2',
        className,
      )}
      style={
        focused || invalid
          ? { boxShadow: `0 0 0 3px ${invalid ? `${colors.danger}2e` : colors.ring}` }
          : undefined
      }
    >
      <TextInput
        className={cn(
          'min-w-0 flex-1 self-stretch py-0 font-sans text-base text-text',
          trailing ? 'pl-3.5 pr-1' : 'px-3.5',
          editable === false && 'text-text-2',
        )}
        style={style}
        textAlignVertical="center"
        placeholderTextColor={colors.placeholder}
        selectionColor={colors.accent}
        cursorColor={colors.accent}
        editable={editable}
        aria-invalid={invalid || undefined}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        {...props}
      />
      {trailing}
    </View>
  );
}

export { Input };
export type { InputProps };
