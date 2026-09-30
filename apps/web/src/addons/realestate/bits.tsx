/**
 * Small pieces every Real Estate Agent screen draws the same way: a deal's health, its side, a duty's status, and
 * where each page is. Words come from core (@hfos/core/addons/realestate/…), so the phone and the Assistant say the
 * same thing.
 */
import { DUTY_STATUS_LABELS, type DutyStatus } from '@hfos/core/addons/realestate/states';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type Health = 'green' | 'yellow' | 'red';

export const HEALTH_WORDS: Readonly<Record<Health, string>> = {
  green: 'On track',
  yellow: 'Needs attention',
  red: 'At risk',
};

/** Where each of the add-on's pages is. */
export const realestateHref = (workspaceId: string, path = '') =>
  `/app/w/${workspaceId}/a/realestate${path ? `/${path}` : ''}`;
export const dealHref = (workspaceId: string, dealId: string, path = '') =>
  realestateHref(workspaceId, `deals/${dealId}${path ? `/${path}` : ''}`);

/** A deal's health as a dot, with its words for screen readers and on hover. */
export function HealthDot({ health, className }: { health: Health; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 flex-none rounded-full',
        health === 'green' && 'bg-success',
        health === 'yellow' && 'bg-warning',
        health === 'red' && 'bg-danger',
        className,
      )}
      title={HEALTH_WORDS[health]}
      data-health={health}
    >
      <span className="sr-only">{HEALTH_WORDS[health]}</span>
    </span>
  );
}

export function SideBadge({ side }: { side: 'buyer' | 'listing' }) {
  return (
    <Badge variant={side === 'buyer' ? 'accent' : 'gray'}>
      {side === 'buyer' ? 'Buyer' : 'Listing'}
    </Badge>
  );
}

/** A duty's status; an open one past its time reads Overdue. */
export function DutyStatusBadge({ status, overdue }: { status: DutyStatus; overdue?: boolean }) {
  if (overdue) return <Badge variant="danger">Overdue</Badge>;
  const variant =
    status === 'completed'
      ? 'ok'
      : status === 'blocked'
        ? 'danger'
        : status === 'waiting_external' || status === 'draft' || status === 'pending_approval'
          ? 'pending'
          : 'gray';
  return <Badge variant={variant}>{DUTY_STATUS_LABELS[status]}</Badge>;
}

/** A card's heading row: its title, and what can be done beside it. */
export function CardHead({
  title,
  action,
  icon,
}: {
  title: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold">
        {icon}
        {title}
      </h2>
      {action}
    </div>
  );
}

/** A label and its value on one line, as the deal page's side cards list them. */
export function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[13.5px]">
      <span className="text-text-2">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
