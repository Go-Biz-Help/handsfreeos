/**
 * What the extension reads off a LinkedIn page (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part
 * by part", 1). Where LinkedIn has what Facebook has (a person, a chat, a post, a notification), the shape is
 * Facebook's (../facebook/types.ts), so what HandsFreeOS takes from one network it can take from the other; the rest
 * is LinkedIn's own. Everything here is what the page itself showed: a name as written, a count as displayed, a time
 * as LinkedIn printed it. Ids and names fit core's LinkedIn kit (`NETWORKS.linkedin` in
 * packages/core/src/addons/outreach/networks.ts).
 */
import type {
  ChatMessage,
  ChatPage,
  ChatSummary,
  GroupRef,
  Named,
  Notice as FacebookNotice,
  Post as FacebookPost,
  ProfileRef,
  ThreadRef,
} from '../facebook/types';

/**
 * A member's profile by the name in its address (/in/<username>/) and, where a link shows it, LinkedIn's id for them
 * (ACoAA…); the link is https://www.linkedin.com/in/<username>/, or /in/<id>/ when only the id is known. A chat's
 * thread is never end-to-end encrypted on LinkedIn.
 */
export type { ChatMessage, ChatPage, ChatSummary, GroupRef, Named, ProfileRef, ThreadRef };

/** The kinds of LinkedIn page the extension knows how to read, decided from the address alone (./urls.ts). */
export const PAGE_KINDS = [
  'profile',
  'own-profile',
  'activity',
  'connections',
  'invitations',
  'search',
  'search-people',
  'search-posts',
  'feed',
  'post',
  'messaging',
  'chat',
  'notifications',
  // Catch up on My Network: connections' birthdays and new jobs (decision 108).
  'catch-up',
  'group',
  'company',
  'other',
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** Which way an invitation to connect went: to you, or from you. */
export type Direction = 'received' | 'sent';

/** A company's page: /company/<name or number>/. */
export interface CompanyRef {
  readonly id: string;
  readonly url: string;
}

/** Where a page is, read from its address: its kind, and whose page, chat, group or post it is. */
export interface PageAddress {
  readonly kind: PageKind;
  readonly profile: ProfileRef | null;
  readonly thread: ThreadRef | null;
  readonly group: GroupRef | null;
  /** On a post's own page, its link. */
  readonly post: string | null;
  /** On your invitations, which ones the address asks for. */
  readonly invitations: Direction | null;
}

/** How far someone is from you: connected (1st), a connection's connection (2nd), or further (3rd, shown "3rd+"). */
export type Degree = '1st' | '2nd' | '3rd';

/**
 * Where the two of you stand, from the buttons on their profile or their row: connected; an invitation you sent
 * that waits ("Pending"); one they sent you (Accept, Ignore); neither ("Connect", or only "Follow"); you; or not
 * told.
 */
export type Connection =
  'connected' | 'pending' | 'received' | 'not_connected' | 'self' | 'unknown';

/** Someone in a list: your connections, people search, your invitations. */
export interface Person extends Named {
  readonly profile: ProfileRef;
  /** The line under the name that they wrote about themselves: "Owner at Acme Plumbing | Austin homeowners". */
  readonly headline: string | null;
  /** Where they are, on lists that show it (people search): "Austin, Texas Metropolitan Area". */
  readonly location: string | null;
  readonly degree: Degree | null;
  /** "Sam Lee and 11 other mutual connections" is 12. */
  readonly mutualConnections: number | null;
  /** The lines under the name, as shown: the headline and place, "Connected on October 3, 2026", the mutual line. */
  readonly details: readonly string[];
  /** What the row's buttons say: Connect, Pending, Message. */
  readonly connection: Connection;
}

/**
 * An invitation to connect, on My Network's Manage invitations: one someone sent you, with Accept and Ignore, or one
 * you sent, with Withdraw. Invitations to follow a page, go to an event or read a newsletter aren't these.
 */
export interface Invitation extends Person {
  readonly direction: Direction;
  /** When, as the row prints it: "Sent 3 weeks ago", "Yesterday". */
  readonly when: string | null;
}

/** The first role under a profile's Experience: their current one, most often. */
export interface Role {
  readonly title: string;
  /** The company, without how they work there: "Acme Plumbing" from "Acme Plumbing · Self-employed". */
  readonly company: string | null;
  /** As shown: "Jan 2015 - Present · 10 yrs 10 mos". */
  readonly dates: string | null;
}

/** A company named on a profile, with its page when the profile links to it. */
export interface CompanyLink {
  readonly name: string;
  readonly company: CompanyRef | null;
}

export interface ProfilePage {
  readonly name: string | null;
  readonly profile: ProfileRef | null;
  /** What they wrote under their name (220 characters at most on LinkedIn). */
  readonly headline: string | null;
  readonly location: string | null;
  /** Their About, line by line, as far as the page shows it. */
  readonly about: string | null;
  readonly role: Role | null;
  /** The company their current role is at, by the top of the profile or their first role, and its page. */
  readonly company: CompanyLink | null;
  readonly degree: Degree | null;
  readonly connection: Connection;
  /** Follow is the main button, with Connect under More: LinkedIn does this for people who post a lot. */
  readonly followFirst: boolean;
  readonly mutualConnections: number | null;
  /** How many follow them, when the top says ("1,234 followers"): for the AI's partner check (decision 81). */
  readonly followers?: number;
}

/**
 * A post on LinkedIn: Facebook's shape, the company page (or showcase page) that posted it when one did, and the line
 * under its author's name.
 */
export interface Post extends FacebookPost {
  readonly company: CompanyRef | null;
  /** What the author says about themselves under their name on the post: their headline. */
  readonly headline: string | null;
}

/** One of your notifications: an invitation accepted, a reaction, a comment, a mention, a look at your profile. */
export interface Notice extends Omit<FacebookNotice, 'kind'> {
  readonly kind: 'accepted' | 'reaction' | 'comment' | 'mention' | 'viewed' | 'other';
}

/**
 * A company's page (/company/<name>/, and its About tab): what it says about itself, for a look-up before a draft.
 * Its name is its heading; its tagline the line under it; `lines` what its About or Overview says, a label and its
 * value on one line ("Industry: Plumbing").
 */
export interface CompanyPage {
  readonly name: string | null;
  readonly company: CompanyRef | null;
  readonly tagline: string | null;
  readonly lines: readonly string[];
}

/** A group's own page: its name, by its heading, and the group its address is. */
export interface GroupPage {
  readonly name: string | null;
  readonly group: GroupRef | null;
}

/** A birthday or a new job on Catch up (./catch-up.ts, decision 108): whose, and for a new job, LinkedIn's words. */
export interface CatchUp extends Named {
  readonly profile: ProfileRef;
  readonly kind: 'birthday' | 'new_job';
  readonly detail: string | null;
}

/** Everything one read of a LinkedIn page found. Plain data: it crosses from the tab to the background as JSON. */
export interface ReadResult {
  readonly platform: 'linkedin';
  readonly kind: PageKind;
  readonly url: string;
  readonly readAt: string;
  readonly profile?: ProfilePage;
  readonly people?: readonly Person[];
  readonly invitations?: readonly Invitation[];
  readonly posts?: readonly Post[];
  readonly chats?: readonly ChatSummary[];
  readonly chat?: ChatPage;
  readonly notices?: readonly Notice[];
  readonly group?: GroupPage;
  readonly company?: CompanyPage;
  readonly catchUp?: readonly CatchUp[];
  /** LinkedIn's own warnings on the page: the weekly invitation limit, a restriction, a security check. */
  readonly warnings: readonly string[];
  /** What the person should know about this read: "LinkedIn loads more as you scroll." */
  readonly notes: readonly string[];
}
