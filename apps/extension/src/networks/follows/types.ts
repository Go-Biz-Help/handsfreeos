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

/** A chat in the person's messages (Threads', decision 167), as the list beside them shows it. */
export interface FollowChatRow {
  /** Who it's with, as the row names them. */
  readonly name: string;
  /** Its last line, as the list shows it, without its time. */
  readonly preview: string | null;
  /** The last line is the person's ("You: …"). */
  readonly yours: boolean;
  /** When it last moved, as the list says ("3h"). */
  readonly when: string | null;
  /** Its number, from the link to it. */
  readonly thread: string | null;
}

/** A message in a chat: the person's or theirs. */
export interface FollowChatMessage {
  readonly from: 'me' | 'them';
  readonly text: string;
}

/** A chat open on its own page (Threads', decision 167). */
export interface FollowChat {
  /** Its number, from its address. */
  readonly thread: string | null;
  /** Who it's with: the one other account its header links to, or null for a group or when it links nobody. */
  readonly with: FollowAccount | null;
  readonly name: string | null;
  /** Its latest messages, oldest first. */
  readonly messages: readonly FollowChatMessage[];
  /** Whose the last message is, written or not (a post shared has no words); null with none read. */
  readonly last: FollowChatMessage['from'] | null;
  /** Its box to write in, in sight. */
  readonly box: boolean;
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
  /**
   * The person's page of followers saying, in the network's own words, that nobody follows them yet (X's, from
   * 0.147.10): an empty list, not one that didn't load.
   */
  readonly listEmpty: boolean;
  /** The person's own username, from the menu's link to their profile. */
  readonly me: string | null;
  /** On its messages (Threads', decision 167): the chats in the list beside them. */
  readonly chats: readonly FollowChatRow[];
  /** On a chat's own page: who it's with, its messages and its box. */
  readonly chat: FollowChat | null;
};

export const NOTHING_FOLLOW_FOUND: FollowFound = {
  profile: null,
  posts: [],
  post: null,
  replies: [],
  people: [],
  listEmpty: false,
  me: null,
  chats: [],
  chat: null,
};

/**
 * Where a network's messages are (Threads', decision 167): its list of the person's chats, a chat's own page by its
 * number, and a profile's own Message. A network without them (X's) has nothing written in anyone's messages.
 */
export interface FollowMessages {
  /** The list of the person's chats. */
  readonly inbox: string;
  /** A chat's own page, from its number. */
  readonly chatUrl: (key: string) => string;
  /** The chat an address is, by its number: null for any other address. */
  readonly chatOf: (url: URL) => string | null;
  /** A profile's own Message, beside its Follow, in the profile's header. */
  readonly messageIn: (header: Element) => HTMLElement | null;
  /** What a box to write a message in is named: "Message", "Write a message…". */
  readonly box: RegExp;
  /** What the control that sends a message says: "Send". */
  readonly send: RegExp;
}

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
    /** Its post search for the words as it ranks them, the busiest first: the comment research's (decision 172). */
    readonly topSearch: (words: string) => string;
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
  /** Whether its page of followers says nobody follows them yet, in its own words (X's empty state). */
  readonly listEmptyIn?: (doc: Document) => boolean;
  /** A list row's button, as it says whether the person follows them. */
  readonly rowStanding: (row: Element) => Standing | null;
  /** Opens the person's followers from the count on their own profile, where they have no page of their own. */
  readonly openFollowers?: (doc: Document) => boolean;
  /** The boxes to reply in that show: under the post on its own page, or over it once Reply was pressed. */
  readonly replyBoxes: (doc: Document) => HTMLElement[];
  /** The button that sends what's written in a box to reply in. */
  readonly sendFor: (box: HTMLElement) => HTMLElement | null;
  /**
   * Its page parts' test ids that end in someone's username (X's `UserAvatar-Container-<name>`): the part before the
   * name, kept in an outline, with the name hidden as a link to them is.
   */
  readonly testIdName?: RegExp;
  /** On the person's notifications, whether a post says it answers them. */
  readonly answersMe: (root: Element, me: string) => boolean;
  /** Its messages, where something is written in them (Threads', decision 167); none on X yet. */
  readonly messages?: FollowMessages;
}
