'use client';
import type { AssistantCard } from '@hfos/core';
import { Check, Pencil, Phone, Undo2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { NextActionChip, StageBadge } from '@/components/crm/chips';
import { WaitChip } from '@/components/inbox/bits';
import { Avatar } from '@/components/ui/avatar';
import { Button, ButtonLink } from '@/components/ui/button';
import { ApiError, errorMessage } from '@/lib/api/client';
import { chatWhen } from '@/lib/assistant/format';
import { undoToolCall } from '@/lib/assistant/stream';
import { useCalls } from '@/lib/calls/call-provider';
import { formatMoney } from '@/lib/format';
import { minutesWaiting } from '@/lib/inbox';
import { cn } from '@/lib/utils';
import { useAssistant } from './assistant-provider';
import {
  cardHead,
  cardRow,
  cardShell,
  Dot,
  Result,
  RowLink,
  Tile,
  touchButton,
} from './card-parts';

type CardOf<T extends AssistantCard['type']> = Extract<AssistantCard, { type: T }>;

/** Won and Lost read green and red, like the pipeline; every other stage is open. */
const stageKind = (name: string): 'open' | 'won' | 'lost' =>
  /^won$/i.test(name) ? 'won' : /^lost$/i.test(name) ? 'lost' : 'open';

function CardTitle({ children }: { children: ReactNode }) {
  return (
    <span className="min-w-0 flex-1 text-[15px] font-semibold leading-[1.35]">{children}</span>
  );
}

function LinkLabel({ children }: { children: ReactNode }) {
  return <span className="min-w-0 flex-1 truncate font-medium text-accent-text">{children}</span>;
}

/** "Find Mike Johnson": the customer, their open lead, and whether they're waiting on a reply. */
export function CustomerCard({ card }: { card: CardOf<'customer'> }) {
  const { closeIfCovering } = useAssistant();
  const waited = minutesWaiting(card.waitingSince);
  return (
    <div className={cardShell} data-testid="assistant-card-customer">
      <div className={cardHead}>
        <Avatar name={card.fullName} seed={card.personId} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium">{card.fullName}</span>
          <span className="truncate text-xs text-text-3">{card.detail}</span>
        </span>
        <ButtonLink
          href={card.href}
          onClick={() => closeIfCovering(card.href)}
          variant="secondary"
          size="sm"
          className={touchButton}
        >
          Open
        </ButtonLink>
      </div>
      {card.lead ? (
        <div className={cardRow}>
          <span className="min-w-0 flex-1 truncate">
            {card.lead.title} · {formatMoney(card.lead.valueCents)}
          </span>
          <StageBadge name={card.lead.stageName} kind={stageKind(card.lead.stageName)} />
        </div>
      ) : null}
      {waited !== null ? (
        <div className={cardRow}>
          <span className="min-w-0 flex-1 truncate text-text-3">Waiting on a reply</span>
          <WaitChip minutes={waited} />
        </div>
      ) : null}
    </div>
  );
}

export function LeadCard({ card }: { card: CardOf<'lead'> }) {
  const sub = [card.customer, formatMoney(card.valueCents), card.assignee]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={cardShell} data-testid="assistant-card-lead">
      <div className={cardHead}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium">{card.title}</span>
          <span className="truncate text-xs text-text-3">{sub}</span>
        </span>
        <StageBadge name={card.stageName} kind={stageKind(card.stageName)} />
      </div>
      {card.nextAction || card.needsNextAction ? (
        <div className={cardRow}>
          <NextActionChip text={card.nextAction} />
        </div>
      ) : null}
      <RowLink href={card.href}>
        <LinkLabel>Open lead</LinkLabel>
      </RowLink>
    </div>
  );
}

/** More than one record matches: the person picks. */
export function ChoicesCard({ card }: { card: CardOf<'choices'> }) {
  return (
    <div className={cardShell} data-testid="assistant-card-choices">
      <div className={cardHead}>
        <CardTitle>{card.title}</CardTitle>
      </div>
      {card.items.map((item) => (
        <RowLink key={item.id} href={item.href}>
          <Avatar name={item.label} seed={item.id} size="sm" />
          <span className="min-w-0 flex-1 truncate">
            <strong className="font-medium">{item.label}</strong>
            {item.detail ? ` · ${item.detail}` : ''}
          </span>
        </RowLink>
      ))}
    </div>
  );
}

/** "What needs attention?": customers waiting, overdue tasks, leads with nothing planned. */
export function AttentionCard({ card, at }: { card: CardOf<'attention'>; at: string }) {
  return (
    <div className={cardShell} data-testid="assistant-card-attention">
      <div className={cardHead}>
        <CardTitle>Waiting on you</CardTitle>
        <span className="text-xs text-text-3">{chatWhen(at, { time: true })}</span>
      </div>
      {card.items.map((item, i) => {
        const waited = minutesWaiting(item.waitingSince);
        return (
          <RowLink key={`${item.href}-${i}`} href={item.href}>
            <Dot tone={item.tone} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{item.title}</span>
              {item.detail ? (
                <span className="truncate text-xs text-text-3">{item.detail}</span>
              ) : null}
            </span>
            {waited !== null ? <WaitChip minutes={waited} /> : null}
          </RowLink>
        );
      })}
    </div>
  );
}

const STAT_COLUMNS = ['grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4'];
const openLabel = (href: string) =>
  /\/pipeline(\?|$)/.test(href)
    ? 'Open the pipeline'
    : /\/tasks(\?|$)/.test(href)
      ? 'Open tasks'
      : /\/inbox(\?|$)/.test(href)
        ? 'Open the inbox'
        : 'Open';

export function NumbersCard({ card }: { card: CardOf<'numbers'> }) {
  const down = card.delta ? /^[-−]/.test(card.delta) : false;
  return (
    <div className={cardShell} data-testid="assistant-card-numbers">
      <div className={cn(cardHead, 'items-end')}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs text-text-3">{card.label}</span>
          <span className="text-[22px] font-semibold leading-[1.15] tracking-[-0.01em]">
            {card.value}
          </span>
        </span>
        {card.delta ? (
          <span className={cn('text-xs font-medium', down ? 'text-text-2' : 'text-success-text')}>
            {card.delta}
          </span>
        ) : null}
      </div>
      {card.stats.length ? (
        <div className={cn('grid border-t border-border', STAT_COLUMNS[card.stats.length - 1])}>
          {card.stats.map((s, i) => (
            <div key={i} className="min-w-0 border-r border-border px-3.5 py-2.5 last:border-r-0">
              <div className="truncate text-[13px] font-medium">{s.value}</div>
              <div className="truncate text-xs text-text-3">{s.label}</div>
            </div>
          ))}
        </div>
      ) : null}
      {card.href ? (
        <RowLink href={card.href}>
          <LinkLabel>{openLabel(card.href)}</LinkLabel>
        </RowLink>
      ) : null}
    </div>
  );
}

/** Tasks due today, a person's tasks, the inbox: one line each. */
export function ListCard({ card }: { card: CardOf<'list'> }) {
  return (
    <div className={cardShell} data-testid="assistant-card-list">
      <div className={cardHead}>
        <CardTitle>{card.title}</CardTitle>
      </div>
      {card.items.length === 0 ? (
        <div className={cn(cardRow, 'text-text-3')}>Nothing here.</div>
      ) : null}
      {card.items.map((item, i) => {
        const inner = (
          <>
            <Dot tone={item.tone} />
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {item.detail ? (
              <span className="max-w-[45%] flex-none truncate text-xs text-text-3">
                {item.detail}
              </span>
            ) : null}
          </>
        );
        return item.href ? (
          <RowLink key={i} href={item.href}>
            {inner}
          </RowLink>
        ) : (
          <div key={i} className={cardRow}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/** A task or note it added on its own; Undo takes back the ones the worker can (card.undoable). */
export function DoneCard({ card }: { card: CardOf<'done'> }) {
  const a = useAssistant();
  const state = a.calls[card.toolCallId];
  const [busy, setBusy] = useState(false);
  const undone = !!state?.undone;
  const canUndo = card.undoable && !undone && !state?.note && (!state || state.status === 'done');

  async function undo() {
    setBusy(true);
    try {
      const out = await undoToolCall(card.toolCallId, a.workspaceId);
      // A successful Undo took it back, whatever else the reply leaves out.
      a.setCall(card.toolCallId, {
        status: 'done',
        undone: out.undone ?? true,
        outcome: out.outcome,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409)
        a.setCall(card.toolCallId, { note: e.message });
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const note = card.kind === 'note';
  const result = undone ? (state?.outcome ?? 'Undone.') : (state?.note ?? null);
  return (
    <div className={cardShell} data-testid="assistant-card-done">
      <div className={cardHead}>
        <Tile icon={note ? Pencil : Check} tone={note ? 'accent' : 'success'} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-medium">{card.title}</span>
          <span className="line-clamp-2 text-xs text-text-3">{card.detail}</span>
        </span>
        {canUndo ? (
          <Button
            variant="ghost"
            size="sm"
            loading={busy}
            onClick={() => void undo()}
            className={touchButton}
          >
            Undo
          </Button>
        ) : null}
      </div>
      {result ? (
        <Result tone="no" icon={Undo2}>
          {result}
        </Result>
      ) : null}
    </div>
  );
}

/** "Call Mike": a Call button on the browser's own calling. */
export function CallCard({ card }: { card: CardOf<'call'> }) {
  const calls = useCalls();
  return (
    <div className={cardShell} data-testid="assistant-card-call">
      <div className={cardHead}>
        <Avatar name={card.fullName} seed={card.personId} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium">Call {card.fullName}</span>
          <span className="truncate text-xs text-text-3">
            {card.phone} ·{' '}
            {calls.available ? 'shows your business number' : 'calls aren’t set up here yet'}
          </span>
        </span>
        <Button
          variant="success"
          size="sm"
          disabled={!calls.available}
          onClick={() =>
            calls.openDialer({ name: card.fullName, phone: card.phone, personId: card.personId })
          }
          className={touchButton}
          data-testid="assistant-call"
        >
          <Phone className="h-3.5 w-3.5" strokeWidth={1.5} />
          Call
        </Button>
      </div>
    </div>
  );
}
