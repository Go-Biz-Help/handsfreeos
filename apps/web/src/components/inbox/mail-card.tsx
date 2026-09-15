'use client';
import { CheckCheck, CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { teammateMessageOf } from '@/lib/ai-team/inbox-types';
import { teammateLabel } from '@/lib/ai-team/inbox-words';
import type { ThreadItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { AttachmentChip } from './attachment-chip';
import { MailBody } from './mail-body';

const STOPPED = new Set(['bounced', 'complained']);
const FAILED = new Set(['failed', 'undelivered']);

/** Why an email didn't arrive, after "Bounced:" or "Not sent:". */
function problem(item: ThreadItem): string {
  if (item.status === 'complained') return 'Marked as spam';
  if (item.status === 'bounced')
    return `Bounced: ${item.errorMessage || 'it could not be delivered'}`;
  return `Not sent: ${item.errorMessage || 'the mail service refused it'}`;
}

/**
 * An email in the conversation: subject, who and from which address, the body (received HTML in a sandboxed
 * frame), attachments, and where an email we sent is. `compact` is the record page's sheet.
 */
export function MailCard({
  item,
  time,
  customerName,
  compact,
  onRetry,
}: {
  item: ThreadItem;
  time: string;
  /** The customer's full name, for what they sent. */
  customerName: string | null;
  compact?: boolean;
  onRetry?: (messageId: string) => void;
}) {
  const out = item.direction === 'outbound';
  const stopped = out && STOPPED.has(item.status);
  const failed = out && FAILED.has(item.status);
  const bad = stopped || failed;
  // The AI teammate's email reads "Ava (AI)", with "approved by Chris" when a person's OK sent it.
  const ai = out ? teammateMessageOf(item) : null;
  const sender = out
    ? ai
      ? teammateLabel(ai)
      : (item.sentBy?.fullName ?? 'HandsFreeOS')
    : (customerName ?? item.fromAddress ?? 'Someone');
  const fromLine = [
    sender,
    item.fromAddress,
    out && item.via ? `sent through ${item.via === 'microsoft' ? 'Outlook' : 'Gmail'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const subject = item.subject || '(no subject)';
  return (
    <div
      data-testid={`message-${item.id}`}
      data-kind="email"
      data-direction={item.direction}
      data-status={item.status}
      className={cn(
        'mt-2 flex flex-col gap-[3px]',
        out ? 'items-end self-end' : 'self-start',
        compact ? 'w-full max-w-[92%]' : 'max-w-[88%] max-md:max-w-[94%]',
      )}
    >
      <article
        className={cn(
          'flex flex-col gap-2 rounded-dialog border bg-card px-4 py-3.5',
          compact ? 'w-full' : 'w-[520px] max-w-full max-md:w-full',
          bad
            ? 'border-danger-soft'
            : out
              ? 'border-[color-mix(in_oklab,var(--accent)_35%,var(--border))]'
              : 'border-border',
        )}
      >
        {/* Desktop: subject and from line, time at the right. Phones: the time joins the from line. */}
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium [overflow-wrap:anywhere]">{subject}</div>
            {compact ? null : (
              <div className="truncate text-xs text-text-3">
                <span className="max-md:hidden">{fromLine}</span>
                <span className="md:hidden">
                  {sender} · {time}
                </span>
              </div>
            )}
          </div>
          <time
            dateTime={item.occurredAt}
            className={cn('whitespace-nowrap text-xs text-text-3', compact ? '' : 'max-md:hidden')}
          >
            {time}
          </time>
        </header>
        {!out && item.bodyHtml ? (
          <MailBody html={item.bodyHtml} media={item.media} title={`Email from ${sender}`} />
        ) : (
          <div
            className={cn(
              'whitespace-pre-wrap text-[13.5px] leading-[1.5] [overflow-wrap:anywhere]',
              bad ? 'text-text-2' : 'text-text',
            )}
          >
            {item.body}
          </div>
        )}
        {item.media.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {item.media.map((m) => (
              <AttachmentChip key={m.objectPath} file={m} />
            ))}
          </div>
        ) : null}
      </article>
      {out && !compact ? (
        <div className="flex items-center gap-[5px] whitespace-nowrap px-1 text-[11.5px] text-text-3 max-md:hidden">
          {bad ? (
            <span className="inline-flex items-center gap-[3px] font-medium text-danger-text">
              <CircleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
              {problem(item)}
            </span>
          ) : item.status === 'delivered' ? (
            <span className="inline-flex items-center gap-[3px] text-success-text">
              <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
              Delivered
            </span>
          ) : item.status === 'sent' ? (
            <span>Sent</span>
          ) : (
            <span>Sending…</span>
          )}
          {/* A soft failure can go again; a bounce or a complaint can't (the address is stopped). */}
          {failed && onRetry ? (
            <Button
              variant="ghost"
              className="h-6 px-1.5 text-xs"
              onClick={() => onRetry(item.id)}
              data-testid={`retry-${item.id}`}
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** An email on its way: the card at once, replaced by the stored message when it arrives. */
export function PendingMailCard({
  subject,
  from,
  body,
  compact,
}: {
  subject: string;
  from: string;
  body: string;
  compact?: boolean;
}) {
  return (
    <div
      data-testid="pending-email"
      className={cn(
        'mt-2 flex flex-col items-end gap-[3px] self-end',
        compact ? 'w-full max-w-[92%]' : 'max-w-[88%] max-md:max-w-[94%]',
      )}
    >
      <article
        className={cn(
          'flex flex-col gap-2 rounded-dialog border border-[color-mix(in_oklab,var(--accent)_35%,var(--border))] bg-card px-4 py-3.5',
          compact ? 'w-full' : 'w-[520px] max-w-full max-md:w-full',
        )}
      >
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium [overflow-wrap:anywhere]">{subject}</div>
            {compact ? null : <div className="truncate text-xs text-text-3">You · {from}</div>}
          </div>
          <span className="whitespace-nowrap text-xs text-text-3">Now</span>
        </header>
        <div className="whitespace-pre-wrap text-[13.5px] leading-[1.5] text-text [overflow-wrap:anywhere]">
          {body}
        </div>
      </article>
      {compact ? null : (
        <div className="px-1 text-[11.5px] text-text-3 max-md:hidden">Sending…</div>
      )}
    </div>
  );
}
