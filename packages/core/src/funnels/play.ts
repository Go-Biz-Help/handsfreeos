/**
 * Trying a funnel as a lead (step 7): a pretend person walks it, and at each fork the steps ask what they do. This
 * works out the path and the times from the definition alone, so the steps and the tests agree, and nothing is
 * sent, booked or moved. Browser-safe.
 *
 * Each stage plays out until something moves them on: the messages due before it go (an "only if" checked against
 * what they'd done by then), and a message whose "only if" the choice settles the other way is shown as skipped.
 * With no choice left, the stage's messages still to come are listed (those with an "only if" as maybes), and the
 * fork is what can move them on from there.
 */
import {
  FUNNEL_EVENTS,
  type FunnelDefinition,
  type FunnelMove,
  type FunnelStage,
} from './definition';
import { funnelMessageDueAt, funnelMessageStale, funnelOnlyIfHolds } from './schedule';
import { funnelMoveCause, type FunnelNames } from './words';

export type FunnelPlayEntry =
  | { readonly kind: 'arrive'; readonly at: number; readonly stageId: string }
  | {
      readonly kind: 'message';
      readonly at: number;
      readonly stageId: string;
      readonly messageId: string;
      /** Shown as "if they still haven't…" because what decides it hasn't been picked yet. */
      readonly maybe: boolean;
    }
  | {
      readonly kind: 'skipped';
      readonly at: number;
      readonly stageId: string;
      readonly messageId: string;
    }
  | { readonly kind: 'did'; readonly at: number; readonly moveId: string; readonly label: string }
  | { readonly kind: 'handoff'; readonly at: number; readonly stageId: string }
  | { readonly kind: 'end'; readonly at: number; readonly stageId: string };

export interface FunnelPlayFork {
  readonly stageId: string;
  /** One per move out of the stage: what they do, and where it takes them. */
  readonly options: readonly {
    readonly moveId: string;
    readonly label: string;
    readonly to: string;
  }[];
}

export interface FunnelPlay {
  readonly entries: readonly FunnelPlayEntry[];
  readonly fork: FunnelPlayFork | null;
  /** Where the pretend lead is now. */
  readonly stageId: string | null;
}

export interface FunnelPlayInput {
  readonly definition: FunnelDefinition;
  readonly names: FunnelNames;
  /** Pipeline stages that end a funnel (won or lost). */
  readonly closedStageIds: ReadonlySet<string>;
  readonly startStageId: string;
  /** When the pretend lead arrives. */
  readonly startAt: number;
  /** Their pretend booking's start (and an hour after is its end). */
  readonly bookingAt: number;
  readonly timeZone: string;
  /** The moves picked so far, one per fork, in order. */
  readonly choices: readonly string[];
}

const MIN = 60_000;
/** A pretend session's length, and how long things take a pretend lead. */
const SESSION_MS = 60 * MIN;

/** When the thing that causes a move happens, for a pretend lead who just reached the stage. */
function happensAt(m: FunnelMove, reachedAt: number, bookingAt: number): number {
  if (m.kind === 'quiet') return reachedAt + m.minutes * MIN;
  if (m.kind === 'reply') return reachedAt + 12 * MIN;
  switch (m.event) {
    case 'attendee.joined':
      return Math.max(reachedAt + MIN, bookingAt - 2 * MIN);
    case 'attendee.attended':
    case 'attendee.no_show':
      return Math.max(reachedAt + MIN, bookingAt + SESSION_MS);
    case 'appointment.booked':
      return reachedAt + 26 * MIN;
    case 'form.submitted':
      return reachedAt + 18 * MIN;
    case 'form.stopped':
      return reachedAt + 40 * MIN;
    default:
      return reachedAt + 10 * MIN;
  }
}

/** The events a move means they did, for later "only if"s at the same stage. */
const didOf = (m: FunnelMove): string | null =>
  m.kind === 'event' ? m.event : m.kind === 'reply' ? 'message.received' : null;

export function playFunnel(input: FunnelPlayInput): FunnelPlay {
  const byId = new Map<string, FunnelStage>(input.definition.stages.map((s) => [s.stageId, s]));
  const entries: FunnelPlayEntry[] = [];
  let stage = byId.get(input.startStageId) ?? null;
  let reachedAt = input.startAt;
  const booking = { startsAt: input.bookingAt };
  let choice = 0;
  // A funnel that loops (missed, booked again, missed…) stops after this many stages.
  for (let hop = 0; stage && hop < 40; hop++) {
    entries.push({ kind: 'arrive', at: reachedAt, stageId: stage.stageId });
    const clock = { reachedAt, booking, timeZone: input.timeZone };
    // What was due before they got here goes as they arrive, unless it's past its good-until by then.
    const timed = stage.messages
      .flatMap((m) => {
        const due = funnelMessageDueAt(m, clock);
        return due === null || funnelMessageStale(m, due, reachedAt)
          ? []
          : [{ m, at: Math.max(due, reachedAt) }];
      })
      .sort((a, b) => a.at - b.at);
    if (input.closedStageIds.has(stage.stageId) || stage.moves.length === 0) {
      for (const { m, at } of timed)
        if (funnelOnlyIfHolds(m, []))
          entries.push({
            kind: 'message',
            at,
            stageId: stage.stageId,
            messageId: m.id,
            maybe: false,
          });
      if (stage.handOff)
        entries.push({ kind: 'handoff', at: timed[0]?.at ?? reachedAt, stageId: stage.stageId });
      entries.push({
        kind: 'end',
        at: timed[timed.length - 1]?.at ?? reachedAt,
        stageId: stage.stageId,
      });
      return { entries, fork: null, stageId: stage.stageId };
    }
    const picked = input.choices[choice];
    const move = picked ? stage.moves.find((x) => x.id === picked) : undefined;
    if (!move) {
      // Nothing picked here yet: what's still to come, then the fork.
      for (const { m, at } of timed)
        entries.push({
          kind: 'message',
          at,
          stageId: stage.stageId,
          messageId: m.id,
          maybe: m.onlyIf !== null,
        });
      if (stage.handOff)
        entries.push({ kind: 'handoff', at: timed[0]?.at ?? reachedAt, stageId: stage.stageId });
      return {
        entries,
        fork: {
          stageId: stage.stageId,
          options: stage.moves.map((x) => ({
            moveId: x.id,
            label: funnelMoveCause(x, input.names),
            to: x.to,
          })),
        },
        stageId: stage.stageId,
      };
    }
    choice++;
    const at = happensAt(move, reachedAt, input.bookingAt);
    const did = didOf(move);
    for (const { m, at: due } of timed) {
      if (due <= at) {
        if (funnelOnlyIfHolds(m, []))
          entries.push({
            kind: 'message',
            at: due,
            stageId: stage.stageId,
            messageId: m.id,
            maybe: false,
          });
      } else if (m.onlyIf && did && m.onlyIf.event === did) {
        // The fork the owner built: "if they haven't joined" never goes to someone who joined.
        entries.push({ kind: 'skipped', at: due, stageId: stage.stageId, messageId: m.id });
      }
    }
    if (stage.handOff)
      entries.push({ kind: 'handoff', at: timed[0]?.at ?? reachedAt, stageId: stage.stageId });
    entries.push({ kind: 'did', at, moveId: move.id, label: funnelMoveCause(move, input.names) });
    reachedAt = at;
    stage = byId.get(move.to) ?? null;
  }
  return { entries, fork: null, stageId: stage?.stageId ?? null };
}

/** What a pretend lead's move says they did, in the past ("joined", "written back"). */
export function funnelPlayDid(m: FunnelMove): string {
  if (m.kind === 'event') return FUNNEL_EVENTS[m.event].past;
  if (m.kind === 'reply') return m.says;
  return 'gone quiet';
}
