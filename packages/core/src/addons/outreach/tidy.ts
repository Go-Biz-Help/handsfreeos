/**
 * Tidying the person's own friends (docs/outreach.md, decisions 10, 12, 15 and 17): sent friend requests nobody
 * answered in the business's wait (3 weeks to start), and friends to unfriend to make room under Facebook's cap: no
 * contact either way in 6 months, friends for longer than that, not in Contacts, not a prospect, not on Keep and not on
 * Don't pitch. The person ticks the ones to go on the web's Friends tab, which asks their computer (./asks.ts), and the
 * extension presses Cancel request or Unfriend on each one's profile for them, slowly, in a tab they can see, within a
 * daily limit.
 *
 * And Facebook's warnings (decision 25): the extension notes each one it sees, which halves the person's daily limits
 * for a week, leaves friend requests off Today's list for two days, and stops what it does for them for the day.
 *
 * Browser-safe: the extension and the web draw these, and the server checks them.
 */
import { z } from 'zod';
import { FIT_LEVEL_KEYS } from './fit';
import {
  TIDY_KIND_KEYS,
  WARNING_NO_REQUESTS_DAYS,
  WARNING_SLOWER_DAYS,
  type TidyKind,
} from './limits';
import { PLATFORM_KEYS } from './playbooks';
import { FacebookUrl, PersonName, ProfileRef } from './saves';

export {
  TIDY_KIND_KEYS,
  TIDY_LIMITS,
  WARNING_NO_REQUESTS_DAYS,
  WARNING_SLOWER_DAYS,
  type TidyKind,
} from './limits';

/** What each is called: on the Friends tab, and in the counts. */
export const TIDY_WORDS: Readonly<
  Record<TidyKind, { readonly label: string; readonly button: string; readonly many: string }>
> = {
  cancel_request: {
    label: 'Old requests',
    button: 'Cancel request',
    many: 'requests cancelled',
  },
  unfriend: { label: 'Friends to unfriend', button: 'Unfriend', many: 'friends unfriended' },
};

/** A friend with no contact either way for this long, and friends for longer, is suggested for unfriending. */
export const UNFRIEND_QUIET_DAYS = 183;
/** How long a sent request waits before it's suggested for cancelling, unless the business says (decision 12). */
export const CANCEL_AFTER_WEEKS = 3;
/** The most of each listed at once. */
export const TIDY_MOST = 200;

const n = z.number().int().min(0);
const moment = z.iso.datetime();

/** Facebook's warning the person got lately: when, its words, and until when it slows things down. */
export const WarningState = z.object({
  at: moment,
  words: z.string(),
  /** Daily limits are halved until then. */
  slowerUntil: moment,
  /** Friend requests are left off Today's list until then. */
  requestsFrom: moment,
  /** Seen today, so the extension does nothing more for them today. */
  today: z.boolean(),
});
export type WarningState = z.output<typeof WarningState>;

/** The red note about a warning: what Facebook said, and what HandsFreeOS does about it. */
export function warningNote(warning: WarningState, now = Date.now()): string {
  const requests = new Date(warning.requestsFrom).getTime() > now;
  const slower = `Your daily limits are halved until ${dayName(warning.slowerUntil)}`;
  return [
    `Facebook warned you: “${warning.words}”.`,
    warning.today ? 'The extension stops for today.' : null,
    requests
      ? `${slower}, and friend requests are off your list until ${dayName(warning.requestsFrom)}.`
      : `${slower}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** "Thursday, October 15", in the reader's own time zone. */
function dayName(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/** When a warning seen at `at` stops slowing things down, and stops keeping friend requests off the list. */
export function warningEnds(at: Date): { slowerUntil: Date; requestsFrom: Date } {
  return {
    slowerUntil: new Date(at.getTime() + WARNING_SLOWER_DAYS * 86_400_000),
    requestsFrom: new Date(at.getTime() + WARNING_NO_REQUESTS_DAYS * 86_400_000),
  };
}

export const TidyInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
});
export type TidyInput = z.input<typeof TidyInput>;

const Candidate = z.object({
  profileId: z.uuid(),
  name: z.string(),
  url: z.string(),
  /** Their profile's number and username, for the extension to check it's them before it presses anything. */
  platformId: z.string().nullable(),
  username: z.string().nullable(),
  /** A request: when it was sent, as far as HandsFreeOS knows. A friend: since when. */
  since: moment,
  /** A friend: the last contact either way, when there was any. */
  lastContact: moment.nullable(),
  /** For a request: how they fit the playbooks. A good fit is still suggested; the person decides. */
  fit: z.enum(FIT_LEVEL_KEYS).nullable(),
});
export type TidyCandidate = z.output<typeof Candidate>;

export const TidyOutput = z.object({
  /** Sent requests waiting longer than the business's wait, the oldest first. */
  cancel: z.array(Candidate),
  /** Friends suggested for unfriending, the longest quiet first. */
  unfriend: z.array(Candidate),
  /** All there are of each, when more than are listed. */
  totals: z.object({ cancel_request: n, unfriend: n }),
  /** The business's wait before a request is suggested for cancelling. */
  cancelAfterWeeks: n,
  /** Unfriending needs the person's download file in, which says when they last talked to each friend. */
  needsFile: z.boolean(),
  /** How many of each today, and the most today. */
  limits: z.object({
    cancel_request: z.object({ done: n, most: n }),
    unfriend: z.object({ done: n, most: n }),
  }),
  friends: n,
  /** Facebook's cap on friends. */
  cap: n,
  warning: WarningState.nullable(),
});
export type TidyOutput = z.output<typeof TidyOutput>;

/** How many more of a kind the extension may do today. */
export const tidyLeft = (out: Pick<TidyOutput, 'limits'>, kind: TidyKind): number =>
  Math.max(0, out.limits[kind].most - out.limits[kind].done);

export const FriendEndInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  kind: z.enum(TIDY_KIND_KEYS),
  profile: ProfileRef,
  name: PersonName,
  /** Done already when the extension got there: they answered the request, or aren't friends anymore. Not counted. */
  already: z.boolean().default(false),
});
export type FriendEndInput = z.input<typeof FriendEndInput>;

export const FriendEndOutput = z.object({
  profileId: z.uuid(),
  /** Counted against today's limit. */
  counted: z.boolean(),
  /** How many of this kind today, counting this one. */
  doneToday: n,
});
export type FriendEndOutput = z.output<typeof FriendEndOutput>;

/** Facebook's own words on a warning, each line once, as the extension read them (src/facebook/warnings.ts). */
export const WarningNoteInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  words: z.array(z.string().trim().min(1).max(300)).min(1).max(5),
  url: FacebookUrl.nullable().default(null),
});
export type WarningNoteInput = z.input<typeof WarningNoteInput>;

export const WarningNoteOutput = z.object({
  /** Seen already today with the same words: kept once. */
  repeated: z.boolean(),
  warning: WarningState,
});
export type WarningNoteOutput = z.output<typeof WarningNoteOutput>;

/** The limits for each kind, as they stand. */
export const tidyLimits = (
  done: Readonly<Record<TidyKind, number>>,
  most: Readonly<Record<TidyKind, number>>,
) => ({
  cancel_request: { done: done.cancel_request, most: most.cancel_request },
  unfriend: { done: done.unfriend, most: most.unfriend },
});
