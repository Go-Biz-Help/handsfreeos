import { Slot } from '@rn-primitives/slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { Text as RNText, type Role } from 'react-native';

import { cn } from '@/lib/utils';

/**
 * Text in the web's type: Hanken Grotesk, `text-text`, with the sizes the phone boards use. A phone reads 15 px as
 * the web reads 14 px, so body text is 15 px here.
 */
const textVariants = cva('font-sans text-[15px] text-text', {
  variants: {
    variant: {
      default: '',
      /** "Welcome back", "Check your email": the sign-in screens' headings. */
      title: 'text-[28px] font-semibold tracking-[-0.56px] leading-[34px]',
      /** A page's own heading ("Delete my account", "HandsFreeOS is locked"). */
      heading: 'text-[22px] font-semibold tracking-[-0.22px] leading-[28px]',
      /** A sheet's title. */
      sheetTitle: 'text-lg font-semibold tracking-[-0.18px]',
      /** The line under a heading. */
      lead: 'text-[15.5px] text-text-2 leading-[22px]',
      muted: 'text-sm text-text-2',
      small: 'text-[13px] text-text-3',
      /** Group labels in lists ("THIS PHONE"). */
      group: 'text-xs font-semibold uppercase tracking-[0.5px] text-text-3',
      mono: 'font-mono text-sm',
    },
  },
  defaultVariants: { variant: 'default' },
});

type TextVariantProps = VariantProps<typeof textVariants>;
type TextVariant = NonNullable<TextVariantProps['variant']>;

const ROLE: Partial<Record<TextVariant, Role>> = {
  title: 'heading',
  heading: 'heading',
  sheetTitle: 'heading',
};

/** Classes a parent (a button, a badge) hands its text. */
const TextClassContext = React.createContext<string | undefined>(undefined);

function Text({
  className,
  asChild = false,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof RNText> &
  TextVariantProps & {
    asChild?: boolean;
  }) {
  const textClass = React.useContext(TextClassContext);
  const Component = asChild ? Slot : RNText;
  return (
    <Component
      className={cn(textVariants({ variant }), textClass, className)}
      role={variant ? ROLE[variant] : undefined}
      {...props}
    />
  );
}

export { Text, TextClassContext, textVariants };
