/**
 * Small helpers for reading LinkedIn's markup, beside Facebook's (../facebook/dom.ts), whose general ones the readers
 * use as they are. LinkedIn's class names are scrambled too, so nothing here looks at a class: only at tags, roles,
 * labels and links. What's LinkedIn's own:
 *
 * - its addresses, so collecting things by their links is done here with LinkedIn's (./urls.ts);
 * - its top bar, a `header` above the page with Home, My Network, Messaging and Me;
 * - that it writes much of its text twice: once to show, hidden from screen readers, and right after it once more
 *   for them, hidden from sight ("Dana Reyes" then "View Dana Reyes’ profile", "3h •" then "3 hours ago"). Its newer
 *   pages (the owner's outlines of 16 Oct 2026) often put the screen readers' copy first ("Owen Park 3rd+" then the
 *   shown "Owen Park • 3rd+"). The readers read what's shown, as the person sees it, and leave the copy out.
 */
import { clean, elementsIn, labelOf } from '../facebook/dom';
import { linkedinUrl } from './urls';
import { nameFrom } from './vocabulary';

const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;

/** The tags whose text is a line of its own, as in ../facebook/dom.ts. */
const BLOCKS = new Set(
  'ADDRESS ARTICLE ASIDE BLOCKQUOTE BODY DD DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER LI MAIN NAV OL P SECTION TABLE TD TH TR UL'.split(
    ' ',
  ),
);
const BLOCK_ROLES = new Set(['article', 'heading', 'list', 'listitem', 'row']);
const UNREAD = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
/** The words and numbers in a piece of text, to tell a screen readers' copy of it: "3h" and "3 hours ago" share "3". */
const TOKENS = /\p{L}{2,}|\p{N}+/gu;

/** The buttons on a page: what the readers leave out of what someone wrote, and look at for where you stand. */
export const CONTROLS = 'button, [role="button"]';

function documentOf(root: Node): Document {
  return root.nodeType === 9 ? (root as Document) : root.ownerDocument!;
}

/** Whether an element sits in LinkedIn's top bar, whose links (you, your messages) are never the page's. */
export function inTopBar(element: Element): boolean {
  if (element.closest('[role="banner"]')) return true;
  const header = element.closest('header');
  return header !== null && header.closest('main, [role="main"]') === null;
}

/** The page's main column: LinkedIn's rails beside it (your card, suggestions, ads) and its chat windows aren't in it. */
export function mainOf(doc: Document): Element {
  return doc.querySelector('main, [role="main"]') ?? doc.body;
}

/** Whether something is hidden from screen readers: the shown half of a line LinkedIn writes twice, or a closed menu. */
export function hiddenFromReaders(element: Element): boolean {
  return element.closest('[aria-hidden="true"]') !== null;
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

function blockOf(element: Element, root: Node): Node {
  for (let e: Element | null = element; e && e !== root; e = e.parentElement)
    if (BLOCKS.has(e.tagName) || BLOCK_ROLES.has(e.getAttribute('role') ?? '')) return e;
  return root;
}

const tokensOf = (text: string) => new Set(text.toLowerCase().match(TOKENS) ?? []);

/** The first piece of text inside an element that has any. */
function firstText(element: Element): Node | null {
  const walker = documentOf(element).createTreeWalker(element, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if ((node.nodeValue ?? '').trim()) return node;
  return null;
}

/**
 * The screen readers' copies LinkedIn's newer pages write before what they show: the element of text right before a
 * piece hidden from screen readers, on the same line, holding nothing hidden itself, that shares a word or a number
 * with it (`<span>Owen Park 3rd+</span><span aria-hidden="true">Owen Park • 3rd+</span>`). The largest element around
 * that text on its line that doesn't hold the hidden piece, as for a copy after.
 */
function copiesBefore(root: Node): Set<Element> {
  const copies = new Set<Element>();
  const scope = root.nodeType === 9 ? (root as Document).documentElement : (root as Element);
  if (!scope?.querySelectorAll) return copies;
  for (const hidden of scope.querySelectorAll('[aria-hidden="true"]')) {
    if (hidden.parentElement?.closest('[aria-hidden="true"]') || unread(hidden, root)) continue;
    const words = tokensOf(hidden.textContent ?? '');
    const first = words.size ? firstText(hidden) : null;
    if (!first) continue;
    const walker = documentOf(root).createTreeWalker(scope, SHOW_TEXT);
    walker.currentNode = first;
    let before = walker.previousNode();
    while (before && !(before.nodeValue ?? '').trim()) before = walker.previousNode();
    const parent = before?.parentElement;
    if (!parent || hiddenFromReaders(parent) || unread(parent, root)) continue;
    const line = blockOf(hidden, root);
    if (blockOf(parent, root) !== line) continue;
    let copy: Element = parent;
    for (
      let up = copy.parentElement;
      up && up !== line && !up.contains(hidden);
      up = up.parentElement
    )
      copy = up;
    if (copy.contains(hidden) || copy === line || copy.querySelector('[aria-hidden="true"]'))
      continue;
    if ([...tokensOf(copy.textContent ?? '')].some((token) => words.has(token))) copies.add(copy);
  }
  return copies;
}

function inAny(element: Element, set: ReadonlySet<Element>, root: Node): boolean {
  if (!set.size) return false;
  for (let e: Element | null = element; e && e !== root; e = e.parentElement)
    if (set.has(e)) return true;
  return false;
}

const FOLLOWING = 0x4;

/** Whether a node comes after `element` in the page and isn't inside it. */
function follows(node: Node, element: Element): boolean {
  return (element.compareDocumentPosition(node) & FOLLOWING) !== 0 && !element.contains(node);
}

export interface LineOptions {
  /** The most lines to read. */
  readonly max?: number;
  /** Text inside an element under `root` that matches this is left out. */
  readonly exclude?: string;
  /** Only text after this element, not inside it. */
  readonly after?: Element | null;
  /** Only text before this element, not inside it. */
  readonly before?: Element | null;
}

/**
 * The lines of text under `root` that the person sees, in page order, as ../facebook/dom.ts's `textLines` reads
 * them (a block is a line, however many `span`s it's split into; a line break starts a new one), less LinkedIn's
 * copies for screen readers. A copy is the text right after a piece hidden from screen readers, on the same line, in
 * an element of its own, that shares a word or a number with it: "View Dana Reyes’ profile" after "Dana Reyes",
 * "2nd degree connection" after "• 2nd". A hidden "·" between two parts of a line has no words, so the part after it
 * stays. A line LinkedIn writes twice ends with its copy: it stacks them ("Owner", "Acme Plumbing · Self-employed",
 * "Jan 2015 - Present") in `span`s it draws as blocks. A copy written before the hidden piece is left out too
 * (`copiesBefore`).
 */
export function shownLines(root: Node, options: LineOptions = {}): string[] {
  const { max = 60, exclude, after = null, before = null } = options;
  const copies = copiesBefore(root);
  const lines: string[] = [];
  let block: Node | null = null;
  let current = '';
  // The hidden pieces the next one may copy, and the copy being left out.
  let hiddenRun = '';
  let hiddenAt: Element | null = null;
  let copy: Element | null = null;
  const push = () => {
    const line = clean(current);
    if (line && lines[lines.length - 1] !== line) lines.push(line);
    current = '';
  };
  const forget = () => {
    hiddenRun = '';
    hiddenAt = null;
    copy = null;
  };
  const walker = documentOf(root).createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      // A line break starts a new line, but for one inside a copy being left out; the hidden half goes on past it.
      const br = node as Element;
      if (br.tagName !== 'BR' || copy?.contains(br)) continue;
      push();
      if (!hiddenFromReaders(br)) forget();
      continue;
    }
    const value = node.nodeValue ?? '';
    const parent = node.parentElement;
    if (!value.trim() || !parent || unread(parent, root)) continue;
    if (after && !follows(node, after)) continue;
    // Past `before`, everything else is too.
    if (before && (before.contains(node) || follows(node, before))) break;
    if (exclude && excluded(parent, exclude, root)) continue;
    if (inAny(parent, copies, root)) continue;
    const here = blockOf(parent, root);
    if (here !== block) {
      push();
      forget();
      if (lines.length >= max) break;
      block = here;
    }
    if (hiddenFromReaders(parent)) {
      hiddenRun += ` ${value}`;
      hiddenAt = parent;
      copy = null;
    } else if (copy?.contains(parent)) {
      continue;
    } else if (hiddenAt && !parent.contains(hiddenAt)) {
      // The copy is the largest element around this piece, on its line, that doesn't hold the hidden half.
      let candidate: Element = parent;
      for (let up = candidate.parentElement; up && up !== here && !up.contains(hiddenAt);) {
        candidate = up;
        up = up.parentElement;
      }
      const hidden = tokensOf(hiddenRun);
      const shared = [...tokensOf(candidate.textContent ?? '')].some((token) => hidden.has(token));
      forget();
      if (shared) {
        // LinkedIn draws each line it writes twice as a line of its own, however the boxes around it are tagged.
        push();
        copy = candidate;
        continue;
      }
    } else {
      forget();
    }
    // Pieces split by the page are words apart, but for punctuation: "Thanks <a>Sam</a>!", "#<b>plumbing</b>".
    const join =
      current && !/[\s(#@‘“]$/.test(current) && !/^[\s.,!?;:)’”…]/.test(value) ? ' ' : '';
    current += join + value;
  }
  push();
  return lines.slice(0, max);
}

/** An element's shown text on one line. */
export function shownText(element: Element, exclude?: string): string {
  return shownLines(element, { exclude }).join(' ');
}

/** What a button or link says: its shown words and its label for screen readers, each when it has one. */
export function wordsOf(element: Element): string[] {
  const words = [labelOf(element), shownText(element)].filter(Boolean);
  return [...new Set(words)];
}

/** The buttons and links under `root` before `end` (when given), outside the top bar, in page order. */
export function controlsIn(root: Element, end: Element | null = null): Element[] {
  return [...root.querySelectorAll(`${CONTROLS}, a[href]`)].filter(
    (control) => !inTopBar(control) && (!end || (!follows(control, end) && !end.contains(control))),
  );
}

/**
 * The names some links carry: first the shown words of each link, then the labels of the links and of the pictures
 * in them ("Dana Reyes’s profile picture" gives "Dana Reyes"). Words come first because a picture's label is the less
 * sure.
 */
export function namesOn(anchors: readonly Element[]): string[] {
  const texts = anchors.map((anchor) => shownLines(anchor, { max: 1 })[0]);
  const labels = anchors.flatMap((anchor) => [
    anchor.getAttribute('aria-label'),
    ...[...anchor.querySelectorAll('img[alt], [aria-label]')].map(
      (e) => e.getAttribute('alt') ?? e.getAttribute('aria-label'),
    ),
  ]);
  return [...texts, ...labels].map(nameFrom).filter(Boolean);
}

/** One thing a page links to, with every link to it and the box around them, as ../facebook/dom.ts's. */
export interface Linked<T> {
  readonly key: string;
  readonly value: T;
  readonly anchors: readonly Element[];
  /** The largest box around its first link that holds no link to anything else of the same sort. */
  readonly card: Element;
}

/**
 * Everything of one sort that a part of the page links to (members, chats, notifications), each once, in page order,
 * as ../facebook/dom.ts's `collectLinked` finds Facebook's. `parse` says what a link points to and its key; two
 * links with one key are the same thing.
 */
export function collectLinked<T>(
  root: Element,
  base: string,
  parse: (url: URL) => { key: string; value: T } | null,
  skip?: (anchor: Element) => boolean,
): Linked<T>[] {
  const keyOf = new Map<Element, string>();
  const found = new Map<string, { value: T; anchors: Element[] }>();
  for (const element of elementsIn(root)) {
    if (element.tagName !== 'A') continue;
    const href = element.getAttribute('href');
    if (!href || skip?.(element)) continue;
    const url = linkedinUrl(href, base);
    const parsed = url ? parse(url) : null;
    if (!parsed) continue;
    keyOf.set(element, parsed.key);
    const entry = found.get(parsed.key);
    if (entry) entry.anchors.push(element);
    else found.set(parsed.key, { value: parsed.value, anchors: [element] });
  }
  return [...found].map(([key, entry]) => ({
    key,
    value: entry.value,
    anchors: entry.anchors,
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

/** Your own name, from the picture on the top bar's Me: LinkedIn shows it there on every page. */
export function yourName(doc: Document): string | null {
  for (const control of doc.querySelectorAll(`${CONTROLS}, a[href]`)) {
    if (!inTopBar(control) || !/\bme$/i.test(shownText(control))) continue;
    const picture = control.querySelector('img[alt]');
    const name = nameFrom(picture?.getAttribute('alt'));
    if (name) return name;
  }
  return null;
}
