/**
 * What each network's kit gives the extension (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "How it fits: one
 * add-on, a kit per network", and "The extension"): its network from core, its sites, its addresses, its readers, the
 * person's steps there, what to look at as they go, and the outline. What differs from one network to the next is
 * here, in each kit, never in an `if` elsewhere. The kits are in ./facebook/kit.ts and ./linkedin/kit.ts, and
 * ./index.ts finds a tab's.
 */
import type { NetworkKit, Platform } from '@hfos/core/addons/outreach/networks';
import type { Answered, Seen, Step } from './facebook/actions';
import type { LookingSwitches, Looking } from './facebook/looking';
import type { ReplySighting } from './facebook/replies';
import type { ProfileRef, ReadResult as FacebookRead } from './facebook/types';
import type { ReadResult as LinkedInRead } from './linkedin/types';
import type { OutlineOptions } from './outline';

export type { Answered, Looking, LookingSwitches, ProfileRef, ReplySighting, Seen, Step };
export type { FacebookRead, LinkedInRead };

/** What one read of a page found, on any network. */
export type PageRead = FacebookRead | LinkedInRead;

/** Whether an address is whole (a tab's always is): a part of one is never any network's page. */
export function isWholeAddress(href: string): boolean {
  try {
    new URL(href);
    return true;
  } catch {
    return false;
  }
}

/** Whether a read is LinkedIn's: only LinkedIn's say their network. */
export const isLinkedInRead = (read: PageRead): read is LinkedInRead =>
  'platform' in read && read.platform === 'linkedin';

/** The network a read is of: Facebook's say none, as they never had to. */
export const platformOf = (read: PageRead): Platform =>
  'platform' in read ? read.platform : 'facebook';

/**
 * What one of the person's clicks or keys was: a step, an answer to a request, someone opened from a group; or a step
 * the page shows only a moment later whether it went (`maybe`): looked at again after `afterMs`, and noted only when
 * `went()` says so. LinkedIn's Connect is one (a box over the page sends the invitation, or it goes at once), and so
 * is Enter in a box to write in where Enter may only start a new line.
 */
export type Noticed =
  | { readonly kind: 'step'; readonly step: Step }
  | { readonly kind: 'answer'; readonly answered: Answered }
  | { readonly kind: 'seen'; readonly seen: Seen }
  | {
      readonly kind: 'maybe';
      readonly step: Step;
      readonly afterMs: number;
      readonly went: () => boolean;
    };

/** Noting the person's steps on one page: it may remember a press (LinkedIn's Connect) until the box it opens sends. */
export interface Noticer {
  /**
   * What a click of the person's was. `keyed`: Enter or Space on a control drawn as a box, which never opens anyone,
   * so it's never someone opened from a group.
   */
  click(target: Element, doc: Document, href: string, keyed?: boolean): Noticed | null;
  /** What Enter in a box to write in was. */
  enter(target: Element, doc: Document, href: string): Noticed | null;
}

/** What the outline of a page is told: the extension's version, what the readers found, the window's size. */
export interface KitOutlineOptions extends Omit<OutlineOptions, 'found'> {
  readonly found?: PageRead;
}

export interface Kit {
  /** Its network, as core names it: what its saves say they're on. */
  readonly platform: Platform;
  /** Core's kit for it (packages/core/src/addons/outreach/networks.ts): its name, the shapes of its links and ids. */
  readonly network: NetworkKit;
  /** Its sites, as Chrome's match patterns: where its script runs, and what Chrome must let the extension on. */
  readonly hosts: readonly string[];
  /**
   * Its sites are asked for when the person turns it on (the manifest's optional host permissions), never on
   * install: Chrome then lets the extension there only once they press Allow.
   */
  readonly optional: boolean;
  /** Whether it's on while HandsFreeOS hasn't said: Facebook, as it always was; any other network starts off. */
  readonly startsOn: boolean;
  /** Whether an address is one of its pages: a tab whose steps and warnings count there. */
  owns(href: string): boolean;
  /** An address the extension's own tab may open there, made whole, or null: anything else is refused. */
  workUrl(href: string): string | null;
  /** What kind of page an address is, by its address alone. */
  kindOf(href: string): string;
  /** One key per profile, whichever way its link was written. */
  profileKey(profile: ProfileRef): string;
  /** Reads a whole page: what kind it is, what's on it, its warnings, and what the person should know. */
  readPage(doc: Document, href: string): PageRead;
  /** Its warnings on a page: a block, a limit, a restriction, a security check. */
  readWarnings(doc: Document, href: string): string[];
  /** The chats on a page whose last message is theirs: who, never what they wrote. */
  readReplies(doc: Document, href: string): ReplySighting[];
  /** What to read of the page in front of the person as they go: all of it, or only its warnings. */
  lookFor(kind: string, on: LookingSwitches): Looking;
  /** Noting the person's own steps, for one page. */
  noticer(): Noticer;
  /** The page's outline, with names and words hidden. */
  outline(doc: Document, href: string, options?: KitOutlineOptions): string;
  /**
   * What else the background may ask a tab of this network: the runner's and the asks' steps, each network its own (a
   * network without it answers none of them). Null for an ask that isn't one of its own.
   */
  readonly work?: (ask: { readonly type: string }) => Promise<unknown> | null;
}
