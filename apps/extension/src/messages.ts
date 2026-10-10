/**
 * What the side panel asks a Facebook tab, and what the tab answers; and what a tab tells the background as the person
 * works there. Every end is the extension's own: Facebook's scripts never see these messages.
 */
import type { Answered, Seen, Step } from './facebook/actions';
import type { AutoResult } from './facebook/auto';
import type { FetchStep, StepResult } from './facebook/fetch';
import type { ReplySighting } from './facebook/replies';
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
  | { readonly type: 'hfos-scroll-list' };

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

/** The line the panel opens to a tab to hear when its page changes, while it reads as the page changes. */
export const WATCH = 'hfos-watch';

/** What the tab says on that line: the page changed (more posts as you scroll, a new message), so read it again. */
export type Note = { readonly type: 'hfos-changed' };

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
    };

export const TAB_NOTES: ReadonlySet<string> = new Set<TabNote['type']>([
  'hfos-noted',
  'hfos-answered',
  'hfos-seen',
  'hfos-replies',
]);

/** Where the switch that turns noting on and off is kept, for the tabs to read: `false` is off, anything else on. */
export const NOTING_KEY = 'hfos.noting';
