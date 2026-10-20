/**
 * The page outline, for any network: the shape of a page with everything people wrote taken out, so the readers can
 * be tuned to the real page without anyone seeing who or what was on it. Each network's kit says what's its own: its
 * addresses and the words in them, its phrases around a name, its top bar (./facebook/outline.ts,
 * ./linkedin/outline.ts).
 *
 * It keeps tags, roles, the network's own words and labels, and the shape of each link. Anything a person wrote (a
 * name, a message, a post, a group's name) becomes "[2 words]", and the people, groups, chats and posts that links
 * point to become {1}, {2}…, the same number each time the same one comes up. Pictures' addresses and scrambled class
 * names are left out. It is plain text, so the person can read it before sending it.
 */
import { clean } from './facebook/dom';
import { frameDocumentOf, shadowOf } from './shadow';

/** What a network's outline keeps, hides and leaves out. */
export interface OutlineSite {
  /** "Facebook", for the line that leaves its top bar out. */
  readonly name: string;
  /** A link on its pages as a URL, or null when it leads anywhere else. */
  readonly url: (href: string, base: string) => URL | null;
  /** Whether a part of an address is one of its own words, kept as it is: by itself, or for where it is. */
  readonly isPathWord: (part: string, at?: number, parts?: readonly string[]) => boolean;
  /** How any other part of an address is hidden: as a whole, by default. */
  readonly maskPart?: (part: string, token: (value: string) => string) => string;
  /** The host its links are on, left out of each link's shape. */
  readonly host: string;
  /** Text with whatever a person wrote hidden, and its own words kept. */
  readonly mask: (text: string) => string;
  readonly maskTitle: (title: string) => string;
  /** The values kept as they are in a link's query, and the names of its tracking, dropped. */
  readonly queryKept: ReadonlySet<string>;
  readonly queryDropped: RegExp;
  /** Whether an element is its top bar, which is about the person and is left out. */
  readonly isTopBar: (element: Element) => boolean;
  /** Attributes worth seeing on its pages besides the ones every outline keeps. */
  readonly alsoKept?: readonly string[];
  /** The boxes it draws parts of its pages in out of reach of the page's look-ups, opened even when kept closed. */
  readonly shadowHosts?: string;
}

/** The attributes worth seeing. Labels among them go through the same hiding as text. */
const KEPT = [
  'role',
  'aria-label',
  'aria-current',
  'aria-hidden',
  'aria-level',
  'aria-selected',
  'aria-expanded',
  'aria-posinset',
  'aria-setsize',
  'dir',
  'contenteditable',
  'data-pagelet',
  'data-ad-comet-preview',
  'data-ad-preview',
  'data-testid',
  'data-scope',
  'alt',
  'title',
  'placeholder',
  'href',
] as const;
const LABELS = new Set(['aria-label', 'aria-placeholder', 'alt', 'title', 'placeholder']);
const LEFT_OUT = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta']);

/** "[2 words]": how many words someone wrote, and nothing of them. */
export function wordsIn(text: string): string {
  const count = text.split(' ').filter(Boolean).length;
  return count === 0 ? '' : `[${count} word${count === 1 ? '' : 's'}]`;
}

/** What a network's text masking goes by. */
export interface MaskRules {
  /** A day with no time could be a birthday: said to be a date, not which. */
  readonly isDate?: (text: string) => boolean;
  /** The network's own words, kept as they are. */
  readonly kept: (text: string) => boolean;
  /** Its phrases with someone's name or words in them: the parts in brackets are hidden, the rest kept. */
  readonly shapes: readonly RegExp[];
}

/** Text with whatever a person wrote hidden, by a network's rules. Shapes need the `d` flag, for where each part is. */
export function maskWith(text: string, rules: MaskRules): string {
  const t = clean(text);
  if (rules.isDate?.(t)) return '(a date)';
  if (!t || rules.kept(t)) return t;
  for (const shape of rules.shapes) {
    const match = shape.exec(t);
    if (!match?.indices) continue;
    let out = '';
    let at = 0;
    for (let group = 1; group < match.length; group++) {
      const span = match.indices[group];
      if (!span) continue;
      out += t.slice(at, span[0]) + wordsIn(match[group] ?? '');
      at = span[1];
    }
    return out + t.slice(at);
  }
  return wordsIn(t);
}

export class SiteOutliner {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly site: OutlineSite) {}

  private token(value: string): string {
    let token = this.tokens.get(value);
    if (!token) {
      token = `{${this.tokens.size + 1}}`;
      this.tokens.set(value, token);
    }
    return token;
  }

  /** A link's shape: the network's words in it kept, names and numbers turned into {1}, {2}… */
  maskLink(href: string, base: string): string {
    if (href.startsWith('#')) return '#';
    const url = this.site.url(href, base);
    if (!url) return /^(https?:)?\/\//i.test(href) ? '(another site)' : '(not a page)';
    const token = (value: string) => this.token(value);
    const parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });
    const path = parts
      .map((part, at) =>
        this.site.isPathWord(part, at, parts)
          ? part
          : this.site.maskPart
            ? this.site.maskPart(part, token)
            : token(part.toLowerCase()),
      )
      .join('/');
    const query = [...url.searchParams]
      .filter(([name]) => !this.site.queryDropped.test(name))
      .map(
        ([name, value]) => `${name}=${this.site.queryKept.has(name) ? value : this.token(value)}`,
      );
    const host = url.hostname === this.site.host ? '' : url.hostname;
    return `${host}/${path}${url.pathname.endsWith('/') && path ? '/' : ''}${query.length ? `?${query.join('&')}` : ''}`;
  }

  /** An element's kept attributes, as `name=value`, with labels and links hidden. */
  private attributesOf(element: Element, base: string): string[] {
    const out: string[] = [];
    for (const name of [...KEPT, ...(this.site.alsoKept ?? [])]) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      const shown =
        name === 'href'
          ? this.maskLink(value, base)
          : LABELS.has(name)
            ? this.site.mask(value)
            : value.replace(/\d{5,}/g, (digits) => this.token(digits));
      out.push(`${name}=${JSON.stringify(shown)}`);
    }
    return out;
  }

  /**
   * What an element draws out of reach of the page's look-ups (./shadow.ts): its shadow root, or a frame's own page
   * when it can be read.
   */
  private insideOf(element: Element): ShadowRoot | Document | null {
    const hosts = this.site.shadowHosts;
    return (
      shadowOf(element, hosts !== undefined && element.matches(hosts)) ?? frameDocumentOf(element)
    );
  }

  /**
   * The outline of everything under `root`, one element a line, `max` lines at most. What's drawn inside a shadow root
   * or a frame comes under its element, after "#shadow-root" or "#document"; a top bar is only ever the page's own.
   */
  outline(root: Element, base: string, max: number): string[] {
    const lines: string[] = [];
    const indent = (depth: number) => '  '.repeat(Math.min(depth, 60));
    const walk = (element: Element, depth: number, inner = false): void => {
      if (lines.length >= max) return;
      const tag = element.tagName.toLowerCase();
      if (LEFT_OUT.has(tag)) return;
      const attributes = this.attributesOf(element, base);
      if (!inner && this.site.isTopBar(element)) {
        lines.push(
          `${indent(depth)}${tag} ${attributes.join(' ')} (${this.site.name}'s top bar, left out)`,
        );
        return;
      }
      const texts = [...element.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => this.site.mask(node.nodeValue ?? ''))
        .filter(Boolean);
      const children = [...element.children];
      const inside = this.insideOf(element);
      // Pages wrap everything in layers of bare boxes: one with nothing of its own and a single child is skipped.
      if ((tag === 'div' || tag === 'span') && attributes.length === 0 && texts.length === 0) {
        if (children.length === 0 && !inside) return;
        if (children.length === 1 && !inside) return walk(children[0]!, depth, inner);
      }
      const head = `${indent(depth)}${[tag, ...attributes].join(' ')}`;
      if (tag === 'svg' || tag === 'img' || tag === 'video') {
        lines.push(head);
        return;
      }
      if (children.length === 0 && !inside) {
        lines.push(
          texts.length ? `${head} ${texts.map((t) => JSON.stringify(t)).join(' ')}` : head,
        );
        return;
      }
      lines.push(head);
      for (const node of element.childNodes) {
        if (node.nodeType === 1) walk(node as Element, depth + 1, inner);
        else if (node.nodeType === 3) {
          const text = this.site.mask(node.nodeValue ?? '');
          if (text && lines.length < max) lines.push(`${indent(depth + 1)}${JSON.stringify(text)}`);
        }
      }
      const page = inside?.nodeType === 9;
      const top: ParentNode | null = page ? (inside as Document).body : inside;
      if (!top?.children.length || lines.length >= max) return;
      lines.push(`${indent(depth + 1)}${page ? '#document' : '#shadow-root'}`);
      for (const child of [...top.children]) walk(child, depth + 2, true);
    };
    walk(root, 0);
    return lines;
  }
}

/** What a read found, as the outline's heading counts it: any network's read has these. */
export interface Found {
  readonly kind: string;
  readonly profile?: unknown;
  readonly group?: unknown;
  readonly people?: readonly unknown[];
  readonly groups?: readonly unknown[];
  readonly invitations?: readonly unknown[];
  readonly posts?: readonly unknown[];
  readonly chats?: readonly unknown[];
  readonly chat?: { readonly messages: readonly unknown[] };
  readonly notices?: readonly unknown[];
  readonly warnings: readonly unknown[];
}

export interface OutlineOptions {
  /** The extension's version, so we know which readers made the counts. */
  readonly version?: string;
  /** What the readers found on the page, counted in the outline's heading. */
  readonly found?: Found;
  /** The window's size, which decides the page's layout. */
  readonly window?: { readonly width: number; readonly height: number };
  readonly maxLines?: number;
}

function counted(found: Found): string {
  const counts: [string, number][] = [
    ['people', found.people?.length ?? 0],
    ['groups', found.groups?.length ?? 0],
    ['invitations', found.invitations?.length ?? 0],
    ['posts', found.posts?.length ?? 0],
    ['chats', found.chats?.length ?? 0],
    ['messages', found.chat?.messages.length ?? 0],
    ['notifications', found.notices?.length ?? 0],
    ['warnings', found.warnings.length],
  ];
  const parts = counts.filter(([, n]) => n > 0).map(([what, n]) => `${n} ${what}`);
  if (found.profile) parts.unshift('a profile');
  if (found.group) parts.unshift('a group');
  return parts.length ? parts.join(', ') : 'nothing';
}

/** The whole outline as text, with a heading that says which page it was and what the readers found there. */
export function outlineWith(
  site: OutlineSite,
  doc: Document,
  href: string,
  options: OutlineOptions = {},
): string {
  const outliner = new SiteOutliner(site);
  const max = options.maxLines ?? 10_000;
  const body = outliner.outline(doc.body, href, max);
  const heading = [
    `HandsFreeOS Social ${options.version ?? ''} · page outline`.replace(/\s+·/, ' ·'),
    `Page: ${options.found?.kind ?? 'unknown'} ${outliner.maskLink(href, href)}`,
    doc.title ? `Title: ${site.maskTitle(doc.title)}` : null,
    options.found ? `Found: ${counted(options.found)}` : null,
    options.window ? `Window: ${options.window.width}×${options.window.height}` : null,
    'Hidden: [2 words] is something a person wrote; {1}, {2}… are the people, groups and chats links lead to.',
    body.length >= max ? `Cut at ${max} lines.` : null,
    '',
  ].filter((line): line is string => line !== null);
  return [...heading, ...body].join('\n');
}
