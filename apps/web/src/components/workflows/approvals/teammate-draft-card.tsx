'use client';
import { Check, Clock, Info, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { approvedToast, DraftActions } from '@/components/inbox/draft-card';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FieldError, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AI_TEXT } from '@/components/workflows/chips';
import { teammateMessageOf, type TeammateDraft } from '@/lib/ai-team/inbox-types';
import {
  aiName,
  CHANNEL_WORD,
  decideRefusal,
  draftTitle,
  expiresLine,
  firstNameOf,
  teammateLabel,
} from '@/lib/ai-team/inbox-words';
import { teammateCommands } from '@/lib/ai-team/use-inbox';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type { ThreadItem } from '@/lib/api/types';
import { minutesSince, waitingFor } from '@/lib/format';
import { clockTime } from '@/lib/inbox';
import { cn, relativeTime } from '@/lib/utils';
import { KindTile } from '../chips';
import { approvalsChanged } from './use-waiting-approvals';
import { segmentLabel } from './words';

const SECTION = 'text-xs font-semibold uppercase tracking-[0.06em] text-text-3';

/** The last few messages of the draft's conversation, oldest first, so the approver sees what it answers. */
function useRecentMessages(workspaceId: string, conversationId: string | null, open: boolean) {
  const [items, setItems] = useState<ThreadItem[] | null>(null);
  useEffect(() => {
    if (!open || !conversationId) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/conversation.thread', {
        body: { workspaceId, conversationId, limit: 4 },
      })
      .then((r) => {
        if (!cancelled)
          setItems(
            unwrap(r)
              .items.filter((i) => i.type === 'message' && (i.body ?? '').trim())
              .reverse(),
          );
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, conversationId, open]);
  return items;
}

/**
 * One of the AI teammate's drafts on the Approvals page: what it answers, the message that will go (editable),
 * any booking change it holds, when it expires, and Approve or Reject. A discount waits for an owner or admin;
 * everyone else sees it read-only. After a rejection: "I’ll reply" or "Try again", as in the inbox.
 */
export function TeammateDraftCard({
  d,
  workspaceId,
  timezone,
  now,
  startOpen,
  onDone,
}: {
  d: TeammateDraft;
  workspaceId: string;
  timezone: string;
  now: number;
  startOpen: boolean;
  /** It left the waiting list (decided, or someone took the conversation). */
  onDone: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const original = d.preview.message?.body ?? '';
  const originalSubject = d.preview.message?.subject ?? '';
  const [body, setBody] = useState(original);
  const [subject, setSubject] = useState(originalSubject);
  const [busy, setBusy] = useState<'approve' | 'reject' | 'take' | 'retry' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [rejected, setRejected] = useState(false);
  const recent = useRecentMessages(workspaceId, d.conversationId, open);
  const name = d.teammate.name;
  // "Mike" in the sentences; "them" for a number or visitor nobody has added to Customers.
  const first = d.person ? firstNameOf(d.person.fullName) : 'them';
  const goesToPerson = d.person ? firstNameOf(d.person.fullName) : 'the conversation';
  const message = d.preview.message;
  const email = d.channel === 'email';
  const expires = expiresLine(d.expiresAt, timezone, now);
  const expired = expires === 'Expired';
  const channel = d.channel ? (CHANNEL_WORD[d.channel] ?? d.channel) : 'message';
  const byline = `${aiName(name)} · ${channel} · ${waitingFor(minutesSince(d.createdAt, now))}${d.kind === 'reply' ? ' · in the inbox too' : ''}`;
  const convHref = d.conversationId ? `/app/w/${workspaceId}/inbox/${d.conversationId}` : null;
  const cmd = teammateCommands(workspaceId);

  async function decide(decision: 'approve' | 'reject') {
    const edits: { body?: string; subject?: string } = {};
    if (decision === 'approve' && message) {
      if (body.trim() !== original.trim()) edits.body = body.trim();
      if (email && subject.trim() !== originalSubject.trim()) edits.subject = subject.trim();
    }
    const edited = Object.keys(edits).length > 0;
    setBusy(decision);
    try {
      const out = await cmd.decide({
        draftId: d.id,
        decision,
        ...(edited ? { edits } : {}),
        ...(decision === 'reject' && reason.trim() ? { reason: reason.trim() } : {}),
      });
      approvalsChanged();
      if (decision === 'approve') {
        toast.success(approvedToast(d, out, edited, first));
        onDone();
      } else {
        toast.success(`Rejected. Nothing went to ${first}.`);
        setRejecting(false);
        // A reply's rejection leaves the conversation with the teammate: ask what happens next.
        if (d.kind === 'reply' && d.conversationId) setRejected(true);
        else onDone();
      }
    } catch (e) {
      const words = e instanceof ApiError ? decideRefusal(e.rule ?? null, first, name) : null;
      toast.error(words ?? errorMessage(e));
      if (words) onDone();
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  async function next(how: 'take' | 'retry') {
    if (!d.conversationId) return;
    setBusy(how);
    try {
      if (how === 'take') {
        await cmd.takeOver(d.conversationId);
        toast.success(`It’s yours. ${name} stays quiet until you hand it back.`);
        router.push(`/app/w/${workspaceId}/inbox/${d.conversationId}`);
      } else {
        await cmd.retry(d.id);
        toast.success(`${name} is writing a new draft for ${first}. It’ll wait here for an OK.`);
      }
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (rejected)
    return (
      <Card className="flex flex-col gap-2.5 px-4 py-3.5" data-testid="teammate-draft-rejected">
        <p className="text-[13.5px]">
          <strong className="font-semibold">You rejected {name}’s draft.</strong> Nothing went to{' '}
          {first}. What next?
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            loading={busy === 'take'}
            onClick={() => void next('take')}
            data-testid="draft-ill-reply"
          >
            I’ll reply
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'retry'}
            onClick={() => void next('retry')}
            data-testid="draft-try-again"
          >
            Try again
          </Button>
        </div>
      </Card>
    );

  if (!open)
    return (
      <Card
        className="flex items-center gap-3 px-4 py-3"
        data-testid="teammate-draft"
        data-draft-id={d.id}
      >
        <KindTile tone="ai" icon={Sparkles} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-semibold">{draftTitle(d)}</span>
          <span className="truncate text-xs text-text-3">{byline}</span>
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="teammate-draft-review"
        >
          Review
        </Button>
      </Card>
    );

  const bookHolds = d.preview.actions.some((a) => a.kind === 'book');
  return (
    <Card
      className="border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] px-4 py-4 shadow-[0_0_0_3px_var(--accent-soft)] md:px-[18px]"
      data-testid="teammate-draft"
      data-draft-id={d.id}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <KindTile tone="ai" icon={Sparkles} />
        <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
          <h3 className="text-[15px] font-semibold leading-snug" data-testid="teammate-draft-title">
            {draftTitle(d)}
          </h3>
          <span className="text-xs text-text-3">{byline}</span>
        </span>
        {expires ? (
          <span
            className={cn(
              'inline-flex flex-none items-center gap-1 rounded-full px-2 py-1 text-xs font-medium',
              expired ? 'bg-danger-soft text-danger-text' : 'bg-warning-soft text-warning-text',
            )}
          >
            <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />
            {expires}
          </span>
        ) : null}
      </div>

      <div className="mt-3.5 grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div className="flex min-w-0 flex-col gap-2">
          <span className={SECTION}>The conversation</span>
          <div
            className="flex flex-col gap-2 rounded-[10px] border border-border p-2.5"
            data-testid="teammate-draft-conversation"
          >
            {recent === null ? (
              <span className="text-xs text-text-3">Loading…</span>
            ) : recent.length === 0 ? (
              <span className="text-xs text-text-3">No messages yet.</span>
            ) : (
              recent.map((m) => {
                const out = m.direction === 'outbound';
                const ai = out ? teammateMessageOf(m) : null;
                return (
                  <div
                    key={m.id}
                    className={cn(
                      'flex max-w-[92%] flex-col gap-0.5',
                      out ? 'items-end self-end' : 'self-start',
                    )}
                  >
                    <div
                      className={cn(
                        'whitespace-pre-wrap rounded-[14px] px-[11px] py-[7px] text-[13px] leading-[1.45] [overflow-wrap:anywhere]',
                        out
                          ? 'rounded-br-[4px] bg-accent text-white'
                          : 'rounded-bl-[4px] bg-card-2',
                      )}
                    >
                      {m.body}
                    </div>
                    <span
                      className={cn(
                        'px-[3px] text-xs',
                        ai ? cn('font-medium', AI_TEXT) : 'text-text-3',
                      )}
                    >
                      {ai
                        ? teammateLabel(ai)
                        : out
                          ? (m.sentBy?.fullName ?? 'HandsFreeOS')
                          : (d.person?.fullName ?? 'Customer')}{' '}
                      · {clockTime(m.occurredAt)}
                    </span>
                  </div>
                );
              })
            )}
          </div>
          <span className="flex items-center gap-1.5 text-xs text-text-3">
            <Check className="h-3.5 w-3.5 text-success-text" strokeWidth={2} />
            It passed the safety check before it was shown here.
          </span>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          {message ? (
            <>
              <Label htmlFor={`draft-${d.id}`} className={SECTION}>
                {email ? 'The email that will go' : `The ${channel} that will go`}
                {d.canDecide ? ' · you can edit it' : ''}
              </Label>
              {email ? (
                <Input
                  inputSize="sm"
                  aria-label="Subject"
                  value={subject}
                  readOnly={!d.canDecide || busy !== null || expired}
                  onChange={(e) => setSubject(e.target.value)}
                />
              ) : null}
              <Textarea
                id={`draft-${d.id}`}
                data-testid="teammate-draft-body"
                className="min-h-[104px] text-[14px]"
                value={body}
                maxLength={email ? 10000 : 1600}
                readOnly={!d.canDecide || busy !== null || expired}
                invalid={!body.trim()}
                onChange={(e) => setBody(e.target.value)}
              />
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-3">
                <span>
                  {body !== original
                    ? 'Edited: your version is what goes out.'
                    : `Written by ${name}. Your edits are what goes out.`}
                </span>
                {d.channel === 'sms' ? (
                  <span className="tabular-nums">{segmentLabel(body)}</span>
                ) : null}
              </div>
              {!body.trim() ? <FieldError>Write the message, or reject it.</FieldError> : null}
            </>
          ) : null}
          <DraftActions draft={d} />
          <p className="flex items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px] text-[12.5px] leading-[1.45] text-text-2">
            <Info className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
            <span>
              {d.kind === 'approval' && !d.canDecide
                ? 'Only owners and admins decide what the AI teammate asks approval for. '
                : ''}
              {bookHolds
                ? 'Approving books the time first, then sends. If someone took that time meanwhile, the conversation goes to a person with a note. '
                : ''}
              {expired
                ? 'This expired, so the conversation went to a person.'
                : `If nobody decides ${expires ? `by ${expires.replace('Expires ', '')}` : 'in time'}, ${goesToPerson} goes to a person.`}
            </span>
          </p>
        </div>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-border pt-3.5">
        {d.canDecide ? (
          <>
            <Button
              onClick={() => void decide('approve')}
              disabled={busy !== null || expired || (!!message && !body.trim())}
              loading={busy === 'approve'}
              data-testid="teammate-draft-approve"
            >
              {busy === 'approve' ? null : <Check className="h-4 w-4" strokeWidth={1.75} />}
              {message ? 'Approve and send' : 'Approve'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setRejecting(true)}
              disabled={busy !== null || expired}
              data-testid="teammate-draft-reject"
            >
              Reject…
            </Button>
          </>
        ) : (
          <span className="text-[13px] text-text-2" data-testid="teammate-draft-readonly">
            Waiting for an owner or admin.
          </span>
        )}
        <span className="flex-1" />
        {convHref ? (
          <Link
            href={convHref}
            className="text-[13px] font-medium text-accent-text hover:underline"
            data-testid="teammate-draft-open"
          >
            Open the conversation
          </Link>
        ) : null}
      </div>

      <Dialog open={rejecting} onOpenChange={(o) => busy === null && setRejecting(o)}>
        <DialogContent
          title={`Reject ${name}’s draft?`}
          description={`Nothing goes to ${first}${d.preview.actions.length ? ', and nothing changes on the calendar' : ''}.`}
        >
          <div className="mt-4 flex flex-col gap-1.5">
            <Label htmlFor={`draft-reject-${d.id}`}>
              Why? It helps {name} next time (optional)
            </Label>
            <Textarea
              id={`draft-reject-${d.id}`}
              data-testid="teammate-draft-reason"
              className="min-h-[72px] text-[14px]"
              value={reason}
              maxLength={1000}
              placeholder="Ask which system first. I’ll call him."
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setRejecting(false)}
              disabled={busy !== null}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() => void decide('reject')}
              loading={busy === 'reject'}
              data-testid="teammate-draft-reject-confirm"
            >
              Reject
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** "Approved by Dale with an edit" (on the phone), "Rejected by Dale: “…”", "Expired: nobody decided in time". */
export function draftDecidedLine(d: TeammateDraft): string {
  const by = d.decidedBy ? ` by ${firstNameOf(d.decidedBy.fullName)}` : '';
  const where =
    d.via === 'assistant' ? ' in the Assistant' : d.via === 'mobile' ? ' on the phone' : '';
  switch (d.status) {
    case 'approved':
      return `Approved${by}${d.edits ? ' with an edit' : ''}${where}`;
    case 'rejected':
      return `Rejected${by}${d.reason ? `: “${d.reason}”` : ''}`;
    case 'expired':
      return 'Expired: nobody decided in time';
    case 'cancelled':
      return d.reason ? `Dropped: ${d.reason.replace(/\.$/, '').toLowerCase()}` : 'Dropped';
    default:
      return 'Waiting';
  }
}

/** One decided draft in the Decided list. */
export function DecidedDraftRow({
  d,
  workspaceId,
  now,
  first,
}: {
  d: TeammateDraft;
  workspaceId: string;
  now: number;
  first: boolean;
}) {
  const who = d.person?.fullName ?? 'A customer';
  return (
    <li
      data-testid="decided-draft-row"
      data-status={d.status}
      className={cn('flex items-center gap-2.5 px-4 py-2.5', !first && 'border-t border-border')}
    >
      <Avatar name={who} seed={d.person?.id ?? d.id} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-center md:gap-3">
        <span className="flex min-w-0 flex-col md:w-44 md:flex-none">
          <span className="truncate text-[13px] font-semibold">{who}</span>
          <span className={cn('truncate text-xs font-medium', AI_TEXT)}>
            {aiName(d.teammate.name)}
          </span>
        </span>
        <span className="min-w-0 break-words text-[13px] text-text-2">{draftDecidedLine(d)}</span>
      </span>
      <span className="flex flex-none flex-col items-end gap-0.5">
        <span className="text-xs text-text-3">{relativeTime(d.decidedAt ?? d.createdAt, now)}</span>
        {d.conversationId ? (
          <Link
            href={`/app/w/${workspaceId}/inbox/${d.conversationId}`}
            className="text-xs font-medium text-accent-text hover:underline"
          >
            Conversation
          </Link>
        ) : null}
      </span>
    </li>
  );
}
