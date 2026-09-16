'use client';
import type { AssistantCard } from '@hfos/core';
import { Check, Clock, Pencil, Phone, Undo2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { NextActionChip, StageBadge } from '@/components/crm/chips';
import { WaitChip } from '@/components/inbox/bits';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
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

/** Chips that tell time: a row shows its first one on the right. */
const TIME_CHIPS: ReadonlySet<string> = new Set([
  'waiting',
  'not_contacted',
  'last_contact',
  'no_contact',
  'follow_up_overdue',
  'overdue',
  'starts_in',
  'expires_in',
]);
/** Approvals read violet and appointments teal, as on Home; every other row goes by its tone. */
const KIND_DOT: Readonly<Record<string, string>> = {
  ai_approval: 'bg-[color-mix(in_oklab,#7c3aed_72%,var(--card))]',
  unconfirmed_appointment: 'bg-[color-mix(in_oklab,#0e7490_76%,var(--card))]',
};
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Waiting 11 min", red once the row is urgent. */
function TimeChip({ text, late }: { text: string; late: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] max-w-[45%] flex-none items-center gap-1 whitespace-nowrap rounded-[6px] px-[7px] text-xs font-medium',
        late ? 'bg-danger-soft text-danger-text' : 'bg-warning-soft text-warning-text',
      )}
    >
      <Clock className="h-3 w-3 flex-none" strokeWidth={1.75} aria-hidden />
      <span className="truncate">{capital(text)}</span>
    </span>
  );
}

/**
 * "What needs my attention?": the Action Center's list in Home's order (design/m8 Assistant), with "$ affected", the
 * urgent count, why each item ranks where it does, and Open Home. Chats from before M8 keep their rows as they were.
 */
export function AttentionCard({ card, at }: { card: CardOf<'attention'>; at: string }) {
  const { workspaceId } = useAssistant();
  const head = card.affected;
  return (
    <div className={cardShell} data-testid="assistant-card-attention">
      {head ? (
        <div className={cn(cardHead, 'items-end')}>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-xs text-text-3">
              Needs attention · {head.scope === 'mine' ? 'Mine' : 'Everyone'} ·{' '}
              {chatWhen(at, { time: true })}
            </span>
            <span
              className="text-[22px] font-semibold leading-[1.15] tracking-[-0.01em]"
              data-testid="assistant-attention-affected"
            >
              {head.cents > 0
                ? `${formatMoney(head.cents)} affected`
                : head.total === 1
                  ? '1 needs attention'
                  : `${head.total} need attention`}
            </span>
          </span>
          {head.urgent ? <Badge variant="danger">{head.urgent} urgent</Badge> : null}
        </div>
      ) : (
        <div className={cardHead}>
          <CardTitle>Waiting on you</CardTitle>
          <span className="text-xs text-text-3">{chatWhen(at, { time: true })}</span>
        </div>
      )}
      {card.items.map((item, i) => {
        const time = item.chips?.find((c) => TIME_CHIPS.has(c.code));
        const waited = item.chips ? null : minutesWaiting(item.waitingSince);
        const kindDot = item.kind && item.tone !== 'danger' ? KIND_DOT[item.kind] : undefined;
        return (
          <RowLink key={item.itemId ?? `${item.href}-${i}`} href={item.href} itemId={item.itemId}>
            {kindDot ? (
              <span aria-hidden className={cn('h-2 w-2 flex-none rounded-full', kindDot)} />
            ) : (
              <Dot tone={item.tone} />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{item.title}</span>
              {item.detail ? (
                <span className="truncate text-xs text-text-3">{item.detail}</span>
              ) : null}
            </span>
            {time ? (
              <TimeChip text={time.text} late={item.tone === 'danger'} />
            ) : waited !== null ? (
              <WaitChip minutes={waited} />
            ) : null}
          </RowLink>
        );
      })}
      {head ? (
        <RowLink href={`/app/w/${workspaceId}`}>
          <LinkLabel>Open Home</LinkLabel>
        </RowLink>
      ) : null}
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
        {card.aside ? (
          <span className="max-w-[55%] flex-none truncate text-xs text-text-3">{card.aside}</span>
        ) : null}
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
