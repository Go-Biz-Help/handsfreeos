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
import type { ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import type { BioResult } from '../facebook/own-profile';
import type { StepTry, TryStep } from '../tries';

/** A network looked at: Instagram or Alignable. */
export type LookingPlatform = Extract<Platform, 'instagram' | 'alignable'>;

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
  /** The person's own profile, from the menu's link to it, when the page has one. */
  readonly own: string | null;
  /** The page's links to a form the person edits their own profile on, in page order (`editLink`). */
  readonly edits: readonly string[];
  /** The network's warnings on the page: a block, a limit, a check of the account. */
  readonly warnings: readonly string[];
  /** A box for a password on the page: the network is asking the person to sign in. */
  readonly signedOut: boolean;
  /** What the person should know about this read. */
  readonly notes: readonly string[];
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
  /** Its own words on its pages, lower case: kept in an outline, as everything else a person wrote is hidden. */
  readonly words: ReadonlySet<string>;
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
   * The person's own profile, before the network's steps are (decision 80): read for the AI's check, and the bio put
   * in. Instagram's; none on a network whose own profile isn't read yet.
   */
  readonly ownProfile?: {
    readonly read: (doc: Document, href: string) => ProfileRead;
    readonly writeBio: (doc: Document, bio: string) => Promise<BioResult>;
  };
  /** The steps it looks for, each on the kinds of page it's for (`*`: any of its pages, while they're still learned). */
  readonly looks: Readonly<
    Partial<Record<TryStep, { readonly on: readonly string[]; readonly look: Look }>>
  >;
}
