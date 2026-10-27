/**
 * Alignable's own readers (partners stage 6c; the Instagram and Alignable plan's part 1, "Reading"), built from the
 * owner's Check Alignable (0.66.0, 19 Oct 2026). What its steps and Find partners need, read off the pages Check opened:
 *
 * - **A search for businesses** (/biz/search): each result's owner and business, what kind and where, and its Connect
 *   (`react-connect-button`), all tied to Alignable's id for the business (`result_id`).
 * - **Your connections** (My Network): each `connection-row`, its business by id (/biz/businesses/<id>) and its
 *   Message (/biz/conversations?with_business_id=<id>, or from 0.94.0 Alignable's newer /biz/messages/new).
 * - **Posts:** on a group's page (a town's own group is /groups/<town-st>) and a discussion's, each with its author, its
 *   words, its likes and its Connect; a forum question's answers (`discussion-comment`), and whether its box to answer
 *   in is there (`discussion-comment-reply-form`).
 * - **A business's page** (/<town-st>/<business>): its names, its town, its Elevator Pitch, About Us, My Ideal Customer
 *   and its ideal partner (who they say they refer with: Find partners' best clue), its tags, which of Connect,
 *   Recommend, Refer and Message it shows, and from the owner's report of 26 Oct 2026 (0.94.0) whether you're
 *   connected: its own Remove Connection.
 * - **Messages:** the conversations down the side (`conversationInSidebar`), and the one open: who, its box and Send,
 *   and from the owner's Check of 21 Oct 2026 (0.83.0) its messages, each the person's or theirs, and who wrote last.
 *
 * It reads by Alignable's own test ids, its links' addresses and its words, never class names. Everything here is what
 * the page showed. Check notes only how many of each it found, never what they say (../../jobs/report.ts).
 */
import { measuredSide } from '../facebook/chat';
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import type { Named, ProfileRef } from '../facebook/types';
import { aboutUsOf, codeBoxIn, idealOf } from './own-profile';

const HOST = 'https://www.alignable.com';
/** How many of each a read keeps: enough to go on with, never a whole page's worth. */
const MOST = 40;
/** A conversation's latest messages, and as much of each as a reader keeps: Instagram's chat reader's. */
const MESSAGES_MOST = 20;
const TEXT_MOST = 2_000;
/**
 * My Network's rows, all of them: Save my connections reads the list a screen at a time and keeps each once, so a read
 * that stopped at the first few would never get past them. Alignable's own cap is far above any small business's.
 */
const CONNECTIONS_MOST = 5_000;
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
  /** Its own Connect, by Alignable's id for it: you're not connected, nor asked. */
  readonly connect: boolean;
  /** You're connected with them: their page shows their own Remove Connection (/biz/connections/<their id>). */
  readonly connected: boolean;
  readonly recommend: boolean;
  readonly refer: boolean;
  /** Its own Message: to its conversation by Alignable's id for it, or Alignable's newer one, beside its own buttons. */
  readonly message: boolean;
}

/** A conversation down the side of Messages. */
export interface ChatRow {
  readonly name: string;
  readonly preview: string | null;
  readonly when: string | null;
}

/** A message in the conversation open: the person's or theirs, what it says, and when Alignable says it was sent. */
export interface ChatMessage {
  readonly from: 'me' | 'them';
  readonly text: string;
  readonly when: string | null;
}

/** The conversation open on Messages: with whom, its box and Send, its latest messages, and who wrote last. */
export interface ChatOpen {
  readonly name: string | null;
  readonly profile: ProfileRef | null;
  readonly box: boolean;
  readonly send: boolean;
  /** Oldest first, as far as the page has drawn them: its latest few. */
  readonly messages: readonly ChatMessage[];
  /** Whose the last message is: null with none read. */
  readonly last: ChatMessage['from'] | null;
}

/**
 * Someone their notifications say engaged with them (the plan's "whoever likes, comments on or recommends you"): who,
 * by their business's address, and how. A like is a reaction.
 */
export interface Engaged extends Named {
  readonly profile: ProfileRef;
  readonly kind: 'reaction' | 'comment' | 'recommend';
}

/** Everything Alignable's readers found on a page. Plain data: it crosses from the tab as JSON. */
export type AlignableFound = {
  readonly businesses: readonly Business[];
  /** On Notifications: who liked, commented on or recommended them. */
  readonly engaged: readonly Engaged[];
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

/** Where a link leads that ties a business's page to its id, and the id it carries there. */
type IdWay = (a: Element, url: URL) => string | null;
const idAt =
  (path: RegExp): IdWay =>
  (_a, url) =>
    path.test(url.pathname) ? idIn(url) : null;

/**
 * The id a business's own page ties it to: its Refer's, its Recommend's, its Remove Connection's once you're
 * connected, then its Connect's or Message's. Never the first link with an id: its page links to other businesses too.
 */
export function idOfPage(root: ParentNode, base: string): string | null {
  const links = linksIn(root, base);
  const ways: readonly IdWay[] = [
    idAt(REFER_AT),
    idAt(RECOMMEND_AT),
    removeConnectionOf,
    idAt(CONNECT_AT),
    idAt(MESSAGE_AT),
  ];
  for (const way of ways)
    for (const { a, url } of links) {
      const id = way(a, url);
      if (id) return id;
    }
  return null;
}

const hasLink = (root: ParentNode, base: string, path: RegExp) =>
  linksIn(root, base).some(({ url }) => path.test(url.pathname));

/**
 * Whether a business's page has this link of its own: one carrying Alignable's id for it when the page has one, never
 * another business's (one its page suggests, say).
 */
const ownLink = (root: ParentNode, base: string, path: RegExp, id: string | null) =>
  linksIn(root, base).some(
    ({ url }) => path.test(url.pathname) && (id === null || idIn(url) === id),
  );

export const CONNECT_AT = /^\/biz\/connection_requests\//i;
export const MESSAGE_AT = /^\/biz\/conversations\/?$/i;
/**
 * Alignable's newer Message (the owner's report of 26 Oct 2026, 0.94.0): /biz/messages/new?recipient_ids=…&to_user=…,
 * to the person by their own id, never their business's. So it's a business's own only by where it sits
 * (`ownNewMessage`); in a list's row, it's the row's.
 */
export const MESSAGE_NEW_AT = /^\/biz\/messages\/new\/?$/i;
/** A business's Refer and Recommend, each carrying Alignable's id for it. */
const REFER_AT = /^\/forward_referral_card\//i;
const RECOMMEND_AT = /^\/biz\/recommendations\/new\/?$/i;
/**
 * Once you're connected, their page's own Remove Connection (the same report): a link to /biz/connections/<their id>,
 * which says so. A link there that says anything else isn't taken for one.
 */
const CONNECTION_AT = /^\/biz\/connections\/([A-Za-z0-9_-]{1,64})\/?$/i;
const REMOVE = /^remove connection$/i;

/** The business a Remove Connection is for, by Alignable's id in its address; null for any other link. */
export function removeConnectionOf(a: Element, url: URL): string | null {
  const id = CONNECTION_AT.exec(url.pathname)?.[1] ?? null;
  if (!id) return null;
  return REMOVE.test(clean(a.textContent) || clean(a.getAttribute('aria-label'))) ? id : null;
}

/** A Message: to a business's conversation, or Alignable's newer one, to someone by their id. */
const isMessage = (url: URL) =>
  MESSAGE_AT.test(url.pathname) ||
  (MESSAGE_NEW_AT.test(url.pathname) && !!url.searchParams.get('recipient_ids'));

/** Whether a part of the page that's one business's alone (a list's row, a search's result) has its Message. */
const hasMessage = (root: ParentNode, base: string) =>
  linksIn(root, base).some(({ url }) => isMessage(url));

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
      message: hasMessage(root, base),
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
  return [...doc.querySelectorAll(PART('connection-row'))]
    .slice(0, CONNECTIONS_MOST)
    .flatMap((row) => {
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
          message: hasMessage(row, base),
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
export function likesIn(root: Element): number | null {
  for (const span of root.querySelectorAll('span')) {
    if (!/^like$/i.test(clean(span.textContent))) continue;
    const count = countOf(clean(span.previousElementSibling?.textContent));
    if (count !== null) return count;
  }
  return null;
}

/**
 * The posts on the page: each found by its Comment, a link to its discussion (/biz/discussions/<id>), and read from the
 * nearest part around it that names its author (`root`, where its runner finds its Like: ./auto.ts). A discussion's own
 * page has its post first, then its answers, each read on its own (`answersOn`).
 */
export function postParts(
  doc: Document,
  base: string,
): { readonly root: Element; readonly thread: Thread }[] {
  const found: { readonly root: Element; readonly thread: Thread }[] = [];
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
      root,
      thread: {
        author: author ? { name: author.name, profile: author.profile } : null,
        url: key,
        when: whenIn(root),
        text: textOf(words),
        likes: likesIn(root),
        connect: hasLink(root, base, CONNECT_AT),
      },
    });
    if (found.length >= MOST) break;
  }
  return found;
}

const postsOn = (doc: Document, base: string): Thread[] =>
  postParts(doc, base).map((part) => part.thread);

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

/**
 * Whose a link on a business's page is, by the business it names: theirs (`page`'s), another's, or nobody's. By
 * Alignable's id when it carries one (a Refer, Recommend, Connect, Message or Remove Connection), else by the business's
 * page it leads to, which is theirs only at their own address.
 */
function whoseLink(url: URL, page: ProfileRef): 'theirs' | 'other' | null {
  const id = idIn(url) ?? CONNECTION_AT.exec(url.pathname)?.[1] ?? null;
  if (id) return id === page.id ? 'theirs' : 'other';
  const to = businessRef(url, null);
  if (!to) return null;
  return page.username !== null && to.username === page.username ? 'theirs' : 'other';
}

/** How far up from a Message its own buttons are looked for, however many boxes Alignable wraps them in. */
const OWN_ROW_STEPS = 10;

/**
 * Whether a business's page has its own Message in Alignable's newer shape (`MESSAGE_NEW_AT`), which names nobody's
 * business: only one whose nearest part of the page naming any business names theirs alone, as their header and their
 * row of buttons do beside their own Refer, Recommend or Remove Connection. Never one in a part naming another business
 * (a business it suggests, with its own Connect; a post or an answer by another), nor in an answer, nor one with no
 * business named near it: then it's nobody's that can be told.
 */
function ownNewMessage(root: Element, base: string, page: ProfileRef): boolean {
  if (!page.id) return false;
  return linksIn(root, base).some(({ a, url }) => {
    if (!MESSAGE_NEW_AT.test(url.pathname) || !url.searchParams.get('recipient_ids')) return false;
    if (a.closest(PART('discussion-comment'))) return false;
    for (
      let up = a.parentElement, steps = 0;
      up && root.contains(up) && steps < OWN_ROW_STEPS;
      up = up.parentElement, steps++
    ) {
      const named = linksIn(up, base).flatMap(({ url: u }) => {
        const whose = whoseLink(u, page);
        return whose ? [whose] : [];
      });
      if (named.length) return named.every((whose) => whose === 'theirs');
    }
    return false;
  });
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
  const profile = businessRef(url, id);
  const town = linksIn(main, base)
    .map(({ url: u }) => parts(u))
    .find((p) => p.length === 1 && TOWN.test(p[0]!))?.[0];
  return {
    name,
    title: clean(main.querySelector('h2[title]')?.textContent) || null,
    profile,
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
    // Its own Connect and Message, by its id. Its Connect goes once it's asked: its runner looks for that after pressing.
    connect: ownLink(main, base, CONNECT_AT, id),
    // Connected already: its own Remove Connection, by its id (the owner's report, 26 Oct 2026). Never another's.
    connected:
      id !== null && linksIn(main, base).some(({ a, url: u }) => removeConnectionOf(a, u) === id),
    recommend: hasLink(main, base, RECOMMEND_AT),
    refer: hasLink(main, base, REFER_AT),
    // Its Message by its id, or Alignable's newer one where it sits among its own buttons.
    message:
      ownLink(main, base, MESSAGE_AT, id) ||
      (profile !== null && ownNewMessage(main, base, profile)),
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

/** The writing in a part of the page outside a message's card, a line a piece: who sent it, and when. */
const besideCard = (part: Element, card: Element): string[] =>
  [...part.querySelectorAll('*')]
    .filter((el) => el.childElementCount === 0 && !card.contains(el) && !el.closest('svg'))
    .map((el) => clean(el.textContent))
    .filter(Boolean);

/** The most lines a message's row has beside its card: who sent it, when, and one more Alignable may add. */
const ROW_LINES = 3;

/**
 * A message's row (the owner's Check, 21 Oct 2026): the nearest part around its card (`rel-card-message`) with its
 * sender's picture in it, never one holding another card or more writing than who sent it and when, so a conversation's
 * first message never takes the business card above it for its own. However many boxes Alignable wraps around each,
 * it's the same row. No picture: the row is as far as it goes.
 */
function rowOf(card: Element): { readonly row: Element; readonly picture: Element | null } {
  let row: Element = card;
  for (let up = card.parentElement, steps = 0; up && steps < 10; up = up.parentElement, steps++) {
    const another = [...up.querySelectorAll(PART('rel-card-message'))].some((c) => c !== card);
    if (another || besideCard(up, card).length > ROW_LINES) break;
    row = up;
    const picture = [...up.querySelectorAll('img')].find((img) => !card.contains(img));
    if (picture) return { row, picture };
  }
  return { row, picture: null };
}

/** Whether two businesses are different ones, by whichever of Alignable's id and address both have. */
const differ = (a: ProfileRef, b: ProfileRef) =>
  (a.id !== null && b.id !== null && a.id !== b.id) ||
  (a.username !== null && b.username !== null && a.username !== b.username);

/**
 * Whose a message is, by its sender's picture: theirs starts its row with their picture in a link to their business
 * (the business the conversation is with, when its header says which), and the person's own ends it with a picture
 * alone. A row with no picture goes by the side of the conversation it sits on: theirs against the left, the person's
 * against the right. Null when nothing says.
 */
function whoseCard(
  card: Element,
  picture: Element | null,
  them: ProfileRef | null,
  conversation: Element,
  base: string,
): ChatMessage['from'] | null {
  if (picture) {
    const link = picture.closest('a[href]');
    const url = link ? urlOf(link.getAttribute('href'), base) : null;
    const to = url ? businessRef(url, idIn(url)) : null;
    return to && !(them && differ(to, them)) ? 'them' : 'me';
  }
  try {
    const side = measuredSide(card, conversation);
    return side === 'left' ? 'them' : side === 'right' ? 'me' : null;
  } catch {
    return null;
  }
}

/** What a message's card says, its lines kept apart: never Alignable's icons beside it. */
function cardText(card: Element): string {
  const copy = card.cloneNode(true) as Element;
  for (const icon of copy.querySelectorAll('svg, button')) icon.remove();
  for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
  for (const block of copy.querySelectorAll('p, div')) block.append('\n');
  return (copy.textContent ?? '')
    .split('\n')
    .map((line) => clean(line))
    .filter(Boolean)
    .join('\n')
    .slice(0, TEXT_MOST);
}

/**
 * The open conversation's messages, oldest first: each card (`rel-card-message`, never one inside another), whose it
 * is, what it says, and the time its row shows after who sent it. The latest few, as Instagram's chat reader keeps.
 */
function messagesIn(
  doc: Document,
  base: string,
  them: ProfileRef | null,
  write: Element | null,
): ChatMessage[] {
  const cards = [...doc.querySelectorAll(PART('rel-card-message'))].filter(
    (card) => !card.parentElement?.closest(PART('rel-card-message')),
  );
  if (!cards.length) return [];
  // The conversation, for which side a message sits on: the part around its messages and its box to write in.
  const conversation = around(write ? [...cards, write] : cards) ?? doc.body;
  return cards
    .flatMap((card) => {
      const { row, picture } = rowOf(card);
      const from = whoseCard(card, picture, them, conversation, base);
      const text = cardText(card);
      if (!from || !text) return [];
      return [{ from, text, when: besideCard(row, card)[1] ?? null }];
    })
    .slice(-MESSAGES_MOST);
}

export function chatOpen(doc: Document, base: string): ChatOpen | null {
  const header = doc.querySelector(PART('channel-header-loaded'));
  const write = doc.querySelector(PART('full-view-write-message'));
  if (!header && !write) return null;
  const link = header
    ? linksIn(header, base).find(({ url }) => businessRef(url, idIn(url)) !== null)
    : undefined;
  const box = write?.querySelector<HTMLElement>('[contenteditable="true"], textarea');
  const profile = link ? businessRef(link.url, idIn(link.url)) : null;
  const messages = messagesIn(doc, base, profile, write);
  return {
    name: clean(link?.a.textContent) || null,
    profile,
    box: !!box && visible(box),
    send: doc.querySelector(PART('messaging-send-external')) !== null,
    messages,
    last: messages[messages.length - 1]?.from ?? null,
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
/** What a notification says someone did: recommended them, commented or answered, or liked; anything else, nothing. */
const ENGAGED: readonly (readonly [Engaged['kind'], RegExp])[] = [
  ['recommend', /\brecommend(ed|s)? you\b|\b(wrote|left|gave) you a recommendation\b/i],
  ['comment', /\b(commented|replied|answered|responded)\b/i],
  ['reaction', /\b(liked?|likes|reacted)\b/i],
];

/**
 * Who Notifications say engaged with them (/biz/notifications, the owner's Check, 0.68.0): each notification is drawn
 * around its own link (/biz/notifications/<kind>/<id>), with the business it's from linked by its address and what they
 * did in words between. Read from the newest down; one row a business and kind.
 */
function engagedOn(doc: Document, base: string): Engaged[] {
  const url = urlOf(base, base);
  if (!url || parts(url)[0] !== 'biz' || parts(url)[1] !== 'notifications') return [];
  const main = doc.querySelector('main, [role="main"]') ?? doc.body;
  const found = new Map<string, Engaged>();
  const seen = new Set<Element>();
  for (const { a, url: link } of linksIn(main, base)) {
    const [, kind, id] = parts(link);
    if (parts(link)[1] !== 'notifications' || !kind || !id) continue;
    // The notification: the nearest part around its link that names a business.
    for (let up = a.parentElement, steps = 0; up && steps < 5; up = up.parentElement, steps++) {
      const from = linksIn(up, base)
        .map(({ a: by, url: u }) => ({
          name: clean(by.textContent),
          profile: businessRef(u, idIn(u)),
        }))
        .find((b) => b.name && b.profile);
      if (!from?.profile) continue;
      if (seen.has(up)) break;
      seen.add(up);
      const words = clean(up.textContent);
      const did = ENGAGED.find(([, says]) => says.test(words))?.[0];
      const key = `${from.profile.username ?? from.profile.id}:${did}`;
      if (did && !found.has(key))
        found.set(key, { name: from.name, profile: from.profile, kind: did });
      break;
    }
  }
  return [...found.values()].slice(0, MOST);
}

export function readAlignable(doc: Document, href: string): AlignableFound {
  return {
    businesses: [...searchResults(doc, href).slice(0, MOST), ...connectionRows(doc, href)],
    engaged: engagedOn(doc, href),
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
