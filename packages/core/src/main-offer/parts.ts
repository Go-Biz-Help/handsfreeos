/**
 * The business's main offer (HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md, Part 1): what's in one, what it takes to
 * publish one, and the AI's score. Browser-safe: the builder checks each part with the same schema the save holds to.
 *
 * It follows the "20 Bookings Per Month" workbook's six parts (who, outcome, timeframe, method, guarantee, price),
 * after a niche finder, with proof beside them. Not the promotions under Knowledge (`offer.*`, `app.offers`).
 */
import { z } from 'zod';

const words = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max.toLocaleString('en-US')} characters.`);

/** How long each part may be. The builder's boxes use the same numbers. */
export const MAIN_OFFER_LIMITS = {
  /** A short answer: a line of work, a size, a price. */
  short: 160,
  /** A sentence or two: the problem, why it matters, the guarantee. */
  long: 800,
  /** One step of the method. */
  step: 160,
  /** The method's steps: 3 to 5 to publish. */
  steps: 5,
  /** One real result, in a line. */
  proofLine: 300,
  proof: 10,
  /** The one-line offer. */
  line: 1200,
  /** The outcome and the guarantee in a few words each, for messages. */
  inAFewWords: 120,
  /** The owner's direction for the whole offer. */
  direction: 2000,
  /** A note to the AI on one part, for the next try. */
  note: 500,
} as const;

const L = MAIN_OFFER_LIMITS;

/** Every part of the offer. A draft may have any of it; publishing needs what `missingParts` lists. */
export const MainOfferParts = z.object({
  /** The niche finder, before the offer: the best customer ever, and who looks just like them. */
  niche: z
    .object({
      bestCustomer: words(L.long),
      theirWork: words(L.short),
      theirSize: words(L.short),
      result: words(L.long),
      howLong: words(L.short),
      lookalikes: words(L.long),
    })
    .partial()
    .default({}),
  who: z
    .object({
      /** The line of work, specific: "Roofers". */
      work: words(L.short),
      /** The slice of it, by its problem or its size: "with 2 to 3 crews, stuck on referrals". */
      slice: words(L.short),
      /** Their size or revenue: "$500k to $2M a year". */
      size: words(L.short),
      /** The single most painful problem they have. */
      problem: words(L.long),
    })
    .partial()
    .default({}),
  outcome: z
    .object({
      /** The result, measurable: "10 to 20 booked roof inspections a month". */
      result: words(L.long),
      /** How it's measured. */
      measure: words(L.long),
      /** Why it matters to them. */
      why: words(L.long),
    })
    .partial()
    .default({}),
  timeframe: z
    .object({
      /** How long it usually takes: "60 days". */
      typical: words(L.short),
      why: words(L.long),
    })
    .partial()
    .default({}),
  method: z
    .object({
      steps: z
        .array(words(L.step).min(1, 'Write the step, or take it out.'))
        .max(L.steps, `Keep it to ${L.steps} steps.`),
      /** What's different about it compared with others who do the same. */
      different: words(L.long),
    })
    .partial()
    .default({}),
  guarantee: z
    .object({
      /** What's promised if it doesn't work. */
      promise: words(L.long),
      /** When it applies. */
      when: words(L.long),
      /** Who qualifies, so bad fits don't hold the business to it. */
      qualifies: words(L.long),
    })
    .partial()
    .default({}),
  price: z
    .object({
      amount: words(L.short),
      /** Flat, setup plus monthly, per result. */
      structure: words(L.long),
      /** Why it's worth it from the customer's side, with the math. */
      value: words(L.long),
    })
    .partial()
    .default({}),
  /** Real results for real customers, a line each. Never invented. */
  proof: z
    .array(words(L.proofLine).min(1, 'Write the result, or take it out.'))
    .max(L.proof, `Keep it to ${L.proof} results.`)
    .default([]),
  /** "We help [who] get [outcome] within [timeframe] using [method]. If [guarantee]. [Price]." */
  line: words(L.line).optional(),
  /** The outcome and guarantee in a few words each, for messages. Messages never carry the price. */
  inAFewWords: z
    .object({ outcome: words(L.inAFewWords), guarantee: words(L.inAFewWords) })
    .partial()
    .default({}),
});
export type MainOfferParts = z.infer<typeof MainOfferParts>;

/** The six parts the AI scores, in the workbook's order. */
export const SCORED_PARTS = [
  'who',
  'outcome',
  'timeframe',
  'method',
  'guarantee',
  'price',
] as const;
export type ScoredPart = (typeof SCORED_PARTS)[number];

export const SCORED_PART_LABELS: Record<ScoredPart, string> = {
  who: 'Who',
  outcome: 'Outcome',
  timeframe: 'Timeframe',
  method: 'Method',
  guarantee: 'Guarantee',
  price: 'Price',
};

/** The score every part needs before the offer is ready to use (the owner's answer, 2026-10-14). */
export const MAIN_OFFER_BAR = 7;

/** A line on what's working or what's holding a part back. */
const scoreLine = words(200).min(1);

/**
 * One part's score: the number, a line on why, and, since tries came in, what's working, what's holding it back and
 * the fix for it. Scores kept before then have none of those, so each is optional.
 */
const partScore = z.object({
  score: z.int().min(1).max(10),
  why: words(300),
  good: z.array(scoreLine).max(3).optional(),
  holding: z.array(scoreLine).max(3).optional(),
  fix: words(300).min(1).optional(),
  /** True when the owner's direction changed how the part was judged ("Scored with your direction"). */
  followedDirection: z.boolean().optional(),
});

/** The AI's score of an offer: each part, the weakest and its fix, and the video's checks. */
export const MainOfferScore = z.object({
  parts: z.object({
    who: partScore,
    outcome: partScore,
    timeframe: partScore,
    method: partScore,
    guarantee: partScore,
    price: partScore,
  }),
  weakest: z.enum(SCORED_PARTS),
  /** What to change first, in a sentence or two. */
  fix: words(600),
  /** The three ways offers fail: nothing to grab onto, sounds like everyone, or a big promise with nothing behind it. */
  flags: z.object({ vague: z.boolean(), generic: z.boolean(), hardToBelieve: z.boolean() }),
  /** Whether a stranger could see the outcome in three seconds. */
  threeSeconds: z.boolean(),
});
export type MainOfferScore = z.infer<typeof MainOfferScore>;

/** Whether every part clears the bar. */
export function clearsBar(score: MainOfferScore): boolean {
  return SCORED_PARTS.every((p) => score.parts[p].score >= MAIN_OFFER_BAR);
}

/** The lowest part's score, for lists of versions and tries. */
export function lowestScore(score: MainOfferScore): number {
  return Math.min(...SCORED_PARTS.map((p) => score.parts[p].score));
}

/** The owner's direction for the whole offer: what it really is, who it's for, what to lead with. */
export const MainOfferDirection = words(MAIN_OFFER_LIMITS.direction);

/** A note to the AI on a part, for the next try. */
const note = words(MAIN_OFFER_LIMITS.note);

/** The owner's notes to the AI, by part. A part with no note isn't there. */
export const MainOfferNotes = z
  .object({
    who: note,
    outcome: note,
    timeframe: note,
    method: note,
    guarantee: note,
    price: note,
  })
  .partial()
  .default({});
export type MainOfferNotes = z.infer<typeof MainOfferNotes>;

/** The parts a try leaves exactly as the draft has them (Keep this part as is). */
export const MainOfferKeep = z.array(z.enum(SCORED_PARTS)).max(SCORED_PARTS.length).default([]);

/** For each scored part, why a try changed it, in a sentence; null for a part it left as it was. */
export const MainOfferTryWhy = z.object({
  who: words(300).nullable(),
  outcome: words(300).nullable(),
  timeframe: words(300).nullable(),
  method: words(300).nullable(),
  guarantee: words(300).nullable(),
  price: words(300).nullable(),
});
export type MainOfferTryWhy = z.infer<typeof MainOfferTryWhy>;

const tidy = (v: unknown): unknown =>
  typeof v === 'string'
    ? v.trim()
    : Array.isArray(v)
      ? v.map(tidy).filter((x) => x !== '')
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .map(([k, x]) => [k, tidy(x)] as const)
              .filter(([, x]) => x !== '' && x !== undefined),
          )
        : v;

/** Whether a scored part says the same in two offers, empty boxes and spaces aside. */
export function samePart(a: MainOfferParts, b: MainOfferParts, part: ScoredPart): boolean {
  return JSON.stringify(tidy(a[part])) === JSON.stringify(tidy(b[part]));
}

/** Whether two offers say the same: the six scored parts, the one line and the few words for messages. */
export function sameOffer(a: MainOfferParts, b: MainOfferParts): boolean {
  return (
    SCORED_PARTS.every((p) => samePart(a, b, p)) &&
    (a.line ?? '').trim() === (b.line ?? '').trim() &&
    JSON.stringify(tidy(a.inAFewWords)) === JSON.stringify(tidy(b.inAFewWords))
  );
}

/** The draft with the picked parts taken from a try; everything else as the draft has it. */
export function withPartsFrom(
  draft: MainOfferParts,
  from: MainOfferParts,
  take: readonly ScoredPart[],
): MainOfferParts {
  const next: MainOfferParts = { ...draft };
  for (const part of SCORED_PARTS)
    if (take.includes(part)) Object.assign(next, { [part]: from[part] });
  return next;
}

/** The parts under the bar, lowest first, in the workbook's order when they tie. */
export function underBar(score: MainOfferScore): ScoredPart[] {
  return SCORED_PARTS.filter((p) => score.parts[p].score < MAIN_OFFER_BAR).sort(
    (a, b) => score.parts[a].score - score.parts[b].score,
  );
}

/** One thing a draft still needs before it can be published. */
export interface MissingPart {
  /** The box it's in, as `MainOfferParts` names it: `who.work`, `method.steps`. */
  readonly path: string;
  /** "Who: the line of work". */
  readonly label: string;
}

const filled = (v: string | undefined) => !!v?.trim();

/** What a draft needs before it can go live, in the builder's order. Empty when it's complete. */
export function missingParts(parts: MainOfferParts): MissingPart[] {
  const missing: MissingPart[] = [];
  const need = (ok: boolean, path: string, label: string) => {
    if (!ok) missing.push({ path, label });
  };
  need(filled(parts.who.work), 'who.work', 'Who: the line of work');
  need(filled(parts.who.problem), 'who.problem', 'Who: their most painful problem');
  need(filled(parts.outcome.result), 'outcome.result', 'Outcome: the result');
  need(filled(parts.timeframe.typical), 'timeframe.typical', 'Timeframe: how long it takes');
  need(
    (parts.method.steps?.filter(filled).length ?? 0) >= 3,
    'method.steps',
    'Method: 3 to 5 steps',
  );
  need(filled(parts.guarantee.promise), 'guarantee.promise', 'Guarantee: what you promise');
  need(filled(parts.price.amount), 'price.amount', 'Price: what it costs');
  need(filled(parts.line), 'line', 'Your offer in one line');
  need(
    filled(parts.inAFewWords.outcome),
    'inAFewWords.outcome',
    'The outcome in a few words, for messages',
  );
  need(
    filled(parts.inAFewWords.guarantee),
    'inAFewWords.guarantee',
    'The guarantee in a few words, for messages',
  );
  return missing;
}

/** "Who: the line of work, and Price: what it costs", for the words when a draft can't go live yet. */
export function missingWords(missing: readonly MissingPart[]): string {
  const labels = missing.map((m) => m.label);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/**
 * The one-line offer from its parts, as the workbook writes it, for the builder to start from: "We help roofers
 * with 2 to 3 crews get 10 to 20 booked inspections a month within 60 days using …. If …. $2,000 a month."
 */
export function offerLineFrom(parts: MainOfferParts): string {
  const who = [parts.who.work, parts.who.slice].filter(filled).join(' ');
  const steps = (parts.method.steps ?? []).filter(filled);
  const sentence = (text: string | undefined) => {
    const t = text?.trim() ?? '';
    if (!t) return '';
    return /[.!?]$/.test(t) ? t : `${t}.`;
  };
  const first = [
    who ? `We help ${who}` : 'We help',
    filled(parts.outcome.result) ? ` get ${parts.outcome.result!.trim()}` : '',
    filled(parts.timeframe.typical) ? ` within ${parts.timeframe.typical!.trim()}` : '',
    steps.length ? ` using ${steps.join(', ')}` : '',
  ].join('');
  return [sentence(first), sentence(parts.guarantee.promise), sentence(parts.price.amount)]
    .filter(Boolean)
    .join(' ');
}

/** What's written in a box of the offer, by its path (`who.work`, `line`); '' when nothing is. Lists aren't boxes. */
export function partWords(parts: MainOfferParts, path: string): string {
  if (path === 'line') return parts.line ?? '';
  const [part, box] = path.split('.') as [string, string | undefined];
  const group = (parts as Record<string, unknown>)[part];
  if (!box || !group || typeof group !== 'object' || Array.isArray(group)) return '';
  const value = (group as Record<string, unknown>)[box];
  return typeof value === 'string' ? value : '';
}

/** The offer with one box changed, by its path; the rest as it was. */
export function withPart(parts: MainOfferParts, path: string, words: string): MainOfferParts {
  if (path === 'line') return { ...parts, line: words };
  const [part, box] = path.split('.') as [keyof MainOfferParts, string | undefined];
  const group = parts[part];
  if (!box || !group || typeof group !== 'object' || Array.isArray(group)) return parts;
  return { ...parts, [part]: { ...group, [box]: words } };
}

/** What a scored part says, in a line, for the screens that list the offer part by part. */
export function partSays(parts: MainOfferParts, part: ScoredPart): string {
  const join = (...xs: (string | undefined)[]) =>
    xs
      .map((x) => x?.trim())
      .filter(Boolean)
      .join('. ');
  switch (part) {
    case 'who':
      return join(
        [parts.who.work, parts.who.slice].filter((x) => x?.trim()).join(' '),
        parts.who.size,
        parts.who.problem,
      );
    case 'outcome':
      return join(parts.outcome.result, parts.outcome.measure);
    case 'timeframe':
      return join(parts.timeframe.typical, parts.timeframe.why);
    case 'method':
      return (parts.method.steps ?? []).filter((s) => s.trim()).join(' · ');
    case 'guarantee':
      return join(parts.guarantee.promise, parts.guarantee.when, parts.guarantee.qualifies);
    case 'price':
      return join(parts.price.amount, parts.price.value);
  }
}
