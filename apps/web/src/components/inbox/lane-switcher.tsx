'use client';
import { ALL_LINES_WORDS } from '@hfos/core';
import { ChevronDown, DoorOpen, Layers, Mail, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ConversationLane } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { WebsiteIcon } from './ai-bits';
import { CountBadge } from './bits';

/** Every lane reads "All lines" the same way, here and in the composer's reason for not sending. */
export const ALL_LINES = ALL_LINES_WORDS.label;

/** The line a lane is on, as an icon: which kind of conversation somebody is switching to. */
function LaneIcon({ channel }: { channel: ConversationLane['channel'] }) {
  if (channel === 'email')
    return <Mail className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} aria-hidden />;
  if (channel === 'chat') return <WebsiteIcon className="h-3.5 w-3.5 flex-none" />;
  if (channel === 'portal')
    return <DoorOpen className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} aria-hidden />;
  return <MessageCircle className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} aria-hidden />;
}

/**
 * Which of the business's lines this customer is being answered on, and a way to change it (0089).
 *
 * The inbox shows a customer once, so this is where the several conversations behind that one row become
 * visible: a text lane per number they have written to, a mail lane per address, a website chat. Picking one
 * is picking what a reply goes out from, which is the whole reason the menu exists rather than a label.
 *
 * **"All lines" reads and never writes.** It is every lane woven into one timeline, each message saying which
 * line it was on — the view for working out what has already been said to somebody, across everything. A
 * reply has to leave from a line, and "all" is not one, so the composer says so instead of guessing; see
 * `Composer`'s `all_lines` reason, which is the other half of this.
 *
 * One lane and no chance of a second (the customer has written to one line, and the business has one) still
 * renders: the line it is on is worth saying, and a menu that appears only sometimes is a menu nobody learns.
 */
export function LaneSwitcher({
  workspaceId,
  lanes,
  currentId,
  all,
  listQuery,
}: {
  workspaceId: string;
  lanes: readonly ConversationLane[];
  currentId: string;
  /** Showing every lane at once, so the trigger says so and the composer is closed. */
  all: boolean;
  /** The list's own filters, carried across so switching a line does not empty the list behind it. */
  listQuery: string;
}) {
  const current = lanes.find((l) => l.id === currentId) ?? null;
  const others = lanes.filter((l) => l.id !== currentId);
  const unreadElsewhere = others.reduce((n, l) => n + l.unreadCount, 0);
  const href = (l: ConversationLane) => `/app/w/${workspaceId}/inbox/${l.id}${listQuery}`;
  const allHref = `/app/w/${workspaceId}/inbox/${currentId}${listQuery ? `${listQuery}&` : '?'}lanes=all`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-1 h-6 gap-1 px-1 text-xs font-normal text-text-3 hover:text-text"
          data-testid="lane-switcher"
          title="Switch the line you're answering on"
        >
          {all ? (
            <Layers className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} aria-hidden />
          ) : current ? (
            <LaneIcon channel={current.channel} />
          ) : null}
          <span className="truncate">{all ? ALL_LINES : (current?.lineDisplay ?? ALL_LINES)}</span>
          {unreadElsewhere > 0 && !all ? <CountBadge count={unreadElsewhere} /> : null}
          <ChevronDown className="h-3 w-3 flex-none" strokeWidth={1.5} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-[260px]">
        <DropdownMenuLabel>Answer on</DropdownMenuLabel>
        {lanes.map((l) => (
          <DropdownMenuItem key={l.id} asChild data-testid={`lane-${l.id}`}>
            <Link href={href(l)}>
              <LaneIcon channel={l.channel} />
              <span className={cn('flex-1 truncate', l.id === currentId && !all && 'font-medium')}>
                {l.lineDisplay}
              </span>
              <CountBadge count={l.unreadCount} />
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem asChild data-testid="lane-all">
          <Link href={allHref}>
            <Layers className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} aria-hidden />
            <span className={cn('flex-1', all && 'font-medium')}>{ALL_LINES}</span>
            <span className="text-xs text-text-3">Reading only</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
