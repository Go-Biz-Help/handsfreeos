'use client';
import { smsKeyword } from '@hfos/core';
import { CheckCheck, CircleAlert, Moon, Sparkles } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { CallCard } from '@/components/calls/call-card';
import { Button } from '@/components/ui/button';
import { AI_TEXT } from '@/components/workflows/chips';
import { teammateMessageOf } from '@/lib/ai-team/inbox-types';
import { teammateLabel } from '@/lib/ai-team/inbox-words';
import type { ThreadItem } from '@/lib/api/types';
import { clockTime, dayDivider } from '@/lib/inbox';
import { cn } from '@/lib/utils';
import { DayDivider, MediaThumb, SystemEntry } from './bits';
import { firstName } from './conversation-row';
import { MailCard, PendingMailCard } from './mail-card';
import type { PendingText } from './hooks';

const FAILED = new Set(['failed', 'undelivered']);

/** Why a text didn't arrive, in words a person can act on (carrier codes are the common ones). */
function failureHelp(item: ThreadItem): string {
  switch (item.errorCode) {
    case '30003':
    case '30005':
    case '30006':
      return 'This number can’t receive texts. It may be a landline.';
    case '21610':
      return 'This customer texted STOP, so the carrier blocked it.';
    case '30007':
      return 'The carrier filtered this text. Try wording it differently.';
    case '30032':
    case '30034':
      return 'Texting isn’t approved for this number yet.';
    default:
      return item.errorMessage || 'The carrier didn’t deliver this text.';
  }
}

/** The time under an entry; the record page's sheet adds the weekday. */
function entryTime(iso: string, compact?: boolean): string {
  return compact
    ? new Date(iso).toLocaleString('en-US', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : clockTime(iso);
}

function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

/**
 * The conversation, oldest at the top and anchored to the bottom like a phone's messages. Customer on the
 * left, the team on the right; delivery status under what the team sent.
 */
export function MessageLog({
  items,
  pending,
  customerFirstName,
  customerName = null,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
  onRetry,
  onCancelScheduled,
  compact,
  tail,
}: {
  items: ThreadItem[];
  pending: PendingText[];
  /** Cancel on a text held for quiet hours: it never goes. */
  onCancelScheduled?: (messageId: string) => void;
  /** After the newest message: the AI teammate's draft, or what became of it. */
  tail?: ReactNode;
  /** For "Mike opted out of texts"; null for a number nobody has linked. */
  customerFirstName: string | null;
  /** The customer's full name, on the emails they sent. */
  customerName?: string | null;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  onRetry?: (messageId: string) => void;
  /** The record page's message sheet: tighter padding, day in the time. */
  compact?: boolean;
}) {
  let lastDay = '';
  const withDay = (iso: string) => {
    const key = dayKey(iso);
    const show = key !== lastDay;
    lastDay = key;
    return show;
  };

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Messages"
      data-testid="message-log"
      className={cn(
        'flex min-h-0 flex-1 flex-col-reverse overflow-y-auto',
        compact ? 'px-5 pb-4 pt-2' : 'px-3.5 pb-3.5 pt-1.5 md:px-6 md:pb-[18px] md:pt-3',
      )}
    >
      <div className="flex flex-col">
        {hasEarlier ? (
          <div className="flex justify-center pt-1">
            <Button variant="ghost" size="sm" loading={loadingEarlier} onClick={onLoadEarlier}>
              Show earlier messages
            </Button>
          </div>
        ) : null}
        {items.length === 0 && pending.length === 0 && !tail ? (
          <div className="py-10 text-center text-[13px] text-text-3">
            No messages yet. Say hello below.
          </div>
        ) : null}
        {items.map((item) => (
          <Fragment key={item.id}>
            {withDay(item.occurredAt) ? (
              <DayDivider>{dayDivider(item.occurredAt)}</DayDivider>
            ) : null}
            {item.type === 'call' ? (
              <CallCard item={item} time={entryTime(item.occurredAt, compact)} compact={compact} />
            ) : item.channel === 'email' ? (
              <MailCard
                item={item}
                time={entryTime(item.occurredAt, compact)}
                customerName={customerName}
                compact={compact}
                onRetry={onRetry}
              />
            ) : (
              <MessageEntry
                item={item}
                onRetry={onRetry}
                onCancelScheduled={onCancelScheduled}
                customerFirstName={customerFirstName}
                compact={compact}
              />
            )}
          </Fragment>
        ))}
        {pending.map((p) => (
          <Fragment key={p.clientId}>
            {withDay(p.at) ? <DayDivider>{dayDivider(p.at)}</DayDivider> : null}
            {p.channel === 'email' ? (
              <PendingMailCard
                subject={p.subject ?? ''}
                from={p.from ?? ''}
                body={p.body}
                compact={compact}
              />
            ) : (
              <div className="mt-2 flex max-w-[84%] flex-col items-end gap-[3px] self-end md:max-w-[76%]">
                <div className="whitespace-pre-wrap rounded-2xl rounded-br-[5px] bg-accent px-[13px] py-[9px] text-[15px] leading-[1.45] text-white [overflow-wrap:anywhere] md:text-sm">
                  {p.body}
                </div>
                <div className="flex items-center gap-[5px] whitespace-nowrap px-1 text-[11.5px] text-text-3">
                  You · now · Sending…
                </div>
              </div>
            )}
          </Fragment>
        ))}
        {tail}
      </div>
    </div>
  );
}

/** When a held text goes, as this browser reads the moment: "at 8:00 AM", "tomorrow at 8:00 AM", "Monday at 8:00 AM". */
export function heldWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = clockTime(iso);
  if (d.toDateString() === now.toDateString()) return `at ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'long' })} at ${time}`;
}

/** A text held for quiet hours (M10): it waits in the thread with when it goes, and Cancel keeps it from going. */
function HeldEntry({
  item,
  onCancel,
}: {
  item: ThreadItem & { scheduledFor: string };
  onCancel?: (messageId: string) => void;
}) {
  const sender = item.sentBy ? firstName(item.sentBy.fullName) : 'HandsFreeOS';
  return (
    <div
      data-testid={`message-${item.id}`}
      data-direction={item.direction}
      data-status="scheduled"
      className="mt-2 flex max-w-[84%] flex-col items-end gap-[3px] self-end md:max-w-[76%]"
    >
      {item.media.map((m) => (
        <MediaThumb
          key={m.objectPath}
          bucket={m.bucket}
          objectPath={m.objectPath}
          name={m.name}
          contentType={m.contentType}
        />
      ))}
      {item.body ? (
        <div className="whitespace-pre-wrap rounded-2xl rounded-br-[5px] border border-dashed border-[color-mix(in_oklab,var(--accent)_55%,transparent)] bg-accent-soft px-[13px] py-[9px] text-[15px] leading-[1.45] text-text [overflow-wrap:anywhere] md:text-sm">
          {item.body}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-x-[5px] px-1 text-[11.5px] text-text-3">
        <Moon className="h-3 w-3 text-warning-text" strokeWidth={1.75} />
        <span data-testid={`held-${item.id}`}>
          {sender} · Sends {heldWhen(item.scheduledFor)}, when quiet hours end
        </span>
        {onCancel ? (
          <Button
            variant="ghost"
            className="h-6 px-1.5 text-xs"
            onClick={() => onCancel(item.id)}
            data-testid={`cancel-held-${item.id}`}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function MessageEntry({
  item,
  onRetry,
  onCancelScheduled,
  customerFirstName,
  compact,
}: {
  item: ThreadItem;
  onRetry?: (messageId: string) => void;
  onCancelScheduled?: (messageId: string) => void;
  customerFirstName: string | null;
  compact?: boolean;
}) {
  const out = item.direction === 'outbound';
  const failed = out && FAILED.has(item.status);
  const time = entryTime(item.occurredAt, compact);
  const keyword = !out && item.body ? smsKeyword(item.body) : null;
  // The AI teammate's reply reads "Ava (AI)", with "approved by Chris" when a person's OK sent it.
  const ai = out ? teammateMessageOf(item) : null;
  const sender = item.sentBy ? firstName(item.sentBy.fullName) : 'HandsFreeOS';
  const mediaNames = item.media.map((m) => m.name).join(', ');
  if (out && item.scheduledFor)
    return (
      <HeldEntry item={{ ...item, scheduledFor: item.scheduledFor }} onCancel={onCancelScheduled} />
    );
  return (
    <>
      <div
        data-testid={`message-${item.id}`}
        data-direction={item.direction}
        data-status={item.status}
        className={cn(
          'mt-2 flex max-w-[84%] flex-col gap-[3px] md:max-w-[76%]',
          out ? 'items-end self-end' : 'self-start',
        )}
      >
        {item.media.map((m) => (
          <MediaThumb
            key={m.objectPath}
            bucket={m.bucket}
            objectPath={m.objectPath}
            name={m.name}
            contentType={m.contentType}
          />
        ))}
        {item.body ? (
          <div
            className={cn(
              'whitespace-pre-wrap rounded-2xl px-[13px] py-[9px] text-[15px] leading-[1.45] [overflow-wrap:anywhere] md:text-sm',
              out
                ? failed
                  ? 'rounded-br-[5px] bg-danger-soft text-danger-text'
                  : 'rounded-br-[5px] bg-accent text-white'
                : 'rounded-bl-[5px] border border-border bg-card',
            )}
          >
            {item.body}
          </div>
        ) : null}
        <div className="flex items-center gap-[5px] whitespace-nowrap px-1 text-[11.5px] text-text-3">
          {out ? (
            <>
              {ai ? (
                <>
                  <span
                    className={cn('inline-flex items-center gap-[3px] font-semibold', AI_TEXT)}
                    data-testid="ai-label"
                  >
                    <Sparkles className="h-3 w-3" strokeWidth={1.75} />
                    {teammateLabel(ai)}
                  </span>
                  <span>· {time}</span>
                </>
              ) : (
                <span>
                  {sender} · {time}
                </span>
              )}
              <DeliveryStatus status={item.status} chat={item.channel === 'chat'} />
              {failed && onRetry ? (
                <Button
                  variant="ghost"
                  className="h-6 px-1.5 text-xs"
                  onClick={() => onRetry(item.id)}
                  data-testid={`retry-${item.id}`}
                >
                  Retry
                </Button>
              ) : null}
            </>
          ) : (
            <span>{!item.body && mediaNames ? `${mediaNames} · ${time}` : time}</span>
          )}
        </div>
        {failed ? (
          <div className="max-w-full px-1 text-right text-xs text-text-2">{failureHelp(item)}</div>
        ) : null}
      </div>
      {keyword === 'stop' ? (
        <SystemEntry icon={CircleAlert}>
          {customerFirstName ?? 'This number'} opted out of texts
        </SystemEntry>
      ) : keyword === 'start' ? (
        <SystemEntry icon={CheckCheck}>
          {customerFirstName ?? 'This number'} opted back in to texts
        </SystemEntry>
      ) : null}
    </>
  );
}

/** Where a reply is. A website chat's is "Seen" once the visitor's chat window read it. */
function DeliveryStatus({ status, chat }: { status: string; chat?: boolean }) {
  if (status === 'queued' || status === 'sending') return <span>· Sending…</span>;
  if (status === 'sent') return <span>· Sent</span>;
  if (status === 'delivered')
    return (
      <span className="inline-flex items-center gap-[3px] text-success-text">
        <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
        {chat ? 'Seen' : 'Delivered'}
      </span>
    );
  if (FAILED.has(status))
    return (
      <span className="inline-flex items-center gap-[3px] font-medium text-danger-text">
        <CircleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
        Not delivered
      </span>
    );
  return null;
}
