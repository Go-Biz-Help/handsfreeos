'use client';
import {
  aiName,
  CONVERSATION_ACTIONS,
  firstNameOf,
  handBackQuestion,
  handBackToast,
  handedLine,
  handlingHow,
  handlingTitle,
  handoffWhy,
  NEEDS_A_PERSON,
  progressShort,
  takeOverToast,
  whoTookOver,
  type HandlingView,
} from '@hfos/core';
import { Sparkles, UserRound, UserRoundPlus } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { TeammateMark } from '@/components/ai-team/mark';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { AI_SOFT, AI_TEXT } from '@/components/workflows/chips';
import { errorMessage } from '@/lib/api/client';
import type { ConversationGet } from '@/lib/api/types';
import type { ConversationHandling } from '@/lib/ai-team/inbox-types';
import { teammateCommands, type TeammateBrief } from '@/lib/ai-team/use-inbox';
import { zonedWhen } from '@/lib/inbox';
import { useUnread } from '@/lib/realtime/unread-provider';
import { cn } from '@/lib/utils';

const STRIP = 'flex gap-2.5 rounded-[10px] text-[13px] leading-[1.4]';

/** Take over and hand back, with the toasts the design words for them. */
export function useHandlingActions(opts: {
  workspaceId: string;
  conversationId: string;
  name: string;
  who: string;
  after: () => void;
}) {
  const [busy, setBusy] = useState<'take' | 'back' | null>(null);
  const cmd = teammateCommands(opts.workspaceId);
  // Taking over (or handing back) moves the conversation between the inbox's boxes, and this tab's own change
  // doesn't come back over Realtime: the counts are read again here.
  const unread = useUnread();
  return {
    busy,
    async takeOver(): Promise<boolean> {
      setBusy('take');
      try {
        const out = await cmd.takeOver(opts.conversationId);
        toast.success(takeOverToast(opts.name, out.draftCancelled));
        opts.after();
        unread.refresh();
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    async handBack(): Promise<boolean> {
      setBusy('back');
      try {
        await cmd.handToAi(opts.conversationId);
        toast.success(handBackToast(opts.name, opts.who));
        opts.after();
        unread.refresh();
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
  };
}

/** "Hand Tom back to Ava?": handing back always asks first. */
export function HandBackDialog({
  open,
  onOpenChange,
  name,
  who,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  who: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const question = handBackQuestion(name, who);
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent title={question.title} description={question.body}>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {CONVERSATION_ACTIONS.keepIt}
          </Button>
          <Button onClick={onConfirm} loading={busy} data-testid="hand-back-confirm">
            {busy ? null : <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />}
            {CONVERSATION_ACTIONS.handBack}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The banner under the thread's header: "Ava (AI) is handling this" with Take over; "Dale took over" with
 * Hand back; or "Needs a person" with Ava's reason and note, and Take it. On a phone it keeps to one line.
 */
export function HandlingBanner({
  view,
  handling,
  teammate,
  myUserId,
  assignee,
  timezone,
  compact,
  busy,
  onTakeOver,
  onHandBack,
  className,
}: {
  view: HandlingView;
  handling: ConversationHandling | null;
  teammate: TeammateBrief | null;
  myUserId: string;
  assignee: { id: string; fullName: string } | null;
  timezone: string;
  compact: boolean;
  busy: 'take' | 'back' | null;
  onTakeOver: () => void;
  onHandBack: () => void;
  className?: string;
}) {
  const name = handling?.teammate?.name ?? teammate?.name ?? 'The AI teammate';
  if (view === 'ai') {
    const how = handlingHow(teammate?.status);
    return (
      <div
        role="status"
        data-testid="handling-ai"
        className={cn(STRIP, 'items-center py-[7px] pl-3 pr-2', AI_SOFT, AI_TEXT, className)}
      >
        <Sparkles className="h-4 w-4 flex-none" strokeWidth={1.5} />
        <span className="min-w-0 flex-1">
          <strong className="font-semibold">
            {handlingTitle(name, 'web')}
            {compact ? '' : '.'}
          </strong>
          {compact ? null : <> {how}</>}
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="flex-none max-md:h-9"
          loading={busy === 'take'}
          onClick={onTakeOver}
          data-testid="take-over"
        >
          {CONVERSATION_ACTIONS.takeOver}
        </Button>
      </div>
    );
  }
  if (view === 'person') {
    const whoTook = whoTookOver(handling?.takenOverBy ?? null, myUserId);
    return (
      <div
        role="status"
        data-testid="handling-person"
        className={cn(STRIP, 'items-center bg-card-2 py-[7px] pl-3 pr-2 text-text-2', className)}
      >
        <UserRound className="h-4 w-4 flex-none" strokeWidth={1.5} />
        <span className="min-w-0 flex-1">
          <strong className="font-semibold text-text">{whoTook} took over</strong>
          {compact ? null : <>. {name} stays quiet until someone hands it back.</>}
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="flex-none max-md:h-9"
          loading={busy === 'back'}
          onClick={onHandBack}
          data-testid="hand-back"
        >
          {busy === 'back' ? null : <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />}
          {compact ? CONVERSATION_ACTIONS.handBack : CONVERSATION_ACTIONS.handBackTo(name)}
        </Button>
      </div>
    );
  }
  if (view === 'needs_person') {
    const why = handoffWhy(handling?.handoffReason ?? null, name);
    return (
      <div
        role="status"
        data-testid="handling-needs-person"
        className={cn(
          STRIP,
          'items-start bg-warning-soft py-3 pl-3.5 pr-3 text-warning-text',
          compact && 'items-center py-2',
          className,
        )}
      >
        <UserRound className="mt-px h-4 w-4 flex-none" strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          <div>
            <strong className="font-semibold">
              {NEEDS_A_PERSON}
              {compact ? '' : '.'}
            </strong>
            {compact ? null : (
              <>
                {' '}
                {handedLine(name, assignee, myUserId, handling?.needsPersonSince ?? null, timezone)}
              </>
            )}
          </div>
          {why ? (
            <div
              className={cn('mt-0.5 text-xs opacity-90', compact && 'line-clamp-1')}
              data-testid="handoff-why"
            >
              Why: {why}.
            </div>
          ) : null}
          {handling?.handoffNote && !compact ? (
            <div
              className="mt-2 rounded-[8px] bg-[color-mix(in_oklab,var(--card)_55%,transparent)] px-2.5 py-2 text-[12.5px] leading-[1.45] text-text"
              data-testid="handoff-note"
            >
              <b className="font-semibold">{name}’s note:</b> “{handling.handoffNote}”
            </div>
          ) : null}
        </div>
        <Button
          size="sm"
          className="flex-none max-md:h-9"
          loading={busy === 'take'}
          onClick={onTakeOver}
          data-testid="take-it"
        >
          {CONVERSATION_ACTIONS.takeIt}
        </Button>
      </div>
    );
  }
  return null;
}

const Label = ({ children }: { children: ReactNode }) => (
  <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
    {children}
  </div>
);

/** Beside the thread: what the teammate is doing here, and when it handed the conversation over. */
export function TeammateContext({
  workspaceId,
  view,
  handling,
  teammate,
  assignee,
  myUserId,
  timezone,
}: {
  workspaceId: string;
  view: HandlingView;
  handling: ConversationHandling | null;
  teammate: TeammateBrief | null;
  assignee: { id: string; fullName: string } | null;
  myUserId: string;
  timezone: string;
}) {
  if (!teammate) return null;
  const name = handling?.teammate?.name ?? teammate.name;
  const line =
    view === 'ai'
      ? 'Handling this conversation'
      : view === 'needs_person'
        ? 'Handed it to a person'
        : view === 'person'
          ? `Stopped when ${
              !handling?.takenOverBy
                ? 'someone'
                : handling.takenOverBy.id === myUserId
                  ? 'you'
                  : firstNameOf(handling.takenOverBy.fullName)
            } took over`
          : 'Not handling this conversation';
  const how =
    teammate.status === 'training'
      ? `Replies need an OK: ${progressShort(teammate.progress) ?? 'training wheels'}`
      : teammate.status === 'automatic'
        ? 'Replies go out on their own'
        : 'Off, so it isn’t answering anyone';
  const since = handling?.needsPersonSince ? new Date(handling.needsPersonSince) : null;
  const told = !assignee
    ? 'The team was told by email.'
    : assignee.id === myUserId
      ? 'You were told by email.'
      : `${firstNameOf(assignee.fullName)} was told by email.`;
  return (
    <>
      <div className="h-px bg-border" />
      {view === 'needs_person' && since ? (
        <section className="flex flex-col gap-1.5" data-testid="context-handed-off">
          <Label>Handed off by {name}</Label>
          <p className="text-[13px] text-text-2">
            {zonedWhen(since, timezone)} · {told} If nobody replies within 15 minutes during open
            hours, the usual reminder goes out.
          </p>
        </section>
      ) : null}
      <section className="flex flex-col gap-2" data-testid="context-teammate">
        <Label>{name} in this conversation</Label>
        <div className="flex items-start gap-2.5 text-[13px]">
          <TeammateMark size="sm" label={aiName(name)} />
          <span className="flex min-w-0 flex-col">
            <span>{line}</span>
            <span className="text-xs text-text-3">{how}</span>
          </span>
        </div>
        <Link
          href={`/app/w/${workspaceId}/ai-team/activity`}
          className="text-[13px] font-medium text-accent-text hover:underline"
        >
          See {name}’s runs
        </Link>
      </section>
    </>
  );
}

/**
 * A website chat's visitor: what they said their name is (never verified), and whether what they typed
 * matched a customer.
 */
export function ChatVisitorStrip({
  chat,
  person,
  name,
  className,
}: {
  chat: NonNullable<ConversationGet['chat']>;
  person: ConversationGet['person'];
  /** The teammate's name, for "Ava never shares that customer's details". */
  name: string | null;
  className?: string;
}) {
  const field = chat.matchedOn === 'email' ? 'email' : 'phone';
  return (
    <div
      className={cn(STRIP, 'items-start bg-card-2 px-3 py-2 text-[12.5px] text-text-2', className)}
      data-testid="chat-visitor"
    >
      <UserRoundPlus className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
      <span className="min-w-0 flex-1">
        {chat.name ? (
          <>
            Said their name is <strong className="font-semibold text-text">{chat.name}</strong>
          </>
        ) : (
          'Hasn’t said their name yet'
        )}
        {chat.matchedOn && person
          ? `, and the ${field} matches a customer, so the chat is linked.${
              name ? ` ${name} never shares that customer’s details in the chat.` : ''
            }`
          : person
            ? ', and gave their details, so they were added to Contacts.'
            : '.'}
        {chat.blocked ? ' They’re blocked from the website chat.' : ''}
      </span>
    </div>
  );
}
