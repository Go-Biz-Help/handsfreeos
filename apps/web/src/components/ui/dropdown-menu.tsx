'use client';
import * as Menu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export function DropdownMenuContent({ className, ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        align="end"
        sideOffset={6}
        className={cn(
          'z-40 min-w-[200px] rounded-menu border border-border bg-card p-1.5 shadow-2',
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
  className,
  danger,
  ...props
}: ComponentProps<typeof Menu.Item> & { danger?: boolean }) {
  return (
    <Menu.Item
      className={cn(
        'flex h-[34px] cursor-pointer select-none items-center gap-2.5 rounded-[6px] px-2.5 text-sm outline-none data-[highlighted]:bg-card-2 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        danger ? 'text-danger-text' : 'text-text',
        className,
      )}
      {...props}
    />
  );
}

export const DropdownMenuSeparator = ({ className }: { className?: string }) => (
  <Menu.Separator className={cn('my-1 h-px bg-border', className)} />
);
export const DropdownMenuLabel = ({ className, ...props }: ComponentProps<typeof Menu.Label>) => (
  <Menu.Label
    className={cn('px-2.5 py-1.5 text-xs font-medium text-text-3', className)}
    {...props}
  />
);
