/**
 * Threads' and X's kits (docs/outreach.md decision 163): follow networks made of short posts, built alike. What
 * differs between the two is a `FollowSpec` (../threads/spec.ts, ../x/spec.ts): their addresses, their own words and
 * warnings, and where on their pages a post, its Like and Reply, a profile's Follow and the box to reply in are. The
 * readers (./read.ts), the presses (./auto.ts) and the site built from them (./site.ts) are the same for both.
 *
 * Both are built from the sites' usual buttons, words, roles and test ids (the owner's 1a), and tuned from Check
 * Threads and Check X: the AI helper (decision 142) and the problem reports catch the rest.
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';

/** Threads or X. */
export type FollowPlatform = Extract<Platform, 'threads' | 'x'>;

/** An account, by its name in its address. */
export interface FollowAccount {
  readonly username: string;
  readonly url: string;
}

/** A post as a page shows it: search results, someone's profile, a post's own page and its replies. */
export interface FollowPost {
  /** Its own address, however the page wrote it: x.com/<them>/status/<id>, threads.com/@<them>/post/<code>. */
  readonly url: string;
  /** Who wrote it: on both, its own address names them. */
  readonly author: FollowAccount;
  /** The name shown beside it, when it's more than the username. */
  readonly name: string | null;
  readonly text: string;
  /** When, from its time's own date and hour. */
  readonly at: string | null;
  /** When, as the page printed it ("3h"). */
  readonly when: string | null;
  readonly likes: number | null;
  readonly replies: number | null;
  /** Whether the person liked it already: null with no Like on it. */
  readonly liked: boolean | null;
  /** Who it answers, by username, when the page says so (X's "Replying to @them"). */
  readonly replyingTo: readonly string[];
}

/** Where the person stands with an account: following them, asked to (a private one), or not. */
export type Standing = 'following' | 'requested' | 'no';

/** Someone's profile, as its own page shows it. */
export interface FollowProfile extends FollowAccount {
  readonly name: string | null;
  readonly bio: string | null;
  readonly links: readonly string[];
  readonly followers: number | null;
  /** Null when no Follow or Following shows: the person's own profile, or one the page didn't draw. */
  readonly following: Standing | null;
  /** They follow the person: X's "Follows you", either's Follow back. Null when the page doesn't say. */
  readonly followsYou: boolean | null;
  /** Their own posts on it, newest first as it draws them: never a repost of someone else's. */
  readonly posts: readonly FollowPost[];
}

/** An account in a list of them (the person's followers). */
export interface FollowListed {
  readonly username: string;
  readonly url: string;
  readonly name: string | null;
  /** Whether the person follows them, as their row's own button says: null when it shows none. */
  readonly following: Standing | null;
}

/** What the kit's readers found on a page. Plain data: it crosses from the tab as JSON. */
export type FollowFound = {
  /** Someone's profile, on their own page. */
  readonly profile: FollowProfile | null;
  /** Every post on the page, in page order. */
  readonly posts: readonly FollowPost[];
  /** On a post's own page: the post its address names. */
  readonly post: FollowPost | null;
  /** On a post's own page: the replies under it. */
  readonly replies: readonly FollowPost[];
  /** A list of accounts on the page: the person's followers, in their own page or a box over the profile. */
  readonly people: readonly FollowListed[];
  /** The person's own username, from the menu's link to their profile. */
  readonly me: string | null;
};

export const NOTHING_FOLLOW_FOUND: FollowFound = {
  profile: null,
  posts: [],
  post: null,
  replies: [],
  people: [],
  me: null,
};

/** Where on a page each part is, on one of the two networks. */
export interface FollowSpec {
  readonly platform: FollowPlatform;
  readonly name: string;
  /** Its sites, as Chrome's match patterns. */
  readonly hosts: readonly string[];
  /** The host its addresses are made whole on. */
  readonly host: string;
  /** A link on its pages as a whole address on its host, or null when it leads anywhere else. */
  readonly url: (href: string, base?: string) => URL | null;
  readonly kindOf: (url: URL) => string;
  readonly profileOf: (url: URL) => FollowAccount | null;
  /** The post a link points to, as one address however it was written; null for any other link. */
  readonly postOf: (url: URL) => string | null;
  /** Who a post's own address names: its writer. */
  readonly postAuthorOf: (url: URL) => FollowAccount | null;
  readonly pathWords: ReadonlySet<string>;
  readonly words: ReadonlySet<string>;
  readonly warnings: readonly RegExp[];
  readonly warnedAt?: (url: URL) => string | null;
  /** Its pages the runner and Check open. */
  readonly pages: {
    readonly home: string;
    /** Its post search for the words, the newest first. */
    readonly search: (words: string) => string;
    /** The person's notifications where replies to them show. */
    readonly notifications: string;
    /** Their followers: a page of its own (X's), or null where a count on their profile opens them (Threads'). */
    readonly followers: (own: FollowAccount) => string | null;
  };
  /** The menu's link to the person's own profile. */
  readonly ownLink: (doc: Document, href: string) => string | null;
  /** A post's part on the page, from the link to it its time sits in. */
  readonly rootOf: (timeLink: Element) => Element | null;
  /** The name shown beside a post's writer, when it's more than their username. */
  readonly nameIn: (root: Element, author: FollowAccount) => string | null;
  /** What a post says. */
  readonly textIn: (root: Element) => string;
  /** A post's own Like, and whether it's liked already. */
  readonly likeIn: (
    root: Element,
  ) => { readonly control: HTMLElement; readonly liked: boolean } | null;
  /** A post's own Reply, which opens the box to reply in where none shows (Threads'). */
  readonly replyIn: (root: Element) => HTMLElement | null;
  /** How many replies a post shows, when it says. */
  readonly repliesIn: (root: Element) => number | null;
  /** Who a post answers, by username, when it says (X's "Replying to"). */
  readonly replyingToIn: (root: Element) => string[];
  /** A profile's header: its name, counts and Follow. */
  readonly headerOf: (doc: Document) => Element | null;
  /** What a profile's header says. */
  readonly profileIn: (
    header: Element,
    account: FollowAccount,
  ) => Pick<FollowProfile, 'name' | 'bio' | 'links' | 'followers' | 'followsYou'>;
  /** A profile's own Follow (or Follow back), and its Following (or Requested). */
  readonly followIn: (header: Element) => {
    readonly follow: HTMLElement | null;
    readonly following: HTMLElement | null;
    readonly requested: boolean;
  };
  /** The Unfollow the site asks to be sure with, once Following was pressed. */
  readonly unfollowIn: (doc: Document) => HTMLElement | null;
  /** A list of accounts on the page: the person's followers, on its own page or in a box. */
  readonly listIn: (doc: Document) => Element | null;
  /** A list row's button, as it says whether the person follows them. */
  readonly rowStanding: (row: Element) => Standing | null;
  /** Opens the person's followers from the count on their own profile, where they have no page of their own. */
  readonly openFollowers?: (doc: Document) => boolean;
  /** The boxes to reply in that show: under the post on its own page, or over it once Reply was pressed. */
  readonly replyBoxes: (doc: Document) => HTMLElement[];
  /** The button that sends what's written in a box to reply in. */
  readonly sendFor: (box: HTMLElement) => HTMLElement | null;
  /** On the person's notifications, whether a post says it answers them. */
  readonly answersMe: (root: Element, me: string) => boolean;
}
