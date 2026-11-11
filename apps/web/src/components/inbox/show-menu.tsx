'use client';
import {
  INBOX_SHOW,
  INBOX_SHOW_LABELS,
  INBOX_SHOW_NOTES,
  unreadLabel,
  type InboxShowKey,
} from '@hfos/core';
import { Archive, Check, ChevronDown, Inbox, ShieldAlert } from 'lucide-react';
import { Fragment } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

const ICONS: Partial<Record<InboxShowKey, typeof Inbox>> = {
  archived: Archive,
  other: Inbox,
  spam: ShieldAlert,
};

/**
 * What the Inbox shows, in one menu beside the search (Chris, 2026-11-11): Open, Snoozed and Closed, then Archived,
 * Other mail and Spam. The person's own mail is in each beside the team's, marked "Only you", so nothing here opens a
 * page of its own. Other mail says how many are unread, Spam how many are in it; a dot on the menu means something
 * unread waits in Other mail.
 */
export function ShowMenu({
  value,
  counts,
  onPick,
  className,
}: {
  value: InboxShowKey;
  counts: { other: number; spam: number };
  onPick: (key: InboxShowKey) => void;
  className?: string;
}) {
  const put = value === 'archived' || value === 'other' || value === 'spam';
  const PutIcon = ICONS[value];
  const dot = counts.other > 0 && value !== 'other';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="inbox-show"
        aria-label={`Show: ${INBOX_SHOW_LABELS[value]}${dot ? `. ${INBOX_SHOW_NOTES.otherUnread}` : ''}`}
        className={cn(
          'flex h-[34px] w-[124px] flex-none items-center gap-1.5 rounded-control border px-2.5 text-sm font-medium outline-none transition-[border-color,box-shadow] focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:border-accent data-[state=open]:ring-[3px] data-[state=open]:ring-ring max-md:h-9',
          put
            ? 'border-accent bg-accent-soft text-accent-text'
            : 'border-border-strong bg-card text-text',
          className,
        )}
      >
        {PutIcon ? <PutIcon className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} /> : null}
        <span className="truncate">{INBOX_SHOW_LABELS[value]}</span>
        {dot ? (
          <span
            aria-hidden
            data-testid="inbox-show-dot"
            title={INBOX_SHOW_NOTES.otherUnread}
            className="h-[7px] w-[7px] flex-none rounded-full bg-accent"
          />
        ) : null}
        <ChevronDown
          aria-hidden
          className={cn('ml-auto h-4 w-4 flex-none', put ? 'text-accent-text' : 'text-text-3')}
          strokeWidth={1.75}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[220px]">
        {INBOX_SHOW.map((key) => {
          const Icon = ICONS[key];
          const count = key === 'other' ? counts.other : key === 'spam' ? counts.spam : 0;
          const on = key === value;
          return (
            <Fragment key={key}>
              {key === 'archived' ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                onSelect={() => onPick(key)}
                aria-current={on || undefined}
                data-testid={`inbox-show-${key}`}
                className={cn(on && 'bg-card-2 font-medium')}
              >
                {Icon ? <Icon className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} /> : null}
                <span className="truncate">{INBOX_SHOW_LABELS[key]}</span>
                {count > 0 ? (
                  <span
                    data-testid={`inbox-show-${key}-count`}
                    className={cn(
                      'ml-auto inline-flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-full px-[5px] text-[11px] font-semibold leading-none',
                      key === 'spam' ? 'bg-border text-text-2' : 'bg-accent text-white',
                    )}
                  >
                    {unreadLabel(count)}
                  </span>
                ) : null}
                {on ? (
                  <Check
                    aria-hidden
                    className={cn('h-4 w-4 flex-none text-accent-text', count > 0 ? '' : 'ml-auto')}
                    strokeWidth={1.75}
                  />
                ) : null}
              </DropdownMenuItem>
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
