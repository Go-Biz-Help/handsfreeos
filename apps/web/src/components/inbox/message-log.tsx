'use client';
import { smsKeyword } from '@hfos/core';
import { CheckCheck, CircleAlert, Phone, PhoneMissed, Voicemail } from 'lucide-react';
import { Fragment } from 'react';
import { Button } from '@/components/ui/button';
import type { ThreadItem } from '@/lib/api/types';
import { clockTime, dayDivider } from '@/lib/inbox';
import { cn } from '@/lib/utils';
import { ChannelIcon, DayDivider, MediaThumb, SystemEntry } from './bits';
import { firstName } from './conversation-row';
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
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
  onRetry,
  compact,
}: {
  items: ThreadItem[];
  pending: PendingText[];
  /** For "Mike opted out of texts"; null for a number nobody has linked. */
  customerFirstName: string | null;
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
        {items.length === 0 && pending.length === 0 ? (
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
              <CallEntry item={item} />
            ) : (
              <MessageEntry
                item={item}
                onRetry={onRetry}
                customerFirstName={customerFirstName}
                compact={compact}
              />
            )}
          </Fragment>
        ))}
        {pending.map((p) => (
          <Fragment key={p.clientId}>
            {withDay(p.at) ? <DayDivider>{dayDivider(p.at)}</DayDivider> : null}
            <div className="mt-2 flex max-w-[84%] flex-col items-end gap-[3px] self-end md:max-w-[76%]">
              <div className="whitespace-pre-wrap rounded-2xl rounded-br-[5px] bg-accent px-[13px] py-[9px] text-[15px] leading-[1.45] text-white [overflow-wrap:anywhere] md:text-sm">
                {p.body}
              </div>
              <div className="flex items-center gap-[5px] whitespace-nowrap px-1 text-[11.5px] text-text-3">
                You · now · Sending…
              </div>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function MessageEntry({
  item,
  onRetry,
  customerFirstName,
  compact,
}: {
  item: ThreadItem;
  onRetry?: (messageId: string) => void;
  customerFirstName: string | null;
  compact?: boolean;
}) {
  const out = item.direction === 'outbound';
  const failed = out && FAILED.has(item.status);
  const time = compact
    ? new Date(item.occurredAt).toLocaleString('en-US', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : clockTime(item.occurredAt);
  const keyword = !out && item.body ? smsKeyword(item.body) : null;
  const sender = item.sentBy ? firstName(item.sentBy.fullName) : 'HandsFreeOS';
  const mediaNames = item.media.map((m) => m.name).join(', ');
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
              <span>
                {sender} · {time}
              </span>
              <DeliveryStatus status={item.status} />
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

function DeliveryStatus({ status }: { status: string }) {
  if (status === 'queued' || status === 'sending') return <span>· Sending…</span>;
  if (status === 'sent') return <span>· Sent</span>;
  if (status === 'delivered')
    return (
      <span className="inline-flex items-center gap-[3px] text-success-text">
        <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
        Delivered
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

const duration = (s: number | null) =>
  s === null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Calls sit in the same thread (they arrive with the calls step; a plain card until then). */
function CallEntry({ item }: { item: ThreadItem }) {
  const missed = item.status !== 'completed' || item.isVoicemail;
  return (
    <div className="mt-2 flex w-[360px] max-w-[80%] flex-col gap-2.5 self-start rounded-[14px] border border-border bg-card px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <ChannelIcon
          icon={item.isVoicemail ? Voicemail : missed ? PhoneMissed : Phone}
          tone={missed ? 'warning' : 'success'}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">
            {item.isVoicemail
              ? 'Missed call · left a voicemail'
              : missed
                ? 'Missed call'
                : `${item.direction === 'inbound' ? 'Incoming' : 'Outgoing'} call`}
          </div>
          <div className="text-xs text-text-3">{clockTime(item.occurredAt)}</div>
        </div>
        {!missed ? (
          <span className="font-mono text-xs text-text-3">{duration(item.durationSeconds)}</span>
        ) : null}
      </div>
      {item.transcript ? <p className="text-[13px] leading-[1.5]">“{item.transcript}”</p> : null}
    </div>
  );
}
