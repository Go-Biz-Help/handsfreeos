'use client';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  hideClose,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  hideClose?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[var(--scrim)] data-[state=open]:animate-in data-[state=open]:fade-in" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-dialog border border-border bg-card p-6 shadow-3 focus:outline-none',
          className,
        )}
      >
        <div className="mb-1 flex items-start justify-between gap-4">
          <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">
            {title}
          </DialogPrimitive.Title>
          {hideClose ? null : (
            <DialogPrimitive.Close
              className="rounded-control p-1 text-text-2 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
              aria-label="Close"
            >
              <X className="h-[18px] w-[18px]" />
            </DialogPrimitive.Close>
          )}
        </div>
        {description ? (
          <DialogPrimitive.Description className="text-[13px] text-text-2">
            {description}
          </DialogPrimitive.Description>
        ) : (
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
        )}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
