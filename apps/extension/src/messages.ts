/**
 * What the background asks a tab, and what the tab answers; what a tab tells the background as the person works
 * there; and what the background asks the offscreen page that reads Facebook's file (src/offscreen.ts). Every end is
 * the extension's own: the networks' scripts never see these messages. A tab's own network (src/networks/) says how
 * it reads, notes and does each step: one ask means the same on every network that answers it (scroll a list, open a
 * chat, read the person's own profile, put the bio or headline in), and a tab answers only its own network's.
 */
import type { ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import type { DownloadPart } from '@hfos/core/addons/outreach/download-read';
import type { BioResult } from './networks/facebook/own-profile';
import type { AutoResult, TheirPost } from './networks/facebook/auto';
import type { FetchStep, StepResult } from './networks/facebook/fetch';
import type { Engaged, PostResult } from './networks/facebook/compose';
import type { JoinStep } from './networks/facebook/join';
import type { ProfileRef, ReadResult } from './networks/facebook/types';
import type { WithdrawResult } from './networks/linkedin/withdraw';
import type { Answered, PageRead, ReplySighting, Seen, Step } from './networks/kit';

export type Ask = { readonly type: 'hfos-read' } | { readonly type: 'hfos-outline' };

/**
 * What the panel asks a tab on one of Facebook's download pages while it gets the person's file
 * (src/networks/facebook/fetch.ts), or on a profile while it cancels a request or unfriends: one step, waiting up to `waitMs`
 * for it to show; or, along a path, the furthest step from `from` on that's there.
 */
export type FetchAsk = (
  | { readonly type: 'hfos-fetch-step'; readonly step: FetchStep; readonly waitMs: number }
  | {
      readonly type: 'hfos-fetch-path';
      readonly steps: readonly FetchStep[];
      readonly from: number;
      readonly waitMs: number;
    }
) & {
  /**
   * On someone's profile: one the person ticked, to cancel a request or unfriend (src/networks/facebook/tidy.ts), or one on
   * their list, to send a friend request or confirm theirs (src/networks/facebook/auto.ts).
   */
  readonly tidy?: boolean;
  /** On the person's own friend requests page: View sent requests, to save the ones they've sent (src/jobs/people.ts). */
  readonly lists?: boolean;
};

/**
 * What the panel asks a Messenger tab while it goes through the person's chats (src/networks/facebook/browse.ts): open one
 * from the list beside it, or scroll the list for more; or a group's tab, for Find posts: scroll its feed for more;
 * or, for the once-a-day jobs, the person's friend requests or a group's members: scroll for more people. The answer
 * says whether it could.
 */
export type BrowseAsk =
  | { readonly type: 'hfos-open-chat'; readonly threadId: string }
  | { readonly type: 'hfos-scroll-chats' }
  | { readonly type: 'hfos-scroll-feed' }
  | { readonly type: 'hfos-scroll-list' }
  /** A list of groups, or a search for them: scroll the page for more (src/jobs/groups.ts). */
  | { readonly type: 'hfos-scroll-page' };

export type BrowseAnswer = { readonly ok: boolean };

/**
 * What the background's runner asks a tab it works in on its own (src/networks/facebook/auto.ts): on someone's profile, like
 * their latest posts to pick one, then like it; on a post, write a comment and send it; in a chat, write a message and send it. Add friend,
 * Confirm and their profile's Message go as a `FetchAsk`.
 */
export type AutoAsk =
  | { readonly type: 'hfos-their-posts'; readonly profile: ProfileRef; readonly most: number }
  | {
      readonly type: 'hfos-like-post';
      readonly profile: ProfileRef;
      readonly index: number;
      readonly url: string | null;
    }
  | { readonly type: 'hfos-comment'; readonly text: string }
  | { readonly type: 'hfos-message'; readonly text: string };

/**
 * Asking to join a group (src/networks/facebook/join.ts, decisions 31 and 48): on its page, press Join group and say what
 * Facebook asks first; then answer its questions with the AI's answers and submit them.
 */
export type JoinAsk =
  | { readonly type: 'hfos-join' }
  | { readonly type: 'hfos-join-answer'; readonly answers: readonly string[] };

export type JoinAnswer =
  | { readonly ok: true; readonly step: JoinStep }
  | { readonly ok: true; readonly result: 'done' | 'not_sent' | 'none' }
  | { readonly ok: false; readonly error: string };

/**
 * Helpful posts (src/networks/facebook/compose.ts, decision 50): on a group's page, put one up; on the person's own post, read
 * who commented and reacted.
 */
export type GroupPostAsk =
  { readonly type: 'hfos-group-post'; readonly text: string } | { readonly type: 'hfos-engaged' };

export type GroupPostAnswer =
  | { readonly ok: true; readonly result: PostResult }
  | { readonly ok: true; readonly comments: Engaged[]; readonly reactions: Engaged[] }
  | { readonly ok: false; readonly error: string };

/**
 * The person's own profile (decision 64): read what a stranger sees first, or put the bio they picked in, which on
 * LinkedIn is their headline (src/networks/facebook/own-profile.ts, src/networks/linkedin/own-profile.ts).
 */
export type OwnProfileAsk =
  { readonly type: 'hfos-own-profile' } | { readonly type: 'hfos-write-bio'; readonly bio: string };

export type OwnProfileAnswer =
  | { readonly ok: true; readonly read: ProfileRead }
  | { readonly ok: true; readonly result: BioResult }
  | { readonly ok: false; readonly error: string };

/**
 * On LinkedIn's Sent invitations, withdraw the one to this member (src/networks/linkedin/withdraw.ts): its row is found
 * by their profile link, and nothing else is pressed.
 */
export type WithdrawAsk = { readonly type: 'hfos-withdraw'; readonly profile: ProfileRef };

export type WithdrawAnswer =
  | { readonly ok: true; readonly result: WithdrawResult }
  | { readonly ok: false; readonly error: string };

export type AutoAnswer =
  | { readonly ok: true; readonly result: AutoResult; readonly postUrl?: string | null }
  | { readonly ok: false; readonly error: string };

/** The posts of theirs read on their profile, for the AI to pick one to like. */
export type PostsAsk = Extract<AutoAsk, { readonly type: 'hfos-their-posts' }>;
export type PostsAnswer =
  | { readonly ok: true; readonly posts: readonly TheirPost[] }
  | { readonly ok: false; readonly error: string };

/** What it answers: how the step went, or the place along the path pressed; an error off the download pages. */
export type FetchAnswer =
  | { readonly ok: true; readonly result: StepResult; readonly at?: number }
  | { readonly ok: false; readonly error: string };

/**
 * A tab's read of its page, and its outline when asked: Facebook's read unless said (a LinkedIn job reads LinkedIn's,
 * src/jobs/linkedin/read.ts), any network's for the panel's outline.
 */
export type Answer<R extends PageRead = ReadResult> =
  | { readonly ok: true; readonly result: R; readonly outline?: string }
  | { readonly ok: false; readonly error: string };

/**
 * What a tab tells the background as the person works there, on its own network (src/networks/facebook/actions.ts,
 * src/networks/linkedin/actions.ts): a step they took, or their answer to a friend request or an invitation, and when;
 * or someone they opened from a group; or the chats on the page whose last message is theirs, and whether the person
 * had the tab in front of them. Never what a comment or a message said. The background knows the network by the tab's
 * address, never by what the tab says.
 */
export type TabNote =
  | { readonly type: 'hfos-noted'; readonly step: Step; readonly at: string }
  | { readonly type: 'hfos-answered'; readonly answered: Answered; readonly at: string }
  | { readonly type: 'hfos-seen'; readonly seen: Seen }
  | {
      readonly type: 'hfos-replies';
      readonly seen: readonly ReplySighting[];
      readonly looking: boolean;
    }
  /**
   * The page in front of the person, read as they go (src/hfos/looked.ts): its network's warnings on it, and on
   * Facebook a chat or a group's posts when they asked for those to be read (./networks/facebook/looking.ts).
   */
  | {
      readonly type: 'hfos-looked';
      readonly url: string;
      readonly warnings: readonly string[];
      readonly result: PageRead | null;
    };

export const TAB_NOTES: ReadonlySet<string> = new Set<TabNote['type']>([
  'hfos-noted',
  'hfos-answered',
  'hfos-seen',
  'hfos-replies',
  'hfos-looked',
]);

/** Where the switch that turns noting on and off is kept, for the tabs to read: `false` is off, anything else on. */
export const NOTING_KEY = 'hfos.noting';

/** Whether chats the person opens in Messenger are read for the AI, and posts marked as they scroll a group (src/hfos/follow.ts keeps them from their settings). */
export const READ_CHATS_KEY = 'hfos.readChats';
export const MARK_POSTS_KEY = 'hfos.markPosts';

/**
 * What the background asks the offscreen page (src/offscreen.ts) while it brings Facebook's file in
 * (src/jobs/file-in.ts): read these zips where Chrome saved them and keep what's in them; then each part to send in
 * turn. A service worker can't open the person's files; an extension page can.
 */
export type OffscreenAsk = { readonly target: 'offscreen' } & (
  | { readonly type: 'hfos-file-read'; readonly paths: readonly string[] }
  | { readonly type: 'hfos-file-part'; readonly i: number }
);

export type OffscreenAnswer =
  | {
      readonly ok: true;
      readonly madeAt: string;
      readonly parts: number;
      readonly people: number;
      readonly chats: number;
    }
  | {
      readonly ok: true;
      readonly part: DownloadPart;
    }
  | { readonly ok: false; readonly error: string };
