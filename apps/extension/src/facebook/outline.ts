/**
 * The page outline: the shape of a Facebook page with everything people wrote taken out, so the readers can be tuned
 * to the real page without anyone seeing who or what was on it.
 *
 * It keeps tags, roles, Facebook's own words and labels, and the shape of each link. Anything a person wrote (a name,
 * a message, a post, a group's name) becomes "[2 words]", and the people, groups, chats and posts that links point to
 * become {1}, {2}…, the same number each time the same one comes up. Pictures' addresses and Facebook's scrambled
 * class names are left out. It is plain text, so the person can read it before sending it.
 */
import { clean } from './dom';
import type { ReadResult } from './types';
import { facebookUrl, isFacebookPathWord, pathParts } from './urls';
import { BADGE, isDate, isFacebookText, sectionTitleOf } from './vocabulary';

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
const LABELS = new Set(['aria-label', 'alt', 'title', 'placeholder']);
const LEFT_OUT = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta']);

/** Facebook's phrases with someone's name or words in them: the parts in brackets are hidden, the rest kept. */
const SHAPES: readonly RegExp[] = [
  /^(?:profile (?:picture|photo) of|may be an image of|may be a photo of|messages in conversation with|conversation with|seen by|more options for|actions for|see who reacted to|comment by|reply by) (.+)$/di,
  /^you(?: replied to|:) (.+)$/di,
  /^(.+?) replied to (?:you|(.+))$/di,
  /^(.+?) and \d+ others?$/di,
  /^(.+?)['’]s (?:profile|profile picture|cover photo|post|photo|story)$/di,
  /^(.+?) (?:accepted your friend request|sent you a friend request|reacted to your (?:post|comment|photo|video|message)|commented on your (?:post|photo|video)|mentioned you in a (?:comment|post)|replied to your comment|shared your post|posted in|invited you to join|is typing)(.*)$/di,
  /^(?:comment as|reply as|follow|unfollow|add friend|cancel request|message|invite) (.+)$/di,
];

/**
 * Words that say nothing about anyone: short counts ("34", "1,234", "12K") and Facebook's "Active 5m ago". A long
 * number could be a phone number someone sent, so it's hidden.
 */
const PLAIN = /^(\d{1,4}|\d{1,3}(,\d{3})+|\d+(\.\d+)?\s*[km]|active (now|\d+\s?[a-z]+ ago))$/i;

function words(text: string): string {
  const count = text.split(' ').filter(Boolean).length;
  return count === 0 ? '' : `[${count} word${count === 1 ? '' : 's'}]`;
}

/** Text with whatever a person wrote hidden, and Facebook's own words kept. */
export function maskText(text: string): string {
  const t = clean(text);
  // A day with no time could be a birthday: say it's a date, not which.
  if (isDate(t)) return '(a date)';
  if (!t || isFacebookText(t) || BADGE.test(t) || sectionTitleOf(t) || PLAIN.test(t)) return t;
  for (const shape of SHAPES) {
    const match = shape.exec(t);
    if (!match?.indices) continue;
    let out = '';
    let at = 0;
    for (let group = 1; group < match.length; group++) {
      const span = match.indices[group];
      if (!span) continue;
      out += t.slice(at, span[0]) + words(match[group] ?? '');
      at = span[1];
    }
    return out + t.slice(at);
  }
  return words(t);
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

export class Outliner {
  private readonly tokens = new Map<string, string>();

  private token(value: string): string {
    let token = this.tokens.get(value);
    if (!token) {
      token = `{${this.tokens.size + 1}}`;
      this.tokens.set(value, token);
    }
    return token;
  }

  /** A link's shape: Facebook's words in it kept, names and numbers turned into {1}, {2}… */
  maskLink(href: string, base: string): string {
    if (href.startsWith('#')) return '#';
    const url = facebookUrl(href, base);
    if (!url) return /^(https?:)?\/\//i.test(href) ? '(another site)' : '(not a page)';
    const path = pathParts(url)
      .map((part) => (isFacebookPathWord(part) ? part : this.token(part.toLowerCase())))
      .join('/');
    const query = [...url.searchParams]
      .filter(([name]) => !QUERY_DROPPED.test(name))
      .map(([name, value]) => `${name}=${QUERY_KEPT.has(name) ? value : this.token(value)}`);
    const host = url.hostname === 'www.facebook.com' ? '' : url.hostname;
    return `${host}/${path}${url.pathname.endsWith('/') && path ? '/' : ''}${query.length ? `?${query.join('&')}` : ''}`;
  }

  /** An element's kept attributes, as `name=value`, with labels and links hidden. */
  private attributesOf(element: Element, base: string): string[] {
    const out: string[] = [];
    for (const name of KEPT) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      const shown =
        name === 'href'
          ? this.maskLink(value, base)
          : LABELS.has(name)
            ? maskText(value)
            : value.replace(/\d{5,}/g, (digits) => this.token(digits));
      out.push(`${name}=${JSON.stringify(shown)}`);
    }
    return out;
  }

  /** The outline of everything under `root`, one element a line, `max` lines at most. */
  outline(root: Element, base: string, max: number): string[] {
    const lines: string[] = [];
    const indent = (depth: number) => '  '.repeat(Math.min(depth, 60));
    const walk = (element: Element, depth: number): void => {
      if (lines.length >= max) return;
      const tag = element.tagName.toLowerCase();
      if (LEFT_OUT.has(tag)) return;
      const attributes = this.attributesOf(element, base);
      if (element.getAttribute('role') === 'banner') {
        lines.push(`${indent(depth)}${tag} ${attributes.join(' ')} (Facebook's top bar, left out)`);
        return;
      }
      const texts = [...element.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => maskText(node.nodeValue ?? ''))
        .filter(Boolean);
      const children = [...element.children];
      // Facebook wraps everything in layers of bare boxes: one with nothing of its own and a single child is skipped.
      if ((tag === 'div' || tag === 'span') && attributes.length === 0 && texts.length === 0) {
        if (children.length === 0) return;
        if (children.length === 1) return walk(children[0]!, depth);
      }
      const head = `${indent(depth)}${[tag, ...attributes].join(' ')}`;
      if (tag === 'svg' || tag === 'img' || tag === 'video') {
        lines.push(head);
        return;
      }
      if (children.length === 0) {
        lines.push(
          texts.length ? `${head} ${texts.map((t) => JSON.stringify(t)).join(' ')}` : head,
        );
        return;
      }
      lines.push(head);
      for (const node of element.childNodes) {
        if (node.nodeType === 1) walk(node as Element, depth + 1);
        else if (node.nodeType === 3) {
          const text = maskText(node.nodeValue ?? '');
          if (text && lines.length < max) lines.push(`${indent(depth + 1)}${JSON.stringify(text)}`);
        }
      }
    };
    walk(root, 0);
    return lines;
  }
}

export interface OutlineOptions {
  /** The extension's version, so we know which readers made the counts. */
  readonly version?: string;
  /** What the readers found on the page, counted in the outline's heading. */
  readonly found?: ReadResult;
  /** The window's size, which decides Facebook's layout. */
  readonly window?: { readonly width: number; readonly height: number };
  readonly maxLines?: number;
}

function counted(found: ReadResult): string {
  const counts: [string, number][] = [
    ['people', found.people?.length ?? 0],
    ['groups', found.groups?.length ?? 0],
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
export function outlinePage(doc: Document, href: string, options: OutlineOptions = {}): string {
  const outliner = new Outliner();
  const max = options.maxLines ?? 10_000;
  const body = outliner.outline(doc.body, href, max);
  const heading = [
    `HandsFreeOS Social ${options.version ?? ''} · page outline`.replace(/\s+·/, ' ·'),
    `Page: ${options.found?.kind ?? 'unknown'} ${outliner.maskLink(href, href)}`,
    doc.title ? `Title: ${maskTitle(doc.title)}` : null,
    options.found ? `Found: ${counted(options.found)}` : null,
    options.window ? `Window: ${options.window.width}×${options.window.height}` : null,
    'Hidden: [2 words] is something a person wrote; {1}, {2}… are the people, groups and chats links lead to.',
    body.length >= max ? `Cut at ${max} lines.` : null,
    '',
  ].filter((line): line is string => line !== null);
  return [...heading, ...body].join('\n');
}
