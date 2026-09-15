'use client';
import { Globe, Sparkles, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { AI_FILL } from '@/components/ai-team/mark';
import { AI_SOFT, AI_TEXT } from '@/components/workflows/chips';
import type { InboxBoxKey } from '@/lib/ai-team/inbox-types';
import { cn } from '@/lib/utils';

const TAG =
  'inline-flex h-5 flex-none items-center gap-1 whitespace-nowrap rounded-[6px] px-[7px] text-[11.5px]';

/** "Ava" or "Ava · draft waiting" on a conversation row the teammate is handling. */
export function AiTag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn(TAG, 'font-semibold', AI_SOFT, AI_TEXT, className)} data-testid="ai-tag">
      <Sparkles className="h-3 w-3" strokeWidth={1.75} />
      {children}
    </span>
  );
}

/** "Needs a person" on a row the teammate handed over. */
export function NeedTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(TAG, 'bg-warning-soft font-semibold text-warning-text', className)}
      data-testid="needs-person-tag"
    >
      <UserRound className="h-3 w-3" strokeWidth={1.75} />
      Needs a person
    </span>
  );
}

/** "On the site now": a website chat's visitor still has the page open. */
export function SiteTag({
  className,
  testId = 'on-site-now',
}: {
  className?: string;
  testId?: string;
}) {
  return (
    <span
      className={cn(TAG, 'gap-[5px] bg-success-soft font-medium text-success-text', className)}
      data-testid={testId}
    >
      <i className="inline-block h-[7px] w-[7px] rounded-full bg-success" aria-hidden />
      On the site now
    </span>
  );
}

/** The website chat's channel mark (the list and the thread header). */
export function WebsiteIcon({ className }: { className?: string }) {
  return (
    <Globe
      className={cn('h-3.5 w-3.5 flex-none text-text-3', className)}
      strokeWidth={1.5}
      aria-label="Website chat"
    />
  );
}

/**
 * The inbox's two teammate boxes under Mine · Unassigned · All: "Needs a person" and the teammate's own,
 * each with how many open conversations are in it.
 */
export function TeammateBoxes({
  box,
  name,
  needsPerson,
  ai,
  onPick,
}: {
  box: InboxBoxKey;
  /** The teammate's name, for its box; null shows only "Needs a person". */
  name: string | null;
  needsPerson: number;
  ai: number;
  onPick: (box: InboxBoxKey) => void;
}) {
  const items: { key: InboxBoxKey; label: string; count: number; icon: typeof Sparkles }[] = [
    { key: 'needs_person', label: 'Needs a person', count: needsPerson, icon: UserRound },
    ...(name ? [{ key: 'ai' as const, label: name, count: ai, icon: Sparkles }] : []),
  ];
  return (
    <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="The AI teammate’s boxes">
      {items.map((b) => {
        const on = box === b.key;
        const Icon = b.icon;
        return (
          <button
            key={b.key}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(on ? 'all' : b.key)}
            data-testid={`box-${b.key}`}
            className={cn(
              'flex h-8 min-w-0 items-center gap-[7px] whitespace-nowrap rounded-control border pl-2.5 pr-2 text-left text-[13px] font-medium transition-colors max-md:h-9',
              on
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border bg-card text-text-2 hover:text-text',
            )}
          >
            <Icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
            <span className="truncate">{b.label}</span>
            {b.count > 0 ? (
              <span
                data-testid={`box-${b.key}-count`}
                className={cn(
                  'ml-auto inline-flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-full px-[5px] text-[11px] font-semibold leading-none text-on-solid',
                  b.key === 'ai' ? AI_FILL : 'bg-warning',
                )}
              >
                {b.count > 99 ? '99+' : b.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
