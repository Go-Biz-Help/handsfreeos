import * as LabelPrimitive from '@rn-primitives/label';
import * as React from 'react';

import { cn } from '@/lib/utils';

/** A field's label, as the web's: 13 px, medium. `nativeID` lets the field name it for screen readers. */
function Label({
  className,
  onPress,
  disabled,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Text> & { disabled?: boolean }) {
  return (
    <LabelPrimitive.Root
      className={cn('flex-row items-center', disabled && 'opacity-50')}
      onPress={onPress}
      disabled={disabled}
    >
      <LabelPrimitive.Text
        className={cn('font-sans text-[13px] font-medium text-text', className)}
        {...props}
      />
    </LabelPrimitive.Root>
  );
}

/** The line under a field when something's wrong with it. */
function FieldError({ children, testID }: { children?: React.ReactNode; testID?: string }) {
  if (!children) return null;
  return (
    <LabelPrimitive.Text
      role="alert"
      testID={testID}
      className="font-sans text-[13px] leading-[18px] text-danger-text"
    >
      {children}
    </LabelPrimitive.Text>
  );
}

export { FieldError, Label };
