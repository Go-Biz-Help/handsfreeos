'use client';
import {
  aiName,
  approvedToast as approvedWords,
  decideRefusal,
  DRAFT_AFTER,
  DRAFT_WORDS,
  draftActionLine,
  draftSegmentsLabel,
  expiresLine,
  firstNameOf,
  knowledgeUsedLine,
  progressShort,
  rejectedToast,
  rejectReasonLabel,
  THREAD_WORDS,
} from '@hfos/core';
import {
  CalendarCheck,
  CalendarClock,
  CalendarX,
  Check,
  CheckCheck,
  ClipboardList,
  Clock,
  CreditCard,
  Link2,
  ListPlus,
  Loader2,
  Minus,
  Pencil,
  Percent,
  Receipt,
  Repeat,
  RotateCw,
  Send,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AI_TEXT } from '@/components/workflows/chips';
import { ApiError, errorMessage } from '@/lib/api/client';
import type {
  DecideDraftOut,
  DraftAction,
  TeammateDraft,
  TeammateGetOut,
} from '@/lib/ai-team/inbox-types';
import { knowledgeOf } from '@/lib/ai-team/describe';
import { teammateCommands } from '@/lib/ai-team/use-inbox';
import { cn } from '@/lib/utils';

type Mode = 'view' | 'editing' | 'rejecting';

const ACTION_ICON: Record<DraftAction['kind'], LucideIcon> = {
  book: CalendarCheck,
  reschedule: CalendarClock,
  cancel: CalendarX,
  book_series: Repeat,
  waitlist: ListPlus,
  share_link: Link2,
  create_invoice: Receipt,
  create_estimate: ClipboardList,
  estimate_answer: CheckCheck,
  start_plan: CreditCard,
};

/** What approving did, for the toast: "Approved. Ava makes the change and texts Mike now. 18 of 20 approved." */
export function approvedToast(
  d: TeammateDraft,
  out: DecideDraftOut,
  edited: boolean,
  who: string,
): string {
  return approvedWords(d, out.progress, edited, who);
}

/**
 * Deciding one draft: approve it as it is, edit its message (and an email's subject) then send, or reject it
 * with an optional reason. The card in the thread and the phone's sticky bar share it.
 */
export function useDraftDecision({
  workspaceId,
  draft,
  who,
  onDecided,
  onRefused,
}: {
  workspaceId: string;
  draft: TeammateDraft | null;
  /** The customer's first name, for the words. */
  who: string;
  /** `edits`: what the person changed before approving (null when they approved it as it was). */
  onDecided: (
    draft: TeammateDraft,
    out: DecideDraftOut,
    edits: { body?: string; subject?: string } | null,
  ) => void;
  /** A refusal (it was decided elsewhere, expired, or the customer wrote again): the list reloads. */
  onRefused: () => void;
}) {
  const original = draft?.preview.message?.body ?? '';
  const originalSubject = draft?.preview.message?.subject ?? '';
  const [forId, setForId] = useState<string | null>(draft?.id ?? null);
  const [mode, setMode] = useState<Mode>('view');
  const [body, setBody] = useState(original);
  const [subject, setSubject] = useState(originalSubject);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  if ((draft?.id ?? null) !== forId) {
    setForId(draft?.id ?? null);
    setMode('view');
    setBody(original);
    setSubject(originalSubject);
    setReason('');
  }

  async function decide(decision: 'approve' | 'reject', withEdits: boolean) {
    if (!draft || busy) return;
    const edits: { body?: string; subject?: string } = {};
    if (withEdits) {
      if (body.trim() !== original.trim()) edits.body = body.trim();
      if (draft.channel === 'email' && subject.trim() !== originalSubject.trim())
        edits.subject = subject.trim();
    }
    const edited = Object.keys(edits).length > 0;
    setBusy(decision);
    try {
      const out = await teammateCommands(workspaceId).decide({
        draftId: draft.id,
        decision,
        ...(edited ? { edits } : {}),
        ...(decision === 'reject' && reason.trim() ? { reason: reason.trim() } : {}),
      });
      toast.success(
        decision === 'approve' ? approvedToast(draft, out, edited, who) : rejectedToast(draft, who),
      );
      setMode('view');
      onDecided(draft, out, edited ? edits : null);
    } catch (e) {
      const words =
        e instanceof ApiError ? decideRefusal(e.rule ?? null, who, draft.teammate.name) : null;
      toast.error(words ?? errorMessage(e));
      if (words) onRefused();
    } finally {
      setBusy(null);
    }
  }

  return {
    draft,
    mode,
    setMode,
    body,
    setBody,
    subject,
    setSubject,
    reason,
    setReason,
    busy,
    blank: !body.trim(),
    approve: () => void decide('approve', false),
    sendEdit: () => {
      if (!body.trim()) {
        toast.error(DRAFT_WORDS.writeIt);
        return;
      }
      void decide('approve', true);
    },
    reject: () => void decide('reject', false),
    cancelEdit: () => {
      setBody(original);
      setSubject(originalSubject);
      setMode('view');
    },
  };
}

export type DraftDecision = ReturnType<typeof useDraftDecision>;

function ActionRow({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-[10px] bg-card-2 px-2.5 py-2 text-[12.5px] leading-[1.35] text-text"
      data-testid="draft-action"
    >
      <span className="inline-flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] bg-accent-soft text-accent-text">
        <Icon className="h-[13px] w-[13px]" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** "Will book …", "Will move …", "Will cancel …", with the first two words in bold. */
export function DraftActions({ draft }: { draft: TeammateDraft }) {
  return (
    <>
      {draft.preview.actions.map((a, i) => {
        const line = draftActionLine(a);
        const [w1, w2, ...rest] = line.split(' ');
        return (
          <ActionRow key={i} icon={ACTION_ICON[a.kind]}>
            <b className="font-semibold">
              {w1} {w2}
            </b>{' '}
            {rest.join(' ')}
          </ActionRow>
        );
      })}
      {draft.preview.discount ? (
        <ActionRow icon={Percent}>
          <b className="font-semibold">Offers {draft.preview.discount.percent}% off</b>
          {draft.preview.discount.reason ? `: ${draft.preview.discount.reason}` : ''}
        </ActionRow>
      ) : null}
    </>
  );
}

/** The buttons under a draft: in the card on wide screens, in the phone's sticky bar on a phone. */
export function DraftButtons({
  d,
  progress,
  size = 'sm',
}: {
  d: DraftDecision;
  progress: TeammateGetOut['progress'];
  size?: 'sm' | 'phone';
}) {
  const draft = d.draft;
  if (!draft) return null;
  const phone = size === 'phone';
  const approvedLine =
    draft.kind === 'reply' && progress?.status === 'training' ? progressShort(progress) : null;
  if (d.mode === 'editing')
    return (
      <div className={cn('flex flex-wrap items-center gap-1.5', phone && 'flex-col items-stretch')}>
        <Button
          size={phone ? 'lg' : 'sm'}
          loading={d.busy === 'approve'}
          disabled={d.busy !== null || d.blank}
          onClick={d.sendEdit}
          data-testid="draft-send-edit"
        >
          {d.busy === 'approve' ? null : <Send className="h-3.5 w-3.5" strokeWidth={1.5} />}
          {DRAFT_WORDS.sendMyVersion}
        </Button>
        <Button
          variant="ghost"
          size={phone ? 'lg' : 'sm'}
          disabled={d.busy !== null}
          onClick={d.cancelEdit}
        >
          {DRAFT_WORDS.cancel}
        </Button>
      </div>
    );
  if (d.mode === 'rejecting')
    return (
      <div className={cn('flex flex-wrap items-center gap-1.5', phone && 'flex-col items-stretch')}>
        <Button
          variant="danger"
          size={phone ? 'lg' : 'sm'}
          loading={d.busy === 'reject'}
          disabled={d.busy !== null}
          onClick={d.reject}
          data-testid="draft-reject-confirm"
        >
          {DRAFT_WORDS.rejectConfirm}
        </Button>
        <Button
          variant="ghost"
          size={phone ? 'lg' : 'sm'}
          disabled={d.busy !== null}
          onClick={() => d.setMode('view')}
        >
          {DRAFT_WORDS.keepIt}
        </Button>
        <span className={cn('text-xs text-text-3', phone ? 'text-center' : 'ml-auto')}>
          {DRAFT_WORDS.nothingSent}
        </span>
      </div>
    );
  const sends = !!draft.preview.message;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', phone && 'flex-col items-stretch')}>
      <Button
        size={phone ? 'lg' : 'sm'}
        className={phone ? 'w-full' : undefined}
        loading={d.busy === 'approve'}
        disabled={d.busy !== null}
        onClick={d.approve}
        data-testid="draft-approve"
      >
        {d.busy === 'approve' ? null : <Check className="h-3.5 w-3.5" strokeWidth={1.75} />}
        {sends ? DRAFT_WORDS.approveAndSend : DRAFT_WORDS.approve}
      </Button>
      <div className={cn('flex gap-1.5', phone && 'w-full')}>
        {sends ? (
          <Button
            variant="secondary"
            size={phone ? 'lg' : 'sm'}
            className={phone ? 'flex-1' : undefined}
            disabled={d.busy !== null}
            onClick={() => d.setMode('editing')}
            data-testid="draft-edit"
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
            {DRAFT_WORDS.edit}
          </Button>
        ) : null}
        <Button
          variant={phone ? 'secondary' : 'ghost'}
          size={phone ? 'lg' : 'sm'}
          className={phone ? 'flex-1' : undefined}
          disabled={d.busy !== null}
          onClick={() => d.setMode('rejecting')}
          data-testid="draft-reject"
        >
          {DRAFT_WORDS.reject}
        </Button>
      </div>
      {approvedLine && !phone ? (
        <span className="ml-auto text-xs text-text-3" data-testid="draft-progress">
          {approvedLine}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The teammate's draft inline in the thread, dashed in its violet: the message, any booking change it holds
 * as plain sentences, when it expires, and Approve, Edit or Reject. On a phone the buttons sit in a sticky bar
 * below the thread (DraftButtons with size="phone").
 */
export function DraftCard({
  d,
  timezone,
  progress,
  phone,
  now,
}: {
  d: DraftDecision;
  timezone: string;
  progress: TeammateGetOut['progress'];
  phone: boolean;
  now: number;
}) {
  const draft = d.draft;
  if (!draft) return null;
  const name = draft.teammate.name;
  const expires = expiresLine(draft.expiresAt, timezone, now);
  const message = draft.preview.message;
  const email = draft.channel === 'email';
  const sms = draft.channel === 'sms' || draft.channel === null;
  const readOnly = !draft.canDecide;
  const used = knowledgeOf(draft.knowledge);
  return (
    <div
      role="group"
      aria-label={`${name}’s draft`}
      data-testid="draft-card"
      data-draft-id={draft.id}
      data-mode={d.mode}
      className="mt-2.5 flex w-full max-w-[452px] flex-col gap-2.5 self-end rounded-2xl rounded-br-[6px] border-[1.5px] border-dashed border-[color-mix(in_oklab,#7c3aed_62%,var(--border-strong))] bg-card px-3.5 py-3 shadow-1"
    >
      <div
        className={cn(
          'flex items-center gap-[7px] whitespace-nowrap text-xs font-semibold',
          AI_TEXT,
        )}
      >
        <Sparkles className="h-[13px] w-[13px] flex-none" strokeWidth={1.75} />
        <span className="truncate">
          {name}’s draft{phone ? '' : DRAFT_WORDS.waiting}
        </span>
        {expires ? (
          <span
            className="ml-auto inline-flex items-center gap-1 font-medium text-text-3"
            data-testid="draft-expires"
          >
            <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />
            {expires}
          </span>
        ) : null}
      </div>
      {message ? (
        d.mode === 'editing' ? (
          <div className="flex flex-col gap-1.5">
            {email ? (
              <Input
                inputSize="sm"
                aria-label="Subject"
                value={d.subject}
                maxLength={200}
                onChange={(e) => d.setSubject(e.target.value)}
                data-testid="draft-subject-input"
              />
            ) : null}
            <Textarea
              aria-label={`Edit ${name}’s draft`}
              className="min-h-[92px] text-[14px] leading-[1.5] max-md:max-h-[45vh] max-md:min-h-[132px] max-md:text-base max-md:field-sizing-content"
              value={d.body}
              autoFocus
              maxLength={email ? 10000 : 1600}
              invalid={d.blank}
              onChange={(e) => d.setBody(e.target.value)}
              data-testid="draft-input"
            />
            <div className="flex flex-wrap justify-between gap-x-3 text-xs text-text-3">
              <span>{DRAFT_WORDS.editNote}</span>
              {sms ? <span className="tabular-nums">{draftSegmentsLabel(d.body)}</span> : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {email && message.subject ? (
              <div className="text-[13px] font-semibold" data-testid="draft-subject">
                {message.subject}
              </div>
            ) : null}
            <div
              className="whitespace-pre-wrap text-[14px] leading-[1.5] text-text [overflow-wrap:anywhere] max-md:text-[15px]"
              data-testid="draft-text"
            >
              {message.body}
            </div>
          </div>
        )
      ) : null}
      <DraftActions draft={draft} />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[6px] bg-success-soft px-[7px] text-[11.5px] font-medium text-success-text">
          <Check className="h-3 w-3" strokeWidth={2.2} />
          {DRAFT_WORDS.safetyPassed}
        </span>
        {used.length ? (
          <span
            className="inline-flex h-5 max-w-full items-center truncate whitespace-nowrap rounded-[6px] bg-card-2 px-[7px] text-[11.5px] font-medium text-text-2"
            title={used.map((k) => k.title).join(', ')}
            data-testid="draft-knowledge"
          >
            {knowledgeUsedLine(used.map((k) => k.title))}
          </span>
        ) : null}
        {readOnly ? (
          <span className="inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[6px] bg-card-2 px-[7px] text-[11.5px] font-medium text-text-2">
            <Minus className="h-3 w-3" strokeWidth={2.2} />
            {DRAFT_WORDS.ownersDecide}
          </span>
        ) : null}
        {message && sms && d.mode !== 'editing' ? (
          <span className="ml-auto text-xs tabular-nums text-text-3">
            {draftSegmentsLabel(message.body).split(' · ')[1]}
          </span>
        ) : null}
      </div>
      {d.mode === 'rejecting' ? (
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium" htmlFor={`reject-${draft.id}`}>
            {rejectReasonLabel(name)}
          </label>
          <Input
            id={`reject-${draft.id}`}
            inputSize="sm"
            value={d.reason}
            maxLength={1000}
            placeholder={DRAFT_WORDS.rejectPlaceholder}
            onChange={(e) => d.setReason(e.target.value)}
            data-testid="draft-reject-reason"
          />
        </div>
      ) : null}
      {!phone && !readOnly ? (
        <div className="border-t border-border pt-2.5">
          <DraftButtons d={d} progress={progress} />
        </div>
      ) : null}
    </div>
  );
}

/** The phone's sticky bar under the thread while a draft waits: Approve and send, Edit, Reject. */
export function PhoneDraftBar({
  d,
  progress,
}: {
  d: DraftDecision;
  progress: TeammateGetOut['progress'];
}) {
  const draft = d.draft;
  if (!draft || !draft.canDecide) return null;
  const line =
    draft.kind === 'reply' && progress?.status === 'training' ? progressShort(progress) : null;
  return (
    <div
      className="flex flex-none flex-col gap-2 border-t border-border bg-card px-3 pb-2 pt-2.5 shadow-[0_-6px_18px_rgba(0,0,0,0.06)]"
      data-testid="draft-bar"
    >
      <DraftButtons d={d} progress={progress} size="phone" />
      {d.mode === 'view' ? (
        <span className="text-center text-xs text-text-3">
          {line ? `${line} · ` : ''}
          {DRAFT_WORDS.typingTakesOver}
        </span>
      ) : null}
    </div>
  );
}

/** A line in the thread about the teammate's work ("Ava’s draft expired…"). */
export function TeammateLine({
  icon: Icon = Sparkles,
  children,
  testId,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="mb-0.5 mt-3 inline-flex max-w-full items-center gap-1.5 self-center text-center text-xs text-text-3"
      data-testid={testId}
    >
      <Icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** An approved draft on its way: shown until the message it sends arrives in the thread. */
export function SendingDraft({ draft }: { draft: TeammateDraft }) {
  const body = draft.edits?.body ?? draft.preview.message?.body ?? '';
  if (!body) return null;
  const by = DRAFT_AFTER.sendingBy(draft.decidedBy);
  return (
    <div
      className="mt-2 flex max-w-[84%] flex-col items-end gap-[3px] self-end md:max-w-[76%]"
      data-testid="draft-sending"
    >
      <div className="whitespace-pre-wrap rounded-2xl rounded-br-[5px] bg-accent px-[13px] py-[9px] text-[15px] leading-[1.45] text-white opacity-70 [overflow-wrap:anywhere] md:text-sm">
        {body}
      </div>
      <div className="flex items-center gap-[5px] whitespace-nowrap px-1 text-[11.5px] text-text-3">
        <span className={cn('inline-flex items-center gap-[3px] font-semibold', AI_TEXT)}>
          <Sparkles className="h-3 w-3" strokeWidth={1.75} />
          {aiName(draft.teammate.name)}
          {by}
        </span>
        <span className="inline-flex items-center gap-1">
          · <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.75} /> {DRAFT_WORDS.sending}
        </span>
      </div>
    </div>
  );
}

/**
 * After a rejection: "You rejected Ava’s draft. Nothing went to Mike. What next?" with I’ll reply (take it
 * over) or Try again (the teammate writes a new draft, with the reason).
 */
export function RejectedNext({
  draft,
  who,
  mine,
  taking,
  retrying,
  onReply,
  onTryAgain,
}: {
  draft: TeammateDraft;
  who: string;
  mine: boolean;
  taking: boolean;
  retrying: boolean;
  onReply: () => void;
  onTryAgain: () => void;
}) {
  const name = draft.teammate.name;
  const by = mine ? 'You' : draft.decidedBy ? firstNameOf(draft.decidedBy.fullName) : 'Someone';
  return (
    <div
      className="mt-2.5 flex w-full max-w-[452px] flex-col gap-2.5 self-end rounded-2xl rounded-br-[6px] border border-border bg-card px-3.5 py-3 shadow-1"
      data-testid="draft-rejected"
    >
      <div className="text-[13px]">
        <strong className="font-semibold">{DRAFT_AFTER.rejectedBy(by, name)}</strong>{' '}
        {DRAFT_AFTER.rejectedNext(who)}
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" loading={taking} onClick={onReply} data-testid="draft-ill-reply">
          I’ll reply
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={retrying}
          onClick={onTryAgain}
          data-testid="draft-try-again"
        >
          {retrying ? null : <RotateCw className="h-3.5 w-3.5" strokeWidth={1.5} />}
          {THREAD_WORDS.tryAgain}
        </Button>
      </div>
      <span className="text-xs text-text-3">{DRAFT_AFTER.tryAgainNote(name, !!draft.reason)}</span>
    </div>
  );
}
