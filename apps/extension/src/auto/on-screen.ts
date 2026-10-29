/**
 * The runners' reads that need the screen (docs/outreach.md, decision 120; ../away.ts): a once-a-day job whose read
 * would bring its window in front while the person isn't away from their computer is put off (`NotAway`), never kept
 * as done for the day, and passed over meanwhile so likes, requests and messages go on unseen. It's tried again once
 * they're away, or in 10 minutes. Instagram's, LinkedIn's and Alignable's runners; Facebook's has none.
 */
import { NotAway } from '../away';
import type { JobEnd } from '../jobs/job';

/** While a job that needs the screen waits, once the rest of the day is done the runner looks again this often. */
export const AWAY_AGAIN_MS = 10 * 60_000;

/** Whether what went wrong is a read put off till the person is away. */
export const isNotAway = (error: unknown): error is NotAway => error instanceof NotAway;

/** How a job put off till the person is away ends: tried again later, not done. */
export const awayEnd = (): JobEnd => ({ line: new NotAway().message, warned: false, away: true });

/**
 * The once-a-day jobs a runner put off, as a read in them met the screen while the person wasn't away: passed over
 * till it looks again, so the rest of the day goes on unseen. Only a job that met the screen is put off, so one with
 * nothing to read today (their profile, read on the 1st) is done as ever.
 */
export class PutOff<K extends string> {
  private readonly till = new Map<K, number>();

  /** Puts a job off till it looks again. */
  off(job: K, now = Date.now()): void {
    this.till.set(job, now + AWAY_AGAIN_MS);
  }

  /** The jobs to pass over now: none while the person is away, when each is tried again. */
  passOver(away: boolean, now = Date.now()): K[] {
    return away ? [] : [...this.till].filter(([, till]) => till > now).map(([job]) => job);
  }
}

/** The jobs passed over and still to do today, by the runner's names for them. */
export function waitingFor<K extends string>(
  passOver: readonly K[],
  daily: Readonly<Partial<Record<string, string>>> | undefined,
  names: Readonly<Record<K, string>>,
): string[] {
  return passOver.filter((job) => daily?.[job] === undefined).map((job) => names[job]);
}

/** The day's last line's words for jobs still waiting for the person to be away, or null for none. */
export function waitingWords(names: readonly string[]): string | null {
  if (!names.length) return null;
  const one = names.length === 1;
  const list = one ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${one ? 'One part waits' : `${names.length} parts wait`} till you’ve been away from your computer for 2 minutes, as ${one ? 'it needs' : 'they need'} its window on screen: ${list}.`;
}
