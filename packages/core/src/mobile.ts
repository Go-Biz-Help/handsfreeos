/**
 * What the phone app and the API agree on (M10): the headers every request from the app carries, the three
 * kinds of action a phone may keep waiting, how a time read off the phone's own clock is moved onto the
 * server's, and how app builds compare. Browser-safe: the app imports these.
 */

/**
 * How long a command may wait on a phone with no signal (every command definition says; the default is online):
 * - `anytime`: notes, photos, tasks, customer and lead edits, stage moves, snoozes, recording cash. Goes through
 *   whenever it arrives.
 * - `{ freshMinutes }`: anything that reaches a customer. Goes on its own while fresh; after that the app asks
 *   "Still send?" (`stale_action`) and sends it again with the moment the person said yes.
 * - `online`: payments and refunds, calls, the Assistant, links, settings and team changes, and everything
 *   else. Refused when it arrives more than two minutes after it was done.
 */
export type OfflineClass = 'anytime' | { readonly freshMinutes: number } | 'online';

/** What a customer-facing action from the phone has, before "Still send?": Chris's 30-minute rule. */
export const FRESH_MINUTES = 30;
/** How old an online-only action from the phone may be when it arrives: the uploader's retries, and the trip. */
export const ONLINE_MINUTES = 2;
/** How recent a "Still send?" yes must be for a stale action to go. */
export const CONFIRMED_MINUTES = 5;

/** `x-hfos-client` says a request is from the app. */
export const APP_CLIENT = 'mobile';

/** The request headers the app sends (lower-case, as HTTP servers hand them over). */
export const APP_HEADERS = {
  /** `mobile`. */
  client: 'x-hfos-client',
  /** The command's own id (a uuid the phone made when the person acted). A repeat returns the first answer. */
  commandId: 'x-hfos-command-id',
  /** When the person did it, by the phone's clock (ISO 8601). */
  occurredAt: 'x-hfos-occurred-at',
  /** When the phone sent this request, by the phone's clock: what corrects the other two. */
  sentAt: 'x-hfos-sent-at',
  /** When the person answered "Still send?" yes, by the phone's clock. */
  confirmedAt: 'x-hfos-confirmed-at',
  /** The app build ("1.4.2"). */
  appVersion: 'x-hfos-app-version',
} as const;

/**
 * A time read off the phone's clock, on the server's: `at + (serverNow − sentAt)`, so a phone whose clock is an
 * hour out still says when things really happened. Never later than now. Without `sentAt`, taken as it is.
 */
export function onServerClock(at: Date, sentAt: Date | null, now: Date): Date {
  const skew = sentAt ? now.getTime() - sentAt.getTime() : 0;
  return new Date(Math.min(at.getTime() + skew, now.getTime()));
}

/** The numbers of a build: "1.4.2" → [1, 4, 2]; anything after them ("-beta.1", "+57") is ignored. */
function versionParts(v: string): number[] | null {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/**
 * Whether an app build is at least the given one. A version that can't be read is treated as too old, so a
 * broken build is asked to update rather than let through.
 */
export function appVersionAtLeast(version: string | null | undefined, minimum: string): boolean {
  const want = versionParts(minimum);
  if (!want) return true;
  const have = version ? versionParts(version) : null;
  if (!have) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== want[i]!) return have[i]! > want[i]!;
  }
  return true;
}
