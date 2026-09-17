import { cva, type VariantProps } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Pressable } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text, TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

/**
 * The web's buttons (apps/web/src/components/ui/button.tsx) at phone size. `lg` (44 px) is the default: a finger needs
 * that much. Smaller sizes keep a 44 px touch area around them.
 */
const buttonVariants = cva('flex-row items-center justify-center gap-2 border border-transparent', {
  variants: {
    variant: {
      primary: 'bg-accent active:bg-accent-hover',
      secondary: 'bg-card border-border-strong active:bg-card-2',
      ghost: 'active:bg-card-2',
      danger: 'bg-danger active:opacity-90',
      /** Sign out and Delete my account in a list of choices: a secondary button with the danger colour. */
      dangerOutline: 'bg-card border-border-strong active:bg-card-2',
      /** Discard, "Don't add Rosa": the last, quietest choice in a sheet, in the danger colour. */
      ghostDanger: 'active:bg-card-2',
    },
    size: {
      sm: 'h-9 px-3 rounded-control',
      md: 'h-10 px-3.5 rounded-control',
      lg: 'h-11 px-[18px] rounded-menu',
    },
  },
  defaultVariants: { variant: 'primary', size: 'lg' },
});

const buttonTextVariants = cva('font-sans font-medium', {
  variants: {
    variant: {
      primary: 'text-white',
      secondary: 'text-text',
      ghost: 'text-text-2',
      danger: 'text-on-solid',
      dangerOutline: 'text-danger-text',
      ghostDanger: 'text-danger-text',
    },
    size: {
      sm: 'text-[13px]',
      md: 'text-sm',
      lg: 'text-[15px]',
    },
  },
  defaultVariants: { variant: 'primary', size: 'lg' },
});

type ButtonProps = Omit<React.ComponentProps<typeof Pressable>, 'children'> &
  VariantProps<typeof buttonVariants> & {
    /** The words on the button, or custom content. */
    children?: React.ReactNode;
    icon?: LucideIcon;
    /** Shows a spinner and ignores presses. */
    loading?: boolean;
  };

const SMALL_HIT = { top: 4, bottom: 4, left: 0, right: 0 };

function Button({
  className,
  variant,
  size,
  icon,
  loading,
  disabled,
  children,
  hitSlop,
  ...props
}: ButtonProps) {
  const colors = useColors();
  const textClass = buttonTextVariants({ variant, size });
  const spinner =
    variant === 'primary' || variant === undefined || variant === null
      ? '#ffffff'
      : variant === 'danger'
        ? colors.onSolid
        : colors.text2;
  return (
    <TextClassContext.Provider value={textClass}>
      <Pressable
        role="button"
        accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }}
        disabled={disabled || loading}
        hitSlop={
          hitSlop ?? (size === 'sm' ? SMALL_HIT : size === 'md' ? { top: 2, bottom: 2 } : undefined)
        }
        className={cn(
          buttonVariants({ variant, size }),
          (disabled || loading) && 'opacity-50',
          className,
        )}
        {...props}
      >
        {loading ? (
          <ActivityIndicator size="small" color={spinner} />
        ) : icon ? (
          <Icon as={icon} className="size-[18px]" />
        ) : null}
        {typeof children === 'string' ? <Text numberOfLines={1}>{children}</Text> : children}
      </Pressable>
    </TextClassContext.Provider>
  );
}

export { Button, buttonTextVariants, buttonVariants };
export type { ButtonProps };
