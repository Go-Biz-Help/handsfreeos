'use client';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const sides = {
  /** A side panel on wide screens; a bottom sheet on phones. */
  right:
    'inset-x-0 bottom-0 max-h-[88vh] rounded-t-2xl border-t sm:inset-y-0 sm:left-auto sm:right-0 sm:h-full sm:max-h-none sm:w-[480px] sm:rounded-none sm:border-l sm:border-t-0 data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom sm:data-[state=open]:slide-in-from-right',
  /** The navigation drawer. */
  left: 'inset-y-0 left-0 w-[300px] max-w-[85vw] border-r data-[state=open]:animate-in data-[state=open]:slide-in-from-left',
};

export function SheetContent({
  title,
  description,
  children,
  className,
  side = 'right',
  hideHeader,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  side?: keyof typeof sides;
  hideHeader?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[var(--scrim)]" />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex flex-col overflow-y-auto border-border bg-card p-5 shadow-3 focus:outline-none sm:p-6',
          sides[side],
          className,
        )}
      >
        {side === 'right' ? (
          <div
            aria-hidden
            className="mx-auto -mt-1 mb-3 h-1 w-10 flex-none rounded-full bg-border-strong sm:hidden"
          />
        ) : null}
        {hideHeader ? (
          <>
            <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              {description ?? title}
            </DialogPrimitive.Description>
          </>
        ) : (
          <div className="mb-4">
            <div className="flex items-start justify-between gap-4">
              <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close
                className="rounded-control p-1 text-text-2 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                aria-label="Close"
              >
                <X className="h-[18px] w-[18px]" />
              </DialogPrimitive.Close>
            </div>
            {description ? (
              <DialogPrimitive.Description className="mt-0.5 text-[13px] text-text-2">
                {description}
              </DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
        )}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
