'use client';
import { MAIL_BOX_NAMES, unreadLabel } from '@hfos/core';
import { Inbox, Lock, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

export type MailBoxKey = keyof typeof MAIL_BOX_NAMES;

/**
 * The email boxes beside the team's Inbox (M19): the person's own mail, when they have an address of their own,
 * and the team's Other mail and Spam. Each says how many are unread (Spam, how many are in it).
 */
export function MailBoxes({
  on,
  own,
  counts,
  onPick,
}: {
  /** The box showing, if it's one of these. */
  on: MailBoxKey | null;
  /** The person has mail of their own here. */
  own: boolean;
  counts: { mine: number; other: number; spam: number };
  /** The box pressed, or null to go back to the team's Inbox. */
  onPick: (box: MailBoxKey | null) => void;
}) {
  const items: { key: MailBoxKey; count: number; icon: typeof Inbox }[] = [
    ...(own ? [{ key: 'mine' as const, count: counts.mine, icon: Lock }] : []),
    { key: 'other', count: counts.other, icon: Inbox },
    { key: 'spam', count: counts.spam, icon: ShieldAlert },
  ];
  return (
    <div
      className={cn('grid gap-1.5', items.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}
      role="group"
      aria-label="Email"
    >
      {items.map((b) => {
        const pressed = on === b.key;
        const Icon = b.icon;
        return (
          <button
            key={b.key}
            type="button"
            aria-pressed={pressed}
            onClick={() => onPick(pressed ? null : b.key)}
            data-testid={`box-${b.key === 'mine' ? 'my-mail' : b.key}`}
            className={cn(
              'flex h-8 min-w-0 items-center gap-[7px] whitespace-nowrap rounded-control border pl-2.5 pr-2 text-left text-[13px] font-medium transition-colors max-md:h-9',
              pressed
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border bg-card text-text-2 hover:text-text',
            )}
          >
            <Icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
            <span className="truncate">{MAIL_BOX_NAMES[b.key]}</span>
            {b.count > 0 ? (
              <span
                data-testid={`box-${b.key === 'mine' ? 'my-mail' : b.key}-count`}
                className={cn(
                  'ml-auto inline-flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-full px-[5px] text-[11px] font-semibold leading-none',
                  b.key === 'spam' ? 'bg-border text-text-2' : 'bg-accent text-white',
                )}
              >
                {unreadLabel(b.count)}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
