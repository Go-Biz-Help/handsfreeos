/**
 * The usage rate card (Milestone 16, "The wallet"): what a text, a minute of talking, a phone number, a
 * million AI tokens or the AI's hearing and speaking costs a business. Pure and browser-safe, so the same rate reads the same on the usage page,
 * in the ledger and in the worker that prices an event.
 *
 * **The shape lives here; the numbers live in the database.** `platform.usage_rates` is a table and not a
 * constant for three reasons: the carriers change their prices without asking, `/admin` has to be able to edit
 * ours with an audit trail, and the `markup_bp` and `rate_card_version` stamped on every ledger row are what
 * make a mid-month price change honest rather than retroactive. What stays in code is the set of keys and their
 * units — `USAGE_KEYS` is check-constrained in SQL and a parity test keeps the two identical, the same
 * arrangement `ATTENTION_KINDS` has.
 *
 * **Two currencies, one rounding step.** Our cost is in **micro-dollars**, because a text segment costs $0.0079
 * and an AI input token $0.000003 and cents cannot hold either. What a business is charged is in **cents**. The
 * rule everything here follows: *card in micros, ledger in cents, round once per event, never per part*.
 * Rounding three segments separately and adding them up loses a penny a message, and rounding an AI request's
 * four token buckets separately loses one four times. `priceEvent` is the only place the rounding happens, and
 * `priceOf` is the one-part case of it.
 */
import { roundHalfUp } from './totals';

/** A million micro-dollars is a dollar; a hundred cents is too, so a cent is ten thousand micros. */
const MICROS_PER_CENT = 10_000;
/** 100% in basis points, as everywhere else in the money core. */
const BP_SCALE = 10_000;

/**
 * Everything a business can be charged for. A key names the thing **and the direction**, because inbound and
 * outbound cost us different amounts and a card that blurs them cannot be checked against a carrier's invoice.
 *
 * Speech (Deepgram) was once left out as too cheap to meter. It isn't any more: talking out loud and the AI
 * answering calls live use far more of it than transcripts did, so every use is tallied and billed at 1.5×, in
 * running totals rather than per clip, because one sentence costs a small fraction of a cent.
 */
export const USAGE_KEYS = [
  // ---------- phone numbers, per month ----------
  'number.local.month',
  'number.tollfree.month',
  // ---------- texts, per segment or per picture ----------
  'sms.outbound.segment',
  'sms.inbound.segment',
  'mms.outbound.message',
  'mms.inbound.message',
  // ---------- talking, per minute ----------
  'voice.outbound.minute',
  'voice.inbound.local.minute',
  'voice.inbound.tollfree.minute',
  // ---------- the AI, per million tokens ----------
  // All four buckets are priced apart. A cache read is about a tenth of an input token and a cache write about
  // a quarter more than one, so a card with only input and output is wrong by roughly twice in one direction or
  // the other, depending on how much of its context the teammate re-reads.
  'ai.input.mtok',
  'ai.output.mtok',
  'ai.cache_read.mtok',
  'ai.cache_write.mtok',
  // ---------- the AI's hearing and voice (Deepgram) ----------
  /** Listening live while the AI teammate is on a phone call, per minute of the call. */
  'speech.live.minute',
  /**
   * Turning a recording into words, per minute of audio: talking out loud to the Assistant or on a test call,
   * and call and voicemail transcripts (each side of a two-sided recording counts).
   */
  'speech.recording.minute',
  /** The AI speaking, per thousand characters it says: on calls, and when talking out loud. */
  'speech.voice.kchar',
  /**
   * A model with no line of its own. Deliberately dear: a new model has to be priced on purpose, and a card
   * that silently bills an unknown one at nothing is how a month of AI goes out free.
   */
  'ai.unknown.mtok',
] as const;
export type UsageKey = (typeof USAGE_KEYS)[number];

export const isUsageKey = (value: unknown): value is UsageKey =>
  typeof value === 'string' && (USAGE_KEYS as readonly string[]).includes(value);

/** What a quantity counts. The unit is the card's, not the caller's: passing minutes for an `mtok` key is a bug. */
export const USAGE_UNITS = ['month', 'segment', 'message', 'minute', 'mtok', 'kchar'] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

export const USAGE_KEY_UNITS: Readonly<Record<UsageKey, UsageUnit>> = {
  'number.local.month': 'month',
  'number.tollfree.month': 'month',
  'sms.outbound.segment': 'segment',
  'sms.inbound.segment': 'segment',
  'mms.outbound.message': 'message',
  'mms.inbound.message': 'message',
  'voice.outbound.minute': 'minute',
  'voice.inbound.local.minute': 'minute',
  'voice.inbound.tollfree.minute': 'minute',
  'ai.input.mtok': 'mtok',
  'ai.output.mtok': 'mtok',
  'ai.cache_read.mtok': 'mtok',
  'ai.cache_write.mtok': 'mtok',
  'speech.live.minute': 'minute',
  'speech.recording.minute': 'minute',
  'speech.voice.kchar': 'kchar',
  'ai.unknown.mtok': 'mtok',
};

/**
 * How a length is rounded up before it is priced. Twilio bills voice **per whole minute**, so a 20-second call
 * is a minute to us and has to be a minute to the business too; everything else is billed for what it was.
 */
export const ROUND_UP_TO = ['none', 'minute', 'six_seconds'] as const;
export type RoundUpTo = (typeof ROUND_UP_TO)[number];

/** One live line of the card. `costMicros` is what we pay for one `unit`; `markupBp` is what we add to it. */
export interface UsageRate {
  readonly key: UsageKey;
  readonly unit: UsageUnit;
  /** Our own cost for one unit, in micro-dollars. */
  readonly costMicros: number;
  /** 15000 is 1.5×. Never below 10000, which is the "never below cost" guarantee, checked in SQL too. */
  readonly markupBp: number;
  /**
   * The least one **event** may be charged. This is what keeps the 1.5× promise on things that cost less than a
   * cent: an inbound text costs us 0.83¢, so 1.5× of it is 1.2¢, and a cent would be under the promise while
   * two cents is over it. Cents can't hold 1.2, so the floor decides.
   */
  readonly minChargeCents: number;
  readonly roundUpTo: RoundUpTo;
}

/** The card as the worker and the pages hold it: every key, at one version. */
export interface RateCard {
  readonly version: number;
  readonly rates: Readonly<Record<UsageKey, UsageRate>>;
}

/** The least markup any line may carry: 1.0×. Below this we would be paying for a business to use the phone. */
export const MARKUP_FLOOR_BP = 10_000;
/** What a new line gets when nobody says otherwise: 1.5×. */
export const MARKUP_DEFAULT_BP = 15_000;

/**
 * A length rounded the way the carrier rounds it. Seconds in, seconds out — the caller turns seconds into
 * minutes afterwards, so the rounding and the conversion are never done twice or in the wrong order.
 */
export function roundedSeconds(seconds: number, roundUpTo: RoundUpTo): number {
  const s = Math.max(0, finite(seconds));
  if (roundUpTo === 'minute') return Math.ceil(s / 60) * 60;
  if (roundUpTo === 'six_seconds') return Math.ceil(s / 6) * 6;
  return s;
}

/** One part of an event: a key and how much of it. Quantities may be fractional (1,300 tokens is 0.0013 mtok). */
export interface UsagePart {
  readonly key: UsageKey;
  readonly quantity: number;
}

export interface Priced {
  /** What the business is charged, in cents. At least the dearest part's `minChargeCents` when anything was used. */
  readonly amountCents: number;
  /** What it cost us, in cents, before the markup — the number the margin column is checked against. */
  readonly costCents: number;
  /**
   * Stamped on the ledger row so a price change later cannot rewrite what this event was charged at. For an
   * event of several parts it is the markup actually realised across them, which is what a margin check needs.
   */
  readonly markupBp: number;
}

/**
 * What one **event** costs a business: one message, one call, one AI request. Several parts are summed in micros
 * and rounded once at the end, which is the whole point — an AI request's four token buckets rounded apart would
 * lose a penny four times, and every one of those pennies is in the same direction.
 */
export function priceEvent(card: RateCard, parts: readonly UsagePart[]): Priced {
  let costMicros = 0;
  let chargeMicros = 0;
  let floorCents = 0;
  let used = false;
  for (const part of parts) {
    const rate = card.rates[part.key];
    if (!rate) throw new Error(`The rate card has no line for ${part.key}`);
    const q = Math.max(0, finite(part.quantity));
    if (q <= 0) continue;
    used = true;
    costMicros += rate.costMicros * q;
    chargeMicros += (rate.costMicros * q * rate.markupBp) / BP_SCALE;
    floorCents = Math.max(floorCents, rate.minChargeCents);
  }
  if (!used) return { amountCents: 0, costCents: 0, markupBp: markupOf(parts, card) };
  const costCents = roundHalfUp(costMicros / MICROS_PER_CENT);
  const amountCents = Math.max(roundHalfUp(chargeMicros / MICROS_PER_CENT), floorCents);
  // The realised markup, not the card's: the floor and the rounding both move it, and the ledger should record
  // what actually happened rather than what the card intended.
  const markupBp =
    costMicros > 0 ? Math.round((amountCents * MICROS_PER_CENT * BP_SCALE) / costMicros) : 0;
  return { amountCents, costCents, markupBp };
}

/** The one-part case: `priceOf(card, 'sms.outbound.segment', 3)` is one three-segment message. */
export const priceOf = (card: RateCard, key: UsageKey, quantity: number): Priced =>
  priceEvent(card, [{ key, quantity }]);

/** What a line charges for one unit, in cents, for "a text is 2¢" on the usage page. Never our own cost. */
export const unitPriceCents = (card: RateCard, key: UsageKey): number =>
  priceOf(card, key, 1).amountCents;

/** The markup realised on a key over a period: 1.5 means we charged one and a half times what we paid. */
export const realisedMarkup = (chargedCents: number, costCents: number): number | null =>
  costCents > 0 ? chargedCents / costCents : null;

/** The card's own markup for a single-part event, so a zero-quantity row still records what it would have been. */
const markupOf = (parts: readonly UsagePart[], card: RateCard): number =>
  parts.length === 1 ? (card.rates[parts[0]!.key]?.markupBp ?? 0) : 0;

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

/**
 * The prices the card is seeded with. Our cost is Twilio's and Anthropic's US list price as of September 2026;
 * what we charge is 1.5× rounded up to something a person can read, which is why the markups are not all 15000.
 * The seed lives here rather than only in SQL so `priceOf`'s tests and the migration cannot drift apart, and so
 * a reader can see the whole card in one place.
 *
 * These are **list** prices and a guess until the shadow week (rollout step 3) measures the real ones against
 * Chris's own invoice. The margin column in `/admin` is what tells us afterwards whether any of them are wrong.
 */
export const SEED_RATES: readonly {
  readonly key: UsageKey;
  readonly costMicros: number;
  readonly markupBp: number;
  readonly minChargeCents: number;
  readonly roundUpTo: RoundUpTo;
  readonly notes: string;
}[] = [
  {
    key: 'number.local.month',
    costMicros: 1_150_000,
    markupBp: 17_391,
    minChargeCents: 0,
    roundUpTo: 'none',
    notes: 'Twilio local number, $1.15 a month. Charged $2.00.',
  },
  {
    key: 'number.tollfree.month',
    costMicros: 2_150_000,
    markupBp: 16_279,
    minChargeCents: 0,
    roundUpTo: 'none',
    notes: 'Twilio toll-free number, $2.15 a month. Charged $3.50.',
  },
  {
    key: 'sms.outbound.segment',
    costMicros: 10_900,
    markupBp: 18_349,
    minChargeCents: 2,
    roundUpTo: 'none',
    notes: 'Twilio $0.0079 plus about $0.003 of carrier pass-through. Charged 2¢ a segment.',
  },
  {
    key: 'sms.inbound.segment',
    costMicros: 8_300,
    markupBp: 18_072,
    minChargeCents: 2,
    roundUpTo: 'none',
    notes: 'Twilio inbound SMS, $0.0083. Charged 1.5¢ a segment, and never under 2¢ a message.',
  },
  {
    key: 'mms.outbound.message',
    costMicros: 32_000,
    markupBp: 15_625,
    minChargeCents: 5,
    roundUpTo: 'none',
    notes: 'Twilio outbound MMS, about $0.032 with the carrier fee. Charged 5¢.',
  },
  {
    key: 'mms.inbound.message',
    costMicros: 16_500,
    markupBp: 18_182,
    minChargeCents: 3,
    roundUpTo: 'none',
    notes: 'Twilio inbound MMS, $0.0165. Charged 3¢.',
  },
  {
    key: 'voice.outbound.minute',
    costMicros: 13_000,
    markupBp: 15_385,
    minChargeCents: 2,
    roundUpTo: 'minute',
    notes: 'Twilio outbound voice, $0.013 a minute, billed per whole minute. Charged 2¢.',
  },
  {
    key: 'voice.inbound.local.minute',
    costMicros: 8_500,
    markupBp: 17_647,
    minChargeCents: 2,
    roundUpTo: 'minute',
    notes:
      'Twilio inbound to a local number, $0.0085 a minute. Charged 1.5¢; recording is folded in.',
  },
  {
    key: 'voice.inbound.tollfree.minute',
    costMicros: 22_000,
    markupBp: 15_909,
    minChargeCents: 4,
    roundUpTo: 'minute',
    notes:
      'Twilio inbound to a toll-free number, $0.022 a minute. Charged 3.5¢, never under 4¢ a call.',
  },
  {
    key: 'ai.input.mtok',
    costMicros: 2_000_000,
    markupBp: 15_000,
    minChargeCents: 0,
    roundUpTo: 'none',
    notes: 'claude-sonnet-5 input, $2.00 a million tokens. Charged $3.00.',
  },
  {
    key: 'ai.output.mtok',
    costMicros: 10_000_000,
    markupBp: 15_000,
    minChargeCents: 0,
    roundUpTo: 'none',
    notes: 'claude-sonnet-5 output, $10.00 a million tokens. Charged $15.00.',
  },
  {
    key: 'ai.cache_read.mtok',
    costMicros: 200_000,
    markupBp: 15_000,
    minChargeCents: 0,
    roundUpTo: 'none',
    notes: 'claude-sonnet-5 cache read, a tenth of input. Charged $0.30.',
  },
  {
    key: 'ai.cache_write.mtok',
    costMicros: 2_500_000,
    markupBp: 15_000,
    minChargeCents: 0,
    roundUpTo: 'none',
    notes: 'claude-sonnet-5 cache write, a quarter more than input. Charged $3.75.',
  },
  {
    key: 'speech.live.minute',
    costMicros: 9_200,
    markupBp: 15_000,
    minChargeCents: 2,
    roundUpTo: 'none',
    notes:
      'Deepgram Nova-3 streaming, English and Spanish, $0.0092 a minute. Charged 1.38¢, billed in running totals.',
  },
  {
    key: 'speech.recording.minute',
    costMicros: 5_200,
    markupBp: 15_000,
    minChargeCents: 1,
    roundUpTo: 'none',
    notes:
      'Deepgram Nova-3 pre-recorded, English and Spanish, $0.0052 a minute. Charged 0.78¢, billed in running totals.',
  },
  {
    key: 'speech.voice.kchar',
    costMicros: 30_000,
    markupBp: 15_000,
    minChargeCents: 1,
    roundUpTo: 'none',
    notes: 'Deepgram Aura 2, $0.030 per 1,000 characters. Charged 4.5¢, billed in running totals.',
  },
  {
    key: 'ai.unknown.mtok',
    costMicros: 15_000_000,
    markupBp: 15_000,
    minChargeCents: 0,
    roundUpTo: 'none',
    notes:
      'A model with no line of its own: priced high on purpose, so one gets noticed and added.',
  },
];

/** The seed as a card: for tests, the local seed, and anything needing a card before the database has one. */
export const SEED_CARD: RateCard = {
  version: 1,
  rates: Object.fromEntries(
    SEED_RATES.map((r) => [
      r.key,
      {
        key: r.key,
        unit: USAGE_KEY_UNITS[r.key],
        costMicros: r.costMicros,
        markupBp: r.markupBp,
        minChargeCents: r.minChargeCents,
        roundUpTo: r.roundUpTo,
      },
    ]),
  ) as Record<UsageKey, UsageRate>,
};
