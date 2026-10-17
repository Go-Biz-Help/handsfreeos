/**
 * The page outline on LinkedIn (../outline.ts): the shape of a LinkedIn page with everything people wrote taken out,
 * so the readers can be tuned to the real page from the owner's own account without anyone seeing who or what was on
 * it. It keeps LinkedIn's own words and the words in its addresses, and the shape of its phrases around a name ("Invite
 * [2 words] to connect"); a name, a headline, a message or a post becomes "[2 words]", and the members, conversations
 * and posts links lead to become {1}, {2}…. The top bar, which is about the person, is left out.
 */
import { isDate } from '../facebook/vocabulary';
import { clean } from '../facebook/dom';
import {
  maskWith,
  outlineWith,
  type OutlineOptions as BaseOptions,
  type OutlineSite,
} from '../outline';
import { DATA_WORDS } from './data';
import { INTEROP } from './dom';
import type { ReadResult } from './types';
import { linkedinUrl } from './urls';
import { degreeOnly, isSentWhen, isWhen, UI_WORDS } from './vocabulary';

/** The words in LinkedIn's addresses, never a name or an id. */
const PATH_WORDS = new Set(
  [
    'in',
    'me',
    'feed',
    'update',
    'hashtag',
    'posts',
    'mynetwork',
    'invite-connect',
    'connections',
    'invitation-manager',
    'received',
    'sent',
    'search',
    'results',
    'all',
    'people',
    'content',
    'companies',
    'groups',
    'messaging',
    'thread',
    'compose',
    'notifications',
    'company',
    'school',
    'showcase',
    'events',
    'newsletters',
    'recent-activity',
    'comments',
    'reactions',
    'shares',
    'overlay',
    'contact-info',
    'about-this-profile',
    'details',
    'experience',
    'education',
    'skills',
    'recommendations',
    'preload',
    'search-custom-invite',
    'custom-invite',
    'checkpoint',
    'challenge',
    'jobs',
    'learning',
    'premium',
    'help',
    'legal',
    'settings',
    'psettings',
    'analytics',
    'about',
    'life',
    'members',
    'new',
    'mypreferences',
    'd',
    'download-my-data',
    'member-data',
    // Seen (as {n}) in the owner's outlines of 16 Oct 2026; a best reading of what they are.
    'edit',
    'forms',
    'position',
    'summary',
    'intro',
    'skill-associations-details',
    'redir',
    'redirect',
    'followers',
    'profile-views',
    'creator',
    'admin',
    'my-items',
    'saved-posts',
    'network-manager',
    'pulse',
    'article',
    'certifications',
    'volunteering-experiences',
    'languages',
    'interests',
    'search-appearances',
  ].map((w) => w.toLowerCase()),
);

/** LinkedIn's reactions, as its newer reaction button names its state: "Reaction button state: like". */
const REACTION_NAMES = [
  'no reaction',
  'like',
  'celebrate',
  'support',
  'love',
  'insightful',
  'funny',
  'praise',
  'appreciation',
  'empathy',
  'interest',
  'entertainment',
];

/** One of LinkedIn's names for a post or a comment: its kind kept, its number hidden. */
const URN = /^(urn:li:[A-Za-z_]+:)(.+)$/;

/** LinkedIn's own words on buttons, boxes and headings, beyond the readers' (./vocabulary.ts). */
const OWN_WORDS = new Set(
  [
    'add a note',
    'add a note to your invitation?',
    'send without a note',
    'send invitation',
    'send now',
    'cancel',
    'dismiss',
    'got it',
    'close',
    'write a message…',
    'add a comment…',
    'add a reply…',
    'text editor for creating content',
    'react like',
    'unreact like',
    'celebrate',
    'support',
    'love',
    'insightful',
    'funny',
    'send in a private message',
    'open send options',
    'press enter to send',
    'click send',
    'attach an image',
    'attach a file',
    'open emoji keyboard',
    'open gif keyboard',
    'start a post',
    'reactions menu',
    'add a photo',
    'main feed',
    'primary navigation',
    'conversation list',
    'more actions',
    'send profile in a message',
    'save to pdf',
    'report or block',
    'report / block',
    'show all posts',
    'contact info',
    'you are on the messaging overlay.',
    'see more, visually reveals content which is already detected by screen readers',
    'linkedin members are more likely to accept invitations that include a note.',
    // The newer layout's (the owner's outlines of 16 Oct 2026), a best reading of the words it hid: the reaction
    // button's states and the menu beside it, the comment box and what may send it, a post's heading and the line
    // above someone else's post, and the own profile's pictures and pencils. If LinkedIn's differ, the next outline
    // still shows "[n words]" there.
    ...REACTION_NAMES.map((name) => `reaction button state: ${name}`),
    'open reactions menu',
    'feed post',
    'text editor for creating comment',
    'text editor for creating a comment',
    'add a comment',
    'add a comment to this post',
    'post comment',
    'submit comment',
    'add an emoji',
    'add a gif',
    'add photo',
    'most relevant',
    'most recent',
    'load more comments',
    'likes this',
    'loves this',
    'celebrates this',
    'supports this',
    'finds this insightful',
    'finds this funny',
    'commented on this',
    'reposted this',
    'reposted by',
    'promoted by',
    'edit intro',
    'edit profile',
    'headline',
    'headline*',
    'save',
    'edit about',
    'edit experience',
    'add experience',
    'edit education',
    'add education',
    'background image',
    'cover image',
    'edit background image',
    'edit cover image',
    'profile photo',
    'add verification badge',
    'add a verification badge',
    'video player',
  ].map((w) => w.toLowerCase()),
);

/** LinkedIn's lines that say nothing about anyone: counts, its own headings and filters. */
const PLAIN = [
  /^(\d{1,4}|\d{1,3}(,\d{3})+|\d+(\.\d+)?\s*[km])$/i,
  /^[\d.,]+\+?\s*[km]?\s+(connections?|followers?|reactions?|comments?|reposts?|members?|results)$/i,
  /^[\d,]+ (?:mutual|shared) connections?$/i,
  /^about [\d,]+ results$/i,
  /^feed post number \d+$/i,
  /^(all|people|pages|newsletters|events|groups) \(\d+\)$/i,
  /^sort by: \w+$/i,
  /^[·•|]$/,
  /^\d+\s?(s|m|h|d|w|mo|yr)(\s*•\s*(edited|promoted)?)*\s*•?$/i,
  /^connections filter\. clicking this button displays all connections filter options\.$/i,
];

/** LinkedIn's phrases with someone's name or words in them: the parts in brackets are hidden, the rest kept. */
const SHAPES: readonly RegExp[] = [
  /^view:? (.+?)[’']s? profile$/di,
  /^view: (.+)$/di,
  /^(.+?)[’']s? profile (?:picture|photo)$/di,
  /^(?:profile (?:picture|photo) of|photo of) (.+)$/di,
  /^invite (.+) to connect$/di,
  /^pending,? click to withdraw invitation sent to (.+)$/di,
  /^withdraw (?:an )?invitation sent to (.+)$/di,
  /^(?:accept|ignore) (?:an )?invitation to (?:follow|attend|join|subscribe to) (.+)$/di,
  /^(?:accept|ignore) (?:an )?invitation (?:to connect )?from (.+)$/di,
  /^accept (.+?)[’']s? invitation$/di,
  /^(?:message|follow|unfollow|following|send (?:a )?message to|remove your connection to) (.+)$/di,
  /^(?:open control menu for post by|dismiss post by|hide post by) (.+)$/di,
  /^(?:react \w+ to|open options for|view more options for|reply to|[\d.,]+\s*[km]? reactions? on) (.+?)[’']s? comment$/di,
  /^[\d.,]+\s*[km]? (?:comments? on|reposts? of|reactions? on) (.+?)[’']s? post$/di,
  /^(.+?) sent the following messages? at (.+)$/di,
  /^(?:messages in )?conversation with (.+)$/di,
  /^open the options list in your conversation with (.+)$/di,
  /^seen by (.+?) at (.+)$/di,
  /^(?:current company|education): (.+?)\. click to skip to \w+ card$/di,
  /^you: (.+)$/di,
  /^(.+?),? and [\d,]+ other (?:mutual|shared) connections?$/di,
  /^(.+?) (?:is a|are) (?:mutual|shared) connections?$/di,
  /^(.+?) and [\d,]+ others?$/di,
  /^your invitation to (.+?) was sent\.?$/di,
  /^personalize your invitation to (.+?) by adding a note\.?$/di,
  /^(.+?) (?:accepted your invitation|viewed your profile|likes this|loves this|celebrates this|supports this|commented on this|reposted this|reacted to your (?:post|comment)|commented on your (?:post|comment)|mentioned you in a (?:comment|post)|replied to your comment)(.*)$/di,
];

/** Text with whatever a person wrote hidden, and LinkedIn's own words kept. */
export function maskText(text: string): string {
  return maskWith(text, {
    isDate,
    kept: (t) =>
      UI_WORDS.has(t.toLowerCase()) ||
      OWN_WORDS.has(t.toLowerCase()) ||
      DATA_WORDS.has(t.toLowerCase()) ||
      isWhen(t) ||
      isSentWhen(t) ||
      degreeOnly(t) !== null ||
      PLAIN.some((pattern) => pattern.test(t)),
    shapes: SHAPES,
  });
}

/** The page's title with the name in it hidden: "(2) Dana Reyes | LinkedIn" is "(2) [2 words] | LinkedIn". */
export function maskTitle(title: string): string {
  const match = /^(\(\d+\+?\)\s*)?(.*?)(\s*\|\s*linkedin)?$/i.exec(clean(title));
  return match ? `${match[1] ?? ''}${maskText(match[2] ?? '')}${match[3] ?? ''}` : maskText(title);
}

/** What a LinkedIn page's outline keeps, hides and leaves out (../outline.ts). */
export const LINKEDIN_OUTLINE: OutlineSite = {
  name: 'LinkedIn',
  url: (href, base) => linkedinUrl(href, base),
  isPathWord: (part) => PATH_WORDS.has(part.toLowerCase()),
  maskPart: (part, token) => {
    const urn = URN.exec(part);
    return urn ? `${urn[1]}${token(urn[2]!)}` : token(part.toLowerCase());
  },
  host: 'www.linkedin.com',
  mask: maskText,
  maskTitle,
  // How a search is sorted and filtered, and where a link came from: never who.
  queryKept: new Set([
    'sortBy',
    'origin',
    'network',
    'facetNetwork',
    'screenContext',
    'filter',
    'isSelfProfile',
    'associationType',
  ]),
  queryDropped: /^(trk|trkInfo|lipi|lici|midToken|midSig|eid|otpToken|trackingId|refId|nis)$/,
  // A box over the page has a header of its own (Edit intro's title), which is kept.
  isTopBar: (element) =>
    element.getAttribute('role') === 'banner' ||
    (element.tagName === 'HEADER' &&
      element.closest('main, [role="main"], dialog, [role="dialog"], [role="alertdialog"]') ===
        null),
  // A post's and a comment's own names (urn:li:activity:…), their numbers hidden as anything long is.
  alsoKept: ['aria-pressed', 'aria-placeholder', 'type', 'data-urn', 'data-id'],
  // Where the newer pages draw their older parts, its messaging windows likely among them (./dom.ts).
  shadowHosts: INTEROP,
};

export interface OutlineOptions extends Omit<BaseOptions, 'found'> {
  /** What the readers found on the page, counted in the outline's heading. */
  readonly found?: ReadResult;
}

/** The whole outline as text, with a heading that says which page it was and what the readers found there. */
export function outlinePage(doc: Document, href: string, options: OutlineOptions = {}): string {
  return outlineWith(LINKEDIN_OUTLINE, doc, href, options);
}

/**
 * The page's outline as it is this moment, as the tab's own is made (../../content.ts) but for what the readers found:
 * for one of Check LinkedIn's tries (./tries.ts) to take while what it opened is still open, before it closes it again.
 */
export function outlineNow(doc: Document): string {
  const view = doc.defaultView;
  const runtime = (
    globalThis as { chrome?: { runtime?: { getManifest?: () => { version: string } } } }
  ).chrome?.runtime;
  const version = runtime?.getManifest?.().version;
  return outlinePage(doc, doc.location.href, {
    ...(version ? { version } : {}),
    ...(view ? { window: { width: view.innerWidth, height: view.innerHeight } } : {}),
  });
}
