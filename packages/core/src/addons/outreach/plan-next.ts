/**
 * A runner's next move, asked of HandsFreeOS (docs/outreach.md decision 195, step 2): the web and phone apps hold the
 * schedule, and the extension does what it's sent. A network's runner says where its day is up to and what only its
 * computer knows (`PlanHere`), and HandsFreeOS answers with the move by the rules (./plan.ts `nextMove`), worked out
 * from its own settings, list, asks, warnings and day. The extension does it, at its own pace and within every limit
 * it keeps today.
 *
 * - **A network at a time** (`PLAN_DECIDES`): Threads and X first, then Alignable, Instagram, LinkedIn, and Facebook
 *   last. For any other, and for a computer that isn't the one that works, the answer is `decides: false`, and the
 *   runner goes on by itself, as it does when HandsFreeOS can't be reached: by the same rules, with what it knows.
 * - **Switched on apart from the build.** A runner that asks (Threads' and X's from `NEXT_SINCE`, Alignable's from
 *   0.157.0, Instagram's from 0.158.0, LinkedIn's from 0.159.0, Facebook's from 0.160.0) is answered
 *   `decides: false` until its network is in `PLAN_DECIDES`: the build goes out first, and a day's plan is checked
 *   against what a working computer really did before HandsFreeOS decides there.
 * - **Its own clock.** A runner's times are on its computer's clock. HandsFreeOS works the move out on its own
 *   (`now` says how far apart the two are) and sends each time back on the runner's.
 * - **A piece of the list's work** comes with today's list, as `outreach.today` gives it, so the runner asks once.
 *
 * Kept apart from ./plan.ts so the extension, which reads only the types here, never carries the list's whole schema.
 */
import { z } from 'zod';
import { LIST_SAVE_KEYS } from './lists';
import { PLATFORM_KEYS, type Platform } from './networks';
import { PlanState, type PlanDay, type RunnerMove } from './plan';
import { workKey, type PlanItem } from './plan-rules';
import { TodayOutput } from './today';

/**
 * The networks HandsFreeOS decides for: their runner asks for its next move and does it. Taken off here, a runner
 * plans for itself at its next go.
 *
 * None yet. Threads' and X's runners ask from `NEXT_SINCE`, Alignable's from 0.157.0, Instagram's from 0.158.0,
 * LinkedIn's from 0.159.0 and Facebook's from 0.160.0: every network's does now. Each waits to be put here: once the
 * plan HandsFreeOS shows (step 1) has been checked against what a working computer really did over a day.
 */
export const PLAN_DECIDES: readonly Platform[] = [];

/**
 * The first build with a runner that asks and does what it's sent (Threads' and X's): an older one isn't answered.
 * A network whose runner began asking later (Alignable's, 0.157.0; Instagram's, 0.158.0; LinkedIn's, 0.159.0;
 * Facebook's, 0.160.0) needs no gate of its own: an older build's runner there never asks. That holds for a move
 * only a later runner knows too: the helpful post (`post`) and the look for a referral (`refer`) are sent only where
 * the runner does them, and LinkedIn's and Facebook's each began asking with the build that does.
 */
export const NEXT_SINCE = '0.156.0';

/** The first build whose runner asks on each network: an older one there plans its own day, and never asks. */
export const ASKS_SINCE: Readonly<Record<Platform, string>> = {
  threads: NEXT_SINCE,
  x: NEXT_SINCE,
  alignable: '0.157.0',
  instagram: '0.158.0',
  linkedin: '0.159.0',
  facebook: '0.160.0',
};

const ms = z.number().int().min(0).max(8_640_000_000_000_000);
const gap = z.number().int().min(0).max(86_400_000);
const job = z.string().min(1).max(60);

export const PlanNextInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS),
  /** The computer asking: only the one that works is answered. */
  computer: z.uuid(),
  /** Where its day is up to, as `outreach.plan.note` says it. */
  state: PlanState,
  /** Its own clock now, in milliseconds: its state's times are on it, and the answer's come back on it. */
  now: ms,
  /** From 0 to 1, for every wait picked: the runner's own for this go, so a go keeps one pace. */
  random: z.number().min(0).max(1),
  /** What only its computer knows. */
  here: z.object({
    away: z.boolean(),
    passOver: z.array(job).max(30).default([]),
    research: z.boolean().optional(),
    asking: z.boolean().optional(),
  }),
});
export type PlanNextInput = z.input<typeof PlanNextInput>;

const BeforeStep = z.discriminatedUnion('do', [
  z.object({ do: z.literal('save'), list: z.enum(LIST_SAVE_KEYS), first: z.boolean() }),
  z.object({ do: z.literal('group_checks') }),
  z.object({ do: z.literal('tidy') }),
  z.object({ do: z.literal('checks') }),
]);

/** The move, as it's sent: a piece of the list's work by its key (`workKey`), found on the list sent with it. */
export const PlanNextMove = z.discriminatedUnion('do', [
  z.object({
    do: z.literal('wait'),
    why: z.enum(['off', 'stopped', 'warned', 'noting', 'asks', 'hours', 'screen', 'idle']),
    until: ms.nullable(),
  }),
  z.object({ do: z.literal('before'), step: BeforeStep, gap }),
  z.object({ do: z.literal('daily'), job, gap }),
  z.object({ do: z.literal('search'), gap }),
  z.object({ do: z.literal('watch'), gap }),
  /** A look for a referral, or an ask after two, to do for the person (decision 185): Facebook's, from 0.160.0. */
  z.object({ do: z.literal('refer'), gap }),
  /**
   * Today's helpful post, put up on its own where the person lets it (decision 50): LinkedIn's, from 0.159.0, and
   * Facebook's, from 0.160.0.
   */
  z.object({ do: z.literal('post'), gap }),
  z.object({
    do: z.literal('work'),
    key: z.string().min(1).max(400),
    left: z.number().int().min(0),
    gap,
    reading: z.boolean(),
    day: z.object({ started: z.boolean(), until: ms.nullable() }),
    answering: z.boolean(),
  }),
]);
export type PlanNextMove = z.output<typeof PlanNextMove>;

/** What a move leaves changed in the day's state before it's done: only what it changed. */
export const PlanNextChange = z.object({
  replied: z.array(z.string().max(80)).max(50).optional(),
  daily: z.record(job, z.string()).optional(),
  round: z.number().int().min(0).max(50).optional(),
  roundAt: ms.nullable().optional(),
});
export type PlanNextChange = z.output<typeof PlanNextChange>;

export const PlanNextOutput = z.object({
  /** false while HandsFreeOS leaves this network's order to the extension, or to another computer: it plans itself. */
  decides: z.boolean(),
  move: PlanNextMove.nullable(),
  change: PlanNextChange.nullable(),
  /** Today's list, with a piece of its work to do: `outreach.today`'s answer. */
  list: TodayOutput.nullable(),
});
export type PlanNextOutput = z.output<typeof PlanNextOutput>;

/** The answer while HandsFreeOS doesn't decide. */
export const NOT_DECIDING = { decides: false, move: null, change: null, list: null } as const;

/** A time on HandsFreeOS's clock, on the runner's: `skew` is how far HandsFreeOS's is ahead. */
const onTheirs = (at: number | null, skew: number): number | null =>
  at === null ? null : Math.max(0, Math.round(at - skew));

/** A move as it's sent, its times on the runner's clock. */
export function moveSent<I extends PlanItem>(move: RunnerMove<I>, skew: number): PlanNextMove {
  switch (move.do) {
    case 'wait':
      return { do: 'wait', why: move.why, until: onTheirs(move.until, skew) };
    case 'work':
      return {
        do: 'work',
        key: workKey(move.work),
        left: move.left,
        gap: Math.round(move.gap),
        reading: move.reading,
        day: { started: move.day.started, until: onTheirs(move.day.until, skew) },
        answering: move.answering,
      };
    case 'before':
      return { do: 'before', step: move.step, gap: Math.round(move.gap) };
    case 'daily':
      return { do: 'daily', job: move.job, gap: Math.round(move.gap) };
    default:
      return { do: move.do, gap: Math.round(move.gap) };
  }
}

/**
 * What the move changed in the day's state (`nextMove`'s `state` beside what was kept): who still waits for an
 * answer, and a round of finding again begun. Null when nothing did, or when HandsFreeOS's day isn't the runner's
 * (around midnight, with clocks apart): the runner begins its own new day at its next go.
 */
export function changeSent(before: PlanDay, after: PlanDay, skew: number): PlanNextChange | null {
  if (before.day !== after.day) return null;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const change: {
    replied?: string[];
    daily?: Record<string, string>;
    round?: number;
    roundAt?: number | null;
  } = {};
  if (!same(before.replied, after.replied)) change.replied = [...after.replied];
  if (!same(before.daily, after.daily))
    change.daily = Object.fromEntries(
      Object.entries(after.daily).filter((e): e is [string, string] => e[1] !== undefined),
    );
  if (before.round !== after.round) change.round = after.round;
  if (before.roundAt !== after.roundAt) change.roundAt = onTheirs(after.roundAt, skew);
  return Object.keys(change).length ? change : null;
}
