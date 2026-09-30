/**
 * A deal's terms as they stand (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Terms and their history"): each key
 * date, amount or word typed in is an entry that never changes, with where it came from and who confirmed it. An
 * amendment or correction supersedes the entry it replaces; two live entries that disagree are a conflict that waits
 * for a person, and nothing that rests on that term counts as confirmed until one is kept (Chris, 2026-09-30).
 * Browser-safe and pure: the commands, the screens and the Assistant all read these.
 */
import { parseClock, parseLocalDate } from '../../calendar/engine/zoned';
import { clockOfMinutes, fmtMonthDay } from '../../calendar/when';
import { money } from '../../money/format';
import { KEY_DATES, type KeyDateKey, type KeyDates, type TermSource } from './dates/key-dates';
import type { DealSide } from './states';

export interface TermDef {
  readonly label: string;
  readonly sides: readonly DealSide[];
  /** Set by the purchase contract or its amendments; the contract's end sets them aside. */
  readonly contract: boolean;
}

/** Amounts, in cents. */
export const MONEY_TERMS = {
  price: { label: 'Purchase price', sides: ['buyer', 'listing'], contract: true },
  list_price: { label: 'List price', sides: ['listing'], contract: false },
  emd_amount: { label: 'Earnest money', sides: ['buyer', 'listing'], contract: true },
  loan_amount: { label: 'Loan amount', sides: ['buyer', 'listing'], contract: true },
  seller_credit: { label: 'Seller credit', sides: ['buyer', 'listing'], contract: true },
} as const satisfies Record<string, TermDef>;
export type MoneyTermKey = keyof typeof MONEY_TERMS;

/** Words. */
export const TEXT_TERMS = {
  loan_type: { label: 'Loan type', sides: ['buyer', 'listing'], contract: true },
  emd_holder: { label: 'Earnest money held by', sides: ['buyer', 'listing'], contract: true },
} as const satisfies Record<string, TermDef>;
export type TextTermKey = keyof typeof TEXT_TERMS;

export type TermKey = KeyDateKey | MoneyTermKey | TextTermKey;
export type TermKind = 'date' | 'money' | 'text';

const ALL: Readonly<Record<string, TermDef & { readonly kind: TermKind }>> = {
  ...Object.fromEntries(Object.entries(KEY_DATES).map(([k, d]) => [k, { ...d, kind: 'date' }])),
  ...Object.fromEntries(Object.entries(MONEY_TERMS).map(([k, d]) => [k, { ...d, kind: 'money' }])),
  ...Object.fromEntries(Object.entries(TEXT_TERMS).map(([k, d]) => [k, { ...d, kind: 'text' }])),
};

export const TERM_KEYS = Object.keys(ALL) as [TermKey, ...TermKey[]];
export const isTermKey = (key: string): key is TermKey => key in ALL;
export const termDef = (key: TermKey): TermDef & { readonly kind: TermKind } => ALL[key]!;
export const termKind = (key: TermKey): TermKind => ALL[key]!.kind;
export const termLabel = (key: TermKey): string => ALL[key]!.label;
/** Whether a deal of this side has the term at all. */
export const termOnSide = (key: TermKey, side: DealSide): boolean =>
  (ALL[key]!.sides as readonly string[]).includes(side);

/** One entry, as stored. */
export interface TermEntry {
  readonly id: string;
  readonly key: TermKey;
  readonly valueDate: string | null;
  readonly valueTime: string | null;
  readonly valueCents: number | null;
  readonly valueText: string | null;
  readonly source: TermSource;
  readonly enteredAt: string;
  readonly confirmedAt: string | null;
  readonly supersededAt: string | null;
  readonly rejectedAt: string | null;
}

/** Still counts: neither replaced nor set aside. */
export const isLive = (e: {
  readonly supersededAt: string | Date | null;
  readonly rejectedAt: string | Date | null;
}): boolean => e.supersededAt === null && e.rejectedAt === null;

/** Two entries say the same thing. */
export const sameValue = (
  a: Pick<TermEntry, 'valueDate' | 'valueTime' | 'valueCents' | 'valueText'>,
  b: Pick<TermEntry, 'valueDate' | 'valueTime' | 'valueCents' | 'valueText'>,
): boolean =>
  a.valueDate === b.valueDate &&
  (a.valueTime ?? null) === (b.valueTime ?? null) &&
  a.valueCents === b.valueCents &&
  (a.valueText ?? null) === (b.valueText ?? null);

/** A term as it stands now. */
export interface TermNow<E extends TermEntry = TermEntry> {
  readonly key: TermKey;
  /** The entry that counts: the newest live one, when every live one agrees. Null while in conflict or empty. */
  readonly current: E | null;
  /** Every live entry, newest first: two or more that disagree are a conflict. */
  readonly live: readonly E[];
  readonly conflict: boolean;
  /** A person confirmed it, and nothing disagrees. */
  readonly confirmed: boolean;
}

/** Each term with at least one entry, as it stands. */
export function termsNow<E extends TermEntry>(
  entries: readonly E[],
): ReadonlyMap<TermKey, TermNow<E>> {
  const byKey = new Map<TermKey, E[]>();
  for (const e of entries) {
    if (!isLive(e)) continue;
    byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  }
  const out = new Map<TermKey, TermNow<E>>();
  for (const [key, list] of byKey) {
    const live = [...list].sort((a, b) =>
      a.enteredAt === b.enteredAt
        ? b.id.localeCompare(a.id)
        : b.enteredAt.localeCompare(a.enteredAt),
    );
    const conflict = live.some((e) => !sameValue(e, live[0]!));
    out.set(key, {
      key,
      current: conflict ? null : live[0]!,
      live,
      conflict,
      confirmed: !conflict && live.some((e) => e.confirmedAt !== null),
    });
  }
  return out;
}

/**
 * The deal's key dates for working out due times. A date in conflict still gives its newest value, never confirmed,
 * so a duty resting on it shows when it would be due and waits for a person to settle it.
 */
export function keyDatesOf(terms: ReadonlyMap<TermKey, TermNow>): KeyDates {
  const out: Partial<Record<KeyDateKey, KeyDates[KeyDateKey]>> = {};
  for (const [key, t] of terms) {
    if (termKind(key) !== 'date') continue;
    const e = t.current ?? t.live[0];
    if (!e?.valueDate) continue;
    out[key as KeyDateKey] = {
      date: e.valueDate,
      time: e.valueTime,
      source: e.source,
      confirmed: t.confirmed,
    };
  }
  return out;
}

/** An amount that counts, or null. */
export const moneyOf = (terms: ReadonlyMap<TermKey, TermNow>, key: MoneyTermKey): number | null =>
  terms.get(key)?.current?.valueCents ?? null;

/** The keys in conflict, in the catalogue's order. */
export const conflictsOf = (terms: ReadonlyMap<TermKey, TermNow>): TermKey[] =>
  TERM_KEYS.filter((k) => terms.get(k)?.conflict);

/** A value as a sentence says it: "Oct 30, 2026 at 5:00 PM", "$412,500.00", or the words. */
export function termValueWords(
  e: Pick<TermEntry, 'valueDate' | 'valueTime' | 'valueCents' | 'valueText'>,
): string {
  if (e.valueDate) {
    const date = `${fmtMonthDay(e.valueDate)}, ${parseLocalDate(e.valueDate).year}`;
    return e.valueTime ? `${date} at ${clockOfMinutes(parseClock(e.valueTime))}` : date;
  }
  if (e.valueCents !== null) return money(e.valueCents);
  return e.valueText ?? '';
}
