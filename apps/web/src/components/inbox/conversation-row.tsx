'use client';
import { AlarmClock, Mail, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { StageBadge } from '@/components/crm/chips';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import type { ConversationSummary } from '@/lib/api/types';
import { listTime, minutesWaiting, zonedWhen } from '@/lib/inbox';
import { cn } from '@/lib/utils';
import { AiTag, NeedTag, SiteTag, WebsiteIcon } from './ai-bits';
import { ContactAvatar, CountBadge, Pill, WaitChip } from './bits';

export const firstName = (full: string): string => full.trim().split(/\s+/)[0] || full;

/** "You: …" and "Marco: …" for what the business sent; the customer's words as they are. */
export function previewLine(c: ConversationSummary, myUserId: string): string {
  if (!c.lastMessageAt) return 'No messages yet';
  const text = c.lastPreview ?? '';
  if (c.lastDirection !== 'outbound' || !c.lastSentBy) return text;
  return `${c.lastSentBy.id === myUserId ? 'You' : firstName(c.lastSentBy.fullName)}: ${text}`;
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
  const unread = c.unreadCount > 0;
  const name = c.person?.fullName ?? c.counterpartDisplay;
  const needsPerson = c.status === 'open' && !!c.needsPersonSince;
  const aiName = c.handledBy === 'ai' ? (c.teammate?.name ?? null) : null;
  const handedFor = needsPerson ? minutesWaiting(c.needsPersonSince) : null;
  const waited = c.status === 'open' ? minutesWaiting(c.awaitingReplySince) : null;
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
      <ContactAvatar person={c.person} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('truncate text-sm', unread ? 'font-semibold' : 'font-medium')}>
            {name}
          </span>
          {c.channel === 'email' ? (
            <Mail
              className="h-3.5 w-3.5 flex-none text-text-3"
              strokeWidth={1.5}
              aria-label="Email"
            />
          ) : c.channel === 'chat' ? (
            <WebsiteIcon />
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
          {needsPerson ? (
            <>
              <NeedTag />
              {handedFor !== null ? <WaitChip minutes={handedFor} /> : null}
            </>
          ) : aiName ? (
            <AiTag>{draftWaiting ? `${aiName} · draft waiting` : aiName}</AiTag>
          ) : null}
          {c.onSiteNow ? <SiteTag testId="row-on-site-now" /> : null}
          {!needsPerson && waited !== null && waited >= waitThreshold ? (
            <WaitChip minutes={waited} />
          ) : null}
          {c.openLead ? (
            <StageBadge
              name={c.openLead.stageName}
              kind="open"
              className="hidden h-5 text-[11.5px] md:inline-flex"
            />
          ) : null}
          {c.person || c.channel === 'chat' ? null : <Pill>New number</Pill>}
          {c.status === 'snoozed' && c.snoozedUntil ? (
            <Pill icon={AlarmClock}>
              Snoozed until {zonedWhen(new Date(c.snoozedUntil), timezone)}
            </Pill>
          ) : null}
          {c.status === 'closed' ? <Badge variant="ok">Closed</Badge> : null}
          <span className="flex-1" />
          {c.assignee ? (
            <span title={`Assigned to ${c.assignee.fullName}`}>
              <Avatar name={c.assignee.fullName} seed={c.assignee.id} size="sm" />
            </span>
          ) : null}
          <CountBadge count={c.unreadCount} />
        </div>
      </div>
    </Link>
  );
}
