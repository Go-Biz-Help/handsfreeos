'use client';
import {
  aiWroteIt,
  ALL_LINES_WORDS,
  arrived,
  clockTime,
  dayDivider,
  dayKey,
  deliveryStateOf,
  deliveryWords,
  FAILED_STATUSES,
  heldLine,
  keywordLine,
  mediaOnlyLine,
  noteLine,
  readLine,
  senderOf,
  socialDeliveryWords,
  socialFailureHelp,
  socialLinesOf,
  textFailureHelp,
  THREAD_WORDS,
  threadWithNotes,
  weekdayClock,
  type NoteEntry,
  VIDEO_LINK_WORDS,
  FILE_LINK_WORDS,
} from '@hfos/core';
import { CheckCheck, CircleAlert, CornerUpLeft, Link2, Moon, Sparkles } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { CallCard } from '@/components/calls/call-card';
import { Button } from '@/components/ui/button';
import { AI_TEXT } from '@/components/workflows/chips';
import type { ThreadItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { DayDivider, MediaThumb, SystemEntry } from './bits';
import { MailCard, PendingMailCard } from './mail-card';
import { ButtonReplyNote, PlainFace, RichContent, TransportTag } from './rich-message';
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
  notes = [],
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
  timeZone,
  aiFeedback,
}: {
  items: ThreadItem[];
  /** Under each message the AI teammate wrote: the thumbs and what came of them. */
  aiFeedback?: (item: ThreadItem) => ReactNode;
  /** The notes the business wrote about this customer, folded into the thread by time (M10 step 15). */
  notes?: readonly NoteEntry[];
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
  /** The business's time zone: a held text says when it goes on the business's clock, as quiet hours end. */
  timeZone: string;
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
        {threadWithNotes(items, notes).map((piece) =>
          piece.kind === 'note' ? (
            <Fragment key={`note-${piece.id}`}>
              {withDay(piece.at) ? <DayDivider>{dayDivider(piece.at)}</DayDivider> : null}
              <NoteEntryCard note={piece.note} time={entryTime(piece.at, compact)} />
            </Fragment>
          ) : (
            <ThreadEntry
              key={piece.id}
              item={piece.item}
              day={withDay(piece.at) ? dayDivider(piece.at) : null}
              time={entryTime(piece.at, compact)}
              customerName={customerName}
              customerFirstName={customerFirstName}
              compact={compact}
              onRetry={onRetry}
              onCancelScheduled={onCancelScheduled}
              timeZone={timeZone}
              aiFeedback={aiFeedback}
            />
          ),
        )}
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

/** One message or call in the thread, with the day divider above it when the day changed. */
function ThreadEntry({
  item,
  day,
  time,
  customerName,
  customerFirstName,
  compact,
  onRetry,
  onCancelScheduled,
  timeZone,
  aiFeedback,
}: {
  item: ThreadItem;
  day: string | null;
  time: string;
  customerName: string | null;
  customerFirstName: string | null;
  compact?: boolean;
  onRetry?: (messageId: string) => void;
  onCancelScheduled?: (messageId: string) => void;
  timeZone: string;
  aiFeedback?: (item: ThreadItem) => ReactNode;
}) {
  return (
    <>
      {day ? <DayDivider>{day}</DayDivider> : null}
      {/* Which of the business's lines this one was on (0089). Only "All lines" fills `lineDisplay`, because
          a single lane's thread says its line once above the composer rather than on every message in it. */}
      {item.lineDisplay ? (
        <div className="pt-2 text-center text-[11px] text-text-3" data-testid={`line-${item.id}`}>
          {ALL_LINES_WORDS.line(item.direction, item.lineDisplay)}
        </div>
      ) : null}
      {item.type === 'call' ? (
        <CallCard item={item} time={time} compact={compact} />
      ) : item.channel === 'email' ? (
        <MailCard
          item={item}
          time={time}
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
          timeZone={timeZone}
        />
      )}
      {aiFeedback && aiWroteIt(item) && !item.scheduledFor ? (
        <div className="mt-0.5 flex justify-end" data-testid={`ai-feedback-${item.id}`}>
          {aiFeedback(item)}
        </div>
      ) : null}
    </>
  );
}

/**
 * A note the business wrote about the customer, in the thread (M10 step 15). It sits in the middle, quietly, so it
 * never reads as something that was sent to them — the same card the phone has shown since step 14.
 */
function NoteEntryCard({ note, time }: { note: NoteEntry; time: string }) {
  return (
    <div
      className="mt-2 self-center rounded-[10px] bg-card-2 px-3 py-2 text-[13px] text-text"
      data-testid={`note-${note.id}`}
    >
      <div className="mb-0.5 text-[11.5px] text-text-3">{noteLine(note, time)}</div>
      <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{note.body}</div>
    </div>
  );
}

/** A text held for quiet hours (M10): it waits in the thread with when it goes, and Cancel keeps it from going. */
function HeldEntry({
  item,
  timeZone,
  onCancel,
}: {
  item: ThreadItem & { scheduledFor: string };
  timeZone: string;
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
        <span data-testid={`held-${item.id}`}>{heldLine(item, item.scheduledFor, timeZone)}</span>
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
  timeZone,
}: {
  item: ThreadItem;
  onRetry?: (messageId: string) => void;
  onCancelScheduled?: (messageId: string) => void;
  customerFirstName: string | null;
  compact?: boolean;
  timeZone: string;
}) {
  const out = item.direction === 'outbound';
  const failed = out && FAILED_STATUSES.has(item.status);
  const time = entryTime(item.occurredAt, compact);
  const keyword = keywordLine(item, customerFirstName);
  // The AI teammate's reply reads "Ava (AI)", with "approved by Chris" when a person's OK sent it.
  const { ai, label: sender } = senderOf(item);
  // Messenger and Instagram: what it shared, what it answers, and whether it was changed or taken back.
  const social = socialLinesOf(item, customerFirstName);
  if (out && item.scheduledFor)
    return (
      <HeldEntry
        item={{ ...item, scheduledFor: item.scheduledFor }}
        timeZone={timeZone}
        onCancel={onCancelScheduled}
      />
    );
  return (
    <>
      <div
        data-testid={`message-${item.id}`}
        data-direction={item.direction}
        data-status={item.status}
        data-transport={item.transport ?? undefined}
        className={cn(
          'mt-2 flex max-w-[84%] flex-col gap-[3px] md:max-w-[76%]',
          out ? 'items-end self-end' : 'self-start',
        )}
      >
        {social?.replyTo ? (
          <span
            className="inline-flex items-center gap-1 px-1 text-[11.5px] text-text-3"
            data-testid={`reply-to-${item.id}`}
          >
            <CornerUpLeft className="h-3 w-3" strokeWidth={1.75} />
            {social.replyTo}
          </span>
        ) : null}
        {social?.unsent ? (
          <div
            className="rounded-2xl border border-dashed border-border px-[13px] py-[9px] text-[13px] italic text-text-3"
            data-testid={`unsent-${item.id}`}
          >
            {social.unsent}
          </div>
        ) : (
          /* A rich text's buttons, card or carousel go with its words (RCS, 0103). */
          <RichContent
            item={item}
            bubble={
              <>
                {item.media.map((m) => (
                  <MediaThumb
                    key={m.objectPath}
                    bucket={m.bucket}
                    objectPath={m.objectPath}
                    name={m.name}
                    contentType={m.contentType}
                  />
                ))}
                {item.media.some((m) => m.via === 'video_link') ? (
                  <span className="px-1 text-[11.5px] text-text-3" data-testid="came-by-video-link">
                    {VIDEO_LINK_WORDS.cameByLink}
                  </span>
                ) : item.media.some((m) => m.via === 'file_link') ? (
                  <span className="px-1 text-[11.5px] text-text-3" data-testid="came-by-file-link">
                    {FILE_LINK_WORDS.cameByLink}
                  </span>
                ) : null}
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
              </>
            }
          />
        )}
        {social && !social.unsent
          ? social.shared.map((x, i) =>
              x.url ? (
                <a
                  key={i}
                  href={x.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex max-w-full items-center gap-1 rounded-[10px] border border-border bg-card px-2.5 py-1.5 text-[13px] text-accent-text hover:underline"
                  data-testid={`shared-${item.id}`}
                >
                  <Link2 className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
                  <span className="truncate">{x.title ? `${x.label}: ${x.title}` : x.label}</span>
                </a>
              ) : (
                <span
                  key={i}
                  className="rounded-[10px] border border-border bg-card px-2.5 py-1.5 text-[13px] text-text-2"
                  data-testid={`shared-${item.id}`}
                >
                  {x.title ? `${x.label}: ${x.title}` : x.label}
                </span>
              ),
            )
          : null}
        {social?.postback ? (
          <span className="px-1 text-[11.5px] text-text-3">{social.postback}</span>
        ) : null}
        {social?.missingFiles ? (
          <span className="max-w-full px-1 text-[11.5px] text-text-3">{social.missingFiles}</span>
        ) : null}
        {out && item.rich && (item.transport === 'sms' || item.transport === 'mms') ? (
          <PlainFace smsText={item.rich.smsText} />
        ) : null}
        {!out && item.buttonReply ? (
          <ButtonReplyNote reply={item.buttonReply} body={item.body} />
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
                  {social?.elsewhere ?? sender} · {time}
                </span>
              )}
              <TransportTag transport={item.transport} />
              <DeliveryStatus
                status={item.status}
                chat={item.channel === 'chat' || item.channel === 'portal'}
                social={!!social}
                readAt={item.readAt}
              />
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
            <>
              <span>{mediaOnlyLine(item, time)}</span>
              {social?.edited ? <span>· {social.edited}</span> : null}
              <TransportTag transport={item.transport} />
            </>
          )}
        </div>
        {failed ? (
          <div className="max-w-full px-1 text-right text-xs text-text-2">
            {social ? socialFailureHelp(item) : textFailureHelp(item)}
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

/**
 * Where a reply is. A website chat's is "Seen" once the visitor's chat window read it, and a Messenger or Instagram
 * reply's once they opened it; an RCS message's is "Read" once the customer opened it, with the time on hover.
 */
function DeliveryStatus({
  status,
  chat,
  social,
  readAt,
}: {
  status: string;
  chat?: boolean;
  /** Messenger and Instagram say "Seen", as their own apps do. */
  social?: boolean;
  readAt?: string | null;
}) {
  const state = deliveryStateOf(status);
  const words = social ? socialDeliveryWords(state) : deliveryWords(state, chat);
  if (state === 'sending' || state === 'sent') return <span>· {words}</span>;
  if (arrived(state))
    return (
      <span
        className="inline-flex items-center gap-[3px] text-success-text"
        title={state === 'read' && readAt ? readLine(readAt) : undefined}
      >
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
