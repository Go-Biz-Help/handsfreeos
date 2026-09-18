'use client';
import {
  ASSISTANT_CONFIRM_WORDS,
  assistantCancelledText,
  assistantMoveKind,
  assistantOpenLabel,
  type AssistantCard,
} from '@hfos/core';
import {
  ArrowRight,
  Ban,
  CalendarClock,
  CalendarOff,
  CalendarX2,
  CircleCheck,
  Clock,
  Info,
  MessageSquareOff,
  Moon,
  ShieldCheck,
  TriangleAlert,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { StageBadge } from '@/components/crm/chips';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { ApiError, errorMessage } from '@/lib/api/client';
import { cancelToolCall, confirmToolCall } from '@/lib/assistant/stream';
import { cn } from '@/lib/utils';
import { useAssistant, type CallState } from './assistant-provider';
import { cardFoot, cardShell, Result, touchButton } from './card-parts';

export type ConfirmCardData = Extract<AssistantCard, { type: 'confirm' }>;

const CAUTION = 'bg-warning-soft text-warning-text';
const WARNING: Record<string, { icon: LucideIcon; className: string }> = {
  quiet_hours: { icon: Moon, className: CAUTION },
  duplicate: { icon: Users, className: 'bg-accent-soft text-accent-text' },
  blocked: { icon: Ban, className: 'bg-danger-soft text-danger-text' },
  // Appointments: things staff can book over (design/m5/Assistant.dc.html).
  conflict: { icon: CalendarX2, className: CAUTION },
  outside_hours: { icon: Clock, className: CAUTION },
  busy: { icon: CalendarClock, className: CAUTION },
  time_off: { icon: CalendarOff, className: CAUTION },
  no_text_consent: { icon: MessageSquareOff, className: CAUTION },
  // The Action Center: what else to know about HandsFreeOS's message, and one it's already sending.
  note: { icon: Info, className: 'bg-accent-soft text-accent-text' },
  scheduled: { icon: Clock, className: 'bg-accent-soft text-accent-text' },
};
const OTHER_WARNING = { icon: TriangleAlert, className: CAUTION };

/** A move shows the old time struck through and the new one in bold. */
const FIELD_VALUE: Record<string, string> = {
  Was: 'text-text-3 line-through',
  Now: 'font-semibold',
};

/**
 * Anything that reaches a customer, or changes a lead, a customer or an appointment, waits here for the
 * person's OK (design/m4/Confirm.dc.html, design/m5/Assistant.dc.html). Confirm runs exactly what the card
 * shows; Cancel ("Keep it" on a cancellation) records a no.
 */
export function ConfirmCard({
  card,
  onEdit,
}: {
  card: ConfirmCardData;
  onEdit: (card: ConfirmCardData) => void;
}) {
  const a = useAssistant();
  const state: CallState = a.calls[card.toolCallId] ?? {
    status: 'awaiting_confirmation',
    tool: card.tool,
    outcome: null,
    error: null,
    href: null,
  };
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const reasonId = useId();
  const waiting = state.status === 'awaiting_confirmation';
  /** A rule stops it (opted out, no number…): no Confirm, only the reason and Close. */
  const blocked = !card.confirmLabel;
  const needsReason = card.reasons.length > 0;
  const moving = !!(card.stageFrom && card.stageTo);
  /** Cancelling an appointment: a red button, and the way out reads "Keep it". */
  const cancelling = card.tool === 'cancel_appointment';
  const leadLine = moving ? card.fields.find((f) => f.label === 'Lead')?.value : undefined;
  // An empty value (a "With" on a calendar that needs no staff) is left out rather than shown blank.
  const fields = card.fields.filter((f) => f.value.trim() && !(moving && f.label === 'Lead'));

  async function decide(kind: 'confirm' | 'cancel') {
    setBusy(kind);
    try {
      const out =
        kind === 'confirm'
          ? await confirmToolCall(card.toolCallId, a.workspaceId, needsReason ? reason : undefined)
          : await cancelToolCall(card.toolCallId, a.workspaceId);
      a.setCall(card.toolCallId, {
        status:
          out.status === 'confirmed'
            ? 'confirmed'
            : out.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
        outcome: out.outcome,
        href: out.href,
        error: out.error,
      });
    } catch (e) {
      // Answered on another screen, or it lapsed: the card says so.
      if (e instanceof ApiError && (e.status === 409 || e.status === 404))
        a.setCall(card.toolCallId, { status: 'expired', note: e.message });
      else toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={cn(
        cardShell,
        waiting &&
          !blocked &&
          'border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] shadow-[0_0_0_3px_var(--accent-soft)]',
      )}
      data-testid="assistant-card-confirm"
      data-status={state.status}
    >
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        {waiting && !blocked ? (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-accent-text">
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
            {ASSISTANT_CONFIRM_WORDS.needsOk}
          </span>
        ) : null}
        <span className="text-[15px] font-semibold leading-[1.35]">{card.title}</span>
        {moving ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StageBadge name={card.stageFrom!} kind="open" />
              <ArrowRight className="h-3.5 w-3.5 text-text-3" strokeWidth={1.5} aria-label="to" />
              <StageBadge name={card.stageTo!} kind={assistantMoveKind(card)} />
            </div>
            {leadLine ? <div className="text-[13px] text-text-2">{leadLine}</div> : null}
          </>
        ) : null}
        {fields.length ? (
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-[5px] text-[13px]">
            {fields.map((f, i) => (
              <div key={`${f.label}-${i}`} className="contents">
                <dt className="min-w-12 text-text-3">{f.label}</dt>
                <dd className={cn('m-0 min-w-0 [overflow-wrap:anywhere]', FIELD_VALUE[f.label])}>
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {card.body ? (
          <div className="whitespace-pre-wrap rounded-[10px] bg-card-2 px-3 py-2.5 text-[13.5px] leading-[1.45] [overflow-wrap:anywhere]">
            {card.body}
          </div>
        ) : null}
        {card.warnings.map((w, i) => {
          const style = WARNING[w.kind] ?? OTHER_WARNING;
          const Icon = style.icon;
          return (
            <div
              key={i}
              role="note"
              data-testid={`assistant-warning-${w.kind}`}
              className={cn(
                'flex items-start gap-2 rounded-control px-2.5 py-2 text-[13px]',
                style.className,
              )}
            >
              <Icon className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
              <span>{w.text}</span>
            </div>
          );
        })}
        {waiting && needsReason ? (
          <div>
            <Label htmlFor={reasonId} className="text-[12.5px]">
              {ASSISTANT_CONFIRM_WORDS.whyLost}
            </Label>
            <Select
              id={reasonId}
              selectSize="sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              <option value="">{ASSISTANT_CONFIRM_WORDS.chooseReason}</option>
              {card.reasons.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>

      {waiting ? (
        <div className={cardFoot}>
          {blocked ? null : (
            <Button
              size="sm"
              variant={cancelling ? 'danger' : 'primary'}
              className={touchButton}
              loading={busy === 'confirm'}
              disabled={!!busy || (needsReason && !reason)}
              onClick={() => void decide('confirm')}
              data-testid="assistant-confirm"
            >
              {card.confirmLabel}
            </Button>
          )}
          {card.editable && !blocked ? (
            <Button
              variant="secondary"
              size="sm"
              className={touchButton}
              disabled={!!busy}
              onClick={() => onEdit(card)}
              data-testid="assistant-edit"
            >
              {ASSISTANT_CONFIRM_WORDS.edit}
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className={touchButton}
            loading={busy === 'cancel'}
            disabled={!!busy}
            onClick={() => void decide('cancel')}
            data-testid="assistant-cancel"
          >
            {blocked
              ? ASSISTANT_CONFIRM_WORDS.close
              : cancelling
                ? ASSISTANT_CONFIRM_WORDS.keepIt
                : ASSISTANT_CONFIRM_WORDS.cancel}
          </Button>
        </div>
      ) : state.status === 'confirmed' ? (
        <Result
          tone="ok"
          icon={CircleCheck}
          action={
            state.href ? (
              <Link
                href={state.href}
                onClick={() => a.closeIfCovering(state.href!)}
                className="flex-none font-medium text-accent-text hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center max-md:px-1"
              >
                {assistantOpenLabel(card.tool, state.href)}
              </Link>
            ) : null
          }
        >
          {state.outcome ?? ASSISTANT_CONFIRM_WORDS.done}
        </Result>
      ) : state.status === 'cancelled' ? (
        <Result tone="no" icon={X}>
          {state.note ?? assistantCancelledText(card)}
        </Result>
      ) : state.status === 'failed' ? (
        <Result tone="bad" icon={Ban}>
          {state.error ?? ASSISTANT_CONFIRM_WORDS.failed}
        </Result>
      ) : (
        <Result tone="no" icon={Clock}>
          {state.note ?? ASSISTANT_CONFIRM_WORDS.expired}
        </Result>
      )}
    </div>
  );
}
