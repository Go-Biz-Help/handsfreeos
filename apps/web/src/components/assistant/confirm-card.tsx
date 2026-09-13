'use client';
import type { AssistantCard } from '@hfos/core';
import {
  ArrowRight,
  Ban,
  CircleCheck,
  Clock,
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

const WARNING: Record<string, { icon: LucideIcon; className: string }> = {
  quiet_hours: { icon: Moon, className: 'bg-warning-soft text-warning-text' },
  duplicate: { icon: Users, className: 'bg-accent-soft text-accent-text' },
  blocked: { icon: Ban, className: 'bg-danger-soft text-danger-text' },
};
const OTHER_WARNING = { icon: TriangleAlert, className: 'bg-warning-soft text-warning-text' };

const lostMove = (card: ConfirmCardData) =>
  card.reasons.length > 0 || card.confirmLabel === 'Mark as lost' || /lost\?$/.test(card.title);
const toKind = (card: ConfirmCardData): 'open' | 'won' | 'lost' =>
  lostMove(card) ? 'lost' : /won\?$/.test(card.title) ? 'won' : 'open';

/** "Mike" from the To line ("Mike Johnson · (713) 555-0142"). */
const firstOfTo = (card: ConfirmCardData) =>
  card.fields
    .find((f) => f.label === 'To')
    ?.value.split(' · ')[0]
    ?.trim()
    .split(/\s+/)[0] ?? null;

function cancelledText(card: ConfirmCardData): string {
  const first = firstOfTo(card);
  switch (card.tool) {
    case 'send_text':
    case 'send_email':
      return first ? `Not sent. Nothing went to ${first}.` : 'Not sent.';
    case 'move_lead':
      return lostMove(card)
        ? `Not changed. It stays in ${card.stageFrom}.`
        : `Not moved. It stays in ${card.stageFrom}.`;
    case 'create_customer':
      return 'Nothing added.';
    case 'create_lead':
      return 'No lead opened.';
    default:
      return 'Not changed.';
  }
}

const openLabel = (tool: string) =>
  tool === 'send_text' || tool === 'send_email'
    ? 'Open conversation'
    : tool === 'create_customer' || tool === 'update_customer'
      ? 'Open customer'
      : tool.endsWith('_lead')
        ? 'Open lead'
        : 'Open';

/**
 * Anything that reaches a customer, or changes a lead or a customer, waits here for the person's OK
 * (design/m4/Confirm.dc.html). Confirm runs exactly what the card shows; Cancel records a no.
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
  const leadLine = moving ? card.fields.find((f) => f.label === 'Lead')?.value : undefined;
  const fields = moving ? card.fields.filter((f) => f.label !== 'Lead') : card.fields;

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
            Needs your OK
          </span>
        ) : null}
        <span className="text-[15px] font-semibold leading-[1.35]">{card.title}</span>
        {moving ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StageBadge name={card.stageFrom!} kind="open" />
              <ArrowRight className="h-3.5 w-3.5 text-text-3" strokeWidth={1.5} aria-label="to" />
              <StageBadge name={card.stageTo!} kind={toKind(card)} />
            </div>
            {leadLine ? <div className="text-[13px] text-text-2">{leadLine}</div> : null}
          </>
        ) : null}
        {fields.length ? (
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-[5px] text-[13px]">
            {fields.map((f, i) => (
              <div key={`${f.label}-${i}`} className="contents">
                <dt className="min-w-12 text-text-3">{f.label}</dt>
                <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{f.value}</dd>
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
              Why was it lost?
            </Label>
            <Select
              id={reasonId}
              selectSize="sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              <option value="">Choose a reason</option>
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
              Edit
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
            {blocked ? 'Close' : 'Cancel'}
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
                {openLabel(card.tool)}
              </Link>
            ) : null
          }
        >
          {state.outcome ?? 'Done.'}
        </Result>
      ) : state.status === 'cancelled' ? (
        <Result tone="no" icon={X}>
          {state.note ?? cancelledText(card)}
        </Result>
      ) : state.status === 'failed' ? (
        <Result tone="bad" icon={Ban}>
          {state.error ?? 'That didn’t work. Nothing was changed.'}
        </Result>
      ) : (
        <Result tone="no" icon={Clock}>
          {state.note ?? 'Expired. You asked something else first, so nothing happened.'}
        </Result>
      )}
    </div>
  );
}
