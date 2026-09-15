/**
 * Reason chips: their words, which ones tick, and their order on a card. Browser-safe, so a card's waiting chip
 * can count up every minute with the same words the worker stored.
 */
import type { AttentionChip, ReasonCode } from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const at = (now: Date | number) => (typeof now === 'number' ? now : now.getTime());

/** "11 min", "3 h", "2 days". */
function span(ms: number): string {
  const minutes = Math.floor(ms / MIN);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return plural(Math.floor(hours / 24), 'day');
}

/** Like the web's waitingFor: "just now" under a minute, then "waiting 1 min", "waiting 3 h", "waiting 2 d". */
function waiting(ms: number): string {
  const minutes = Math.floor(ms / MIN);
  if (minutes < 1) return 'just now';
  const hours = Math.floor(minutes / 60);
  if (minutes < 60) return `waiting ${minutes} min`;
  return hours < 24 ? `waiting ${hours} h` : `waiting ${Math.floor(hours / 24)} d`;
}

function lastContact(ms: number): string {
  if (ms >= DAY) return `Last contact ${plural(Math.floor(ms / DAY), 'day')} ago`;
  if (ms >= HOUR) return `Last contact ${Math.floor(ms / HOUR)} h ago`;
  return 'Last contact just now';
}

/** A chip's words at a moment: ticking chips recount, the rest keep their label. */
export function chipText(chip: AttentionChip, now: Date | number): string {
  const t = at(now);
  if (chip.since) {
    const ms = Math.max(0, t - Date.parse(chip.since));
    switch (chip.code) {
      case 'waiting':
        return waiting(ms);
      case 'last_contact':
        return lastContact(ms);
      case 'follow_up_overdue':
        return ms < MIN ? 'follow-up due now' : `follow-up ${span(ms)} overdue`;
      case 'overdue':
        return ms < MIN ? 'due now' : `${span(ms)} overdue`;
      default:
        return chip.label;
    }
  }
  if (chip.until) {
    const ms = Date.parse(chip.until) - t;
    switch (chip.code) {
      case 'starts_in':
        return ms < MIN ? 'starting now' : `starts in ${span(ms)}`;
      case 'expires_in':
        return ms < MIN ? 'expiring now' : `expires in ${span(ms)}`;
      default:
        return chip.label;
    }
  }
  return chip.label;
}

/** A chip with fixed words. */
export function chip(code: ReasonCode, label: string): AttentionChip {
  return { code, label };
}

/** A chip that counts up from `since` (ms), with its words as of `now`. */
export function sinceChip(code: ReasonCode, since: number, now: number): AttentionChip {
  const c = { code, label: '', since: new Date(since).toISOString() };
  return { ...c, label: chipText(c, now) };
}

/** A chip that counts down to `until` (ms), with its words as of `now`. */
export function untilChip(code: ReasonCode, until: number, now: number): AttentionChip {
  const c = { code, label: '', until: new Date(until).toISOString() };
  return { ...c, label: chipText(c, now) };
}

/** $18,500, or $18,500.50 when there are cents. */
export function moneyLabel(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

/** Most telling first: a card shows the first three. */
export const CHIP_ORDER: readonly ReasonCode[] = [
  'value',
  'waiting',
  'ready_to_book',
  'qualified',
  'repeat_customer',
  'came_in_today',
  'not_contacted',
  'handed_off',
  'last_contact',
  'no_contact',
  'follow_up_overdue',
  'no_next_action',
  'next_action',
  'starts_in',
  'asked_to_confirm',
  'draft',
  'approval',
  'expires_in',
  'overdue',
  'stage',
  'not_a_fit',
];

/** Chips in CHIP_ORDER, one per code (the first of each wins). */
export function sortChips(chips: readonly AttentionChip[]): AttentionChip[] {
  const seen = new Set<ReasonCode>();
  const unique = chips.filter((c) => !seen.has(c.code) && seen.add(c.code));
  return unique.sort((a, b) => CHIP_ORDER.indexOf(a.code) - CHIP_ORDER.indexOf(b.code));
}
