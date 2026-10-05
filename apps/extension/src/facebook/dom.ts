/**
 * Small helpers for reading Facebook's markup. They take the page's nodes and never the window, so the tests run them
 * on saved pages. Facebook's class names are scrambled and change every week, so nothing here looks at a class: only
 * at tags, roles, labels and links.
 */
import { facebookUrl } from './urls';

const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;

const BLOCKS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BODY',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL',
]);
/** Roles whose text is a line of its own whatever the tag: Facebook draws lists with `span role="listitem"`. */
const BLOCK_ROLES = new Set(['article', 'heading', 'list', 'listitem', 'row']);
const UNREAD = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
/** A picture of an emoji is labelled with it: a pictograph, or a flag's two letters. */
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

/** Text with Facebook's invisible characters taken out and its spaces evened out. */
export function clean(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function documentOf(root: Node): Document {
  return root.nodeType === 9 ? (root as Document) : root.ownerDocument!;
}

/** Every element under `root`, in page order. */
export function* elementsIn(root: Node): Generator<Element> {
  const walker = documentOf(root).createTreeWalker(root, SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) yield node as Element;
}

export function isHeading(element: Element): boolean {
  return /^H[1-6]$/.test(element.tagName) || element.getAttribute('role') === 'heading';
}

function unread(element: Element, root: Node): boolean {
  for (let e: Element | null = element; e && e !== root; e = e.parentElement)
    if (UNREAD.has(e.tagName) || e.tagName.toLowerCase() === 'svg') return true;
  return false;
}

function excluded(element: Element, selector: string, root: Node): boolean {
  const match = element.closest(selector);
  return match !== null && match !== root && root.contains(match);
}

/**
 * Whether an element's text is a line of its own: a block tag, a role that is one, or Facebook's `dir="auto"`, which
 * it puts on each separate run of text (a name, the line under it) and draws as a block.
 */
function startsLine(element: Element): boolean {
  return (
    BLOCKS.has(element.tagName) ||
    BLOCK_ROLES.has(element.getAttribute('role') ?? '') ||
    element.getAttribute('dir') === 'auto'
  );
}

function blockOf(element: Element, root: Node): Node {
  for (let e: Element | null = element; e && e !== root; e = e.parentElement)
    if (startsLine(e)) return e;
  return root;
}

/**
 * The lines of text under `root`, in order. Words in one block (a `div`, a heading, a list item, a run of text Facebook
 * marks `dir="auto"`) make one line, however many `span`s Facebook split them into: "Owner at <a>Smith Plumbing</a>"
 * is one line. Text inside an element under `root` that matches `exclude` is left out.
 */
export function textLines(root: Node, max = 60, exclude?: string): string[] {
  const lines: string[] = [];
  let block: Node | null = null;
  let current = '';
  const finish = () => {
    const line = clean(current);
    if (line && lines[lines.length - 1] !== line) lines.push(line);
    current = '';
  };
  const walker = documentOf(root).createTreeWalker(root, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? '';
    const parent = node.parentElement;
    if (!value.trim() || !parent || unread(parent, root)) continue;
    if (exclude && excluded(parent, exclude, root)) continue;
    const here = blockOf(parent, root);
    if (here !== block) {
      finish();
      if (lines.length >= max) break;
      block = here;
    }
    const join = current && !/\s$/.test(current) && !/^\s/.test(value) ? ' ' : '';
    current += join + value;
  }
  finish();
  return lines.slice(0, max);
}

/**
 * An element's text with the emoji put back: Facebook draws them as pictures labelled with the emoji itself, so
 * "Thanks <img alt="🙏">" is "Thanks 🙏", and a message that is only an emoji isn't empty.
 */
export function textWithEmoji(element: Element): string {
  let text = '';
  const walker = documentOf(element).createTreeWalker(element, SHOW_ELEMENT | SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 3) text += node.nodeValue ?? '';
    else if ((node as Element).tagName === 'IMG') {
      const alt = (node as Element).getAttribute('alt') ?? '';
      if (EMOJI.test(alt) && !/\p{L}/u.test(alt)) text += alt;
    }
  }
  return clean(text);
}

/**
 * The pieces of text under `root` as the page holds them, each trimmed. React keeps the parts of a sentence it builds
 * apart: "sent ", "You", ": hi" are three pieces, where `textContent` has one line.
 */
export function textPieces(root: Node): string[] {
  const pieces: string[] = [];
  const walker = documentOf(root).createTreeWalker(root, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const piece = (node.nodeValue ?? '').trim();
    if (piece) pieces.push(piece);
  }
  return pieces;
}

/** The nearest element from `element` up to `root` (both included) that matches `selector`. */
export function closestWithin(element: Element, selector: string, root: Element): Element | null {
  for (let e: Element | null = element; e; e = e.parentElement) {
    if (e.matches(selector)) return e;
    if (e === root) break;
  }
  return null;
}

/** The elements under `root` (itself included) that match `selector` and aren't inside another one that does. */
export function outermost(root: Element, selector: string): Element[] {
  const all = [root, ...root.querySelectorAll(selector)].filter((e) => e.matches(selector));
  const matched = new Set(all);
  return all.filter((element) => {
    for (let up = element.parentElement; up && up !== root.parentElement; up = up.parentElement)
      if (matched.has(up)) return false;
    return true;
  });
}

/** What a button or link says: its label for screen readers when it has one, else its text. */
export function labelOf(element: Element): string {
  return clean(element.getAttribute('aria-label')) || clean(element.textContent);
}

/** The labels of every button under `root`, in page order. */
export function buttonLabels(root: ParentNode): string[] {
  return [...root.querySelectorAll('[role="button"], button')].map(labelOf).filter(Boolean);
}

/** Whether an element sits in Facebook's top bar, whose links (you, your notifications) are never the page's. */
export function inTopBar(element: Element): boolean {
  return element.closest('[role="banner"]') !== null;
}

/** A page's tabs (a profile's All, About, Friends…; a group's About, Discussion, People…), outside the top bar. */
export function tabsIn(root: Element): Element | null {
  return [...root.querySelectorAll('[role="tablist"]')].find((tabs) => !inTopBar(tabs)) ?? null;
}

const PRECEDING = 0x2;
const FOLLOWING = 0x4;

/** Whether `element` comes before `other` in the page, and isn't inside it. */
export function isBefore(element: Element, other: Element): boolean {
  return (other.compareDocumentPosition(element) & PRECEDING) !== 0 && !other.contains(element);
}

/** Whether `element` comes after `other` in the page, and isn't inside it. */
export function isAfter(element: Element, other: Element): boolean {
  return (other.compareDocumentPosition(element) & FOLLOWING) !== 0 && !other.contains(element);
}

/**
 * The names some links carry: first the text of each link, then the labels of the links and of the pictures in them
 * ("Profile picture of Jane Doe" gives "Jane Doe"). Text comes first because a picture's label is the less sure.
 */
export function namesOn(anchors: readonly Element[]): string[] {
  const texts = anchors.map((anchor) => textLines(anchor, 1)[0]);
  const labels = anchors.flatMap((anchor) => [
    anchor.getAttribute('aria-label'),
    ...[...anchor.querySelectorAll('img[alt], [aria-label]')].map(
      (e) => e.getAttribute('alt') ?? e.getAttribute('aria-label'),
    ),
  ]);
  return [...texts, ...labels.map(withoutPicturePrefix)].filter((name): name is string =>
    Boolean(name),
  );
}

/** A picture's label without Facebook's words around the name: "Profile picture of Jane Doe" is "Jane Doe". */
export function withoutPicturePrefix(label: string | null): string {
  return clean(label).replace(/^(profile (picture|photo) of|may be an image of)\s+/i, '');
}

/** One thing a page links to, with every link to it and the box around them. */
export interface Linked<T> {
  readonly key: string;
  readonly value: T;
  /** Every link to it, in page order. */
  readonly anchors: readonly Element[];
  /** The largest box around its first link that holds no link to anything else of the same sort. */
  readonly card: Element;
  /** The part of the list it's in, when the page has parts and `sectionOf` was given. */
  readonly section: string | null;
}

export interface CollectOptions {
  /** Links to leave out, like the ones in the top bar. */
  readonly skip?: (anchor: Element) => boolean;
  /** The title an element starts, when it starts a part of the list. */
  readonly sectionOf?: (element: Element) => string | null;
}

/**
 * Everything of one sort that a part of the page links to (people, groups, chats), each once, in page order. `parse`
 * says what a link points to and its key; two links with one key are the same thing.
 */
export function collectLinked<T>(
  root: Element,
  base: string,
  parse: (url: URL) => { key: string; value: T } | null,
  options: CollectOptions = {},
): Linked<T>[] {
  const keyOf = new Map<Element, string>();
  const found = new Map<string, { value: T; anchors: Element[]; section: string | null }>();
  let section: string | null = null;
  for (const element of elementsIn(root)) {
    const title = options.sectionOf?.(element);
    if (title) {
      section = title;
      continue;
    }
    if (element.tagName !== 'A') continue;
    const href = element.getAttribute('href');
    if (!href || options.skip?.(element)) continue;
    const url = facebookUrl(href, base);
    const parsed = url ? parse(url) : null;
    if (!parsed) continue;
    keyOf.set(element, parsed.key);
    const entry = found.get(parsed.key);
    if (entry) entry.anchors.push(element);
    else found.set(parsed.key, { value: parsed.value, anchors: [element], section });
  }
  return [...found].map(([key, entry]) => ({
    key,
    value: entry.value,
    anchors: entry.anchors,
    section: entry.section,
    card: cardOf(entry.anchors[0]!, key, keyOf, root),
  }));
}

/** Climbs from a link while the box above holds no link to something else. */
function cardOf(anchor: Element, key: string, keyOf: Map<Element, string>, root: Element): Element {
  let card = anchor;
  for (let steps = 0; steps < 12 && card !== root; steps++) {
    const up: Element | null = card.parentElement;
    if (!up || holdsAnother(up, key, keyOf)) break;
    card = up;
  }
  return card;
}

function holdsAnother(box: Element, key: string, keyOf: Map<Element, string>): boolean {
  for (const anchor of box.querySelectorAll('a[href]')) {
    const other = keyOf.get(anchor);
    if (other !== undefined && other !== key) return true;
  }
  return false;
}
