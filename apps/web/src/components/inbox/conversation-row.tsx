'use client';
import {
  assignedToLabel,
  conversationChips,
  listTime,
  previewLine,
  rowName,
  type RowChip,
} from '@hfos/core';
import { AlarmClock, DoorOpen, Layers, Mail, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { StageBadge } from '@/components/crm/chips';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import type { ConversationSummary } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { AiTag, NeedTag, SiteTag, WebsiteIcon } from './ai-bits';
import { ContactAvatar, CountBadge, Pill, WaitChip } from './bits';
import { SocialMark } from './social-bits';

/** One chip under a row, as core words it. */
function Chip({ chip }: { chip: RowChip }) {
  switch (chip.kind) {
    case 'needs_person':
      return <NeedTag />;
    case 'wait':
      return <WaitChip minutes={chip.minutes} />;
    case 'ai':
      return <AiTag>{chip.label}</AiTag>;
    case 'on_site':
      return <SiteTag testId="row-on-site-now" />;
    case 'stage':
      return (
        <StageBadge
          name={chip.label}
          kind="open"
          className="hidden h-5 text-[11.5px] md:inline-flex"
        />
      );
    case 'new_number':
      return <Pill>{chip.label}</Pill>;
    case 'lanes':
      return (
        <Pill icon={Layers} testId="row-lanes">
          {chip.label}
        </Pill>
      );
    case 'same_as':
      return (
        <Badge variant="member" data-testid="row-same-as">
          {chip.label}
        </Badge>
      );
    case 'snoozed':
      return <Pill icon={AlarmClock}>{chip.label}</Pill>;
    case 'closed':
      return <Badge variant="ok">{chip.label}</Badge>;
  }
}

/**
 * Customer or number, the latest message, and what needs attention: wait, the AI teammate ("Ava", "Ava · draft
 * waiting", "Needs a person"), a chat visitor still on the site, stage, owner, unread.
 */
export function ConversationRow({
  c,
  href,
  selected,
  myUserId,
  waitThreshold,
  timezone,
  onOpen,
  draftWaiting = false,
}: {
  c: ConversationSummary;
  href: string;
  selected: boolean;
  myUserId: string;
  waitThreshold: number;
  timezone: string;
  onOpen?: () => void;
  /** The teammate's reply waits for someone's OK. */
  draftWaiting?: boolean;
}) {
  const unread = c.unreadTotal > 0;
  const chips = conversationChips(c, { waitThreshold, draftWaiting, timeZone: timezone });
  return (
    <Link
      href={href}
      onClick={onOpen}
      aria-current={selected ? 'page' : undefined}
      data-testid={`conversation-row-${c.id}`}
      className={cn(
        'flex w-full gap-3 border-b border-border px-3.5 py-3 text-left transition-colors max-md:min-h-[76px] md:px-4',
        selected ? 'bg-accent-soft' : 'hover:bg-card-2',
      )}
    >
      <ContactAvatar
        person={c.person}
        chat={c.channel === 'chat'}
        social={c.channel === 'messenger' || c.channel === 'instagram' ? c.channel : null}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('truncate text-sm', unread ? 'font-semibold' : 'font-medium')}>
            {rowName(c)}
          </span>
          {c.channel === 'email' ? (
            <Mail
              className="h-3.5 w-3.5 flex-none text-text-3"
              strokeWidth={1.5}
              aria-label="Email"
            />
          ) : c.channel === 'chat' ? (
            <WebsiteIcon />
          ) : c.channel === 'portal' ? (
            <DoorOpen
              className="h-3.5 w-3.5 flex-none text-text-3"
              strokeWidth={1.5}
              aria-label="Client portal"
            />
          ) : c.channel === 'messenger' || c.channel === 'instagram' ? (
            <SocialMark channel={c.channel} className="text-text-3" />
          ) : (
            <MessageCircle
              className="hidden h-3.5 w-3.5 flex-none text-text-3 md:block"
              strokeWidth={1.5}
              aria-label="Text messages"
            />
          )}
          <span
            className={cn(
              'ml-auto whitespace-nowrap text-xs',
              unread ? 'font-semibold text-accent-text' : 'text-text-3',
            )}
          >
            {listTime(c.lastMessageAt ?? c.createdAt)}
          </span>
        </div>
        <p
          className={cn(
            'mt-0.5 line-clamp-2 text-[13px] leading-[1.4]',
            unread ? 'text-text' : 'text-text-2',
          )}
        >
          {previewLine(c, myUserId)}
        </p>
        <div className="mt-[7px] flex min-h-5 items-center gap-1.5">
          {chips.map((chip, i) => (
            <Chip key={i} chip={chip} />
          ))}
          <span className="flex-1" />
          {c.assignee ? (
            <span title={assignedToLabel(c.assignee.fullName)}>
              <Avatar name={c.assignee.fullName} seed={c.assignee.id} size="sm" />
            </span>
          ) : null}
          <CountBadge count={c.unreadTotal} />
        </div>
      </div>
    </Link>
  );
}
