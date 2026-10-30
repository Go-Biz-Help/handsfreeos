/**
 * Home's Action Center words (M8; in core since M10 so the web and the phone say the same): the kind labels the cards
 * use, the reason chips as of a moment, the snooze choices in the business's time zone, the fold of lower cards into
 * groups, where each item opens, the main button, the ⋯ sheet, Assign, Dismiss, "Handled by HandsFreeOS", the Let
 * HandsFreeOS Handle sheet and the toasts. Browser-safe.
 */
import { addDays, localDateOf, localInstant, zonedParts } from '../calendar/engine/zoned';
import type { WordPart } from '../inbox/composer';
import { money as moneyLabel } from '../money/format';
import type { AttentionItemOut } from '../schemas/attention';
import { chipText } from './chips';
import { ATTENTION_KIND_LABELS, ATTENTION_KIND_PLURALS, type AttentionKind } from './kinds';
import { clockLabel, dayLabel } from './wording';

type Item = AttentionItemOut;
type ChipOut = Item['reasons'][number];

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
  wallet_low: ['balance', 'balances'],
  wallet_empty: ['balance', 'balances'],
  wallet_card_declined: ['card', 'cards'],
  job_not_thanked: ['customer', 'customers'],
  referral_mentioned: ['referral', 'referrals'],
  maintenance_due: ['customer', 'customers'],
  pipeline_mismatch: ['deal', 'deals'],
  quiet_after_price: ['lead', 'leads'],
  job_unconfirmed: ['job', 'jobs'],
  job_never_completed: ['job', 'jobs'],
  job_no_address: ['job', 'jobs'],
  client_quiet: ['customer', 'customers'],
  promise_due: ['promise', 'promises'],
  revenue_moved: ['week', 'weeks'],
  channel_quiet: ['channel', 'channels'],
  connection_error: ['connection', 'connections'],
  connection_silent: ['connection', 'connections'],
  ai_unreviewed: ['teammate', 'teammates'],
  ai_corrections: ['lesson', 'lessons'],
  website_changed: ['scan', 'scans'],
  faq_suggestions: ['question', 'questions'],
  offer_lapsing: ['promotion', 'promotions'],
  texting_rejected: ['registration', 'registrations'],
  addon_alert: ['alert', 'alerts'],
  webinar_hot: ['customer', 'customers'],
};

/** The settings page that checks a channel or fixes a connection, by the card's stored subject type. */
const HEALTH_TARGETS: Readonly<Record<string, AttentionTarget>> = {
  channel_text: { href: '/settings/texting', label: 'Open texting settings' },
  channel_call: { href: '/settings/texting', label: 'Open phone settings' },
  channel_email: { href: '/settings/email', label: 'Open email settings' },
  channel_chat: { href: '/settings/website-chat', label: 'Open website chat' },
  payment_connection: { href: '/settings/payments', label: 'Open payments' },
  calendar_connection: { href: '/settings/my-calendar', label: 'Open your calendar' },
  mailbox: { href: '/settings/email', label: 'Open email settings' },
  review_connection: { href: '/reviews', label: 'Open reviews' },
  phone_number: { href: '/settings/texting', label: 'Open phone settings' },
  meta_account: { href: '/settings/facebook-instagram', label: 'Open Facebook & Instagram' },
};

/** The kinds about a lead: assigning one makes that person the lead's owner. */
export const LEAD_ITEM_KINDS: ReadonlySet<AttentionKind> = new Set<AttentionKind>([
  'hot_lead',
  'unanswered_lead',
  'quiet_after_price',
  'stale_opportunity',
  'missing_next_action',
]);

/** A folded group's title and count: "Unconfirmed appointments" and "4 customers". */
export function attentionGroupTitle(
  kind: AttentionKind,
  count: number,
): { title: string; count: string } {
  const [one, many] = NOUNS[kind];
  return { title: ATTENTION_KIND_PLURALS[kind], count: `${count} ${count === 1 ? one : many}` };
}

/** "Maria Lopez · New AC install" as its two parts. */
export function splitItemTitle(title: string): { head: string; rest: string | null } {
  const at = title.indexOf(' · ');
  return at < 0
    ? { head: title, rest: null }
    : { head: title.slice(0, at), rest: title.slice(at + 3) };
}

/** The customer a card is about, or null for a task (its title is the task's own). */
export const itemCustomerOf = (item: Pick<Item, 'kind' | 'title'>): string | null =>
  item.kind === 'overdue_task' ? null : splitItemTitle(item.title).head;

/** "Maria" from "Maria Lopez"; the fallback ("them") when there's no name. */
export const firstNameOr = (name: string | null | undefined, fallback = 'them'): string =>
  name?.trim().split(/\s+/)[0] || fallback;

export const sentenceCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** "Furnace repair" in the middle of a sentence; "AC tune-up" keeps its capitals. */
export const inSentenceCase = (text: string): string =>
  /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;

/** "A, B and C"; past `max` names, "A, B, C, D and 2 more". */
export function joinAnd(names: readonly string[], max = 4): string {
  if (names.length > max) return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** An AI teammate's draft (the approval chip says a workflow's approval step). */
export const isDraftItem = (item: Pick<Item, 'reasons'>): boolean =>
  item.reasons.some((r) => r.code === 'draft');

// ---------- reason chips ----------

export type CardChipTone = 'plain' | 'money' | 'est' | 'time' | 'late' | 'good' | 'ai' | 'auto';
export type CardChipIcon = 'clock' | 'check' | 'ai' | 'auto' | null;
export interface CardChip {
  readonly key: string;
  readonly text: string;
  readonly tone: CardChipTone;
  readonly icon: CardChipIcon;
  readonly title?: string;
}

const LOOK: Partial<Record<ChipOut['code'], readonly [CardChipTone, CardChipIcon]>> = {
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
const PLAIN: readonly [CardChipTone, CardChipIcon] = ['plain', null];

/** A stored chip's words at a moment: "waiting 12 min" keeps counting. */
function wordsOf(c: ChipOut, now: number): string {
  const text = chipText(
    {
      code: c.code,
      label: c.label,
      ...(c.since ? { since: c.since } : {}),
      ...(c.until ? { until: c.until } : {}),
    },
    now,
  );
  return c.code === 'value' ? text : sentenceCase(text);
}

/** When HandsFreeOS is about to act on its own, or null. */
export function autoActionAt(item: Pick<Item, 'auto'>): number | null {
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
export function cardChipsOf(
  item: Pick<Item, 'valueIsEstimate' | 'valueCents' | 'reasons' | 'urgent' | 'auto'>,
  now: number,
  timeZone: string,
): CardChip[] {
  const out: CardChip[] = [];
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
  const at = autoActionAt(item);
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

export interface AttentionSnoozeChoice {
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
export function attentionSnoozeChoices(timeZone: string, now: number): AttentionSnoozeChoice[] {
  const today = localDateOf(now, timeZone);
  const hour = now + 60 * 60_000;
  const out: AttentionSnoozeChoice[] = [
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
export function snoozedUntilWords(until: number, timeZone: string, now: number): string {
  const day = localDateOf(until, timeZone);
  const today = localDateOf(now, timeZone);
  const clock = clockLabel(until, timeZone);
  if (day === today) return clock;
  if (day === addDays(today, 1)) return `tomorrow at ${clock}`;
  return `${dayLabel(until, timeZone)} at ${clock}`;
}

/** Why a picked snooze time can't be used, or null when it can ("Pick a time…"). */
export function snoozePickError(until: number | null, now: number): string | null {
  if (until === null) return ATTENTION_WORDS.pickDayAndTime;
  if (!(until > now)) return ATTENTION_WORDS.pickLater;
  if (until > now + SNOOZE_MAX_DAYS * 86_400_000) return ATTENTION_WORDS.pickWithin30;
  return null;
}

// ---------- groups ----------

/** Cards from this rank on may fold into a group... */
export const FOLD_FROM_RANK = 5;
/** ...when at least this many of one kind are there. */
export const FOLD_MIN = 3;

export type AttentionListRow<T extends Pick<Item, 'kind'> = Item> =
  | { readonly type: 'item'; readonly item: T }
  | { readonly type: 'group'; readonly kind: AttentionKind; readonly items: readonly T[] };

/**
 * The ranked list below Urgent, with three or more items of one kind from rank 5 down folded into one group where
 * the first of them stood ("Unconfirmed appointments · 4 customers"). `ranksBefore` counts the urgent cards above.
 */
export function foldAttentionRows<T extends Pick<Item, 'kind'>>(
  items: readonly T[],
  ranksBefore: number,
): AttentionListRow<T>[] {
  const low = (i: number) => ranksBefore + i >= FOLD_FROM_RANK;
  const tail = items.filter((_, i) => low(i));
  const counts = new Map<AttentionKind, number>();
  for (const it of tail) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
  const folded = new Set([...counts].filter(([, n]) => n >= FOLD_MIN).map(([k]) => k));
  const placed = new Set<AttentionKind>();
  const rows: AttentionListRow<T>[] = [];
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
export function groupValueCents(
  items: readonly Pick<Item, 'id' | 'leadId' | 'valueCents' | 'valueIsEstimate'>[],
): number {
  const best = new Map<string, number>();
  for (const it of items) {
    if (it.valueIsEstimate || it.valueCents <= 0) continue;
    const key = it.leadId ?? it.id;
    best.set(key, Math.max(best.get(key) ?? 0, it.valueCents));
  }
  return [...best.values()].reduce((sum, v) => sum + v, 0);
}

/** "Today and tomorrow": the days a group's appointments fall on. */
export function groupDaysSpan(
  items: readonly Pick<Item, 'dueAt'>[],
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
  return words.length ? sentenceCase(joinAnd(words)) : null;
}

/** "Show all 4", or "Hide" once it's open. */
export const groupToggleLabel = (open: boolean, count: number): string =>
  open ? 'Hide' : `Show all ${count}`;

/** The line after a group row's name: "Roof leak repair · Tomorrow 9:00 AM · you". */
export function groupRowMore(
  item: Pick<Item, 'kind' | 'title' | 'detail' | 'assignee'>,
  myUserId: string,
): string {
  const who = item.assignee
    ? item.assignee.id === myUserId
      ? 'you'
      : firstNameOr(item.assignee.fullName)
    : null;
  return [
    splitItemTitle(item.title).rest,
    item.kind === 'unconfirmed_appointment' ? item.detail : null,
    who,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---------- handled ----------

/** HandsFreeOS did it: on its own, or because someone chose Let HandsFreeOS Handle. */
export const handledByHandsFree = (item: Pick<Item, 'handled'>): boolean =>
  item.handled?.via === 'auto' || item.handled?.via === 'let_handle';

/** "Asked 2 customers to confirm and followed up with 1 lead". */
export function handledSummary(items: readonly Pick<Item, 'auto'>[]): string {
  const asked = items.filter((i) => i.auto.action === 'confirm_request').length;
  const nudged = items.filter((i) => i.auto.action === 'nudge').length;
  const other = items.length - asked - nudged;
  const parts = [
    asked ? `asked ${asked} ${asked === 1 ? 'customer' : 'customers'} to confirm` : null,
    nudged ? `followed up with ${nudged} ${nudged === 1 ? 'lead' : 'leads'}` : null,
    other ? `handled ${other} more` : null,
  ].filter((p): p is string => p !== null);
  return sentenceCase(joinAnd(parts));
}

/** What was done, as a sentence with the customer in bold, and the line under it. */
export function handledLineOf(
  item: Pick<Item, 'kind' | 'title' | 'detail' | 'handled' | 'auto'>,
  myUserId: string,
): { text: WordPart[]; sub: string | null } {
  const name = itemCustomerOf(item) ?? item.title;
  const rest = splitItemTitle(item.title).rest;
  const h = item.handled;
  const by = h?.by ? (h.by.id === myUserId ? 'you' : firstNameOr(h.by.fullName)) : null;
  const who = { strong: name };
  if (handledByHandsFree(item)) {
    const how =
      h?.via === 'let_handle' && by ? `${sentenceCase(by)} asked HandsFreeOS` : 'On its own';
    if (item.auto.action === 'confirm_request')
      return {
        text: ['Asked ', who, ` to confirm${rest ? ` the ${inSentenceCase(rest)}` : ''}`],
        sub: [item.detail, how].filter(Boolean).join(' · '),
      };
    if (item.auto.action === 'nudge')
      return {
        text: ['Followed up with ', who, rest ? ` about the ${inSentenceCase(rest)}` : ''],
        sub: how,
      };
    return { text: ['Took care of ', who, rest ? ` · ${rest}` : ''], sub: how };
  }
  return {
    text: [`${by ? sentenceCase(by) : 'Someone'} took care of `, who],
    sub: rest ?? item.detail,
  };
}

// ---------- where an item opens ----------

export interface AttentionTarget {
  /** The web's path. */
  readonly href: string;
  readonly label: string;
}

/** The record behind an item: the lead, the conversation, the appointment, Approvals or Tasks. */
export function attentionTargetOf(
  item: Pick<
    Item,
    'kind' | 'leadId' | 'conversationId' | 'appointmentId' | 'reasons' | 'subject' | 'personId'
  > & { readonly addonAlert?: Item['addonAlert'] },
  workspaceId: string,
): AttentionTarget {
  const base = `/app/w/${workspaceId}`;
  switch (item.kind) {
    case 'hot_lead':
    case 'unanswered_lead':
    case 'stale_opportunity':
    case 'missing_next_action':
    case 'quiet_after_price':
    case 'pipeline_mismatch':
      if (item.leadId) return { href: `${base}/leads/${item.leadId}`, label: 'Open the lead' };
      break;
    case 'customer_waiting':
      if (item.conversationId)
        return { href: `${base}/inbox/${item.conversationId}`, label: 'Open the conversation' };
      break;
    case 'unconfirmed_appointment':
    case 'job_unconfirmed':
    case 'job_never_completed':
    case 'job_no_address':
      if (item.appointmentId)
        return {
          href: `${base}/calendar?appt=${encodeURIComponent(item.appointmentId)}`,
          label: 'Open the appointment',
        };
      break;
    case 'ai_approval':
      return {
        href: `${base}/workflows/approvals${isDraftItem(item) ? '?filter=ai' : ''}`,
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
    // The wallet's three are about the business's own balance rather than a customer, so they open the balance
    // itself — Settings → Usage & balance on the web, the Balance screen on the phone.
    case 'wallet_low':
    case 'wallet_empty':
    case 'wallet_card_declined':
      return { href: `${base}/settings/usage`, label: 'Open your balance' };
    // The customer who mentioned them: that's where the conversation is.
    case 'job_not_thanked':
    case 'referral_mentioned':
    case 'maintenance_due':
    case 'client_quiet':
    case 'promise_due':
    case 'webinar_hot':
      break;
    // What came in, and what's still owed.
    case 'revenue_moved':
      return { href: `${base}/money`, label: 'Open money' };
    // The business's own set-up: the page that checks or fixes it.
    case 'channel_quiet':
    case 'connection_error':
    case 'connection_silent': {
      const t = HEALTH_TARGETS[item.subject.type];
      if (t) return { href: `${base}${t.href}`, label: t.label };
      return { href: `${base}/settings`, label: 'Open settings' };
    }
    case 'ai_unreviewed':
      return { href: `${base}/ai-team/review`, label: 'Review its replies' };
    case 'ai_corrections':
      return { href: `${base}/ai-team/instructions`, label: 'Open its instructions' };
    case 'website_changed':
      return { href: `${base}/knowledge/suggestions?reason=scan`, label: 'Open the updates' };
    case 'faq_suggestions':
      return { href: `${base}/knowledge/suggestions?reason=gap`, label: 'Open the questions' };
    case 'offer_lapsing':
      return { href: `${base}/knowledge/offers`, label: 'Open the promotions' };
    case 'texting_rejected':
      return { href: `${base}/settings/texting`, label: 'Open Texting & calls' };
    // The add-on's own page, as it named it.
    case 'addon_alert':
      return item.addonAlert
        ? { href: `${base}${item.addonAlert.href}`, label: `Open in ${item.addonAlert.addonName}` }
        : { href: `${base}/add-ons`, label: 'Open Add-ons' };
  }
  if (item.personId)
    return { href: `${base}/customers/people/${item.personId}`, label: 'Open the customer' };
  return { href: base, label: 'Open' };
}

/** The conversation to answer in, or the record itself. */
export const attentionReachOf = (
  item: Parameters<typeof attentionTargetOf>[0],
  workspaceId: string,
): string =>
  item.conversationId
    ? `/app/w/${workspaceId}/inbox/${item.conversationId}`
    : attentionTargetOf(item, workspaceId).href;

// ---------- the main button ----------

export type HandleIcon =
  | 'phone'
  | 'mail'
  | 'send'
  | 'message'
  | 'calendar-plus'
  | 'check'
  | 'list-checks'
  | 'receipt'
  | 'file-text'
  | 'user-plus';

/**
 * A lesson from correcting the AI that goes against what it already knows: its card asks which is right, and its
 * main button puts the new words in place of the old ones (teammate_lesson.apply with `replace`).
 */
export function lessonKnowsOtherwise(item: {
  readonly kind: Item['kind'];
  readonly reasons: readonly { readonly code: string }[];
}): boolean {
  return item.kind === 'ai_corrections' && item.reasons.some((r) => r.code === 'knows_otherwise');
}

/**
 * The main button's words and icon for an item: Call Maria, Reply, Set next action, Confirm by text, Approve, Open
 * task. `reach` says the channel it would really use; `callsAvailable` whether this device can call (the web's
 * browser calling, a phone's own cell).
 */
export function handleButtonOf(
  item: Pick<
    Item,
    'kind' | 'title' | 'reach' | 'personId' | 'conversationId' | 'reasons' | 'callable'
  >,
  callsAvailable: boolean,
): { label: string; icon: HandleIcon } {
  const first = firstNameOr(itemCustomerOf(item));
  const email = item.reach === 'email';
  // A card that has taken on a customer's wait answers it first, whatever kind of card it is. Since lead
  // intake (M14) a stranger who texts is a lead straight away, so the wait arrives folded into that lead's
  // card (attention/folding.ts) — and a card offering "Set next action" to somebody who is sitting there
  // waiting for an answer is the opposite of what the Action Center is for.
  if (item.conversationId && item.reasons.some((r) => r.code === 'waiting'))
    return { label: 'Reply', icon: email ? 'mail' : 'send' };
  switch (item.kind) {
    case 'hot_lead':
      return callsAvailable && item.personId
        ? { label: `Call ${first}`, icon: 'phone' }
        : { label: 'Reply', icon: email ? 'mail' : 'send' };
    case 'unanswered_lead':
    case 'customer_waiting':
      return { label: 'Reply', icon: email ? 'mail' : 'send' };
    case 'stale_opportunity':
      if (email) return { label: `Email ${first}`, icon: 'mail' };
      return item.conversationId || item.reach === 'sms'
        ? { label: `Text ${first}`, icon: 'message' }
        : { label: 'Follow up', icon: 'message' };
    case 'missing_next_action':
      return { label: 'Set next action', icon: 'calendar-plus' };
    case 'unconfirmed_appointment':
      if (email) return { label: 'Confirm by email', icon: 'mail' };
      return item.reach === 'sms'
        ? { label: 'Confirm by text', icon: 'message' }
        : { label: 'Ask to confirm', icon: 'message' };
    case 'ai_approval':
      return isDraftItem(item)
        ? { label: 'Approve', icon: 'check' }
        : { label: 'Review', icon: 'check' };
    case 'overdue_task':
      return { label: 'Open task', icon: 'list-checks' };
    // Money reaches the customer like every other kind: a call while the business is open, otherwise a text
    // or an email with the follow-up already written.
    case 'estimate_waiting':
    case 'invoice_overdue':
      if (callsAvailable && item.callable && item.personId)
        return { label: `Call ${first}`, icon: 'phone' };
      if (email) return { label: `Email ${first}`, icon: 'mail' };
      if (item.reach === 'sms') return { label: `Text ${first}`, icon: 'message' };
      // Nothing can reach them: the card falls back to the document it is about.
      return {
        label: item.kind === 'invoice_overdue' ? 'Open the invoice' : 'Open the estimate',
        icon: item.kind === 'invoice_overdue' ? 'receipt' : 'file-text',
      };
    // The wallet's three go to the usage page. Nothing reaches a customer, so none of the channel reasoning
    // above applies — the whole card is about the business's own balance.
    case 'wallet_low':
    case 'wallet_empty':
      return { label: 'Top up', icon: 'receipt' };
    case 'wallet_card_declined':
      return { label: 'Fix the card', icon: 'receipt' };
    case 'job_not_thanked':
      return email
        ? { label: `Thank ${first}`, icon: 'mail' }
        : { label: `Thank ${first}`, icon: 'message' };
    case 'referral_mentioned':
      return { label: 'Create lead', icon: 'user-plus' };
    case 'maintenance_due':
      if (callsAvailable && item.personId) return { label: `Call ${first}`, icon: 'phone' };
      if (email) return { label: `Email ${first}`, icon: 'mail' };
      return { label: `Text ${first}`, icon: 'message' };
    case 'pipeline_mismatch':
      return { label: 'Move deal', icon: 'check' };
    case 'quiet_after_price':
      if (callsAvailable && item.personId) return { label: `Call ${first}`, icon: 'phone' };
      if (email) return { label: `Email ${first}`, icon: 'mail' };
      return { label: `Text ${first}`, icon: 'message' };
    case 'job_unconfirmed':
    case 'job_never_completed':
      return { label: 'Mark done', icon: 'check' };
    case 'job_no_address':
      return { label: 'Add address', icon: 'calendar-plus' };
    case 'client_quiet':
    case 'promise_due':
    case 'webinar_hot':
      if (callsAvailable && item.personId) return { label: `Call ${first}`, icon: 'phone' };
      if (email) return { label: `Email ${first}`, icon: 'mail' };
      return { label: `Text ${first}`, icon: 'message' };
    case 'revenue_moved':
      return { label: 'Open money', icon: 'receipt' };
    case 'channel_quiet':
    case 'connection_silent':
      return { label: 'Check it', icon: 'list-checks' };
    case 'connection_error':
      return { label: 'Reconnect', icon: 'list-checks' };
    case 'ai_unreviewed':
      return { label: 'Review', icon: 'check' };
    case 'ai_corrections':
      return lessonKnowsOtherwise(item)
        ? { label: 'Use the new one', icon: 'check' }
        : { label: 'Add to its instructions', icon: 'check' };
    case 'website_changed':
      return { label: 'Review updates', icon: 'file-text' };
    case 'faq_suggestions':
      return { label: 'Answer', icon: 'message' };
    case 'offer_lapsing':
      return { label: 'Open the promotion', icon: 'file-text' };
    case 'texting_rejected':
      return { label: 'Fix and send again', icon: 'message' };
    case 'addon_alert':
      return { label: 'Open', icon: 'file-text' };
  }
}

/** Why Let HandsFreeOS Handle is off for an item, or null when it's on. */
export function letHandleOffReason(
  item: Pick<Item, 'kind' | 'letHandleMode' | 'actions'>,
): string | null {
  if (item.kind === 'ai_approval') return 'Approvals always need a person';
  if (item.kind === 'overdue_task') return 'HandsFreeOS can’t do your tasks';
  if (item.kind === 'job_not_thanked') return 'HandsFreeOS couldn’t send this one';
  if (item.kind === 'referral_mentioned') return 'Reaching out to someone new is your call';
  if (item.kind === 'maintenance_due') return 'It already texted them twice';
  if (item.kind === 'pipeline_mismatch') return 'HandsFreeOS couldn’t move it itself';
  if (item.kind === 'quiet_after_price') return 'The follow-up texts are already going';
  if (item.kind === 'job_unconfirmed' || item.kind === 'job_never_completed')
    return 'Only someone who was there knows';
  if (item.kind === 'job_no_address') return 'Only you or the customer know where';
  if (item.kind === 'client_quiet') return 'A regular hears from a person';
  if (item.kind === 'promise_due') return 'The promise was yours';
  if (item.kind === 'revenue_moved') return 'This one is for you to look at';
  if (item.kind === 'channel_quiet' || item.kind === 'connection_silent')
    return 'Only you can check what’s wrong';
  if (item.kind === 'connection_error') return 'Reconnecting needs you to sign in';
  if (item.kind === 'ai_unreviewed') return 'Reviewing the AI is for a person';
  if (
    item.kind === 'ai_corrections' ||
    item.kind === 'website_changed' ||
    item.kind === 'faq_suggestions'
  )
    return 'What the AI learns is yours to decide';
  if (item.kind === 'offer_lapsing') return 'Whether a promotion runs longer is your call';
  if (item.kind === 'texting_rejected') return 'Only you can fix the details they turned down';
  if (item.kind === 'addon_alert') return 'The add-on says when it’s done';
  if (item.kind === 'webinar_hot') return 'Someone hot hears from a person';
  if (item.letHandleMode === 'none') return 'HandsFreeOS can’t handle this one';
  if (!item.actions.letHandle) return 'You can’t hand this one off';
  return null;
}

// ---------- the goes strip ----------

/** "HandsFreeOS will ask Olivia to confirm at 9:05 AM." or "HandsFreeOS will follow up at 9:05 AM." */
export function goesStripWords(
  item: Pick<Item, 'kind' | 'title' | 'auto'>,
  at: number,
  timeZone: string,
): { strong: string; rest: string | null } {
  const when = clockLabel(at, timeZone);
  const confirm = item.auto.action === 'confirm_request';
  return confirm
    ? {
        strong: `HandsFreeOS will ask ${firstNameOr(itemCustomerOf(item))} to confirm at ${when}.`,
        rest: null,
      }
    : { strong: `HandsFreeOS will follow up at ${when}.`, rest: ' One message, in your words.' };
}

// ---------- the header ----------

/**
 * The top of Home: "$49,852 affected" (or "10 need attention" when no real dollars stand behind the items, or "Nothing
 * needs you right now"), then "10 need attention · 2 urgent · 3 handled today".
 */
export function attentionHeaderWords(o: {
  readonly total: number;
  readonly urgent: number;
  readonly handledToday: number;
  readonly affectedCents: number;
}): {
  /** The big line: its figure, and the smaller words after it (none when nothing needs you). */
  readonly headline: { readonly figure: string; readonly words: string | null };
  /** Why the figure is what it is, when it's dollars. */
  readonly title: string | null;
  /** "10 need attention", or null when the headline already says it. */
  readonly need: { readonly count: string; readonly words: string } | null;
  readonly urgent: string | null;
  readonly handled: string;
} {
  const nothing = o.total === 0;
  // With no real dollars behind the items (typical values are left out), the count is the headline instead.
  const countFirst = !nothing && o.affectedCents === 0;
  const need = o.total === 1 ? 'needs attention' : 'need attention';
  return {
    headline: nothing
      ? { figure: 'Nothing needs you right now', words: null }
      : countFirst
        ? { figure: String(o.total), words: need }
        : { figure: moneyLabel(o.affectedCents), words: 'affected' },
    title:
      nothing || countFirst
        ? null
        : 'Lead values and overdue invoices, each job counted once. An estimate counts once it’s approved.',
    need: countFirst ? null : { count: String(o.total), words: need },
    urgent: o.urgent ? `${o.urgent} urgent` : null,
    handled: `${o.handledToday} handled today`,
  };
}

// ---------- Assign ----------

/** What assigning changes, under the list. */
export function assignNoteOf(item: Pick<Item, 'kind'>): string {
  if (LEAD_ITEM_KINDS.has(item.kind)) return 'This makes them the lead’s owner too.';
  if (item.kind === 'customer_waiting') return 'This assigns them the conversation too.';
  if (item.kind === 'overdue_task') return 'This makes it their task too.';
  return 'For appointments and approvals, this assigns only the item.';
}

/** "Assign Maria Lopez to", or "Assign this item to". */
export function assignHeadingOf(item: Pick<Item, 'kind' | 'title'>): string {
  const name = itemCustomerOf(item);
  return !name || item.kind === 'unconfirmed_appointment' || item.kind === 'ai_approval'
    ? 'Assign this item to'
    : `Assign ${name} to`;
}

/** Who has it, beside Assign…: "You", "Priya" or "Nobody". */
export function assigneeShortOf(item: Pick<Item, 'assignee'>, myUserId: string): string {
  return item.assignee
    ? item.assignee.id === myUserId
      ? 'You'
      : firstNameOr(item.assignee.fullName)
    : 'Nobody';
}

/** "unassigned", "assigned to you", "assigned to Priya" (under the ⋯ sheet's title). */
export function assignedToOf(item: Pick<Item, 'assignee'>, myUserId: string): string {
  if (!item.assignee) return 'unassigned';
  return `assigned to ${item.assignee.id === myUserId ? 'you' : firstNameOr(item.assignee.fullName)}`;
}

/** What assigning did, for its toast. */
export function assignedToast(
  passedTo: 'lead' | 'conversation' | 'task' | null,
  self: boolean,
  first: string | null,
): string {
  if (!self && !first) return 'Unassigned.';
  const who = self ? 'you' : first;
  const theirs = self ? 'yours' : `${first}’s`;
  switch (passedTo) {
    case 'lead':
      return `Assigned to ${who}. ${self ? 'You’re' : `${first} is`} now the lead’s owner.`;
    case 'conversation':
      return `Assigned to ${who}. The conversation is ${theirs} too.`;
    case 'task':
      return `Assigned to ${who}. The task is ${theirs} too.`;
    default:
      return `Assigned to ${who}.`;
  }
}

// ---------- Dismiss ----------

export const DISMISS_LEAD_REASONS = [
  'Already taken care of',
  'Not a real lead',
  'They’re not interested',
  'Something else',
] as const;
export const DISMISS_OTHER_REASONS = [
  'Already taken care of',
  'Not needed',
  'Something else',
] as const;
/** The longest reason the dismissal keeps. */
export const DISMISS_REASON_MAX = 500;

export const dismissReasonsOf = (item: Pick<Item, 'kind'>): readonly string[] =>
  LEAD_ITEM_KINDS.has(item.kind) ? DISMISS_LEAD_REASONS : DISMISS_OTHER_REASONS;

/** "Maria Lopez · New AC install · $18,500": what "Dismiss this?" is about. */
export function dismissAboutOf(
  item: Pick<Item, 'title' | 'valueCents' | 'valueIsEstimate'>,
): string {
  return [
    item.title,
    item.valueCents > 0 && !item.valueIsEstimate ? moneyLabel(item.valueCents) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** What happens once it's dismissed. */
export function dismissNoteOf(item: Pick<Item, 'kind' | 'title'>): string {
  const first = firstNameOr(itemCustomerOf(item), 'them');
  return `It stays off the list until something changes, like a new message from ${first}.${
    LEAD_ITEM_KINDS.has(item.kind) ? ' The lead itself doesn’t change.' : ''
  }`;
}

/** The reason kept with the dismissal: the choice, a note, or both ("Not needed: they called back"). */
export const dismissSaid = (reason: string | null, note: string): string | null =>
  [reason, note.trim()].filter(Boolean).join(': ').slice(0, DISMISS_REASON_MAX) || null;

// ---------- Let HandsFreeOS Handle ----------

export type LetHandleMode = 'auto' | 'ask' | 'none';
export type LetHandleChoice = 'hand_to_ai' | 'reply' | 'set_next_action';

export const LET_HANDLE_MODE_LABELS: Readonly<Record<LetHandleMode, string>> = {
  auto: 'Handled on its own',
  ask: 'Asks first',
  none: 'Always a person',
};

/** The sheet's title: "Ask Olivia Grant to confirm", "Reply to Maria Lopez", "Hand Kendra Lee to Ava?". */
export function letHandleTitleOf(o: {
  readonly item: Pick<Item, 'kind' | 'title'>;
  readonly mode: LetHandleMode;
  readonly choice: LetHandleChoice | null;
  readonly confirm: boolean;
  readonly teammateName: string | null;
}): string {
  const name = itemCustomerOf(o.item) ?? o.item.title;
  const ai = o.teammateName ?? 'your AI teammate';
  const money = o.item.kind === 'estimate_waiting' || o.item.kind === 'invoice_overdue';
  if (o.mode === 'auto') return o.confirm ? `Ask ${name} to confirm` : `Follow up with ${name}`;
  if (o.mode === 'ask') {
    switch (o.choice) {
      case 'hand_to_ai':
        return `Hand ${name} to ${ai}?`;
      case 'reply':
        return money ? `Follow up with ${name}` : `Reply to ${name}`;
      case 'set_next_action':
        return `Set a next action for ${name}`;
      default:
        return name;
    }
  }
  return `${ATTENTION_KIND_LABELS[o.item.kind]}: ${name}`;
}

/** Under the sheet's title: the job, then the first two chips ("New AC install · $18,500 · waiting 11 min"). */
export function letHandleSubOf(
  item: Parameters<typeof cardChipsOf>[0] & Pick<Item, 'title'>,
  now: number,
  timeZone: string,
): string {
  return [
    splitItemTitle(item.title).rest,
    ...cardChipsOf(item, now, timeZone)
      .slice(0, 2)
      .map((c) =>
        c.tone === 'money' || c.tone === 'est'
          ? c.text
          : c.text.charAt(0).toLowerCase() + c.text.slice(1),
      ),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "Texts Maria now", "Emails Maria now", "Answers Maria in the chat now", "Writes to Maria now". */
export function letHandleChannelVerb(channel: string | null | undefined, first: string): string {
  return channel === 'email'
    ? `Emails ${first} now`
    : channel === 'chat'
      ? `Answers ${first} in the chat now`
      : channel === 'portal'
        ? `Answers ${first} in their portal now`
        : channel === 'messenger'
          ? `Answers ${first} on Messenger now`
          : channel === 'instagram'
            ? `Answers ${first} on Instagram now`
            : channel === 'sms'
              ? `Texts ${first} now`
              : `Writes to ${first} now`;
}

/** What handing a customer to the AI teammate does, as the sheet lists it. */
export function handToAiBullets(channel: string | null | undefined, first: string): string[] {
  return [
    `${letHandleChannelVerb(channel, first)} and answers their questions from your Knowledge`,
    'Offers times on your calendar if they want a visit',
    'Hands them to a person if they ask for one, or if it can’t help',
  ];
}

/** "Maria stays with Dale. If they need a person, Ava hands them over, like any hand-off." */
export function handToAiStays(
  first: string,
  assignee: { readonly fullName: string } | null,
  teammateName: string | null,
): string {
  const ai = teammateName ?? 'your AI teammate';
  return `${first} stays ${assignee ? `with ${firstNameOr(assignee.fullName)}` : 'unassigned'}. If they need a person, ${ai} hands them over, like any hand-off.`;
}

/** The footnote under an automatic message. */
export function letHandleFootnote(confirm: boolean, channel: string | null | undefined): string {
  return confirm
    ? channel === 'email'
      ? 'Confirm is a button on their booking page, so email scanners can’t confirm by accident.'
      : 'A reply of C, or the Confirm button on their booking page, confirms it.'
    : 'Your wording from Settings, Automations. It never adds prices or links.';
}

/** "It stops on its own if Maria writes first, or replies STOP." */
export const letHandleStops = (first: string, channel: string | null | undefined): string =>
  `It stops on its own if ${first} writes first${channel === 'sms' ? ', or replies STOP' : ''}.`;

/** "Text to (512) 555-0134" or "Email to maria@example.com". */
export const letHandleTo = (channel: string | null | undefined, to: string): string =>
  channel === 'email' ? `Email to ${to}` : `Text to ${to}`;

/** The automatic action's button: "Ask to confirm at 9:05 AM", "Follow up". */
export const letHandleAutoButton = (confirm: boolean, at: string | null): string =>
  `${confirm ? 'Ask to confirm' : 'Follow up'}${at ? ` at ${at}` : ''}`;

/** The ask-first button: "Send", "Add next action", "Hand to Ava". */
export function letHandleAskButton(
  choice: LetHandleChoice | null,
  teammateName: string | null,
): string {
  if (choice === 'reply') return 'Send';
  if (choice === 'set_next_action') return 'Add next action';
  return `Hand to ${teammateName ?? 'your AI teammate'}`;
}

/** Where a reply goes, above its box. */
export const letHandleReplyBy = (channel: string | null | undefined): string =>
  channel === 'email'
    ? 'By email'
    : channel === 'chat'
      ? 'In the website chat'
      : channel === 'portal'
        ? 'In their portal'
        : channel === 'messenger'
          ? 'On Messenger'
          : channel === 'instagram'
            ? 'On Instagram'
            : 'By text';

/** What HandsFreeOS did when the person pressed its button, for the toast. */
export function letHandleAutoToast(o: {
  readonly confirm: boolean;
  readonly channel: string | null | undefined;
  readonly first: string;
  readonly at: string | null;
}): string {
  const what = o.confirm
    ? `${o.channel === 'email' ? 'email' : 'text'} ${o.first} to confirm`
    : `follow up with ${o.first}`;
  return o.at
    ? `HandsFreeOS will ${what} at ${o.at}. You can cancel until then.`
    : `HandsFreeOS will ${what}.`;
}

/** Why an approval or a task has no Let HandsFreeOS Handle, when the preview gives no reason. */
export const letHandleNoneFallback = (kind: AttentionKind): string =>
  kind === 'ai_approval'
    ? 'Approvals always need a person.'
    : 'HandsFreeOS can’t do a task for you. Snooze moves it to later.';

/** The words on Home that don't depend on an item. */
export const ATTENTION_WORDS = {
  letHandle: 'Let HandsFreeOS Handle',
  urgent: 'Urgent',
  upNext: 'Up next',
  loading: 'Loading what needs attention…',
  mine: 'Mine',
  everyone: 'Everyone',
  caughtUpTitle: 'You’re all caught up',
  caughtUpBody:
    'When something needs you, it shows up here first. HandsFreeOS keeps watching for new leads, replies and tomorrow’s visits.',
  handledToday: 'Handled today',
  handledByHandsFree: 'Handled by HandsFreeOS',
  handledCount: (n: number) => `${n} today`,
  handledSplit: (team: number, hf: number) => `${team} by your team, ${hf} by HandsFreeOS`,
  showMore: (n: number) => `Show ${n} more`,
  open: 'Open',
  cancel: 'Cancel',
  close: 'Close',
  back: 'Back',
  more: 'More',
  snooze: 'Snooze',
  assign: 'Assign…',
  dismiss: 'Dismiss…',
  pickTime: 'Pick a time…',
  upTo30Days: 'Up to 30 days',
  snoozeUntil: 'Snooze until',
  day: 'Day',
  time: 'Time',
  pickDayAndTime: 'Pick a day and a time.',
  pickLater: 'Pick a time later than now.',
  pickWithin30: 'Snooze for 30 days at most.',
  pickZone: (zone: string) => `Up to 30 days, ${zone}.`,
  dismissTitle: 'Dismiss this?',
  why: 'Why?',
  optional: 'Optional',
  dismissNotePlaceholder: 'Add a note for your team (optional)',
  keepIt: 'Keep it',
  dismissConfirm: 'Dismiss',
  undo: 'Undo',
  snoozedToast: (when: string) => `Snoozed until ${when}`,
  dismissedToast: 'Dismissed. It comes back if something changes.',
  approvedToast: (teammateName: string | null, first: string) =>
    `Approved. ${teammateName ?? 'The AI teammate'}’s message went to ${first}.`,
  cancelledAutoToast: (confirm: boolean, first: string) =>
    confirm
      ? `Cancelled. ${first} won’t get a confirmation request.`
      : `Cancelled. ${first} won’t get a follow-up.`,
  asksAtToast: (first: string, at: string) => `HandsFreeOS asks ${first} to confirm at ${at}.`,
  /** An add-on's alert that waits for someone to say they've seen it. */
  acknowledge: 'Acknowledge',
  /** The same, on the phone's card beside its Open button (board 92). */
  gotIt: 'Got it',
  acknowledgedToast: 'Acknowledged. Everyone who sees it knows you’ve seen it.',
  noPhoneToast: (first: string) => `There’s no phone number for ${first}.`,
  workingOut: 'Working out what HandsFreeOS would do…',
  whatItSends: 'What it sends',
  checkedJustNow: 'Checked just now',
  goesOutAt: (at: string) => `Goes out at ${at}`,
  aiWill: (teammateName: string | null) => `${teammateName ?? 'your AI teammate'} (AI) will`,
  asSetUp: 'As it’s set up in AI teammate',
  subject: 'Subject',
  message: 'Message',
  replyPlaceholder: (first: string) => `Hi ${first}, …`,
  nextAction: 'Next action',
  when: 'When',
  writeMessage: 'Write a message.',
  sayNext: 'Say what to do next.',
  sentToast: (first: string) => `Sent to ${first}.`,
  nextActionSetToast: 'Next action set.',
  handedToast: (teammateName: string | null, first: string) => {
    const ai = teammateName ?? 'your AI teammate';
    return `Handed to ${ai}. ${ai} answers ${first} now.`;
  },
  callInstead: (first: string) => `Call ${first} instead`,
  myself: (label: string) => `${label} myself`,
  callMyself: (first: string) => `Call ${first} myself`,
  replyMyself: 'I’ll reply myself',
} as const;
