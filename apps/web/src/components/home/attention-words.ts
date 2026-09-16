/**
 * Home's Action Center words (M8): the kind labels the cards use, the reason chips as of a moment, the snooze
 * choices in the business's time zone, the fold of lower cards into groups, and where each item opens.
 * Browser-safe.
 */
import {
  addDays,
  ATTENTION_KIND_LABELS,
  ATTENTION_KIND_PLURALS,
  chipText,
  clockLabel,
  dayLabel,
  localDateOf,
  localInstant,
  moneyLabel,
  zonedParts,
  type AttentionKind,
} from '@hfos/core';
import type { AttentionChipOut, AttentionItem } from '@/lib/api/types';
import { calendarHref } from '@/lib/calendar/url';

/** The label on a card: core's words, which Settings and the Assistant use too. */
export const KIND_LABEL: Readonly<Record<AttentionKind, string>> = ATTENTION_KIND_LABELS;

const NOUNS: Readonly<Record<AttentionKind, readonly [string, string]>> = {
  hot_lead: ['lead', 'leads'],
  unanswered_lead: ['lead', 'leads'],
  stale_opportunity: ['lead', 'leads'],
  missing_next_action: ['lead', 'leads'],
  unconfirmed_appointment: ['customer', 'customers'],
  ai_approval: ['approval', 'approvals'],
  customer_waiting: ['customer', 'customers'],
  overdue_task: ['task', 'tasks'],
  estimate_waiting: ['estimate', 'estimates'],
  invoice_overdue: ['invoice', 'invoices'],
};

/** The kinds about a lead: assigning one makes that person the lead's owner. */
export const LEAD_KINDS: ReadonlySet<AttentionKind> = new Set<AttentionKind>([
  'hot_lead',
  'unanswered_lead',
  'stale_opportunity',
  'missing_next_action',
]);

/** A folded group's title and count: "Unconfirmed appointments" and "4 customers". */
export function groupTitle(kind: AttentionKind, count: number): { title: string; count: string } {
  const [one, many] = NOUNS[kind];
  return { title: ATTENTION_KIND_PLURALS[kind], count: `${count} ${count === 1 ? one : many}` };
}

/** "Maria Lopez · New AC install" as its two parts. */
export function splitTitle(title: string): { head: string; rest: string | null } {
  const at = title.indexOf(' · ');
  return at < 0
    ? { head: title, rest: null }
    : { head: title.slice(0, at), rest: title.slice(at + 3) };
}

/** The customer a card is about, or null for a task (its title is the task's own). */
export const customerOf = (item: Pick<AttentionItem, 'kind' | 'title'>): string | null =>
  item.kind === 'overdue_task' ? null : splitTitle(item.title).head;

export const firstNameOf = (name: string | null | undefined, fallback = 'them'): string =>
  name?.trim().split(/\s+/)[0] || fallback;

export const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** "Furnace repair" in the middle of a sentence; "AC tune-up" keeps its capitals. */
export const inSentence = (text: string): string =>
  /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;

/** "A, B and C"; past `max` names, "A, B, C, D and 2 more". */
export function andList(names: readonly string[], max = 4): string {
  if (names.length > max) return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** An AI teammate's draft (the approval chip says a workflow's approval step). */
export const isDraft = (item: Pick<AttentionItem, 'reasons'>): boolean =>
  item.reasons.some((r) => r.code === 'draft');

// ---------- reason chips ----------

export type ChipTone = 'plain' | 'money' | 'est' | 'time' | 'late' | 'good' | 'ai' | 'auto';
export type ChipIcon = 'clock' | 'check' | 'ai' | 'auto' | null;
export interface ShownChip {
  readonly key: string;
  readonly text: string;
  readonly tone: ChipTone;
  readonly icon: ChipIcon;
  readonly title?: string;
}

const LOOK: Partial<Record<AttentionChipOut['code'], readonly [ChipTone, ChipIcon]>> = {
  value: ['money', null],
  not_contacted: ['time', 'clock'],
  last_contact: ['time', null],
  follow_up_overdue: ['late', 'clock'],
  overdue: ['late', 'clock'],
  starts_in: ['time', 'clock'],
  expires_in: ['time', 'clock'],
  handed_off: ['time', null],
  qualified: ['good', 'check'],
  ready_to_book: ['good', 'check'],
  repeat_customer: ['good', null],
  draft: ['ai', 'ai'],
};
const PLAIN: readonly [ChipTone, ChipIcon] = ['plain', null];

/** A stored chip's words at a moment: "waiting 12 min" keeps counting. */
function wordsOf(c: AttentionChipOut, now: number): string {
  const text = chipText(
    {
      code: c.code,
      label: c.label,
      ...(c.since ? { since: c.since } : {}),
      ...(c.until ? { until: c.until } : {}),
    },
    now,
  );
  return c.code === 'value' ? text : sentence(text);
}

/** When HandsFreeOS is about to act on its own, or null. */
export function autoAt(item: Pick<AttentionItem, 'auto'>): number | null {
  return item.auto.state === 'scheduled' && item.auto.scheduledFor
    ? Date.parse(item.auto.scheduledFor)
    : null;
}

/** The chips that are already money: a card with one of these needs no stand-in value. */
const MONEY_CODES: ReadonlySet<string> = new Set(['value', 'amount']);

/**
 * Up to three chips for a card as of `now`: its reasons in order, a typical job value as "About $4,200" (it isn't
 * counted in $ affected), and "Follows up at 9:05 AM" when HandsFreeOS is about to act.
 *
 * An estimate's value is an estimate in the other sense — a real figure someone quoted, which simply isn't owed
 * yet — and its own chip says so ("$12,928.50 quoted"). Standing "About $12,928.50" in front of that would say
 * the same money twice, and call an exact quote a guess.
 */
export function chipsOf(item: AttentionItem, now: number, timeZone: string): ShownChip[] {
  const out: ShownChip[] = [];
  if (
    item.valueIsEstimate &&
    item.valueCents > 0 &&
    !item.reasons.some((r) => MONEY_CODES.has(r.code))
  )
    out.push({
      key: 'estimate',
      text: `About ${moneyLabel(item.valueCents)}`,
      tone: 'est',
      icon: null,
      title: 'Typical job value. Not counted in $ affected.',
    });
  item.reasons.forEach((c, i) => {
    const [tone, icon] =
      c.code === 'waiting'
        ? ([item.urgent ? 'late' : 'time', 'clock'] as const)
        : (LOOK[c.code] ?? PLAIN);
    out.push({ key: `${c.code}-${i}`, text: wordsOf(c, now), tone, icon });
  });
  const at = autoAt(item);
  if (at === null) return out.slice(0, 3);
  const when = clockLabel(at, timeZone);
  return [
    ...out.slice(0, 2),
    {
      key: 'auto',
      text:
        item.auto.action === 'confirm_request'
          ? `Asks to confirm at ${when}`
          : `Follows up at ${when}`,
      tone: 'auto',
      icon: 'auto',
    },
  ];
}

// ---------- snooze ----------

export const SNOOZE_MAX_DAYS = 30;

export interface SnoozeChoice {
  readonly key: 'hour' | 'evening' | 'tomorrow' | 'next_week';
  readonly label: string;
  readonly until: number;
  /** "9:05 AM", "Wed 8:00 AM", "Tue, Sep 29". */
  readonly hint: string;
}

const weekdayShortOf = (at: number, timeZone: string): string =>
  dayLabel(at, timeZone).split(',')[0] ?? '';

/**
 * An hour, this evening at 6 PM (until 5 PM), tomorrow at 8 AM, and the same day next week at 8 AM, in the business's
 * time zone.
 */
export function snoozeChoices(timeZone: string, now: number): SnoozeChoice[] {
  const today = localDateOf(now, timeZone);
  const hour = now + 60 * 60_000;
  const out: SnoozeChoice[] = [
    { key: 'hour', label: '1 hour', until: hour, hint: clockLabel(hour, timeZone) },
  ];
  if (zonedParts(now, timeZone).hour < 17) {
    const evening = localInstant(today, '18:00', timeZone);
    out.push({
      key: 'evening',
      label: 'This evening',
      until: evening,
      hint: clockLabel(evening, timeZone),
    });
  }
  const morning = localInstant(addDays(today, 1), '08:00', timeZone);
  out.push({
    key: 'tomorrow',
    label: 'Tomorrow morning',
    until: morning,
    hint: `${weekdayShortOf(morning, timeZone)} ${clockLabel(morning, timeZone)}`,
  });
  const week = localInstant(addDays(today, 7), '08:00', timeZone);
  out.push({ key: 'next_week', label: 'Next week', until: week, hint: dayLabel(week, timeZone) });
  return out;
}

/** "9:05 AM", "tomorrow at 8:00 AM", "Tue, Sep 29 at 8:00 AM" (after "Snoozed until"). */
export function snoozedUntil(until: number, timeZone: string, now: number): string {
  const day = localDateOf(until, timeZone);
  const today = localDateOf(now, timeZone);
  const clock = clockLabel(until, timeZone);
  if (day === today) return clock;
  if (day === addDays(today, 1)) return `tomorrow at ${clock}`;
  return `${dayLabel(until, timeZone)} at ${clock}`;
}

// ---------- groups ----------

/** Cards from this rank on may fold into a group... */
export const FOLD_FROM_RANK = 5;
/** ...when at least this many of one kind are there. */
export const FOLD_MIN = 3;

export type ListRow =
  | { readonly type: 'item'; readonly item: AttentionItem }
  | {
      readonly type: 'group';
      readonly kind: AttentionKind;
      readonly items: readonly AttentionItem[];
    };

/**
 * The ranked list below Urgent, with three or more items of one kind from rank 5 down folded into one group where
 * the first of them stood ("Unconfirmed appointments · 4 customers"). `ranksBefore` counts the urgent cards above.
 */
export function foldRows(items: readonly AttentionItem[], ranksBefore: number): ListRow[] {
  const low = (i: number) => ranksBefore + i >= FOLD_FROM_RANK;
  const tail = items.filter((_, i) => low(i));
  const counts = new Map<AttentionKind, number>();
  for (const it of tail) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
  const folded = new Set([...counts].filter(([, n]) => n >= FOLD_MIN).map(([k]) => k));
  const placed = new Set<AttentionKind>();
  const rows: ListRow[] = [];
  items.forEach((item, i) => {
    if (!low(i) || !folded.has(item.kind)) {
      rows.push({ type: 'item', item });
    } else if (!placed.has(item.kind)) {
      placed.add(item.kind);
      rows.push({
        type: 'group',
        kind: item.kind,
        items: tail.filter((t) => t.kind === item.kind),
      });
    }
  });
  return rows;
}

/** Each lead's real value once, estimates left out (as "$ affected" counts it). */
export function valueOf(items: readonly AttentionItem[]): number {
  const best = new Map<string, number>();
  for (const it of items) {
    if (it.valueIsEstimate || it.valueCents <= 0) continue;
    const key = it.leadId ?? it.id;
    best.set(key, Math.max(best.get(key) ?? 0, it.valueCents));
  }
  return [...best.values()].reduce((sum, v) => sum + v, 0);
}

/** "Today and tomorrow": the days a group's appointments fall on. */
export function daysSpan(
  items: readonly AttentionItem[],
  timeZone: string,
  now: number,
): string | null {
  const today = localDateOf(now, timeZone);
  const days = [
    ...new Set(items.flatMap((i) => (i.dueAt ? [localDateOf(Date.parse(i.dueAt), timeZone)] : []))),
  ].sort();
  const words = days.map((d) =>
    d === today
      ? 'today'
      : d === addDays(today, 1)
        ? 'tomorrow'
        : dayLabel(localInstant(d, '12:00', timeZone), timeZone),
  );
  return words.length ? sentence(andList(words)) : null;
}

// ---------- handled ----------

/** HandsFreeOS did it: on its own, or because someone chose Let HandsFreeOS Handle. */
export const byHandsFree = (item: Pick<AttentionItem, 'handled'>): boolean =>
  item.handled?.via === 'auto' || item.handled?.via === 'let_handle';

/** "Asked 2 customers to confirm and followed up with 1 lead". */
export function handledSummary(items: readonly AttentionItem[]): string {
  const asked = items.filter((i) => i.auto.action === 'confirm_request').length;
  const nudged = items.filter((i) => i.auto.action === 'nudge').length;
  const other = items.length - asked - nudged;
  const parts = [
    asked ? `asked ${asked} ${asked === 1 ? 'customer' : 'customers'} to confirm` : null,
    nudged ? `followed up with ${nudged} ${nudged === 1 ? 'lead' : 'leads'}` : null,
    other ? `handled ${other} more` : null,
  ].filter((p): p is string => p !== null);
  return sentence(andList(parts));
}

// ---------- where an item opens ----------

export interface ItemTarget {
  readonly href: string;
  readonly label: string;
}

/** The record behind an item: the lead, the conversation, the appointment, Approvals or Tasks. */
export function targetOf(item: AttentionItem, workspaceId: string): ItemTarget {
  const base = `/app/w/${workspaceId}`;
  switch (item.kind) {
    case 'hot_lead':
    case 'unanswered_lead':
    case 'stale_opportunity':
    case 'missing_next_action':
      if (item.leadId) return { href: `${base}/leads/${item.leadId}`, label: 'Open the lead' };
      break;
    case 'customer_waiting':
      if (item.conversationId)
        return { href: `${base}/inbox/${item.conversationId}`, label: 'Open the conversation' };
      break;
    case 'unconfirmed_appointment':
      if (item.appointmentId)
        return {
          href: calendarHref(workspaceId, { appt: item.appointmentId }),
          label: 'Open the appointment',
        };
      break;
    case 'ai_approval':
      return {
        href: `${base}/workflows/approvals${isDraft(item) ? '?filter=ai' : ''}`,
        label: 'Open in Approvals',
      };
    case 'overdue_task':
      return { href: `${base}/tasks`, label: 'Open Tasks' };
    // The document itself: what it says, what has been paid, and the buttons that follow it up or remind
    // them — none of which HandsFreeOS ever presses on its own.
    case 'estimate_waiting':
      return {
        href: `${base}/money/estimates/${item.subject.id}`,
        label: 'Open the estimate',
      };
    case 'invoice_overdue':
      return { href: `${base}/money/invoices/${item.subject.id}`, label: 'Open the invoice' };
  }
  if (item.personId)
    return { href: `${base}/customers/people/${item.personId}`, label: 'Open the customer' };
  return { href: base, label: 'Open' };
}
