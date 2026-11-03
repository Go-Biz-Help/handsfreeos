'use client';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ComponentProps, ReactNode } from 'react';

/**
 * Tooltips inside share one wait: the first shows once the pointer rests `delayDuration` ms, and the next straight away
 * while the pointer moves along (`skipDelayDuration`), as menus' do.
 */
export function TooltipProvider({
  delayDuration,
  children,
}: {
  delayDuration: number;
  children: ReactNode;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/**
 * A short note on what something does, shown when the pointer rests on it or the keyboard lands on it, and read with
 * it by a screen reader. A touch never shows it: a touch presses. Inside a `TooltipProvider`.
 */
export function Tooltip({
  content,
  side = 'top',
  align = 'center',
  children,
}: {
  content: ReactNode;
  side?: ComponentProps<typeof TooltipPrimitive.Content>['side'];
  align?: ComponentProps<typeof TooltipPrimitive.Content>['align'];
  /** The one element it's about, which takes the pointer and the focus. */
  children: ReactNode;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          // Above a sheet or dialog (z-50), where most of them sit.
          className="z-[60] max-w-[280px] rounded-[8px] bg-toast-bg px-3 py-2 text-[13px] leading-snug text-toast-text shadow-2"
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-toast-bg" width={10} height={5} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
