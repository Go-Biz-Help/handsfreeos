/**
 * Meta's Accounts Center (docs/outreach.md, decision 89): where the person's own Facebook profile's username and name
 * change (accountscenter.facebook.com, in a Facebook window), and their own Instagram profile's
 * (accountscenter.instagram.com, in an Instagram window). The extension types there only on the username and name
 * pages of the person's own profile, by its number in the address, each on its own network's Accounts Center
 * (./username.ts, ./name.ts); this is what both share: the addresses, the person's own profile among Profiles, what
 * Meta asks the person for before it goes on, and its warnings there.
 *
 * - **Its own network's only.** A Facebook tab works on accountscenter.facebook.com, an Instagram tab on
 *   accountscenter.instagram.com, never the other's: a tab never answers on the other's host (./work.ts).
 * - **The person's own profile.** On Facebook, the number from their profile's Edit profile link, or else the one row
 *   among Profiles that says Facebook. On Instagram, the row that says Instagram and shows the account they're signed
 *   in to on instagram.com, or else the only Instagram row there: Instagram's own Accounts Center always holds the
 *   account signed in to it.
 * - **Never a password or a code** (`askingHere`): a password box, a box for a code or a PIN, or "Confirm it's you"
 *   with ways to pick, is the person's to answer, and the page's words aren't read as a warning while Meta asks.
 * - **Its warnings, never its answers** (`centerWarnings`): Facebook's warnings, and Instagram's block ("Action
 *   blocked"), but never Meta saying a name or username can't change now, or Instagram's "Try again later" or
 *   "Confirm it's you" on their own: those are answers to the person, not a block (decision 25), and stopping the day
 *   on them would halve their limits for nothing.
 *
 * Built from Meta's usual words for these pages, not yet from a page outline of them.
 */
import { PLATFORMS } from '@hfos/core/addons/outreach/networks';
import { clean, labelOf, textLines } from '../facebook/dom';
import { EDITOR_BUTTONS, fieldName } from '../facebook/editors';
import { askingFor, placesOf, visible } from '../facebook/fetch';
import { maskText } from '../facebook/outline';
import { readWarnings } from '../facebook/warnings';

/** The networks whose own profile's username and name change in an Accounts Center. */
export type CenterNetwork = 'facebook' | 'instagram';
/** The parts of a profile the extension changes there. */
export type CenterPart = 'username' | 'name';

/** Each network's own Accounts Center: a Facebook tab works only on Facebook's, an Instagram tab only on Instagram's. */
export const CENTER_HOSTS: Readonly<Record<CenterNetwork, string>> = {
  facebook: 'accountscenter.facebook.com',
  instagram: 'accountscenter.instagram.com',
};

/** The network the other one is, for an offer to change both. */
export const OTHER_NETWORK: Readonly<Record<CenterNetwork, CenterNetwork>> = {
  facebook: 'instagram',
  instagram: 'facebook',
};

const NUMBER = /^\d{1,20}$/;

/** An Accounts Center's own address: `https://accountscenter.facebook.com`. */
export const centerHome = (network: CenterNetwork): string => `https://${CENTER_HOSTS[network]}`;

/** Accounts Center's Profiles, where the person's own profile is found when its number isn't known. */
export const profilesAddress = (network: CenterNetwork): string =>
  `${centerHome(network)}/profiles`;

/**
 * An address on one of the Accounts Centers, whole: https, that host exactly, nothing else in it (no name, password or
 * port), and whose it is. Null for anything else.
 */
export function centerUrl(
  href: string,
  base?: string,
): { readonly url: URL; readonly network: CenterNetwork } | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const network = (Object.keys(CENTER_HOSTS) as CenterNetwork[]).find(
    (n) => CENTER_HOSTS[n] === host,
  );
  return network ? { url, network } : null;
}

/** Whether an address is on an Accounts Center at all: one network's, when it says which. */
export function onAccountsCenter(href: string, network?: CenterNetwork): boolean {
  const at = centerUrl(href);
  return at !== null && (network === undefined || at.network === network);
}

/** A profile's username or name page on a network's Accounts Center, by its number; null for anything that isn't one. */
export function centerAddress(
  network: CenterNetwork,
  id: string | null | undefined,
  part: CenterPart,
): string | null {
  return id && NUMBER.test(id) ? `${centerHome(network)}/profiles/${id}/${part}/` : null;
}

/** The number of the profile whose username or name page an address is, on that network's Accounts Center; else null. */
export function centerPageOf(href: string, network: CenterNetwork, part: CenterPart): string | null {
  const at = centerUrl(href);
  if (!at || at.network !== network) return null;
  const match = /^\/profiles\/(\d{1,20})\/(username|name)\/?$/.exec(at.url.pathname);
  return match && match[2] === part ? match[1]! : null;
}

/** Whether an address is a network's Accounts Center's Profiles, or one profile there. */
export function profilesPage(href: string, network: CenterNetwork = 'facebook'): boolean {
  const at = centerUrl(href);
  return at !== null && at.network === network && /^\/profiles(\/\d{1,20})?\/?$/.test(at.url.pathname);
}

/** A link to one profile among Profiles: its number. */
const PROFILE_LINK =
  /^(?:https:\/\/accountscenter\.(?:facebook|instagram)\.com)?\/profiles\/(\d{1,20})\/?(?:[?#].*)?$/i;

/** One row among Profiles: the profile's number, and what it says. */
interface ProfileRow {
  readonly id: string;
  readonly says: string;
  readonly lines: readonly string[];
}

/** The rows among Profiles, as the page shows them: each a link to one profile. */
function profileRows(doc: Document): ProfileRow[] {
  const rows: ProfileRow[] = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    if (!visible(a)) continue;
    const match = PROFILE_LINK.exec(a.getAttribute('href') ?? '');
    if (!match) continue;
    const lines = [...textLines(a, 12), clean(a.getAttribute('aria-label'))].filter(Boolean);
    rows.push({ id: match[1]!, says: clean(a.textContent) || labelOf(a), lines });
  }
  return rows;
}

/** Whether a row says it's this network's profile, and not the other's. */
const rowIsOn = (row: ProfileRow, network: CenterNetwork): boolean =>
  new RegExp(`\\b${network}\\b`, 'i').test(row.says) &&
  !new RegExp(`\\b${OTHER_NETWORK[network]}\\b`, 'i').test(row.says);

/** Whether a row shows this username, as a line of its own or with an @ before it. */
const rowShows = (row: ProfileRow, username: string): boolean => {
  const u = username.toLowerCase();
  return row.lines.some((line) =>
    line
      .toLowerCase()
      .split(/[\s·•|,]+/)
      .some((word) => word === u || word === `@${u}`),
  );
};

/**
 * The person's own profile among Accounts Center's Profiles, by its number: on Facebook, the one row that says
 * Facebook; on Instagram, the row that says Instagram and shows the username they're signed in to on instagram.com,
 * or else the only row that says Instagram. Null when it can't tell which, or there's none.
 */
export function profileRowOn(
  doc: Document,
  network: CenterNetwork,
  username?: string | null,
): string | null {
  const rows = profileRows(doc).filter((row) => rowIsOn(row, network));
  const ids = new Set(rows.map((row) => row.id));
  if (network === 'instagram' && username) {
    const theirs = new Set(rows.filter((row) => rowShows(row, username)).map((row) => row.id));
    if (theirs.size) return theirs.size === 1 ? [...theirs][0]! : null;
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

/** What Meta asks the person for on Accounts Center before it goes on: only they answer it. */
export type Asking = 'password' | 'code' | 'confirm';

/** Meta asking to be sure it's them, with a way to pick (a password, a code) and Continue, before any box. */
const CONFIRM_YOU = /\b(confirm|verify) (your identity|it['’]s you|that this is your account)\b/i;
const PASSWORD_FIELD = /\bpassword\b/i;
const CODE_FIELD = /\b(code|pin|passcode)\b/i;
/** The boxes the extension types in there, by their labels: never taken for Meta asking for something. */
const OWN_BOXES = /^(username|first name|middle name( \(optional\))?|last name|surname|name)\s*\*?$/i;
/** Where Meta asks it: a box over the page, or a heading. */
const ASKED_IN = '[role="dialog"], [role="alertdialog"], h1, h2, h3, [role="heading"]';

/**
 * What Meta asks the person for on Accounts Center, when it does: their password (a password box, or one named for
 * it), a code (a box for one, a PIN's, a phone keypad's or a number box), or to confirm it's them ("Confirm it's you",
 * with ways to pick and Continue, before any box shows). The extension types none of these, and its words aren't read
 * as a warning while it asks (decision 25). Null when it asks nothing.
 */
export function askingHere(doc: Document): Asking | null {
  const first = askingFor(doc);
  if (first) return first;
  for (const field of doc.querySelectorAll<HTMLElement>('input:not([type="hidden"]), textarea')) {
    const type = (field.getAttribute('type') ?? 'text').toLowerCase();
    if (['radio', 'checkbox', 'submit', 'button', 'search'].includes(type) || !visible(field))
      continue;
    const named = fieldName(field);
    if (OWN_BOXES.test(named)) continue;
    const says = [named, field.getAttribute('name'), field.getAttribute('id')].join(' ');
    if (PASSWORD_FIELD.test(says)) return 'password';
    if (type === 'tel' || type === 'number' || CODE_FIELD.test(says)) return 'code';
  }
  for (const place of doc.querySelectorAll(ASKED_IN))
    if (visible(place) && textLines(place, 20).some((line) => CONFIRM_YOU.test(line)))
      return 'confirm';
  return null;
}

/** What the network asked the person for, in a note's words. */
export const askedNote = (asking: Asking, network: CenterNetwork = 'facebook'): string =>
  asking === 'code'
    ? `${PLATFORMS[network]} asked for a code`
    : asking === 'confirm'
      ? `${PLATFORMS[network]} asked them to confirm it’s them`
      : `${PLATFORMS[network]} asked for the password`;

/** Instagram's own blocks, as Meta words them on its Accounts Center too: never "Try again later" alone. */
const INSTAGRAM_BLOCKS =
  /\baction blocked\b|\bwe restrict certain activity\b|\bwe suspect automated behaviou?r\b/i;
/** Where Meta puts a block. */
const BLOCKED_IN = '[role="dialog"], [role="alertdialog"], [role="alert"], h1, h2, [role="heading"]';
/**
 * Meta's answer about the name or username itself ("You can't change your name right now", "…too often"): said to the
 * person, never a block on the account.
 */
const ABOUT_THE_PART = /\b(your|this|that|the|a|new) (user ?)?name\b|\bname standards\b/i;

/**
 * Meta's warnings on an Accounts Center page: Facebook's, and Instagram's block, each once, as Meta worded them. Never
 * its answer about the name or username, and none while Meta asks the person for something (the caller asks
 * `askingHere` first).
 */
export function centerWarnings(doc: Document, href: string): string[] {
  const found = new Set(readWarnings(doc, href).filter((line) => !ABOUT_THE_PART.test(line)));
  for (const place of doc.querySelectorAll(BLOCKED_IN)) {
    if (!visible(place)) continue;
    for (const line of textLines(place, 40))
      if (line.length <= 300 && INSTAGRAM_BLOCKS.test(line) && !ABOUT_THE_PART.test(line))
        found.add(clean(line));
  }
  return [...found].slice(0, 5);
}

/** Boxes a username or a name might be typed in: plain ones only. */
export const FIELDS =
  'input:not([type]), input[type="text"], input[type="search"], [role="textbox"]';
/** Anything in a box over the page that could be typed in: Meta's box to be sure has none. */
export const ANY_BOX =
  'input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="textbox"]';
/** Meta's button that saves it. */
export const DONE = /^(done|save|save changes)$/i;

/** What's in a box: a plain box's value, or the words in one drawn to write in. */
export const valueOf = (box: HTMLElement): string =>
  clean('value' in box && typeof box.value === 'string' ? box.value : box.textContent);

/** The boxes in the box on top whose label says these words, shown: never a code's, or one beside a password. */
export function boxesLabelled(doc: Document, label: RegExp): HTMLElement[] {
  const place = placesOf(doc)[0]!;
  return [...place.querySelectorAll<HTMLElement>(FIELDS)].filter(
    (field) =>
      visible(field) &&
      !field.matches('[autocomplete="one-time-code"], [inputmode="numeric"]') &&
      !field.closest('form')?.querySelector('input[type="password"]') &&
      label.test(fieldName(field)),
  );
}

/** A box that can't be typed in now: Meta holding it, as it does while a change can't be made. */
export const heldBox = (box: HTMLElement): boolean =>
  box.hasAttribute('readonly') ||
  box.getAttribute('aria-readonly') === 'true' ||
  box.hasAttribute('disabled') ||
  box.getAttribute('aria-disabled') === 'true';

/** The buttons in the box on top saying these words, in sight whether or not they're on yet. */
export function buttonsOnTop(doc: Document, words: RegExp): HTMLElement[] {
  const place = placesOf(doc)[0]!;
  return [...place.querySelectorAll<HTMLElement>(EDITOR_BUTTONS)].filter(
    (b) => words.test(labelOf(b)) && visible(b) && !b.closest('[role="banner"]'),
  );
}

/** Meta's Done (or Save, or Save changes) in the box on top, in sight whether or not it's on yet. */
export const doneButtons = (doc: Document): HTMLElement[] => buttonsOnTop(doc, DONE);

/** The lines in the box on top: what's there before typing, so only Meta's answer after counts. */
export function linesOnTop(doc: Document): Set<string> {
  return new Set(textLines(placesOf(doc)[0]!, 80));
}

/** The lines in a place that are new since `before`: Meta's answer, never the page's own help. */
export const freshLines = (place: Element, before: ReadonlySet<string>): string[] =>
  textLines(place, 80).filter((line) => !before.has(line) && line.length <= 300);

/** The names of the buttons in the box on top, as the outline shows them. */
export const namesOn = (doc: Document): string[] =>
  [...placesOf(doc)[0]!.querySelectorAll(EDITOR_BUTTONS)]
    .filter((b) => visible(b) && !b.closest('[role="banner"]'))
    .slice(0, 12)
    .map((b) => maskText(labelOf(b)).slice(0, 60) || `(${b.tagName.toLowerCase()})`);
