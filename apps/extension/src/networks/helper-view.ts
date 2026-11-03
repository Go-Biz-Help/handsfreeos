/**
 * The AI helper's eyes and hands in a tab (docs/outreach.md, decision 142; core's addons/outreach/helper.ts), for any
 * network: a **view** of the page, its moves, and the learned ways it tries before asking.
 *
 * The view is one numbered line per thing on screen (buttons, links, boxes, headings, dialogs, menus), indented under
 * the part of the page it's in, what's on top first. Words go through the network's own outline masking: its words
 * kept, everything a person wrote as "[2 words]", and the person the step is for as "(their name)". Links show their
 * shape ({1}, {2}… for people's and groups' parts). Nothing else of the page leaves it.
 *
 * Its moves, one at a time and only on the numbers of the last view: a click that clears the way (never on anything
 * whose words take a step or change something: core's `mayClear`, checked here on the element's own words), a press of
 * the step's own button (`mayPress`, and only one that names the person the step is for when it names anyone), a
 * scroll, Escape, or a wait. It never types, and never follows a link to another page.
 *
 * A press gives back the **way** it was found (tag, role, the masked label and words, the part of the page, the menu
 * it was under), which the extension keeps across computers once the page shows the step went: `pressWay` finds and
 * presses one again, only when exactly one thing on the page fits it.
 */
import {
  HELPER_VIEW_MOST,
  mayClear,
  mayPress,
  THEIR_NAME,
  viewLine,
  wayWords,
  type HelperButton,
  type WayShape,
} from '@hfos/core/addons/outreach/helper';
import { clean, textPieces } from './facebook/dom';
import { nameOf, visible } from './facebook/fetch';
import { SiteOutliner, type OutlineSite } from './outline';

/** What can be clicked, pressed or written in. */
const CONTROLS = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="option"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="searchbox"]',
].join(', ');
/** The parts of a page things sit in: a line each, with what's in them under it. */
const PARTS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  'main',
  '[role="main"]',
  'nav',
  '[role="navigation"]',
  '[role="banner"]',
  'aside',
  '[role="complementary"]',
  'article',
  '[role="article"]',
  '[role="feed"]',
  '[role="region"][aria-label]',
  'form',
  '[role="form"]',
  '[role="alert"]',
  '[role="status"]',
].join(', ');
const HEADINGS = 'h1, h2, h3, [role="heading"]';
/** What's drawn over the page: looked at first. */
const ON_TOP = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** What a part or a control is, as the view names it. */
function kindOf(element: Element): string {
  const role = element.getAttribute('role');
  if (role) return role;
  const tag = element.tagName.toLowerCase();
  switch (tag) {
    case 'a':
      return 'link';
    case 'nav':
      return 'navigation';
    case 'aside':
      return 'complementary';
    case 'textarea':
      return 'textbox';
    case 'h1':
    case 'h2':
    case 'h3':
      return 'heading';
    case 'input':
      return `input:${element.getAttribute('type') ?? 'text'}`;
    default:
      return element.hasAttribute('contenteditable') ? 'textbox' : tag;
  }
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The everyday words on a network's buttons and boxes that the helper must read to clear the way, kept in its view
 * as they are when they're the whole of a control's words: "Not now", "Close", "Got it". Short, and nobody's name.
 */
const UI_WORDS = new Set(
  [
    'not now',
    'close',
    'ok',
    'okay',
    'got it',
    'dismiss',
    'skip',
    'later',
    'maybe later',
    'remind me later',
    'continue',
    'done',
    'cancel',
    'back',
    'next',
    'more',
    'see more',
    'show more',
    'see all',
    'more options',
    'more actions',
    'actions',
    'options',
    'menu',
    'open',
    'expand',
    'collapse',
    'allow',
    'allow all cookies',
    'accept all',
    'decline optional cookies',
    'only allow essential cookies',
    'turn on',
    'turn off',
    'try again',
    'reload',
    'refresh',
    'learn more',
    'no thanks',
    'x',
  ].map((w) => w.toLowerCase()),
);

/**
 * Words with whatever a person wrote hidden by the network's masking, and the person the step is for as "(their
 * name)": their whole name where it shows, else their first name. A control's everyday words (`UI_WORDS`) are kept.
 */
export function shapeWords(text: string, site: OutlineSite, theirName: string | null): string {
  const t = clean(text);
  if (!t) return '';
  if (UI_WORDS.has(t.toLowerCase().replace(/[.!?…]+$/, ''))) return t;
  const name = clean(theirName);
  const first = name.split(' ')[0] ?? '';
  for (const part of [name, first.length >= 3 ? first : '']) {
    if (!part) continue;
    const pieces = t.split(new RegExp(`\\b${escaped(part)}\\b`, 'i'));
    if (pieces.length > 1)
      return pieces
        .map((p) => (p.trim() ? site.mask(p.trim()) : ''))
        .join(` ${THEIR_NAME} `)
        .replace(/\s+/g, ' ')
        .trim();
  }
  return site.mask(t);
}

/** Parts whose words say what's wrong ("You can’t send requests right now"): their own text when they have no label. */
const SAYING = '[role="dialog"], [role="alertdialog"], [role="alert"], [role="status"]';

/** A part's name: its label, or for a box or a notice, the start of what it says. */
function partWords(part: Element, site: OutlineSite, theirName: string | null): string {
  const label = part.getAttribute('aria-label');
  if (label) return shapeWords(label, site, theirName);
  if (part.hasAttribute('aria-labelledby')) return shapeWords(nameOf(part), site, theirName);
  if (!part.matches(SAYING)) return '';
  return shapeWords(textPieces(part).slice(0, 12).join(' ').slice(0, 200), site, theirName);
}

/** Whether the element is above or below what the window shows, when Chrome can tell (it draws it). */
function offScreen(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  const rect = element.getBoundingClientRect?.();
  if (!view || !rect || rect.height === 0) return false;
  return rect.bottom < 0 || rect.top > view.innerHeight;
}

/** The view of the page, and the elements its numbers stand for. */
export interface HelperView {
  readonly view: string;
  readonly refs: readonly Element[];
}

/**
 * The view: a heading (the page's address as the outline masks it, the window, how far down it is), then what's drawn
 * on top (dialogs, menus), then the rest of the page, each thing a line, within `most` characters.
 */
export function helperView(
  doc: Document,
  href: string,
  site: OutlineSite,
  theirName: string | null,
  most: number = HELPER_VIEW_MOST,
): HelperView {
  const outliner = new SiteOutliner(site);
  const view = doc.defaultView;
  const heading = [
    `Page: ${outliner.maskLink(href, href)}`,
    view
      ? `Window: ${view.innerWidth}×${view.innerHeight}, scrolled ${Math.round(view.scrollY)} of ${Math.round(
          doc.documentElement.scrollHeight,
        )}`
      : null,
  ].filter((l): l is string => l !== null);
  const refs: Element[] = [];
  const lines: string[] = [];
  let size = heading.join('\n').length;
  let cut = false;
  const seen = new Set<Element>();
  const add = (line: string) => {
    if (cut) return false;
    if (size + line.length + 1 > most - 40) {
      cut = true;
      return false;
    }
    lines.push(line);
    size += line.length + 1;
    return true;
  };
  /** Whether an element is in the network's top bar, which is about the person and is left out, as in the outline. */
  const topBars = new Map<Element, boolean>();
  const inTopBar = (element: Element): boolean => {
    const path: Element[] = [];
    let answer = false;
    for (let e: Element | null = element; e; e = e.parentElement) {
      const known = topBars.get(e);
      if (known !== undefined) {
        answer = known;
        break;
      }
      path.push(e);
      if (site.isTopBar(e)) {
        answer = true;
        break;
      }
    }
    for (const e of path) topBars.set(e, answer);
    return answer;
  };
  /** The network's own words on the page, each once: what it says went wrong is often plain text. */
  const said = new Set<string>();
  const walk = (root: Element, depthOf: (e: Element) => number) => {
    for (const element of root.querySelectorAll('*')) {
      if (cut) return;
      if (seen.has(element)) continue;
      const control = element.matches(CONTROLS);
      const part = !control && element.matches(PARTS);
      const heading = !control && !part && element.matches(HEADINGS);
      if (!control && !part && !heading) {
        // Plain words of the network's own (nothing a person wrote), outside any control: said once each.
        if (element.closest(CONTROLS)) continue;
        for (const node of element.childNodes) {
          if (node.nodeType !== 3) continue;
          const text = clean(node.nodeValue);
          if (text.length < 3 || text.length > 160 || said.has(text) || site.mask(text) !== text)
            continue;
          if (!visible(element) || inTopBar(element)) break;
          said.add(text);
          add(`${'  '.repeat(Math.min(depthOf(element), 12))}text ${JSON.stringify(text)}`);
        }
        continue;
      }
      if (!visible(element) || inTopBar(element)) continue;
      // A control inside another (the words inside a link) is the outer one's.
      if (control && element.parentElement?.closest(CONTROLS)) continue;
      seen.add(element);
      const depth = depthOf(element);
      const words = part
        ? partWords(element, site, theirName)
        : shapeWords(nameOf(element), site, theirName);
      const link = element.closest('a[href]')?.getAttribute('href') ?? null;
      const kind = kindOf(element) + (offScreen(element) ? ' (off screen)' : '');
      refs.push(element);
      if (
        !add(
          viewLine(
            depth,
            refs.length,
            kind,
            words,
            control && link ? outliner.maskLink(link, href) : null,
          ),
        )
      )
        refs.pop();
    }
  };
  /** How many parts it's inside, up to `top`. */
  const depthIn = (top: Element | null) => (element: Element) => {
    let depth = 0;
    for (let e = element.parentElement; e && e !== top; e = e.parentElement)
      if (e.matches(PARTS) && visible(e)) depth++;
    return depth;
  };
  const over = [...doc.querySelectorAll(ON_TOP)].filter(
    (e) => visible(e) && !e.parentElement?.closest(ON_TOP),
  );
  if (over.length) {
    add('On top:');
    for (const top of over.reverse()) {
      if (seen.has(top)) continue;
      seen.add(top);
      refs.push(top);
      if (!add(viewLine(1, refs.length, kindOf(top), partWords(top, site, theirName)))) refs.pop();
      walk(top, (e) => depthIn(top)(e) + 2);
    }
    add('The page:');
  }
  walk(doc.body, depthIn(null));
  if (cut) lines.push('(cut here: there’s more below)');
  return { view: [...heading, ...lines].join('\n'), refs };
}

// ---------- moves ----------

/** One move, on the numbers of the last view. */
export interface HelperMoveAsk {
  readonly do: 'click' | 'scroll' | 'escape' | 'wait' | 'press';
  readonly ref: number | null;
  readonly dir: 'up' | 'down' | null;
}

export interface HelperMoveDone {
  readonly went: boolean;
  /** The element's line, without its number, as the report keeps it. */
  readonly on: string | null;
  /** Why it wasn't taken, in the extension's words. */
  readonly error?: string;
  /** A press: how the step's button was found, to learn. */
  readonly way?: WayShape;
}

/** How long a wait waits, and how long a menu takes to open. */
const WAIT_MS = 2_000;
const OPEN_MS = 900;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** An element's own words, each as the page has it: its label, its name, and what it says (checked here, never sent). */
const ownPieces = (element: Element): string[] => [
  ...new Set(
    [
      clean(element.getAttribute('aria-label')),
      nameOf(element),
      clean(textPieces(element).join(' ')),
    ].filter(Boolean),
  ),
];
const ownWords = (element: Element) => ownPieces(element).join(' · ');

/** The part of the page an element sits in, as a way names it. */
function insideOf(element: Element): string | null {
  const part = element.parentElement?.closest(PARTS);
  return part ? kindOf(part) : null;
}

/** How an element is found again: its tag, role, masked label and words. */
function shapeOf(element: Element, site: OutlineSite, theirName: string | null) {
  const label = element.getAttribute('aria-label');
  const words = clean(textPieces(element).join(' '));
  return {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role'),
    label: label ? shapeWords(label, site, theirName).slice(0, 120) || null : null,
    words: words ? shapeWords(words, site, theirName).slice(0, 120) || null : null,
  };
}

/** The way a pressed element was found, with the menu it was under when one was opened just before. */
export function wayOf(
  element: Element,
  opener: Element | null,
  site: OutlineSite,
  theirName: string | null,
): WayShape {
  const inMenu = element.closest(ON_TOP);
  return {
    ...shapeOf(element, site, theirName),
    inside: insideOf(element),
    menu: opener && inMenu && !inMenu.contains(opener) ? shapeOf(opener, site, theirName) : null,
  };
}

/** The words on a step's buttons around a name ("Add … as a friend", "Invite … to connect"): never a name. */
const BUTTON_FILLER =
  /(?<![\p{L}\p{N}])(as|a|an|to|the|your|you|with|and|of|for|request|send|friend|friends|add|connect|invite|follow|back|confirm|accept|like|page|profile|business)(?![\p{L}\p{N}])/giu;

/**
 * Whether a button names someone other than the person the step is for ("Add Jordan Lee as a friend" beside someone
 * suggested): with their name and the button's own words taken out, a capitalised word is left. A press is never on
 * one.
 */
function namesSomeoneElse(element: Element, theirName: string | null): boolean {
  const name = clean(theirName);
  const first = name.split(' ')[0] ?? '';
  return ownPieces(element).some((piece) => {
    let rest = piece;
    for (const part of [name, first.length >= 3 ? first : ''])
      if (part) rest = rest.replace(new RegExp(`\\b${escaped(part)}(’s|'s)?\\b`, 'gi'), ' ');
    return /(^|[^\p{L}])\p{Lu}\p{Ll}/u.test(rest.replace(BUTTON_FILLER, ' '));
  });
}

/**
 * Whether a link only runs on the page it's on: `#…`, or a `javascript:` one the network's own script answers. A
 * `data:` or `vbscript:` link goes somewhere, so it counts as leaving, as anything else does.
 */
function staysOnPage(href: string): boolean {
  const to = href.trim().toLowerCase();
  if (to.startsWith('data:') || to.startsWith('vbscript:')) return false;
  return to.startsWith('#') || to.startsWith('javascript:');
}

/** Whether a link would take the tab to another page: the helper never follows one. */
function leaves(element: Element): boolean {
  const link = element.closest('a[href]');
  if (!link) return false;
  const href = link.getAttribute('href') ?? '';
  if (!href || staysOnPage(href)) return false;
  try {
    const to = new URL(href, element.ownerDocument.location.href);
    const here = new URL(element.ownerDocument.location.href);
    return to.origin !== here.origin || to.pathname !== here.pathname;
  } catch {
    return true;
  }
}

/**
 * Whether a link would take the tab off the network: the step's own button may be a link to the network's own page
 * that takes the step (Alignable's Connect), which the runner's own check follows up; never one anywhere else.
 */
function leavesSite(element: Element): boolean {
  const link = element.closest('a[href]');
  if (!link) return false;
  const href = link.getAttribute('href') ?? '';
  if (!href || staysOnPage(href)) return false;
  try {
    return (
      new URL(href, element.ownerDocument.location.href).origin !==
      new URL(element.ownerDocument.location.href).origin
    );
  } catch {
    return true;
  }
}

/** Presses an element the way the extension's steps do. */
function pressOn(element: Element): void {
  element.scrollIntoView?.({ block: 'center' });
  (element as HTMLElement).click();
}

/** What the helper's moves remember in a tab: the last view's elements, and what it last clicked open. */
export class HelperHands {
  private refs: readonly Element[] = [];
  private lines: readonly string[] = [];
  private opener: Element | null = null;

  constructor(
    private readonly site: OutlineSite,
    private readonly theirName: () => string | null,
  ) {}

  /** A fresh view; `fresh` forgets what an earlier step opened. */
  look(doc: Document, href: string, fresh: boolean): string {
    if (fresh) this.opener = null;
    const seen = helperView(doc, href, this.site, this.theirName());
    this.refs = seen.refs;
    this.lines = seen.view.split('\n');
    return seen.view;
  }

  private lineOf(ref: number): string | null {
    const line = this.lines.find((l) => l.trimStart().startsWith(`[${ref}] `));
    return line
      ? line
          .trim()
          .replace(/^\[\d+\]\s+/, '')
          .slice(0, 200)
      : null;
  }

  async move(
    doc: Document,
    ask: HelperMoveAsk,
    button: HelperButton | null,
  ): Promise<HelperMoveDone> {
    const element = ask.ref === null ? null : (this.refs[ask.ref - 1] ?? null);
    const on = ask.ref === null ? null : this.lineOf(ask.ref);
    const gone = { went: false, on, error: 'That isn’t on the page any more.' };
    switch (ask.do) {
      case 'wait':
        await pause(WAIT_MS);
        return { went: true, on: null };
      case 'escape': {
        const target = (doc.activeElement as HTMLElement | null) ?? doc.body;
        const view = doc.defaultView;
        if (!view) return { went: false, on: null };
        for (const type of ['keydown', 'keyup'] as const)
          target.dispatchEvent(
            new view.KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true }),
          );
        return { went: true, on: null };
      }
      case 'scroll': {
        const view = doc.defaultView;
        if (!view) return { went: false, on };
        const by = (ask.dir === 'up' ? -1 : 1) * Math.max(300, view.innerHeight * 0.8);
        if (element?.isConnected) element.scrollBy?.({ top: by });
        else view.scrollBy({ top: by });
        await pause(OPEN_MS);
        return { went: true, on };
      }
      case 'click': {
        if (!element?.isConnected) return gone;
        if (!mayClear(ownWords(element)))
          return { went: false, on, error: 'It doesn’t click anything that takes a step.' };
        if (leaves(element))
          return { went: false, on, error: 'It doesn’t follow links to other pages.' };
        pressOn(element);
        this.opener = element;
        await pause(OPEN_MS);
        return { went: true, on };
      }
      case 'press': {
        if (!element?.isConnected) return gone;
        if (!button || !mayPress(ownWords(element), button))
          return { went: false, on, error: 'That isn’t the step’s own button.' };
        if (namesSomeoneElse(element, this.theirName()))
          return { went: false, on, error: 'That button is for someone else.' };
        if (leavesSite(element))
          return { went: false, on, error: 'It doesn’t follow links off the network.' };
        const way = wayOf(element, this.opener, this.site, this.theirName());
        // Answered as it presses: a link that takes the step may open another page.
        pressOn(element);
        return { went: true, on, way };
      }
    }
  }

  /**
   * A learned way, pressed: its menu opened first when it has one, then the one thing on the page that fits it, only
   * when it's the step's own button and for nobody else. Whether it was pressed (the step's own check says whether it
   * went).
   */
  async pressWay(doc: Document, way: WayShape, button: HelperButton): Promise<boolean> {
    const theirName = this.theirName();
    const fits = (
      element: Element,
      part: Pick<WayShape, 'tag' | 'role' | 'label' | 'words'>,
    ): boolean => {
      if (element.tagName.toLowerCase() !== part.tag) return false;
      if ((element.getAttribute('role') ?? null) !== part.role) return false;
      const shape = shapeOf(element, this.site, theirName);
      return (
        wayWords(shape.label) === wayWords(part.label) &&
        wayWords(shape.words) === wayWords(part.words)
      );
    };
    const only = (
      part: Pick<WayShape, 'tag' | 'role' | 'label' | 'words'>,
      inside?: string | null,
    ) => {
      const found = [...doc.querySelectorAll(part.tag)].filter(
        (e) => visible(e) && fits(e, part) && (inside === undefined || insideOf(e) === inside),
      );
      return found.length === 1 ? found[0]! : null;
    };
    if (way.menu) {
      const opener = only(way.menu);
      if (!opener || !mayClear(ownWords(opener)) || leaves(opener)) return false;
      pressOn(opener);
      await pause(OPEN_MS);
    }
    const target = only(way, way.inside);
    if (!target || !mayPress(ownWords(target), button)) return false;
    if (namesSomeoneElse(target, theirName) || leavesSite(target)) return false;
    pressOn(target);
    return true;
  }
}
