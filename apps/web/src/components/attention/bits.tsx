'use client';
/**
 * The Action Center's small pieces for the pages outside Home (M8, design/m8 Cards and Settings): a kind's tile, a
 * reason chip the way the cards show it, and the open items about one record (the lead page's banner and the
 * inbox header's waiting chip).
 */
import { chipText, type AttentionKind } from '@hfos/core';
import {
  CalendarClock,
  Check,
  Clock,
  Wrench,
  CreditCard,
  FileText,
  Flame,
  Heart,
  Hourglass,
  ListChecks,
  MessageCircle,
  Receipt,
  Signpost,
  Sparkles,
  UserPlus,
  UserRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AI_SOFT, AI_TEXT } from '@/components/workflows/chips';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { AttentionRecordItem } from '@/lib/api/types';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';

/** The canvas's hot red and booking teal, mixed into the card like the AI teammate's violet, so dark mode follows. */
export const HOT_SOFT = 'bg-[color-mix(in_oklab,#c43335_12%,var(--card))]';
export const HOT_TEXT = 'text-[color-mix(in_oklab,#c43335_80%,var(--text))]';
const BR_SOFT = 'bg-[color-mix(in_oklab,#0e7490_13%,var(--card))]';
const BR_TEXT = 'text-[color-mix(in_oklab,#0e7490_82%,var(--text))]';

/** Each kind's icon and tile colors (the canvas's k-hot, k-act, k-appr, k-quiet, k-br, k-ai and k-task). */
export const KIND_LOOK: Readonly<Record<AttentionKind, { icon: LucideIcon; tone: string }>> = {
  hot_lead: { icon: Flame, tone: `${HOT_SOFT} ${HOT_TEXT}` },
  unanswered_lead: { icon: UserRound, tone: 'bg-accent-soft text-accent-text' },
  customer_waiting: { icon: MessageCircle, tone: 'bg-warning-soft text-warning-text' },
  stale_opportunity: { icon: Hourglass, tone: 'bg-card-2 text-text-2' },
  missing_next_action: { icon: Signpost, tone: 'bg-card-2 text-text-2' },
  unconfirmed_appointment: { icon: CalendarClock, tone: `${BR_SOFT} ${BR_TEXT}` },
  ai_approval: { icon: Sparkles, tone: `${AI_SOFT} ${AI_TEXT}` },
  overdue_task: { icon: ListChecks, tone: 'bg-warning-soft text-warning-text' },
  estimate_waiting: { icon: FileText, tone: 'bg-warning-soft text-warning-text' },
  invoice_overdue: { icon: Receipt, tone: `${HOT_SOFT} ${HOT_TEXT}` },
  // The wallet's three (M16): a warning in amber, and the two that stop the business working in red.
  wallet_low: { icon: Wallet, tone: 'bg-warning-soft text-warning-text' },
  wallet_empty: { icon: Wallet, tone: `${HOT_SOFT} ${HOT_TEXT}` },
  wallet_card_declined: { icon: CreditCard, tone: `${HOT_SOFT} ${HOT_TEXT}` },
  job_not_thanked: { icon: Heart, tone: 'bg-accent-soft text-accent-text' },
  referral_mentioned: { icon: UserPlus, tone: 'bg-accent-soft text-accent-text' },
  maintenance_due: { icon: Wrench, tone: `${BR_SOFT} ${BR_TEXT}` },
};

/** A card's kind, in the canvas's words ("Gone quiet", "Not confirmed"). */
export const KIND_WORD: Readonly<Record<AttentionKind, string>> = {
  hot_lead: 'Hot lead',
  unanswered_lead: 'Unanswered lead',
  customer_waiting: 'Customer waiting',
  stale_opportunity: 'Gone quiet',
  missing_next_action: 'No next action',
  unconfirmed_appointment: 'Not confirmed',
  ai_approval: 'Approval',
  overdue_task: 'Overdue task',
  estimate_waiting: 'Estimate waiting',
  invoice_overdue: 'Invoice overdue',
  wallet_low: 'Balance running low',
  wallet_empty: 'Balance empty',
  wallet_card_declined: 'Card declined',
  job_not_thanked: 'Say thanks',
  referral_mentioned: 'Referral',
  maintenance_due: 'Maintenance due',
};

/** The kind's icon on its tinted tile: 30 px on cards, 24 px in Settings' list. */
export function KindTile({
  kind,
  size = 'md',
  className,
}: {
  kind: AttentionKind;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { icon: Icon, tone } = KIND_LOOK[kind];
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex flex-none items-center justify-center',
        size === 'sm' ? 'h-6 w-6 rounded-[7px]' : 'h-[30px] w-[30px] rounded-lg',
        tone,
        className,
      )}
    >
      <Icon
        className={size === 'sm' ? 'h-[13px] w-[13px]' : 'h-[15px] w-[15px]'}
        strokeWidth={1.75}
      />
    </span>
  );
}

type Chip = AttentionRecordItem['reasons'][number];

const GOOD = new Set(['qualified', 'ready_to_book', 'repeat_customer', 'came_in_today']);
const AI = new Set(['auto_replied', 'handed_off', 'draft', 'approval']);
/** Chips that count time: waiting, since the last contact, overdue, until the start. */
export const TIME_CODES: ReadonlySet<string> = new Set([
  'waiting',
  'not_contacted',
  'last_contact',
  'no_contact',
  'follow_up_overdue',
  'overdue',
  'starts_in',
  'expires_in',
  'asked_to_confirm',
]);

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** A chip's words now: ticking chips count on ("Waiting 12 min"), starting with a capital as the cards do. */
export const chipWords = (chip: Chip, now: number): string =>
  capital(chip.since || chip.until ? chipText(chip, now) : chip.text || chip.label);

/** One reason chip (the canvas's `.ch`): money in plain type, time in amber (red once urgent), good signs in green. */
export function ReasonChip({
  chip,
  now,
  urgent,
  className,
}: {
  chip: Chip;
  now: number;
  urgent?: boolean;
  className?: string;
}) {
  const time = TIME_CODES.has(chip.code);
  const tone =
    chip.code === 'value'
      ? 'bg-card-2 font-semibold tabular-nums text-text'
      : time
        ? urgent && chip.code === 'waiting'
          ? 'bg-danger-soft text-danger-text'
          : 'bg-warning-soft text-warning-text'
        : GOOD.has(chip.code)
          ? 'bg-success-soft text-success-text'
          : AI.has(chip.code)
            ? `${AI_SOFT} ${AI_TEXT}`
            : 'bg-card-2 text-text-2';
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-[6px] px-[7px] text-xs font-medium',
        tone,
        className,
      )}
      data-code={chip.code}
    >
      {time ? <Clock className="h-3 w-3 flex-none" strokeWidth={1.75} aria-hidden /> : null}
      {GOOD.has(chip.code) ? (
        <Check className="h-3 w-3 flex-none" strokeWidth={2} aria-hidden />
      ) : null}
      {chipWords(chip, now)}
    </span>
  );
}

/** The chip that tells the item's time ("waiting 11 min", "Last contact 9 days ago"), if it has one. */
export const timeChipOf = (item: AttentionRecordItem): Chip | undefined =>
  item.reasons.find((r) => r.code === 'waiting') ??
  item.reasons.find((r) => TIME_CODES.has(r.code));

/**
 * The inbox header's chip: this conversation is on Home ("Waiting 12 min", "Hot lead · waiting 11 min"), red once
 * it's urgent. It opens Home.
 */
export function AttentionWaitingChip({
  item,
  now,
  href,
  className,
}: {
  item: AttentionRecordItem;
  now: number;
  href: string;
  className?: string;
}) {
  const time = timeChipOf(item);
  const words = time ? chipWords(time, now) : KIND_WORD[item.kind];
  const label =
    item.kind === 'hot_lead' && time
      ? `Hot lead · ${words.charAt(0).toLowerCase()}${words.slice(1)}`
      : words;
  const Icon = item.kind === 'hot_lead' ? Flame : Clock;
  return (
    <Link
      href={href}
      title={`On Home: ${KIND_WORD[item.kind]}`}
      aria-label={`On Home: ${KIND_WORD[item.kind]}, ${words}`}
      data-testid="attention-chip"
      data-kind={item.kind}
      data-urgent={item.urgent || undefined}
      className={cn(
        'inline-flex h-[22px] flex-none items-center gap-1 whitespace-nowrap rounded-[6px] px-[7px] text-xs font-medium hover:brightness-95',
        item.urgent ? 'bg-danger-soft text-danger-text' : 'bg-warning-soft text-warning-text',
        className,
      )}
    >
      <Icon className="h-3 w-3 flex-none" strokeWidth={1.75} aria-hidden />
      {label}
    </Link>
  );
}

/** The time now, moved on every `ms` so waiting chips keep counting. */
export function useTick(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export type AttentionRecordType = 'lead' | 'person' | 'conversation' | 'appointment' | 'task';

/**
 * The open Action Center items about one record (attention.for_record), kept current by live updates. A banner is
 * extra: when it can't load, the page carries on without it.
 */
export function useRecordAttention(
  workspaceId: string,
  recordType: AttentionRecordType,
  recordId: string | null,
): { items: readonly AttentionRecordItem[]; reload: () => void } {
  const version = useLiveVersion(['attention_item']);
  const [items, setItems] = useState<readonly AttentionRecordItem[]>([]);
  const load = useCallback(async () => {
    if (!recordId) {
      setItems([]);
      return;
    }
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/attention.for_record', {
          body: { workspaceId, recordType, recordId },
        }),
      );
      setItems(out.items.filter((i) => i.state === 'open'));
    } catch {
      // Keep what's on screen.
    }
  }, [workspaceId, recordType, recordId]);
  useEffect(() => {
    void load();
  }, [load, version]);
  return { items, reload: () => void load() };
}
