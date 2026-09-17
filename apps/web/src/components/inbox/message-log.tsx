'use client';
import {
  clockTime,
  dayDivider,
  dayKey,
  deliveryStateOf,
  deliveryWords,
  FAILED_STATUSES,
  heldLine,
  keywordLine,
  mediaOnlyLine,
  senderOf,
  textFailureHelp,
  THREAD_WORDS,
  weekdayClock,
} from '@hfos/core';
import { CheckCheck, CircleAlert, Moon, Sparkles } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { CallCard } from '@/components/calls/call-card';
import { Button } from '@/components/ui/button';
import { AI_TEXT } from '@/components/workflows/chips';
import type { ThreadItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { DayDivider, MediaThumb, SystemEntry } from './bits';
import { MailCard, PendingMailCard } from './mail-card';
import type { PendingText } from './hooks';

/** The time under an entry; the record page's sheet adds the weekday. */
function entryTime(iso: string, compact?: boolean): string {
  return compact ? weekdayClock(iso) : clockTime(iso);
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
              {THREAD_WORDS.showEarlier}
            </Button>
          </div>
        ) : null}
        {items.length === 0 && pending.length === 0 && !tail ? (
          <div className="py-10 text-center text-[13px] text-text-3">{THREAD_WORDS.empty}</div>
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
                  {THREAD_WORDS.sendingNow}
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

/** A text held for quiet hours (M10): it waits in the thread with when it goes, and Cancel keeps it from going. */
function HeldEntry({
  item,
  onCancel,
}: {
  item: ThreadItem & { scheduledFor: string };
  onCancel?: (messageId: string) => void;
}) {
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
        <span data-testid={`held-${item.id}`}>{heldLine(item, item.scheduledFor)}</span>
        {onCancel ? (
          <Button
            variant="ghost"
            className="h-6 px-1.5 text-xs"
            onClick={() => onCancel(item.id)}
            data-testid={`cancel-held-${item.id}`}
          >
            {THREAD_WORDS.cancel}
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
  const failed = out && FAILED_STATUSES.has(item.status);
  const time = entryTime(item.occurredAt, compact);
  const keyword = keywordLine(item, customerFirstName);
  // The AI teammate's reply reads "Ava (AI)", with "approved by Chris" when a person's OK sent it.
  const { ai, label: sender } = senderOf(item);
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
                    {sender}
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
                  {THREAD_WORDS.retry}
                </Button>
              ) : null}
            </>
          ) : (
            <span>{mediaOnlyLine(item, time)}</span>
          )}
        </div>
        {failed ? (
          <div className="max-w-full px-1 text-right text-xs text-text-2">
            {textFailureHelp(item)}
          </div>
        ) : null}
      </div>
      {keyword ? (
        <SystemEntry icon={keyword.kind === 'stop' ? CircleAlert : CheckCheck}>
          {keyword.text}
        </SystemEntry>
      ) : null}
    </>
  );
}

/** Where a reply is. A website chat's is "Seen" once the visitor's chat window read it. */
function DeliveryStatus({ status, chat }: { status: string; chat?: boolean }) {
  const state = deliveryStateOf(status);
  const words = deliveryWords(state, chat);
  if (state === 'sending' || state === 'sent') return <span>· {words}</span>;
  if (state === 'delivered')
    return (
      <span className="inline-flex items-center gap-[3px] text-success-text">
        <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
        {words}
      </span>
    );
  if (state === 'failed')
    return (
      <span className="inline-flex items-center gap-[3px] font-medium text-danger-text">
        <CircleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
        {words}
      </span>
    );
  return null;
}
