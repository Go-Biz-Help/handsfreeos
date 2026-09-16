import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { View } from 'react-native';

import { TextClassContext } from '@/components/ui/text';
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

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <TextClassContext.Provider value={badgeTextVariants({ variant })}>
      <View className={cn(badgeVariants({ variant }), className)} {...props} />
    </TextClassContext.Provider>
  );
}

export { Badge, badgeTextVariants, badgeVariants };
export type { BadgeProps };
