'use client';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useAssistant } from './assistant-provider';

/** The answer card (design/m4 `.acard`): full panel width, rows split by hairlines. */
export const cardShell = 'overflow-hidden rounded-card border border-border bg-card';
export const cardHead = 'flex items-center gap-2.5 px-3.5 py-3';
export const cardRow =
  'flex min-w-0 items-center gap-2.5 border-t border-border px-3.5 py-[9px] text-[13px] text-text max-md:min-h-12';
export const cardFoot = 'flex items-center gap-2 border-t border-border px-3.5 py-2.5';
/** Card buttons grow to 44 px on phones. */
export const touchButton = 'max-md:h-11 max-md:px-3.5 max-md:text-[14.5px]';

export type Tone = 'accent' | 'warning' | 'danger' | 'muted';
const DOT: Record<Tone, string> = {
  accent: 'bg-accent',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-border-strong',
};

export function Dot({ tone }: { tone: Tone }) {
  return <span aria-hidden className={cn('h-2 w-2 flex-none rounded-full', DOT[tone])} />;
}

/** A card row that opens a page in the app. `itemId` marks an Action Center item's row (`data-item`, as on Home). */
export function RowLink({
  href,
  children,
  className,
  itemId,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  itemId?: string;
}) {
  const { closeIfCovering } = useAssistant();
  return (
    <Link
      href={href}
      data-item={itemId}
      onClick={() => closeIfCovering(href)}
      className={cn(
        cardRow,
        'w-full text-left transition-colors hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring',
        className,
      )}
    >
      {children}
      <ChevronRight className="h-3.5 w-3.5 flex-none text-text-3" strokeWidth={1.5} />
    </Link>
  );
}

const TILE = {
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
  neutral: 'bg-card-2 text-text-2',
} as const;

/** The round icon at the start of a card (a task done, a note, the daily limit). */
export function Tile({
  icon: Icon,
  tone,
  size = 32,
}: {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  tone: keyof typeof TILE;
  size?: 32 | 40;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex flex-none items-center justify-center rounded-full',
        size === 40 ? 'h-10 w-10' : 'h-8 w-8',
        TILE[tone],
      )}
    >
      <Icon className={size === 40 ? 'h-[18px] w-[18px]' : 'h-3.5 w-3.5'} strokeWidth={1.5} />
    </span>
  );
}

/** The line under a card once it's answered: done, not done, or stopped by a rule. */
export function Result({
  tone,
  icon: Icon,
  children,
  action,
}: {
  tone: 'ok' | 'no' | 'bad';
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      data-testid="assistant-result"
      className={cn(
        'flex items-center gap-2 border-t border-border px-3.5 py-2.5 text-[13px]',
        tone === 'ok' && 'bg-success-soft text-success-text',
        tone === 'no' && 'bg-card-2 text-text-2',
        tone === 'bad' && 'bg-danger-soft text-danger-text',
      )}
    >
      <Icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}
