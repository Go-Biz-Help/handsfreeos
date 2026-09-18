/**
 * A migration's words and its step — the parts the browser needs (M11).
 *
 * Kept apart from the loaders next door because those reach for `next/headers`, and a client component that
 * imports them takes the whole server module with it.
 */
import type { paths } from '@hfos/api-client';

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type MigrationList = Ok<'/v1/queries/migration.list'>;
export type MigrationDetail = Ok<'/v1/queries/migration.get'>;
export type MigrationReviewQueue = Ok<'/v1/queries/migration.review_queue'>;

/**
 * Which step of the wizard a migration is on.
 *
 * There is no separate "choose" step, and that is deliberate: the scan ticks everything it can bring, so
 * choosing and checking the plan are the same screen — tick what you don't want, read what it will do, press
 * the button. A step whose default answer is already right is not a step, it is a page to click through.
 */
/**
 * The line under a connected source's name: how it was connected, what it reaches, and what it turned out
 * not to be allowed to read.
 *
 * A private token is deliberately worded without a number (0069). It never says what it was given, so the
 * honest thing to show before a scan is which door it came in through — what it cannot read is found out by
 * asking, and the scan says so category by category.
 */
export function connectionWords(c: MigrationList['connections'][number]): string {
  if (c.authKind === 'private_token') return 'A private token · one business';
  const reaches = c.installKind === 'agency' ? 'Your whole agency' : 'One business';
  if (c.missingScopes.length === 0) return reaches;
  const n = c.missingScopes.length;
  return `${reaches} · ${n} ${n === 1 ? 'thing' : 'things'} this sign-in cannot read`;
}

export type MigrationStep = 'map' | 'review' | 'importing' | 'done';

export function stepOf(status: string, mapped: boolean): MigrationStep {
  if (
    status === 'importing' ||
    status === 'verifying' ||
    status === 'scanning' ||
    status === 'paused' ||
    status === 'finalizing' ||
    status === 'rolling_back'
  )
    return 'importing';
  if (
    status === 'imported' ||
    status === 'transition' ||
    status === 'completed' ||
    status === 'rolled_back'
  )
    return 'done';
  return mapped ? 'review' : 'map';
}

/** What a person is told a migration is doing, in their words rather than the database's. */
export const STATUS_WORDS: Record<string, string> = {
  draft: 'Not started',
  connected: 'Connected',
  scanning: 'Looking at the old system',
  scanned: 'Ready to set up',
  ready: 'Ready to bring across',
  importing: 'Bringing it across',
  paused: 'Paused',
  verifying: 'Checking it',
  imported: 'Brought across',
  transition: 'Keeping up with the old system',
  finalizing: 'Finishing',
  completed: 'Finished',
  needs_attention: 'Needs a look',
  failed: 'Stopped',
  cancelling: 'Stopping',
  cancelled: 'Stopped',
  rolling_back: 'Taking it back',
  rolled_back: 'Taken back',
};
