/**
 * What the background asks a Facebook tab, and what the tab answers; what a tab tells the background as the person
 * works there; and what the background asks the offscreen page that reads Facebook's file (src/offscreen.ts). Every
 * end is the extension's own: Facebook's scripts never see these messages.
 */
import type { Answered, Seen, Step } from './facebook/actions';
import type { AutoResult } from './facebook/auto';
import type { FetchStep, StepResult } from './facebook/fetch';
import type { ReplySighting } from './facebook/replies';
import type { DownloadPart } from '@hfos/core/addons/outreach/download-read';
import type { ProfileRef, ReadResult } from './facebook/types';

export type Ask = { readonly type: 'hfos-read' } | { readonly type: 'hfos-outline' };

/**
 * What the panel asks a tab on one of Facebook's download pages while it gets the person's file
 * (src/facebook/fetch.ts), or on a profile while it cancels a request or unfriends: one step, waiting up to `waitMs`
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
   * On someone's profile: one the person ticked, to cancel a request or unfriend (src/facebook/tidy.ts), or one on
   * their list, to send a friend request or confirm theirs (src/facebook/auto.ts).
   */
  readonly tidy?: boolean;
};

/**
 * What the panel asks a Messenger tab while it goes through the person's chats (src/facebook/browse.ts): open one
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
 * What the background's runner asks a tab it works in on its own (src/facebook/auto.ts): on someone's profile, like
 * their latest post; on a post, write a comment and send it; in a chat, write a message and send it. Add friend,
 * Confirm and their profile's Message go as a `FetchAsk`.
 */
export type AutoAsk =
  | { readonly type: 'hfos-like-latest'; readonly profile: ProfileRef }
  | { readonly type: 'hfos-comment'; readonly text: string }
  | { readonly type: 'hfos-message'; readonly text: string };

export type AutoAnswer =
  | { readonly ok: true; readonly result: AutoResult; readonly postUrl?: string | null }
  | { readonly ok: false; readonly error: string };

/** What it answers: how the step went, or the place along the path pressed; an error off the download pages. */
export type FetchAnswer =
  | { readonly ok: true; readonly result: StepResult; readonly at?: number }
  | { readonly ok: false; readonly error: string };

export type Answer =
  | { readonly ok: true; readonly result: ReadResult; readonly outline?: string }
  | { readonly ok: false; readonly error: string };

/**
 * What a Facebook tab tells the background as the person works there (src/facebook/actions.ts): a step they took, or
 * their answer to a friend request, and when; or someone they opened from a group; or the chats on the page whose last
 * message is theirs (src/facebook/replies.ts), and whether the person had the tab in front of them. Never what a
 * comment or a message said.
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
   * The page in front of the person, read as they go (src/hfos/looked.ts): Facebook's warnings on it, and a chat or a
   * group's posts when they asked for those to be read (./facebook/looking.ts).
   */
  | {
      readonly type: 'hfos-looked';
      readonly url: string;
      readonly warnings: readonly string[];
      readonly result: ReadResult | null;
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
