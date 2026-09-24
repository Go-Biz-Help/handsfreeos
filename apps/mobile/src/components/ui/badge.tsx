import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { View } from 'react-native';

import { Text, TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** The web's badges (apps/web/src/components/ui/badge.tsx). */
const badgeVariants = cva(
  'h-[22px] shrink-0 flex-row items-center gap-1.5 self-start rounded-full border border-transparent px-2',
  {
    variants: {
      variant: {
        accent: 'bg-accent-soft',
        admin: 'bg-card-2 border-border',
        member: 'border-border-strong',
        pending: 'bg-warning-soft',
        danger: 'bg-danger-soft',
        ok: 'bg-success-soft',
        gray: 'bg-card-2',
      },
    },
    defaultVariants: { variant: 'gray' },
  },
);

const badgeTextVariants = cva('font-sans text-xs font-medium', {
  variants: {
    variant: {
      accent: 'text-accent-text',
      admin: 'text-text',
      member: 'text-text-2',
      pending: 'text-warning-text',
      danger: 'text-danger-text',
      ok: 'text-success-text',
      gray: 'text-text-2',
    },
  },
  defaultVariants: { variant: 'gray' },
});

type BadgeProps = React.ComponentProps<typeof View> & VariantProps<typeof badgeVariants>;

/** Only words: a string or a number, or several strung together (`{status}{pending ? ' · waiting' : ''}`). */
function isWords(children: React.ReactNode): boolean {
  const parts = React.Children.toArray(children);
  return parts.length > 0 && parts.every((c) => typeof c === 'string' || typeof c === 'number');
}

/**
 * Words handed straight to a badge go in a Text, as a Button's do. Raw words in a View are React Native's "Text strings
 * must be rendered within a <Text> component": an error in development, and in a store build the words may not show.
 * The visit's job status on an appointment and a customer's Archived badge were handed that way.
 */
function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <TextClassContext.Provider value={badgeTextVariants({ variant })}>
      <View className={cn(badgeVariants({ variant }), className)} {...props}>
        {isWords(children) ? <Text>{children}</Text> : children}
      </View>
    </TextClassContext.Provider>
  );
}

export { Badge, badgeTextVariants, badgeVariants };
export type { BadgeProps };
