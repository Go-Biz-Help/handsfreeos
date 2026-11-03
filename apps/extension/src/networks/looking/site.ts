/**
 * A network still looked at (docs/outreach.md decision 78; core's `stage: 'looking'`): Instagram and Alignable, before
 * their steps are built. The plan's build order says each starts with "a look at a real account": the extension reads
 * its pages only for Check <network>, outlines them with what people wrote hidden, notes its warnings, and looks for
 * each step's button without pressing it, so the steps can be built from the person's own account rather than from
 * guesses. Nothing is noted as the person goes, and nothing is pressed.
 *
 * What differs from one such network to the next is its site (`LookingSite`): its addresses, its own words, its
 * warnings and the steps it looks for. Everything else is ./kit.ts, ./read.ts and ./looks.ts, the same for each.
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { CommentLiked, TheirComment } from '../../messages';
import type { ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import type { AboutResult, CodeResult } from '../alignable/own-profile';
import type { AlignableWithdrawResult } from '../alignable/withdraw';
import type { AutoResult, TheirPost } from '../facebook/auto';
import type { PostResult } from '../facebook/compose';
import type { JoinStep } from '../facebook/join';
import type { BioResult } from '../facebook/own-profile';
import type { ReplySighting } from '../facebook/replies';
import type { FormSteps } from '../instagram/own-profile';
import type { PartWrite, PartWrote } from '../fill';
import type { ProfileRef } from '../facebook/types';
import type { CenterNetwork } from '../accounts-center/pages';
import type { Noticer } from '../kit';
import type { StepTry, TryStep } from '../tries';

/** A network looked at: Instagram or Alignable. */
export type LookingPlatform = Extract<Platform, 'instagram' | 'alignable'>;

/** Whose post a comment goes on, and which (decision 92): their profile, and the post's own link. */
export interface CommentOn {
  readonly profile: ProfileRef;
  readonly postUrl: string;
}

/** What one read of a page found on a network still looked at. Plain data: it crosses from the tab as JSON. */
export interface LookingRead {
  readonly platform: LookingPlatform;
  /** What kind of page it is, by its address alone. */
  readonly kind: string;
  readonly url: string;
  readonly readAt: string;
  /** Links to people's profiles on the page, each once, in page order: never the person's own. */
  readonly people: readonly { readonly url: string }[];
  /** Links to posts on the page, each once, in page order. */
  readonly posts: readonly { readonly url: string }[];
  /**
   * The places the site's own menus lead to, each once, by their own words (anything else hidden); `worth` when their
   * real words say people, messages or posts are there. Never one that signs out, pays or deletes.
   */
  readonly places: readonly {
    readonly name: string;
    readonly url: string;
    readonly worth: boolean;
  }[];
  /**
   * The page's other links whose words are all the site's own (Alignable's Requests tab, a connection's Message), each
   * once, in page order: never a menu's, a profile's or a post's. What Check opens next is found by their words.
   */
  readonly links: readonly { readonly name: string; readonly url: string }[];
  /** The person's own profile, from the menu's link to it, when the page has one. */
  readonly own: string | null;
  /** The page's links to a form the person edits their own profile on, in page order (`editLink`). */
  readonly edits: readonly string[];
  /** The network's warnings on the page: a block, a limit, a check of the account. */
  readonly warnings: readonly string[];
  /** A box for a password on the page: the network is asking the person to sign in. */
  readonly signedOut: boolean;
  /** The boxes to write in on the page, in sight: a form drawn after its page opens has none till it's drawn. */
  readonly boxes: number;
  /** What the person should know about this read. */
  readonly notes: readonly string[];
  /**
   * What the network's own readers found on the page (`readFound`): Alignable's businesses, posts, answers and chats.
   * Each of Check's notes counts them, never says them.
   */
  readonly found?: Readonly<Record<string, unknown>>;
}

/**
 * One look for a step's button, on the page the tab shows. It never presses the step's last button; where a step's
 * button shows only once something's written (Instagram's Post), it writes a word and takes it out again, as Check
 * Facebook's tries do, and where the step starts with opening something (Message's chat), it opens it and closes it.
 */
export type Look = (doc: Document, href: string) => StepTry | Promise<StepTry>;

/** Whether Check opens a place a menu leads to: worth a look, maybe, or never (and then it isn't even listed). */
export type PlaceOpening = 'worth' | 'maybe' | 'never';

export interface LookingSite {
  readonly platform: LookingPlatform;
  /** Its name, as its pages and the outline say it. */
  readonly name: string;
  /** Its sites, as Chrome's match patterns. */
  readonly hosts: readonly string[];
  /** The host its addresses are made whole on. */
  readonly host: string;
  /**
   * Its own Accounts Center, where its tab changes the person's own username and name for Put these in (decision 89):
   * Instagram's, at accountscenter.instagram.com (../accounts-center/). Its tab may go there and answers its asks there,
   * but the pages aren't its own: nothing the person does there is noted.
   */
  readonly accountsCenter?: CenterNetwork;
  /** A link on its pages as a whole address on its host, or null when it leads anywhere else. */
  readonly url: (href: string, base?: string) => URL | null;
  /** What kind of page an address is. */
  readonly kindOf: (url: URL) => string;
  /** The profile a link points to: its name in the address, and its own address; null for any other link. */
  readonly profileOf: (url: URL) => { readonly username: string; readonly url: string } | null;
  /** The post a link points to, as one address however it was written; null for any other link. */
  readonly postOf: (url: URL) => string | null;
  /** The parts of its addresses that are its own words (never a name), kept in an outline's links. */
  readonly pathWords: ReadonlySet<string>;
  /** A part kept for where it is in its address: the word after Alignable's /biz/connection_requests/. */
  readonly pathWordAt?: (parts: readonly string[], at: number) => boolean;
  /** Its own words on its pages, lower case: kept in an outline, as everything else a person wrote is hidden. */
  readonly words: ReadonlySet<string>;
  /** Its own words in an address's query, kept in an outline beside every network's (tab, type, filter, sort). */
  readonly queryKept?: ReadonlySet<string>;
  /** Its warnings, as its pages word them. */
  readonly warnings: readonly RegExp[];
  /** The addresses that are themselves a warning: a check of the account before going on. */
  readonly warnedAt?: (url: URL) => string | null;
  /** The person's own profile on the page: the menu's link to it. */
  readonly ownLink: (doc: Document, href: string) => string | null;
  /** Whether a link leads to a form the person edits their own profile on: Alignable's /biz/…/edit. */
  readonly editLink?: (url: URL) => boolean;
  /**
   * Whether Check opens a place its menus lead to, by the place's real words and address (the read hides the words, so
   * this is decided in the tab). Without it, every place is maybe.
   */
  readonly placeOpening?: (name: string, url: URL) => PlaceOpening;
  /**
   * The person's own profile, before the network's steps are (decision 80): read for the AI's check, and the bio or
   * the About put in where the extension can. Instagram's bio; Alignable's About Us, past the code it emails (decision
   * 82), put in where it asks for it.
   */
  readonly ownProfile?: {
    readonly read: (doc: Document, href: string) => ProfileRead;
    readonly writeBio?: (doc: Document, bio: string) => Promise<BioResult>;
    /** The bio put in with each step said, for the job's note (Instagram's form, from 0.94.0). */
    readonly writeBioSteps?: (
      doc: Document,
      bio: string,
    ) => Promise<{ readonly result: BioResult; readonly steps: FormSteps }>;
    readonly writeAbout?: (doc: Document, about: string) => Promise<AboutResult>;
    readonly putCode?: (doc: Document, code: string) => Promise<CodeResult>;
    /** Decision 99's parts (Alignable's Elevator Pitch, ideal customer and partner, services), from 0.98.0. */
    readonly writePart?: (
      doc: Document,
      href: string,
      part: PartWrite,
      mask: (text: string) => string,
    ) => Promise<PartWrote>;
  };
  /** Noting the person's own steps there, once its steps are known (Alignable's, partners stage 6c). */
  readonly noticer?: () => Noticer;
  /**
   * Unfollowing the account whose page the tab shows, once the person ticked them (Instagram's tidying, its part 12):
   * `done`, `not_found` when they aren't followed, or `none`.
   */
  readonly unfollow?: (doc: Document) => Promise<'done' | 'not_found' | 'none'>;
  /**
   * Withdrawing a request the person sent, on that business's own page, once they ticked it or on its own (Alignable's
   * tidying, 0.97.0).
   */
  readonly withdraw?: (
    doc: Document,
    href: string,
    profile: ProfileRef,
  ) => Promise<AlignableWithdrawResult>;
  /**
   * Answering a request the person got, from that business (decision 136, Alignable's from 0.118.0): Accept for
   * Confirm, Decline for Delete, on the page the site answers them on.
   */
  readonly answerRequest?: (
    doc: Document,
    href: string,
    profile: ProfileRef,
    answer: 'confirm' | 'delete',
  ) => Promise<AutoResult>;
  /**
   * Going through one of its lists, for the person's asks (Alignable's connections and requests, partners stage 6c):
   * scroll for more, its own Show more pressed where the list ends in one, and a list that opens on a few switched to
   * its tab of them all. Each says whether it could.
   */
  readonly lists?: {
    readonly scroll: (doc: Document, href: string) => boolean | Promise<boolean>;
    readonly showAll?: (doc: Document, href: string) => boolean | Promise<boolean>;
    /**
     * A chat opened from the side of its messages: for Check to outline, one with messages in it; for Read my chats on
     * Instagram, whose rows aren't links, the one whose row shows `name`.
     */
    readonly openChat?: (
      doc: Document,
      href: string,
      name: string | null,
    ) => boolean | Promise<boolean>;
    /**
     * A good post's people (Instagram's, decision 92): its Likes box opened over it, its View all comments pressed
     * once, and the box over the page closed again.
     */
    readonly openLikers?: (doc: Document, href: string) => boolean | Promise<boolean>;
    readonly moreComments?: (doc: Document, href: string) => boolean | Promise<boolean>;
    readonly closeDialog?: (doc: Document, href: string) => boolean | Promise<boolean>;
    /**
     * Another account's followers (Instagram's accounts like the business's, decision 110): the box of them opened by
     * its count of followers, on that account's own page.
     */
    readonly openTheirFollowers?: (doc: Document, href: string) => boolean | Promise<boolean>;
  };
  /**
   * The chats on the page whose last message is theirs (decision 22), for HandsFreeOS to hear who wrote back, as the
   * person goes and as Read my chats goes (Instagram's, its part 13). A network without it tells of none.
   */
  readonly replies?: (doc: Document, href: string) => ReplySighting[];
  /**
   * The presses its runner makes on its own, once the person lets it (Alignable's, partners stage 6c, part 5; Instagram's,
   * its part 14), each on the page it's for: their posts read on their page, a like on the one picked, their own Connect
   * (Instagram's Follow), and a message in their conversation, which on Instagram their account's Message may open
   * first. From 0.95.0 (decision 92), on a site that declares them: a comment on a good post, once OK'd or past the
   * hold, only on that post's own page and in its own box (`comment`); and a group's own Join, on its page (`join`,
   * Alignable's). A network without them presses none of these, and a site without `comment` or `join` is never asked
   * to: the kit answers that it doesn't.
   */
  readonly auto?: {
    readonly theirPosts: (doc: Document, href: string, profile: ProfileRef) => TheirPost[];
    /**
     * Their story liked on its own page (Instagram's, decision 111): watched a few seconds, liked with the viewer's own
     * Like, and closed; the address of the story it liked. A site without stories is never asked.
     */
    readonly likeStory?: (
      doc: Document,
      href: string,
      profile: ProfileRef,
    ) => Promise<{ readonly result: AutoResult; readonly storyUrl: string | null }>;
    readonly like: (
      doc: Document,
      href: string,
      profile: ProfileRef,
      pick: { readonly index: number; readonly url: string | null },
    ) => Promise<{ readonly result: AutoResult; readonly postUrl: string | null }>;
    /**
     * Their comment on a good post's own page (decision 116: the warm-up for someone found by their comment), found
     * again by who wrote it: read (`theirComment`), then liked with its own Like (`likeComment`), its link and what it
     * says. A site without them is never asked.
     */
    readonly theirComment?: (
      doc: Document,
      href: string,
      profile: ProfileRef,
      postUrl: string,
    ) => TheirComment | null;
    readonly likeComment?: (
      doc: Document,
      href: string,
      profile: ProfileRef,
      postUrl: string,
    ) => Promise<CommentLiked>;
    readonly connect: (
      doc: Document,
      href: string,
      profile: ProfileRef,
    ) => AutoResult | Promise<AutoResult>;
    readonly openMessage?: (doc: Document, href: string, profile: ProfileRef) => boolean;
    readonly message: (
      doc: Document,
      href: string,
      text: string,
      profile: ProfileRef,
    ) => Promise<AutoResult>;
    /**
     * A comment on their post (decision 92): `on` says whose post and which, and it's written only on that post's own
     * page, only in the post's own box (never a reply's, never one with writing in it), sent with that box's own
     * button. `none` with no such box; `not_sent` when the network didn't take it.
     */
    readonly comment?: (
      doc: Document,
      href: string,
      text: string,
      on: CommentOn,
    ) => Promise<AutoResult>;
    /**
     * The group's own Join, on its page (Alignable's, decision 92): what came of it, as Facebook's `hfos-join` says.
     * `answerJoin`, where the site asks questions first; a site without it asks none, so the kit says there were none.
     */
    readonly join?: (doc: Document, href: string) => Promise<JoinStep>;
    readonly answerJoin?: (
      doc: Document,
      answers: readonly string[],
    ) => Promise<'done' | 'not_sent' | 'none'>;
    /**
     * The person's own helpful post, once they OK'd it (Alignable's, decision 109): put up on their own page with the
     * box's own Post, only while that box is empty; its link when the page shows it.
     */
    readonly post?: (
      doc: Document,
      href: string,
      text: string,
    ) => Promise<{ readonly result: PostResult; readonly url: string | null }>;
  };
  /** Its own readers, run on each page read beside the links (`LookingRead.found`). */
  readonly readFound?: (doc: Document, href: string) => Readonly<Record<string, unknown>>;
  /** The steps it looks for, each on the kinds of page it's for (`*`: any of its pages, while they're still learned). */
  readonly looks: Readonly<
    Partial<Record<TryStep, { readonly on: readonly string[]; readonly look: Look }>>
  >;
}
