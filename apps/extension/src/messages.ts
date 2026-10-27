/**
 * What the background asks a tab, and what the tab answers; what a tab tells the background as the person works
 * there; and what the background asks the offscreen page that reads Facebook's file (src/offscreen.ts). Every end is
 * the extension's own: the networks' scripts never see these messages. A tab's own network (src/networks/) says how
 * it reads, notes and does each step: one ask means the same on every network that answers it (scroll a list, open a
 * chat, read the person's own profile, put the bio or headline in), and a tab answers only its own network's.
 */
import type { ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import type { AboutSteps, HeadlineSteps, ProfileLoad } from './networks/linkedin/own-profile';
import type { StepTry, TryStep } from './networks/tries';
import type { DownloadPart } from '@hfos/core/addons/outreach/download-read';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { LinkedInFilePart } from './hfos/files';
import type { AboutResult, CodeResult } from './networks/alignable/own-profile';
import type { EditorSteps } from './networks/facebook/editors';
import type { LinkResult } from './networks/facebook/links';
import type { BioResult, OwnEditors } from './networks/facebook/own-profile';
import type { FormSteps } from './networks/instagram/own-profile';
import type { NameWrote } from './networks/accounts-center/name';
import type { Asking } from './networks/accounts-center/pages';
import type { UsernameWrote } from './networks/accounts-center/username';
import type { AutoResult, MessageWrote, TheirPost } from './networks/facebook/auto';
import type { StepAsk, StepResult } from './networks/facebook/fetch';
import type { Engaged, PostResult } from './networks/facebook/compose';
import type { JoinStep } from './networks/facebook/join';
import type { ProfileRef, ReadResult } from './networks/facebook/types';
import type { WithdrawResult } from './networks/linkedin/withdraw';
import type { Answered, PageRead, ReplySighting, Seen, Step } from './networks/kit';

export type Ask = { readonly type: 'hfos-read' } | { readonly type: 'hfos-outline' };

/**
 * What the panel asks a tab on one of Facebook's download pages while it gets the person's file
 * (src/networks/facebook/fetch.ts), or LinkedIn's Get a copy of your data (src/networks/linkedin/data.ts), or on a
 * profile while it cancels a request or unfriends: one step, waiting up to `waitMs` for it to show; or, along a path,
 * the furthest step from `from` on that's there.
 */
export type FetchAsk = StepAsk & {
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
  /**
   * On Instagram, whose chats' rows aren't links (src/networks/instagram/browse.ts), `name` says which: the row that
   * shows it.
   */
  | { readonly type: 'hfos-open-chat'; readonly threadId: string; readonly name?: string }
  | { readonly type: 'hfos-scroll-chats' }
  | { readonly type: 'hfos-scroll-feed' }
  | { readonly type: 'hfos-scroll-list' }
  /** A list of groups, or a search for them: scroll the page for more (src/jobs/groups.ts). */
  | { readonly type: 'hfos-scroll-page' }
  /** A list that opens on a few (Alignable's My Network, on its picks): its tab of them all (src/jobs/alignable). */
  | { readonly type: 'hfos-show-all' };

export type BrowseAnswer = { readonly ok: boolean };

/**
 * What the background's runner asks a tab it works in on its own (src/networks/facebook/auto.ts): on someone's profile, like
 * their latest posts to pick one, then like it; on a post, write a comment and send it; in a chat, write a message and send it. Add friend
 * and Confirm go as a `FetchAsk`, and their profile's Message as an `OpenMessageAsk`.
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
  /**
   * `profile` says whose conversation's box it goes in (src/networks/linkedin/auto.ts, src/networks/alignable/auto.ts,
   * src/networks/instagram/auto.ts). On Facebook (src/networks/facebook/auto.ts) `names` does too, for a chat that
   * names them without a link to their profile: the name Facebook showed for them, on the chat or the profile the
   * runner checked. Facebook types nothing for an ask without `profile`.
   */
  | {
      readonly type: 'hfos-message';
      readonly text: string;
      readonly profile?: ProfileRef;
      readonly names?: readonly string[];
    };

/**
 * LinkedIn's runner's own steps besides those (src/networks/linkedin/auto.ts): Connect on their profile without a
 * note, whose answer is an `AutoAnswer`; and their profile's Message, which opens the conversation in a window over the
 * page, whose answer is a `BrowseAnswer`. On Alignable (src/networks/alignable/auto.ts), `profile` says whose business
 * page it is, and only its own Connect, carrying Alignable's id for it, is pressed.
 */
export type ConnectAsk = { readonly type: 'hfos-connect'; readonly profile?: ProfileRef };
/**
 * On Instagram (src/networks/instagram/auto.ts), `profile` says whose account's Message it is. On Facebook
 * (src/networks/facebook/auto.ts), the chats open before it are noted first: none of those is taken for theirs by name.
 */
export type OpenMessageAsk = { readonly type: 'hfos-open-message'; readonly profile?: ProfileRef };

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
 * LinkedIn's helpful post, put up on the person's own feed (src/networks/linkedin/compose.ts): how it went, and its
 * link once LinkedIn shows it. Who engaged is read with `hfos-engaged`, as on Facebook.
 */
export type FeedPostAsk = { readonly type: 'hfos-feed-post'; readonly text: string };
export type FeedPostAnswer =
  | { readonly ok: true; readonly result: PostResult; readonly url: string | null }
  | { readonly ok: false; readonly error: string };

/**
 * The person's own profile (decision 64): read what a stranger sees first, or put the bio they picked in, which on
 * LinkedIn is their headline, or LinkedIn's About or Alignable's About Us (decision 80; src/networks/facebook/own-profile.ts,
 * src/networks/linkedin/own-profile.ts, src/networks/instagram/own-profile.ts, src/networks/alignable/own-profile.ts).
 */
export type OwnProfileAsk =
  | { readonly type: 'hfos-own-profile' }
  | { readonly type: 'hfos-write-bio'; readonly bio: string }
  | { readonly type: 'hfos-write-about'; readonly about: string };

/** LinkedIn's name, in its intro's First name and Last name (decision 84): answered as a bio's put in is. */
export type WriteNameAsk = { readonly type: 'hfos-write-name'; readonly name: string };

/**
 * Whether anyone's at the address the tab shows (decision 84, ./networks/there.ts): false when the network says the
 * page isn't there (a username that's free), true when a profile shows, null when it can't tell.
 */
export type PageThereAsk = { readonly type: 'hfos-page-there' };
export type PageThereAnswer =
  | { readonly ok: true; readonly there: boolean | null }
  | { readonly ok: false; readonly error: string };

/**
 * A code the person gave HandsFreeOS, put in where the network asks for the one it emailed them (Alignable's, before
 * About Us changes; decision 82, src/networks/alignable/own-profile.ts).
 */
export type CodeAsk = { readonly type: 'hfos-put-code'; readonly code: string };
export type CodeAnswer =
  { readonly ok: true; readonly code: CodeResult } | { readonly ok: false; readonly error: string };

export type OwnProfileAnswer =
  /** `load`: how loading the whole profile went, where the network draws it as it comes into view (LinkedIn). */
  | { readonly ok: true; readonly read: ProfileRead; readonly load?: ProfileLoad }
  /** `steps`: how each step of putting LinkedIn's headline in went, or its About. */
  | {
      readonly ok: true;
      /** `code`: Alignable asks for the code it emailed before About Us goes in. */
      readonly result: BioResult | AboutResult;
      readonly steps?: HeadlineSteps;
      readonly aboutSteps?: AboutSteps;
      /** How each step of putting Facebook's bio in went (from 0.93.0). */
      readonly bioSteps?: EditorSteps;
      /** How each step of putting Instagram's bio in on its form went (from 0.94.0). */
      readonly formSteps?: FormSteps;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Facebook's own profile, where its parts are changed (decision 89): Edit profile's and Edit links's addresses, and the
 * profile's number Accounts Center goes by. For the job alone: never sent to HandsFreeOS.
 */
export type OwnEditorsAsk = { readonly type: 'hfos-own-editors' };
export type OwnEditorsAnswer =
  | { readonly ok: true; readonly editors: OwnEditors }
  | { readonly ok: false; readonly error: string };

/** One new link, added on Contact and basic info (src/networks/facebook/links.ts, decision 89). */
export type WriteLinkAsk = { readonly type: 'hfos-write-link'; readonly link: string };
export type WriteLinkAnswer =
  | { readonly ok: true; readonly result: LinkResult; readonly steps: EditorSteps }
  | { readonly ok: false; readonly error: string };

/**
 * The new username, on Accounts Center's username page for their own profile (src/networks/accounts-center/username.ts,
 * decision 89): how it went, what the network said, and the warnings that stopped it. `profile` is their profile's
 * number: the tab writes only on that profile's username page, on its own network's Accounts Center. `was` is the
 * username the profile has now, when the job knows it (Instagram's): the tab types only while the box holds it or the
 * new one.
 */
export type WriteUsernameAsk = {
  readonly type: 'hfos-write-username';
  readonly username: string;
  readonly profile: string;
  readonly was?: string | null;
};
export type WriteUsernameAnswer =
  | {
      readonly ok: true;
      readonly result: UsernameWrote['result'];
      readonly steps: UsernameWrote['steps'];
      readonly said: string | null;
      readonly warnings?: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * The new name, on Accounts Center's name page for their own Facebook or Instagram profile
 * (src/networks/accounts-center/name.ts, decision 89): as the username's. Never LinkedIn's `hfos-write-name`, whose
 * box is its intro's.
 */
export type WriteCenterNameAsk = {
  readonly type: 'hfos-write-center-name';
  readonly name: string;
  readonly profile: string;
};
export type WriteCenterNameAnswer =
  | {
      readonly ok: true;
      readonly result: NameWrote['result'];
      readonly steps: NameWrote['steps'];
      readonly said: string | null;
      readonly warnings?: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * On Accounts Center's Profiles, the person's own profile among them, or null: its number, and on Facebook its username
 * page (`url`, as 0.93.0 had it); and the network's warnings there, unless it asks for a password
 * (decision 89). On Instagram, `username` is the account they're signed in to on instagram.com, whose row it is.
 */
export type UsernamePageAsk = {
  readonly type: 'hfos-username-page';
  readonly username?: string | null;
};
export type UsernamePageAnswer =
  | {
      readonly ok: true;
      readonly url: string | null;
      readonly profile?: string | null;
      readonly warnings: readonly string[];
      /** What the network asks the person for first, when it does: no profile is looked for then. */
      readonly asking: Asking | null;
    }
  | { readonly ok: false; readonly error: string };

/**
 * The network's warnings on the page the tab shows, after the person carried on (decision 89): on Accounts Center, none
 * while it asks them for something, as its "Confirm it's you" there is no warning (decision 25), and never its answer
 * about a name or a username.
 */
export type AccountWarningsAsk = { readonly type: 'hfos-account-warnings' };
export type AccountWarningsAnswer =
  | {
      readonly ok: true;
      readonly warnings: readonly string[];
      readonly asking: Asking | null;
    }
  | { readonly ok: false; readonly error: string };

/** Put these in's own asks on Facebook, and in Accounts Center on Instagram (decision 89), and what each is answered. */
export type ProfileEditAsk =
  | OwnEditorsAsk
  | WriteLinkAsk
  | WriteUsernameAsk
  | WriteCenterNameAsk
  | UsernamePageAsk
  | AccountWarningsAsk;
export interface ProfileEditAnswers {
  readonly 'hfos-own-editors': OwnEditorsAnswer;
  readonly 'hfos-write-link': WriteLinkAnswer;
  readonly 'hfos-write-username': WriteUsernameAnswer;
  readonly 'hfos-write-center-name': WriteCenterNameAnswer;
  readonly 'hfos-username-page': UsernamePageAnswer;
  readonly 'hfos-account-warnings': AccountWarningsAnswer;
}

/**
 * Check LinkedIn's and Check Facebook's tries (src/networks/linkedin/tries.ts, src/networks/facebook/tries.ts,
 * decisions 76 and 77): one of the extension's steps on the network taken up to its last press, on the page it's for;
 * `profile` is whose page it is, for messaging and liking.
 */
export type TryAsk = {
  readonly type: 'hfos-try';
  readonly step: TryStep;
  readonly profile?: ProfileRef;
};
export type TryAnswer =
  { readonly ok: true; readonly tried: StepTry } | { readonly ok: false; readonly error: string };

/**
 * On LinkedIn's Sent invitations, withdraw the one to this member (src/networks/linkedin/withdraw.ts): its row is found
 * by their profile link, and nothing else is pressed.
 */
export type WithdrawAsk = { readonly type: 'hfos-withdraw'; readonly profile: ProfileRef };

export type WithdrawAnswer =
  | { readonly ok: true; readonly result: WithdrawResult }
  | { readonly ok: false; readonly error: string };

/**
 * On an Instagram account's own page, unfollow them, once the person ticked them (src/networks/instagram/unfollow.ts):
 * its Following (or Requested), then Unfollow in the box Instagram opens, each by its own words. `not_found` when the
 * page shows they aren't followed already; `none` when it couldn't.
 */
export type UnfollowAsk = { readonly type: 'hfos-unfollow' };
export type UnfollowAnswer =
  | { readonly ok: true; readonly result: 'done' | 'not_found' | 'none' }
  | { readonly ok: false; readonly error: string };

export type AutoAnswer =
  | {
      readonly ok: true;
      readonly result: AutoResult;
      readonly postUrl?: string | null;
      /** A message's typing it couldn't take out of another chat's box, with the name on that box (Facebook's). */
      readonly left?: MessageWrote['left'];
    }
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
  | {
      readonly ok: true;
      readonly result: R;
      readonly outline?: string;
      /** With the outline: whether Chrome showed the page (it draws nothing in a window hidden behind another). */
      readonly shown?: boolean;
    }
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
 * What the background asks the offscreen page (src/offscreen.ts) while it brings a network's file in
 * (src/jobs/file-in.ts, src/jobs/linkedin/file.ts): read these zips where Chrome saved them, as Facebook's unless said,
 * and keep what's in them; then each part to send in turn. A service worker can't open the person's files; an
 * extension page can.
 */
export type OffscreenAsk = { readonly target: 'offscreen' } & (
  | {
      readonly type: 'hfos-file-read';
      readonly paths: readonly string[];
      readonly platform?: Platform;
    }
  | { readonly type: 'hfos-file-part'; readonly i: number }
);

export type OffscreenAnswer =
  | {
      readonly ok: true;
      readonly madeAt: string;
      readonly parts: number;
      readonly people: number;
      readonly chats: number;
      /** LinkedIn's: its connections, the invitations still waiting, and the people with no link to save them by. */
      readonly connections?: number;
      readonly invitations?: number;
      readonly noLink?: number;
    }
  | {
      readonly ok: true;
      readonly part: DownloadPart;
    }
  | {
      readonly ok: true;
      /** LinkedIn's (the field isn't called "linkedin": the secret scan reads that before a type name as a key). */
      readonly filePart: LinkedInFilePart;
    }
  | { readonly ok: false; readonly error: string };
