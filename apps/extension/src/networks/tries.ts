/**
 * What Check LinkedIn's and Check Facebook's tries share (docs/outreach.md, decisions 76 and 77): how trying one step
 * went, whatever the network. Each network's tries are its own (./linkedin/tries.ts, ./facebook/tries.ts), and take each
 * step up to its last press with the step's own functions, never pressing that one.
 */
import type { TryStepName } from '@hfos/core/addons/outreach/reports';

/** A step a Check tries, on any network: core names each (`TRY_STEP_NAMES`). */
export type TryStep = TryStepName;

/** How trying one step went. */
export interface StepTry {
  readonly step: TryStep;
  /** Whether there was something to try it on: a post of theirs, someone to connect with, an invitation sent. */
  readonly tried: boolean;
  /** Everything it needed was there and did what it should. */
  readonly works: boolean;
  /** What it found: counts, and yes or no. */
  readonly found: Readonly<Record<string, number | boolean>>;
  /** What it couldn't find or do, in the extension's own words; empty when it works. */
  readonly missing: readonly string[];
  /** The names of what it looked among, as the outline shows them. */
  readonly seen?: readonly string[];
  /** The page's outline the moment it didn't work, while what the try opened was still open. */
  readonly outline?: string;
  /**
   * An address to try the step again on, a second way: the page Message links to when it opened nothing on the profile.
   * For the job alone; never in a note.
   */
  readonly next?: string;
}

/** A step tried: it works when nothing was missing. */
export const went = (
  step: TryStep,
  found: Record<string, number | boolean>,
  missing: readonly string[],
  seen?: readonly string[],
): StepTry => ({
  step,
  tried: true,
  works: missing.length === 0,
  found,
  missing,
  ...(seen?.length ? { seen } : {}),
});

/** Nothing to try it on: not a fault of the step's. */
export const untried = (
  step: TryStep,
  why: string,
  found: Record<string, number | boolean> = {},
): StepTry => ({ step, tried: false, works: false, found, missing: [why] });

/** A word written to see a box take it, and taken out again: never sent. */
export const TRY_WORD = 'Testing';

/** The reasons something's missing, without the ones that aren't. */
export const missingOf = (reasons: readonly (string | false | null | undefined)[]): string[] =>
  reasons.filter((m): m is string => typeof m === 'string');
