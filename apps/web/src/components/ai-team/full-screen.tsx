'use client';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A phone's full-screen form: a top bar with Back, the title and an action, and the form scrolling under
 * it. The builder's modules open this way at 390 px.
 */
export function FullScreen({
  open,
  onOpenChange,
  title,
  description,
  action,
  children,
  className,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** On the right of the top bar (Save). */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-testid={testId}
          className={cn('fixed inset-0 z-50 flex flex-col bg-bg focus:outline-none', className)}
        >
          <div className="flex h-14 flex-none items-center gap-1 border-b border-border bg-card px-2">
            <DialogPrimitive.Close
              aria-label="Back"
              className="flex h-11 w-11 flex-none items-center justify-center rounded-control text-text-2 hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
            >
              <ArrowLeft className="h-5 w-5" strokeWidth={1.5} />
            </DialogPrimitive.Close>
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-base font-semibold">
              {title}
            </DialogPrimitive.Title>
            {action ? <div className="flex flex-none items-center pr-1">{action}</div> : null}
          </div>
          <DialogPrimitive.Description className="sr-only">
            {description ?? title}
          </DialogPrimitive.Description>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
