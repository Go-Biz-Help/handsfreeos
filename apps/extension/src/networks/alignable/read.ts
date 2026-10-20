/**
 * Alignable's own readers (partners stage 6c; the Instagram and Alignable plan's part 1, "Reading"), built from the
 * owner's Check Alignable (0.66.0, 19 Oct 2026). What its steps and Find partners need, read off the pages Check opened:
 *
 * - **A search for businesses** (/biz/search): each result's owner and business, what kind and where, and its Connect
 *   (`react-connect-button`), all tied to Alignable's id for the business (`result_id`).
 * - **Your connections** (My Network): each `connection-row`, its business by id (/biz/businesses/<id>) and its
 *   Message (/biz/conversations?with_business_id=<id>).
 * - **Posts:** on a group's page (a town's own group is /groups/<town-st>) and a discussion's, each with its author, its
 *   words, its likes and its Connect; a forum question's answers (`discussion-comment`), and whether its box to answer
 *   in is there (`discussion-comment-reply-form`).
 * - **A business's page** (/<town-st>/<business>): its names, its town, its Elevator Pitch, About Us, My Ideal Customer
 *   and its ideal partner (who they say they refer with: Find partners' best clue), its tags, and which of Connect,
 *   Recommend, Refer and Message it shows.
 * - **Messages:** the conversations down the side (`conversationInSidebar`), and the one open: who, its box and Send.
 *
 * It reads by Alignable's own test ids, its links' addresses and its words, never class names. Everything here is what
 * the page showed. Check notes only how many of each it found, never what they say (../../jobs/report.ts).
 */
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import type { Named, ProfileRef } from '../facebook/types';
import { aboutUsOf, codeBoxIn, idealOf } from './own-profile';

const HOST = 'https://www.alignable.com';
/** How many of each a read keeps: enough to go on with, never a whole page's worth. */
const MOST = 40;
/** A town in its addresses: "austin-tx". */
const TOWN = /^[a-z0-9]+(-[a-z0-9]+)*-[a-z]{2}$/i;
/** A business's name in its addresses. */
const SLUG = /^[A-Za-z0-9_-]{1,100}$/;
/** Alignable's id for a business, as its links carry it. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A town's own pages under its address, never a business. */
const TOWN_PAGES = new Set(['forum', 'questions', 'events', 'groups']);
/** How long ago, as Alignable prints it: "4h", "5 days ago", "about 4 hours ago", "Yesterday". */
const WHEN =
  /^((about |over |almost )?\d+\s*(s|m|h|d|w|mo|y|sec|secs|min|mins|minutes?|hr|hrs|hours?|days?|weeks?|months?|years?)( ago)?|just now|yesterday|today)$/i;
export const PART = (id: string) => `[data-testid="${id}"]`;

/** Ideal customer or partner, as a business says it: its words, who and where, and its tags. */
export type Ideal = NonNullable<ReturnType<typeof idealOf>>;

/** A business in a list: a search's results, your connections. Its owner is `name`; `business` is its own name. */
export interface Business extends Named {
  readonly profile: ProfileRef;
  readonly business: string | null;
  /** The lines under its name, as shown: what kind of business, where. */
  readonly details: readonly string[];
  /** Its row has Connect: you're not connected, nor asked. */
  readonly connect: boolean;
  /** Its row has Message: a connection. */
  readonly message: boolean;
}

/**
 * A connection request someone sent you, on My Network's Requests (`requests-360-table`): who, why they say they'd
 * connect, and its Accept. The owner's Check (0.67.0) found the table empty, so its rows are read by their links and
 * buttons till one shows.
 */
export interface Request extends Named {
  readonly profile: ProfileRef;
  readonly business: string | null;
  /** What its second column says: why they'd like to connect. */
  readonly reason: string | null;
  readonly accept: boolean;
}

/** A post on a group's page or a discussion's: its author, its words, its likes, and its Connect. */
export interface Thread {
  readonly author: Named | null;
  /** Its discussion's own page. */
  readonly url: string | null;
  readonly when: string | null;
  readonly text: string;
  readonly likes: number | null;
  /** Its author's Connect is beside it: you're not connected, nor asked. */
  readonly connect: boolean;
}

/** An answer on a forum question's page, or a reply to one. */
export interface Answer {
  readonly author: Named | null;
  readonly when: string | null;
  readonly text: string;
  readonly connect: boolean;
  /** A reply to another answer, under it. */
  readonly reply: boolean;
}

/** A business's own page. */
export interface BusinessPage {
  /** Its heading, and the line under it. */
  readonly name: string | null;
  readonly title: string | null;
  readonly profile: ProfileRef | null;
  readonly town: string | null;
  readonly pitch: string | null;
  readonly about: string | null;
  readonly customer: Ideal | null;
  readonly partner: Ideal | null;
  readonly tags: readonly string[];
  readonly connect: boolean;
  readonly recommend: boolean;
  readonly refer: boolean;
  readonly message: boolean;
}

/** A conversation down the side of Messages. */
export interface ChatRow {
  readonly name: string;
  readonly preview: string | null;
  readonly when: string | null;
}

/** The conversation open on Messages: with whom, and its box and Send. */
export interface ChatOpen {
  readonly name: string | null;
  readonly profile: ProfileRef | null;
  readonly box: boolean;
  readonly send: boolean;
}

/** Everything Alignable's readers found on a page. Plain data: it crosses from the tab as JSON. */
export type AlignableFound = {
  readonly businesses: readonly Business[];
  readonly requests: readonly Request[];
  readonly threads: readonly Thread[];
  readonly answers: readonly Answer[];
  readonly chats: readonly ChatRow[];
  readonly business: BusinessPage | null;
  readonly chat: ChatOpen | null;
  /** A forum question's box to answer in, and its Send. */
  readonly answerBox: boolean;
  /**
   * A box over the page asking for a code Alignable emailed them, with its Continue: what its profile's editors ask
   * for before a change (the owner's Check, 0.68.0).
   */
  readonly codeBox: boolean;
};

export function urlOf(href: string | null | undefined, base: string): URL | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return /^(www\.)?alignable\.com$/i.test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

const parts = (url: URL) => url.pathname.split('/').filter(Boolean);

/** Alignable's id for a business, from whichever part of a link carries it. */
export function idIn(url: URL): string | null {
  for (const name of ['business_id', 'with_business_id', 'result_id']) {
    const id = url.searchParams.get(name);
    if (id && ID.test(id)) return id;
  }
  const [first, second, third] = parts(url);
  if (
    first === 'biz' &&
    second === 'businesses' &&
    third &&
    third !== 'my_profile' &&
    ID.test(third)
  )
    return third;
  if (first === 'forward_referral_card' && second && ID.test(second)) return second;
  if (first === 'biz' && second === 'recommendations') {
    const id = url.searchParams.get('id');
    if (id && ID.test(id)) return id;
  }
  return null;
}

/** A business by its address in its town (/<town-st>/<business>), or by Alignable's id (/biz/businesses/<id>). */
export function businessRef(url: URL, id: string | null): ProfileRef | null {
  const [first = '', second = '', third] = parts(url);
  if (TOWN.test(first) && SLUG.test(second) && !TOWN_PAGES.has(second.toLowerCase()) && !third)
    return {
      id: id && ID.test(id) ? id : null,
      username: `${first}-${second}`.toLowerCase().slice(0, 100),
      url: `${HOST}/${first.toLowerCase()}/${second}`,
    };
  const byId = idIn(url);
  if (first === 'biz' && second === 'businesses' && byId)
    return { id: byId, username: null, url: `${HOST}/biz/businesses/${byId}` };
  return null;
}

/** The links in a part of the page, made whole on Alignable. */
export const linksIn = (root: ParentNode, base: string) =>
  [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].flatMap((a) => {
    const url = urlOf(a.getAttribute('href'), base);
    return url ? [{ a, url }] : [];
  });

/**
 * The id a business's own page ties it to: its Refer's, its Recommend's, then its Connect's or Message's. Never the
 * first link with an id: its page links to other businesses too.
 */
export function idOfPage(root: ParentNode, base: string): string | null {
  const links = linksIn(root, base);
  for (const path of [
    /^\/forward_referral_card\//i,
    /^\/biz\/recommendations\/new\/?$/i,
    CONNECT_AT,
    MESSAGE_AT,
  ])
    for (const { url } of links) {
      const id = path.test(url.pathname) ? idIn(url) : null;
      if (id) return id;
    }
  return null;
}

const hasLink = (root: ParentNode, base: string, path: RegExp) =>
  linksIn(root, base).some(({ url }) => path.test(url.pathname));

export const CONNECT_AT = /^\/biz\/connection_requests\//i;
export const MESSAGE_AT = /^\/biz\/conversations\/?$/i;

/** The nearest part of the page holding all of these. */
function around(elements: readonly Element[]): Element | null {
  const [first, ...rest] = elements;
  for (let up: Element | null = first ?? null; up; up = up.parentElement)
    if (rest.every((el) => up!.contains(el))) return up;
  return null;
}

/** What a part of the page says, its lines and paragraphs kept apart by a space. */
function textOf(element: Element | null | undefined): string {
  if (!element) return '';
  const copy = element.cloneNode(true) as Element;
  // A See More is the page's, never what they wrote.
  for (const button of copy.querySelectorAll('button')) button.remove();
  for (const br of copy.querySelectorAll('br')) br.replaceWith(' ');
  for (const block of copy.querySelectorAll('p, div')) block.append(' ');
  return clean(copy.textContent);
}

/** A number as a count shows it: "3", "1,204". */
const countOf = (text: string): number | null => {
  const digits = /^\d[\d,]*$/.test(text) ? Number(text.replace(/,/g, '')) : NaN;
  return Number.isFinite(digits) ? digits : null;
};

// ------------------------------------------------------------------------------------------------ businesses

/**
 * A search's results: each tied to its business by `result_id` on its links, the owner's name first (its avatar's),
 * then the business's name (its other titled link), what kind and where, and its Connect.
 */
function searchResults(doc: Document, base: string): Business[] {
  const byId = new Map<string, HTMLAnchorElement[]>();
  for (const { a, url } of linksIn(doc, base)) {
    const id = url.searchParams.get('result_id');
    if (!id || !ID.test(id)) continue;
    byId.set(id, [...(byId.get(id) ?? []), a]);
  }
  const found: Business[] = [];
  for (const [id, anchors] of byId) {
    const root = around(anchors);
    if (!root) continue;
    const home = anchors.find((a) => {
      const url = urlOf(a.getAttribute('href'), base);
      return url !== null && TOWN.test(parts(url)[0] ?? '');
    });
    const homeUrl = home ? urlOf(home.getAttribute('href'), base) : null;
    const profile = homeUrl ? businessRef(homeUrl, id) : null;
    if (!profile) continue;
    const titled = anchors.filter((a) => a.hasAttribute('title') && clean(a.textContent));
    const name = clean(titled[0]?.textContent);
    if (!name) continue;
    const businessLink = [...titled].reverse().find((a) => clean(a.textContent) !== name) ?? null;
    const details = businessLink
      ? [
          ...[...(businessLink.parentElement?.children ?? [])]
            .filter((el) => el !== businessLink && el.tagName !== 'A')
            .map((el) => clean(el.textContent)),
          clean(businessLink.parentElement?.nextElementSibling?.textContent),
        ].filter(Boolean)
      : [];
    found.push({
      name,
      profile,
      business: businessLink ? clean(businessLink.textContent) : null,
      details,
      connect:
        root.querySelector(PART('react-connect-button')) !== null ||
        hasLink(root, base, CONNECT_AT),
      message: hasLink(root, base, MESSAGE_AT),
    });
    if (found.length >= MOST) break;
  }
  return found;
}

/** My Network's Requests: each row's business, its names, why they'd connect, and its Accept. */
function requestRows(doc: Document, base: string): Request[] {
  const table = doc.querySelector(PART('requests-360-table'));
  if (!table) return [];
  return [...table.querySelectorAll('tbody tr')].slice(0, MOST).flatMap((row) => {
    if (row.querySelector(PART('connection-requests-360-empty'))) return [];
    const link = linksIn(row, base).find(({ url }) => businessRef(url, idIn(url)) !== null);
    if (!link) return [];
    const profile = businessRef(link.url, idIn(link.url) ?? idAround(row, base));
    if (!profile) return [];
    const cells = [...row.querySelectorAll('td')];
    const lines = [...(cells[0]?.querySelectorAll('a, span, div') ?? [])]
      .filter((el) => el.children.length === 0)
      .map((el) => clean(el.textContent))
      .filter(Boolean);
    const name = lines[0] ?? clean(link.a.textContent);
    if (!name) return [];
    return [
      {
        name,
        profile,
        business: lines.find((line) => line !== name) ?? null,
        reason: textOf(cells[1]) || null,
        accept: [...row.querySelectorAll('button, a')].some((el) =>
          /^(accept|confirm|connect)$/i.test(clean(el.textContent)),
        ),
      },
    ];
  });
}

/** The id a part of the page ties its business to: the first of its links that carries one. */
function idAround(root: ParentNode, base: string): string | null {
  for (const { url } of linksIn(root, base)) {
    const id = idIn(url);
    if (id) return id;
  }
  return null;
}

/** My Network's rows: each business by its id, its owner's and business's names, and its Message. */
function connectionRows(doc: Document, base: string): Business[] {
  return [...doc.querySelectorAll(PART('connection-row'))].slice(0, MOST).flatMap((row) => {
    const link = row.querySelector(PART('connection-row-profile-link'));
    const url = urlOf(link?.getAttribute('href'), base);
    const profile = url ? businessRef(url, idIn(url)) : null;
    if (!profile) return [];
    const lines = [
      ...(row.querySelector(PART('connection-row-summary'))?.querySelectorAll('span') ?? []),
    ]
      .filter((span) => span.children.length === 0)
      .map((span) => clean(span.textContent))
      .filter(Boolean);
    const name = lines[0] ?? clean(link?.getAttribute('aria-label'));
    if (!name) return [];
    return [
      {
        name,
        profile,
        business: lines[1] ?? null,
        details: lines.slice(2),
        connect: hasLink(row, base, CONNECT_AT),
        message: hasLink(row, base, MESSAGE_AT),
      },
    ];
  });
}

// ------------------------------------------------------------------------------------------------ posts

/** Who wrote a post or an answer: the first link to a business in it that has words, and its business's name. */
export function authorIn(
  root: Element,
  base: string,
): (Named & { readonly business: string | null }) | null {
  for (const { a, url } of linksIn(root, base)) {
    const profile = businessRef(url, null);
    if (!profile) continue;
    const spans = [...a.querySelectorAll('span')]
      .filter((span) => span.children.length === 0 || !span.querySelector('span'))
      .map((span) => clean(span.textContent))
      .filter(Boolean);
    const name = spans[0] ?? clean(a.textContent);
    if (!name) continue;
    return { name, profile, business: spans.length > 2 ? spans[spans.length - 1]! : null };
  }
  return null;
}

/** When, as it's printed near the top: the first short line that says how long ago. */
function whenIn(root: Element): string | null {
  for (const el of root.querySelectorAll('span, time, a, div')) {
    if (el.children.length) continue;
    const text = clean(el.textContent);
    if (text && WHEN.test(text)) return text;
  }
  return null;
}

/** A post's likes: the count beside the word Like in its counts. */
function likesIn(root: Element): number | null {
  for (const span of root.querySelectorAll('span')) {
    if (!/^like$/i.test(clean(span.textContent))) continue;
    const count = countOf(clean(span.previousElementSibling?.textContent));
    if (count !== null) return count;
  }
  return null;
}

/**
 * The posts on the page: each found by its Comment, a link to its discussion (/biz/discussions/<id>), and read from the
 * nearest part around it that names its author. A discussion's own page has its post first, then its answers, each
 * read on its own (`answersOn`).
 */
function postsOn(doc: Document, base: string): Thread[] {
  const found: Thread[] = [];
  const seen = new Set<string>();
  for (const { a, url } of linksIn(doc, base)) {
    const [first, second, id] = parts(url);
    if (first !== 'biz' || second !== 'discussions' || !id) continue;
    if (a.closest(PART('discussion-comment'))) continue;
    const key = `${HOST}/biz/discussions/${id}`;
    if (seen.has(key)) continue;
    let root: Element | null = a.parentElement;
    for (let steps = 0; root && steps < 8 && !authorIn(root, base); steps++)
      root = root.parentElement;
    if (!root) continue;
    seen.add(key);
    const author = authorIn(root, base);
    // Its words: a box of them with a title (a group's page), else the part between its author and its counts, which a
    // discussion's own page draws as a plain box of words (the owner's Check, 0.67.0).
    const words = root.querySelector('div[title]') ?? bodyOf(root, base);
    found.push({
      author: author ? { name: author.name, profile: author.profile } : null,
      url: key,
      when: whenIn(root),
      text: textOf(words),
      likes: likesIn(root),
      connect: hasLink(root, base, CONNECT_AT),
    });
    if (found.length >= MOST) break;
  }
  return found;
}

/** A post's own part with its words: the first of its parts that names no business and holds no link of its own. */
function bodyOf(root: Element, base: string): Element | null {
  for (const part of root.children) {
    if (part.closest(PART('discussion-comment')) || part.querySelector(PART('discussion-comment')))
      continue;
    if (linksIn(part, base).length) continue;
    if (textOf(part)) return part;
  }
  return null;
}

/** A forum question's answers, and the replies under them, each with its own author, words and Connect. */
function answersOn(doc: Document, base: string): Answer[] {
  return [...doc.querySelectorAll(PART('discussion-comment'))].slice(0, MOST).map((answer) => {
    const own = (el: Element) => el.closest(PART('discussion-comment')) === answer;
    const head = [...answer.querySelectorAll('a[href]')].find(
      (a) => own(a) && clean(a.textContent),
    );
    const url = head ? urlOf(head.getAttribute('href'), base) : null;
    const profile = url ? businessRef(url, null) : null;
    const body = [...answer.querySelectorAll(PART('discussion-comment-body'))].find(own);
    const whenEl = head?.nextElementSibling;
    return {
      author: profile && head ? { name: clean(head.textContent), profile } : null,
      when: clean(whenEl?.textContent) || null,
      text: textOf(body),
      connect: linksIn(answer, base).some(({ a, url: u }) => own(a) && CONNECT_AT.test(u.pathname)),
      reply: answer.parentElement?.closest(PART('discussion-comment')) !== null,
    };
  });
}

// ------------------------------------------------------------------------------------------------ a business's page

/** The Elevator Pitch on a business's page: the words its Read more opens. */
function pitchOn(root: ParentNode): string | null {
  const more = [...root.querySelectorAll('a, button')].find((el) =>
    /^read more$/i.test(clean(el.textContent)),
  );
  if (!more?.parentElement) return null;
  const short = clean(more.parentElement.textContent).replace(/\s*read more$/i, '');
  const whole = clean(more.parentElement.nextElementSibling?.textContent);
  return (whole.length > short.length ? whole : short) || null;
}

export function businessPage(doc: Document, base: string): BusinessPage | null {
  const url = urlOf(base, base);
  if (!url) return null;
  const [first = ''] = parts(url);
  if (!TOWN.test(first) && !(first === 'biz' && parts(url)[1] === 'businesses')) return null;
  const main = doc.querySelector('main, [role="main"]') ?? doc.body;
  const name = clean(main.querySelector('h1[title]')?.textContent) || null;
  if (!name) return null;
  const id = idOfPage(main, base);
  const town = linksIn(main, base)
    .map(({ url: u }) => parts(u))
    .find((p) => p.length === 1 && TOWN.test(p[0]!))?.[0];
  return {
    name,
    title: clean(main.querySelector('h2[title]')?.textContent) || null,
    profile: businessRef(url, id),
    town: town?.toLowerCase() ?? null,
    pitch: pitchOn(main),
    about: aboutUsOf(main),
    customer: idealOf(main, 'customer'),
    partner: idealOf(main, 'partner'),
    tags: [
      ...new Set(
        linksIn(main, base)
          .filter(({ url: u }) => u.searchParams.get('source') === 'profile_featured_tags')
          .map(({ a }) => clean(a.textContent))
          .filter(Boolean),
      ),
    ],
    connect: hasLink(main, base, CONNECT_AT),
    recommend: hasLink(main, base, /^\/biz\/recommendations\/new\/?$/i),
    refer: hasLink(main, base, /^\/forward_referral_card\//i),
    message: hasLink(main, base, MESSAGE_AT),
  };
}

// ------------------------------------------------------------------------------------------------ messages

function chatRows(doc: Document): ChatRow[] {
  return [...doc.querySelectorAll(PART('conversationInSidebar'))].slice(0, MOST).flatMap((row) => {
    const lines = [...row.querySelectorAll('div')]
      .filter((div) => div.children.length === 0)
      .map((div) => clean(div.textContent))
      .filter(Boolean);
    const name = lines[0];
    if (!name) return [];
    return [
      {
        name,
        preview: lines[1] ?? null,
        when: clean(row.querySelector(PART('conversationDate'))?.textContent) || null,
      },
    ];
  });
}

export function chatOpen(doc: Document, base: string): ChatOpen | null {
  const header = doc.querySelector(PART('channel-header-loaded'));
  const write = doc.querySelector(PART('full-view-write-message'));
  if (!header && !write) return null;
  const link = header
    ? linksIn(header, base).find(({ url }) => businessRef(url, idIn(url)) !== null)
    : undefined;
  const box = write?.querySelector<HTMLElement>('[contenteditable="true"], textarea');
  return {
    name: clean(link?.a.textContent) || null,
    profile: link ? businessRef(link.url, idIn(link.url)) : null,
    box: !!box && visible(box),
    send: doc.querySelector(PART('messaging-send-external')) !== null,
  };
}

/** A forum question's box to answer in, with its Send. */
function answerBoxOn(doc: Document): boolean {
  const form = doc.querySelector(PART('discussion-comment-reply-form'));
  if (!form) return false;
  const box = form.querySelector<HTMLElement>('[contenteditable="true"], textarea');
  const send = [...form.querySelectorAll('button')].some((b) =>
    /^send$/i.test(clean(b.textContent)),
  );
  return !!box && send;
}

/** Everything Alignable's readers find on a page. */
export function readAlignable(doc: Document, href: string): AlignableFound {
  return {
    businesses: [...searchResults(doc, href), ...connectionRows(doc, href)].slice(0, MOST),
    requests: requestRows(doc, href),
    threads: postsOn(doc, href),
    answers: answersOn(doc, href),
    chats: chatRows(doc),
    business: businessPage(doc, href),
    chat: chatOpen(doc, href),
    answerBox: answerBoxOn(doc),
    codeBox: codeBoxIn(doc) !== null,
  };
}
