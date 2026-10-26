/**
 * The page outline: the shape of a Facebook page with everything people wrote taken out, so the readers can be tuned
 * to the real page without anyone seeing who or what was on it.
 *
 * It keeps tags, roles, Facebook's own words and labels, and the shape of each link. Anything a person wrote (a name,
 * a message, a post, a group's name) becomes "[2 words]", and the people, groups, chats and posts that links point to
 * become {1}, {2}…, the same number each time the same one comes up. Pictures' addresses and Facebook's scrambled
 * class names are left out. It is plain text, so the person can read it before sending it.
 */
import {
  maskWith,
  outlineWith,
  SiteOutliner,
  type OutlineOptions as BaseOptions,
  type OutlineSite,
} from '../outline';
import { clean } from './dom';
import { PROFILE_EDIT_WORDS } from './editors';
import { FETCH_WORDS } from './fetch';
import type { ReadResult } from './types';
import { facebookUrl, isFacebookPathWord } from './urls';
import { BADGE, isDate, isFacebookText, sectionTitleOf } from './vocabulary';

/** Facebook's phrases with someone's name or words in them: the parts in brackets are hidden, the rest kept. */
const SHAPES: readonly RegExp[] = [
  /^(?:profile (?:picture|photo) of|may be an image of|may be a photo of|messages in conversation with|conversation with|seen by|more options for|actions for|see who reacted to|comment by|reply by) (.+)$/di,
  /^you(?: replied to|:) (.+)$/di,
  /^(.+?) replied to (?:you|(.+))$/di,
  /^(.+?) and \d+ others?$/di,
  /^(.+?)['’]s (?:profile|profile picture|cover photo|post|photo|story)$/di,
  /^(.+?) (?:accepted your friend request|sent you a friend request|reacted to your (?:post|comment|photo|video|message)|commented on your (?:post|photo|video)|mentioned you in a (?:comment|post)|replied to your comment|shared your post|posted in|invited you to join|is typing)(.*)$/di,
  /^(?:comment as|reply as|follow|unfollow|add friend|cancel request|message|invite) (.+)$/di,
  // Accounts Center's username page (decision 89): Facebook's answer about a username, and the address it makes.
  /^(.+?) (?:is available|isn['’]t available|is not available|is taken|is already taken)\W*$/di,
  /^(?:https?:\/\/)?(?:www\.)?facebook\.com\/(.+)$/di,
];

/**
 * Words that say nothing about anyone: short counts ("34", "1,234", "12K") and Facebook's "Active 5m ago". A long
 * number could be a phone number someone sent, so it's hidden.
 */
const PLAIN = /^(\d{1,4}|\d{1,3}(,\d{3})+|\d+(\.\d+)?\s*[km]|active (now|\d+\s?[a-z]+ ago))$/i;

/** Text with whatever a person wrote hidden, and Facebook's own words kept. */
export function maskText(text: string): string {
  return maskWith(text, {
    isDate,
    kept: (t) =>
      isFacebookText(t) ||
      FETCH_WORDS.has(t.toLowerCase()) ||
      PROFILE_EDIT_WORDS.has(t.toLowerCase()) ||
      BADGE.test(t) ||
      Boolean(sectionTitleOf(t)) ||
      PLAIN.test(t),
    shapes: SHAPES,
  });
}

/** The page's title with the name in it hidden: "(3) Jane Doe | Facebook" is "(3) [2 words] | Facebook". */
export function maskTitle(title: string): string {
  const match = /^(\(\d+\+?\)\s*)?(.*?)(\s*\|\s*facebook)?$/i.exec(clean(title));
  return match ? `${match[1] ?? ''}${maskText(match[2] ?? '')}${match[3] ?? ''}` : maskText(title);
}

/** The values kept as they are: a profile's tab, and what kind of notification a link came from. */
const QUERY_KEPT = new Set(['sk', 'notif_t', 'ref', 'filter']);
/** Facebook's tracking, dropped. */
const QUERY_DROPPED =
  /^(__|fbclid$|mibextid$|notif_id$|paipv$|eav$|rdid$|hc_ref$|hc_location$|fref$|comment_tracking$)/;

/** What a Facebook page's outline keeps, hides and leaves out (../outline.ts). */
export const FACEBOOK_OUTLINE: OutlineSite = {
  name: 'Facebook',
  url: (href, base) => facebookUrl(href, base),
  isPathWord: isFacebookPathWord,
  host: 'www.facebook.com',
  mask: maskText,
  maskTitle,
  queryKept: QUERY_KEPT,
  queryDropped: QUERY_DROPPED,
  isTopBar: (element) => element.getAttribute('role') === 'banner',
};

/** Facebook's outliner: the network's own words in a link kept, names and numbers turned into {1}, {2}… */
export class Outliner extends SiteOutliner {
  constructor() {
    super(FACEBOOK_OUTLINE);
  }
}

export interface OutlineOptions extends Omit<BaseOptions, 'found'> {
  /** What the readers found on the page, counted in the outline's heading. */
  readonly found?: ReadResult;
}

/** The whole outline as text, with a heading that says which page it was and what the readers found there. */
export function outlinePage(doc: Document, href: string, options: OutlineOptions = {}): string {
  return outlineWith(FACEBOOK_OUTLINE, doc, href, options);
}
