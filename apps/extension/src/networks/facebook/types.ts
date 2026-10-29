/**
 * What the extension reads off a Facebook page (README.md). Phase 0 only shows it in the side panel; later phases
 * send the same shapes to HandsFreeOS. Everything here is what the page itself showed: a name as written, a count as
 * displayed, a time as Facebook printed it.
 */

/** The kinds of page the extension knows how to read, decided from the address alone (./urls.ts). */
export const PAGE_KINDS = [
  'profile',
  'friends',
  'followers',
  'following',
  'chats',
  'chat',
  'groups',
  'group',
  'group-members',
  'search',
  'notifications',
  // Your friends' birthdays (facebook.com/events/birthdays/, decision 108).
  'birthdays',
  'post',
  'feed',
  'other',
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** A person's profile: by the number in its link when the link shows one, else by its username. */
export interface ProfileRef {
  readonly id: string | null;
  readonly username: string | null;
  /** The canonical link: https://www.facebook.com/profile.php?id=… or https://www.facebook.com/<username>. */
  readonly url: string;
}

export interface GroupRef {
  /** The group's number, or its vanity name when the link uses one. */
  readonly id: string;
  readonly url: string;
}

export interface ThreadRef {
  readonly id: string;
  /** End-to-end encrypted chats live under /messages/e2ee/t/. */
  readonly encrypted: boolean;
  readonly url: string;
}

/** Where a page is, read from its address: its kind and whose page it is. */
export interface PageAddress {
  readonly kind: PageKind;
  readonly profile: ProfileRef | null;
  readonly group: GroupRef | null;
  readonly thread: ThreadRef | null;
}

/** Someone named on a page, with the profile their name links to. */
export interface Named {
  readonly name: string;
  readonly profile: ProfileRef | null;
}

/**
 * Where a friend request with someone stands, as their row in a list shows it (./friends.ts): one they sent you, with
 * Confirm and Delete; one you sent them, with Cancel request; or one answered already, "Request accepted".
 */
export type RequestRow = 'received' | 'sent' | 'answered';

export interface Person extends Named {
  /** The lines under the name, as shown: "12 mutual friends", "Owner at Smith Plumbing", "Joined 2 hours ago". */
  readonly details: readonly string[];
  /** Labels the page puts on them: "Admin", "Moderator", "Group expert". */
  readonly badges: readonly string[];
  /** The part of the list they're in ("Admins and moderators", "Members"), on pages that have parts. */
  readonly section: string | null;
  /** On your friends pages, the friend request their row is about. Null for anyone else, and on other pages. */
  readonly request: RequestRow | null;
}

export interface ProfilePage {
  readonly name: string | null;
  readonly profile: ProfileRef | null;
  /**
   * What the profile says about them: the bio and the details under the name (a place there reads as "Lives in …"),
   * then the Intro card's lines, or the 2026 Personal details, Work and Education cards: work, business, town.
   */
  readonly intro: readonly string[];
  /** What the buttons on the profile say about the two of you. */
  readonly friendship:
    'self' | 'friends' | 'request_sent' | 'request_received' | 'not_friends' | 'unknown';
  readonly mutualFriends: number | null;
  /** How many follow them, when the top says ("12K followers"): for the AI's partner check (decision 81). */
  readonly followers?: number;
  /** How many friends they have, when the top says ("349 friends"): where they live, with their mutual friends. */
  readonly friends?: number;
}

export interface GroupLink {
  readonly name: string;
  readonly group: GroupRef;
  /** The line under the name: "Public · 12K members", "Last active 2 hours ago". */
  readonly detail: string | null;
}

export interface GroupPage {
  readonly name: string | null;
  readonly group: GroupRef | null;
  readonly privacy: 'public' | 'private' | null;
  /** As displayed, so "12K members" is 12000. */
  readonly members: number | null;
  /** Whether the page shows you as a member ("Joined") or offers "Join group". */
  readonly joined: boolean | null;
  /** Asked to join, and waiting for the admins: the page offers to cancel the request. */
  readonly asked?: boolean;
}

/** A group's About tab: what it says it's for, and its rules from the admins (./groups.ts). */
export interface GroupAbout {
  readonly about: readonly string[];
  readonly rules: readonly string[];
}

export interface Post {
  readonly author: Named | null;
  /** The post's own link, without Facebook's tracking. */
  readonly url: string | null;
  /** When, as Facebook printed it ("3h", "Yesterday at 3:15 PM"). */
  readonly when: string | null;
  readonly text: string;
  readonly comments: number | null;
  readonly reactions: number | null;
}

export interface ChatMessage {
  /** Who wrote it, when the page says: you, or them. */
  readonly from: 'me' | 'them' | 'unknown';
  readonly sender: string | null;
  readonly text: string;
  /** The last time marker above it, as shown ("Today at 10:12 AM"). */
  readonly when: string | null;
}

export interface ChatSummary {
  readonly name: string;
  readonly thread: ThreadRef;
  readonly preview: string | null;
  readonly when: string | null;
}

export interface ChatPage {
  readonly name: string | null;
  readonly thread: ThreadRef | null;
  readonly profile: ProfileRef | null;
  readonly messages: readonly ChatMessage[];
}

/** One of your notifications: someone accepted your request, reacted, commented, mentioned you. */
export interface Notice {
  readonly kind:
    'friend_accepted' | 'friend_request' | 'reaction' | 'comment' | 'mention' | 'group' | 'other';
  /** What it says, as shown: "Jane Doe accepted your friend request." */
  readonly text: string;
  /** Who did it: the names it starts with. */
  readonly names: readonly string[];
  /** Their profile, when the notification links to it (an accepted request does). */
  readonly profile: ProfileRef | null;
  /** The post, profile or group it opens. */
  readonly url: string | null;
  readonly when: string | null;
}

/** Everything one read of a page found. Plain data: it crosses from the tab to the side panel as JSON. */
export interface ReadResult {
  readonly kind: PageKind;
  readonly url: string;
  readonly readAt: string;
  readonly profile?: ProfilePage;
  /** On a profile, the pages its lines link to: the business they own or work at (./profile.ts). */
  readonly pages?: readonly Named[];
  readonly group?: GroupPage;
  /** On a group's About tab: what it's for, and its rules (decision 48). */
  readonly about?: GroupAbout;
  readonly chat?: ChatPage;
  readonly people?: readonly Person[];
  readonly groups?: readonly GroupLink[];
  readonly posts?: readonly Post[];
  readonly chats?: readonly ChatSummary[];
  readonly notices?: readonly Notice[];
  /**
   * Which of your own lists the page shows (./friends.ts): your friends, or your friend requests, the ones you've got
   * or, after View sent requests, the ones you've sent.
   */
  readonly friendList?: 'friends' | 'requests';
  /** Facebook's own warnings on the page: a block, a limit, a security check. Later phases stop for the day on any. */
  readonly warnings: readonly string[];
  /** What the person should know about this read: "Facebook loads members as you scroll." */
  readonly notes: readonly string[];
}
