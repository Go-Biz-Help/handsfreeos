import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type BadgeVariant =
  'owner' | 'admin' | 'member' | 'pending' | 'revoked' | 'ok' | 'gray' | 'accent';

const variants: Record<BadgeVariant, string> = {
  owner: 'bg-accent-soft text-accent-text',
  accent: 'bg-accent-soft text-accent-text',
  admin: 'bg-card-2 text-text border-border',
  member: 'border-border-strong text-text-2',
  pending: 'bg-warning-soft text-warning-text',
  revoked: 'bg-danger-soft text-danger-text',
  ok: 'bg-success-soft text-success-text',
  gray: 'bg-card-2 text-text-2',
};

export function Badge({
  variant = 'gray',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-2 text-xs font-medium',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

export function RoleBadge({ role }: { role: 'owner' | 'admin' | 'member' }) {
  const label = { owner: 'Owner', admin: 'Admin', member: 'Member' }[role];
  return <Badge variant={role}>{label}</Badge>;
}
