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
 * - **Groups** (from 0.95.0, decision 92; drawn from guessed markup till the owner's next Check): the groups a page
 *   lists (a search for groups, the person's own groups) by their links (/groups/<group>), each with how many members,
 *   whether they're in it and the line under its name (`groupCards`); a group's own page, its About and its members
 *   page: its name, members, its own Join and where they stand, and its About (`groupFacts`); and who's in it, each by
 *   their business, its leaders marked (`memberRows`, `groupLeaders`).
 *
 * It reads by Alignable's own test ids, its links' addresses and its words, never class names. Everything here is what
 * the page showed. Check notes only how many of each it found, never what they say (../../jobs/report.ts).
 */
import { measuredSide } from '../facebook/chat';
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import type { Named, ProfileRef } from '../facebook/types';
import { mainOf, nameOf } from '../looking/looks';
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
  /**
   * A request to them waits: one of their own controls says so (Request Sent, Pending), a button or their Connect's
   * own link (0.97.0, for withdrawing it).
   */
  readonly asked: boolean;
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
  /** From 0.95.0 (decision 92): the groups a page lists (a search for groups, the person's own groups). */
  readonly groups: readonly GroupCard[];
  /** On a group's page of its people: who's in it, each by their business, its leaders marked. */
  readonly members: readonly Member[];
  /**
   * A group's own page, its About or a page of its people: left out on any other page, so a report of a business's
   * page or a post's is no longer for it (../../jobs/report.ts keeps only so much).
   */
  readonly group?: GroupPage;
  /** From 0.104.0 (decision 112): the events a list of them shows, left out on any other page. */
  readonly events?: readonly EventCard[];
  /** An event's own page: who's hosting it and who's going. */
  readonly event?: EventPage;
  /** From 0.108.0 (decision 116): who liked a post, while the box of them is open over its page (./likers.ts). */
  readonly likers?: readonly Named[];
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
  return answerParts(doc, base).map(({ read }) => read);
}

/**
 * A forum question's answers and the replies under them, as `answersOn` reads them, each with its own part of the page
 * (`discussion-comment`), where its runner finds its own Like (./auto.ts, decision 116).
 */
export function answerParts(
  doc: Document,
  base: string,
): { readonly answer: Element; readonly read: Answer }[] {
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
      answer,
      read: {
        author: profile && head ? { name: clean(head.textContent), profile } : null,
        when: clean(whenEl?.textContent) || null,
        text: textOf(body),
        connect: linksIn(answer, base).some(
          ({ a, url: u }) => own(a) && CONNECT_AT.test(u.pathname),
        ),
        reply: answer.parentElement?.closest(PART('discussion-comment')) !== null,
      },
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
  return linksIn(root, base).some(
    ({ a, url }) =>
      MESSAGE_NEW_AT.test(url.pathname) &&
      !!url.searchParams.get('recipient_ids') &&
      amongTheirOwn(a, root, base, page),
  );
}

/**
 * Whether a control on a business's page is one of theirs: the nearest part of the page around it naming any business
 * names theirs alone (their header, their row of buttons), never in an answer, and never with no business named near
 * it. Their newer Message is told this way, and from 0.97.0 what their page shows while a request to them waits.
 */
export function amongTheirOwn(
  control: Element,
  root: Element,
  base: string,
  page: ProfileRef,
): boolean {
  if (control.closest(PART('discussion-comment'))) return false;
  for (
    let up = control.parentElement, steps = 0;
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
}

/** What a business's own control says while a request to them waits. */
export const REQUEST_WAITS =
  /^(request sent|requested|pending|invitation sent|connection requested|awaiting (response|approval))$/i;
/** A way to take a request back, by its own words: never a bare Cancel, which closes a box. */
export const REQUEST_TAKE_BACK =
  /^(cancel( connection)? request|withdraw( connection)?( request| invitation)?|remove( connection)? request|undo( connection)? request)$/i;

/**
 * Whether a request to a business waits, by its own controls' words (what it says while it waits, or a way to take it
 * back): its Connect's own link, by its id, or a button among its own (`amongTheirOwn`); never another business's,
 * nor one in a post or an answer.
 */
function requestWaits(main: Element, base: string, page: ProfileRef): boolean {
  if (!page.id) return false;
  return [...main.querySelectorAll(CONTROLS)].some((control) => {
    const words = clean(control.textContent) || clean(control.getAttribute('aria-label'));
    if (!REQUEST_WAITS.test(words) && !REQUEST_TAKE_BACK.test(words)) return false;
    if (control.closest(PART('discussion-comment'))) return false;
    const url = control.matches('a[href]') ? urlOf(control.getAttribute('href'), base) : null;
    if (url && CONNECT_AT.test(url.pathname)) return idIn(url) === page.id;
    return amongTheirOwn(control, main, base, page);
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
    asked: profile !== null && requestWaits(main, base, profile),
    recommend: hasLink(main, base, RECOMMEND_AT),
    refer: hasLink(main, base, REFER_AT),
    // Its Message by its id, or Alignable's newer one where it sits among its own buttons.
    message:
      ownLink(main, base, MESSAGE_AT, id) ||
      (profile !== null && ownNewMessage(main, base, profile)),
  };
}

// ------------------------------------------------------------------------------------------------ groups

/** A group's name in its address: /groups/<group>. */
const GROUP_SLUG = /^[A-Za-z0-9._-]{1,100}$/;
/** What sits at /groups/<word> that's never a group: Alignable's own pages for groups, as far as they can be told. */
const NOT_GROUPS = new Set([
  'search',
  'events',
  'members',
  'about',
  'new',
  'edit',
  'settings',
  'create',
  'my_groups',
  'my-groups',
  'mine',
  'joined',
  'discover',
  'browse',
  'suggested',
  'recommended',
  'popular',
  'trending',
  'nearby',
  'local',
  'all',
  'categories',
  'category',
]);
/** A group's own pages under its address that say what it is: its About, its rules, and its people. */
const GROUP_OWN_PAGES = new Set(['about', 'members', 'leaders', 'admins', 'rules']);
/** Its other pages under its address, never one of its discussions either (as ./site.ts's `GROUP_PAGES`). */
const GROUP_OTHER_PAGES = new Set(['events', 'new', 'edit', 'settings', 'search', 'join', 'leave']);
/** Its pages that list its people: its members, and its leaders where it has a page of them. */
const GROUP_PEOPLE_PAGES = new Set(['members', 'leaders', 'admins']);
/** How many groups a read keeps: a person's own may be many, and a search's screen is a few dozen. */
const GROUPS_MOST = 100;
/** How many of a group's members a read keeps: enough screens of them to go on with. */
const MEMBERS_MOST = 300;
/** As much of a line of a group's About as a read keeps (core's `GROUP_LINE_MOST`), and how many. */
const ABOUT_LINE_MOST = 300;
const ABOUT_LINES = 30;

/** A group's Join, and what it says once the person is in it, or asked and waiting. Never Join Now or Join Free. */
export const JOIN = /^(join|join group|join this group|request to join|ask to join)$/i;
export const JOINED = /^(joined|leave|leave group|member|you['’]re a member|you are a member)$/i;
export const JOIN_ASKED = /^(requested|request sent|pending|cancel request|awaiting approval)$/i;
/** A link to a group that's only a way in: never its name. */
const VIEW = /^(view|view group|open|open group|see group|visit|visit group|go to group)$/i;
/** A section of a group's people that's its leaders, and the mark beside one in a list of them. */
const LEADERS =
  /^(group )?(leaders?|leadership|organizers?|co-?organizers?|admins?|administrators?|moderators?|hosts?)( \(\d[\d,]*\))?$/i;
const LEADER_MARK =
  /^(group )?(leader|organizer|co-?organizer|admin|administrator|moderator|host|owner|founder)$/i;
const ABOUT_HEADING = /^about( this group| the group| us| group)?$/i;
/** A heading of a page of a group's people that starts a section of them: its leaders, or its members. */
const PEOPLE_SECTION = /^(all |other |group )?members?( \(\d[\d,]*\))?$/i;
/** A row's own buttons' words: never a line about them. */
const ROW_CONTROLS =
  /^(connect|connected|message|send message|request sent|pending|follow|following|remove)$/i;
const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const CONTROLS = 'button, [role="button"], a[href]';

/** A group by its address: its name there, its page, and which of its own pages a link is to (null: the group's). */
export function groupOf(
  url: URL,
): { readonly id: string; readonly url: string; readonly page: string | null } | null {
  const all = parts(url);
  // Its Directory of members under /biz since Oct 2026 (decision 138; the owner's look of 31 Oct 2026: "the
  // Directory link, which opens /biz/groups/<slug>/members"): the group's own page as ever.
  const under = all[0]?.toLowerCase() === 'biz' && all[1]?.toLowerCase() === 'groups';
  const [first = '', slug = '', page] = under ? all.slice(1) : all;
  if (first.toLowerCase() !== 'groups' || !GROUP_SLUG.test(slug)) return null;
  if (NOT_GROUPS.has(slug.toLowerCase())) return null;
  return { id: slug, url: `${HOST}/groups/${slug}`, page: page ? page.toLowerCase() : null };
}

/**
 * A group's Directory of its members: /biz/groups/<group>/members since Oct 2026 (decision 138), where
 * /groups/<group>/members shows nothing.
 */
export const membersPage = (group: { readonly id: string }): string =>
  `${HOST}/biz/groups/${group.id}/members`;

/** A group as a link to it showed it: its name in its address, its page, and its name when the page said it. */
export interface GroupLink {
  readonly id: string;
  readonly url: string;
  readonly name: string | null;
}

/** A group as a list of them showed it (a search's, the person's own groups): how many, and whether they're in it. */
export interface GroupCard extends GroupLink {
  readonly members: number | null;
  /** In it (Joined, Leave), or not (its own Join, or asked and waiting); null when its card didn't say. */
  readonly joined: boolean | null;
  /** Asked to join, and waiting. */
  readonly asked: boolean;
  /** The line under its name: what it's about, or where. */
  readonly detail: string | null;
}

/** A group's own page (and its About and members pages): what it says of itself, and where the person stands. */
export interface GroupPage extends GroupCard {
  /** Its own Join, to press. */
  readonly join: boolean;
  /** What its About says, a line a piece. */
  readonly about: readonly string[];
  /** On a page of its people: whether it showed its leaders, as a section of them or a leader's mark on a row. */
  readonly leaders: boolean;
}

/** Someone a group's page of its people shows: by their business, its name, the lines under theirs, and a leader. */
export interface Member extends Named {
  readonly profile: ProfileRef;
  readonly business: string | null;
  readonly lines: readonly string[];
  /** One of its leaders: under its leaders' heading, or marked as one. */
  readonly leader: boolean;
}

/** Whether a part of the page is one of the site's menus: never a group's card, nor a member's row. */
const inMenu = (el: Element) =>
  el.closest('nav, header, footer, [role="navigation"], [role="banner"]') !== null;

/** How many members a group says it has: "1,204 members", "1.2K Members", "Members (1,204)". */
export function membersIn(text: string): number | null {
  const counted =
    /\b(\d[\d,]*(?:\.\d+)?)\s*([km])?\+?\s+members?\b/i.exec(text) ??
    /\bmembers?\s*[:(]\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?\)?/i.exec(text);
  if (!counted) return null;
  const n = Number(counted[1]!.replace(/,/g, ''));
  const times = { k: 1_000, m: 1_000_000 }[counted[2]?.toLowerCase() as 'k' | 'm'] ?? 1;
  return Number.isFinite(n) ? Math.round(n * times) : null;
}

/** The first short line in a part of the page that says how many members. */
function membersOn(root: Element): number | null {
  for (const el of root.querySelectorAll('span, div, p, li, small, strong, a')) {
    const text = clean(el.textContent);
    if (!text || text.length > 60) continue;
    const count = membersIn(text);
    if (count !== null) return count;
  }
  return null;
}

/** The lines in a part of the page that hold no other: a card's or a row's, as shown. */
const leafLines = (root: Element): string[] =>
  [...root.querySelectorAll('span, div, p, li, small, strong, em, a, h1, h2, h3, h4, h5, h6')]
    .filter((el) => el.childElementCount === 0 && !el.closest('svg'))
    .map((el) => clean(el.textContent))
    .filter(Boolean);

/** Whether a line is one of a group's controls' words, a count of its members, or a way in. */
const pageWords = (line: string) =>
  JOIN.test(line) ||
  JOINED.test(line) ||
  JOIN_ASKED.test(line) ||
  VIEW.test(line) ||
  membersIn(line) !== null;

/** Where the person stands with a group, by the controls given: in it, asked, or with its Join to press. */
function standing(controls: readonly HTMLElement[]): {
  readonly joined: boolean;
  readonly asked: boolean;
  readonly join: HTMLElement | null;
} {
  const says = (words: RegExp) => controls.some((c) => words.test(nameOf(c)));
  const joined = says(JOINED);
  const asked = !joined && says(JOIN_ASKED);
  const join = joined || asked ? null : (controls.find((c) => JOIN.test(nameOf(c))) ?? null);
  return { joined, asked, join };
}

/** The groups a part of the page links to, by the name in their addresses, lowercased. */
const groupsIn = (root: ParentNode, base: string) =>
  new Set(
    linksIn(root, base).flatMap(({ url }) => {
      const group = groupOf(url);
      return group ? [group.id.toLowerCase()] : [];
    }),
  );

/** How far up from a link its card is looked for, and from a control the group it's for. */
const CARD_STEPS = 4;
const OWN_STEPS = 6;

/**
 * The groups a page lists (a search for groups, the person's own groups, a list of them): each by its links, read
 * from the largest part around them that links to no other group, never a menu's. Its name (its link's words, else its
 * heading), how many members it says, whether the person is in it, and the line under its name. Not on a group's own
 * pages or its discussions: there, links to other groups are only suggestions, and `groupFacts` reads the group.
 */
export function groupCards(doc: Document, base: string): GroupCard[] {
  const here = urlOf(base, base);
  if (here && groupOf(here)) return [];
  const main = mainOf(doc);
  const byGroup = new Map<string, { group: GroupLink; anchors: HTMLAnchorElement[] }>();
  for (const { a, url } of linksIn(main, base)) {
    const group = groupOf(url);
    if (!group || group.page !== null || inMenu(a) || a.closest(PART('discussion-comment')))
      continue;
    const key = group.id.toLowerCase();
    const seen = byGroup.get(key);
    if (seen) seen.anchors.push(a);
    else byGroup.set(key, { group: { id: group.id, url: group.url, name: null }, anchors: [a] });
  }
  const found: GroupCard[] = [];
  for (const [key, { group, anchors }] of byGroup) {
    let card = around(anchors);
    for (
      let up = card?.parentElement ?? null, steps = 0;
      card && up && up !== main && main.contains(up) && steps < CARD_STEPS;
      up = up.parentElement, steps++
    ) {
      const groups = groupsIn(up, base);
      if (groups.size > 1 || !groups.has(key)) break;
      card = up;
    }
    if (!card) continue;
    const named = anchors
      .map((a) => clean(a.textContent) || clean(a.getAttribute('title')))
      .find((words) => words && !pageWords(words));
    const name = named || clean(card.querySelector(HEADINGS)?.textContent) || null;
    const lines = leafLines(card).filter((line) => line !== name && !pageWords(line));
    const now = standing([...card.querySelectorAll<HTMLElement>(CONTROLS)]);
    found.push({
      ...group,
      name,
      members: membersOn(card),
      joined: now.joined ? true : now.asked || now.join ? false : null,
      asked: now.asked,
      detail: lines[0] ?? null,
    });
    if (found.length >= GROUPS_MOST) break;
  }
  return found;
}

/** Links that make a part of the page someone's: their post, and their Connect or Message. */
const SOMEONES_AT = [/^\/biz\/discussions\//i, CONNECT_AT, MESSAGE_AT, MESSAGE_NEW_AT] as const;

/** Whether a part of the page is someone's: it links to a business or person, a post, or a Connect or Message. */
const someonesIn = (root: ParentNode, base: string) =>
  linksIn(root, base).some(
    ({ url }) => memberBusiness(url) !== null || SOMEONES_AT.some((at) => at.test(url.pathname)),
  );

/**
 * A group's own controls on its page: never one in another group's card (one it suggests), nor an asked one in a
 * post or a person's row, whose Connect says Request Sent or Pending once asked, as a group's Join does. A control is
 * the group's when the nearest part around it that links to a group links to this group alone, or none does. Only
 * the asked words are looked at for someone's part: a Join or Joined beside a leader's link is still the group's,
 * and the part with the group's name (its h1) is its own whatever it holds.
 */
function ownControls(main: Element, base: string, id: string): HTMLElement[] {
  const key = id.toLowerCase();
  const name = main.querySelector('h1');
  return [...main.querySelectorAll<HTMLElement>(CONTROLS)].filter((control) => {
    if (inMenu(control) || control.closest(PART('discussion-comment'))) return false;
    const asked = JOIN_ASKED.test(nameOf(control));
    for (
      let up = control.parentElement, steps = 0;
      up && up !== main && steps < OWN_STEPS;
      up = up.parentElement, steps++
    ) {
      // A Connect asked in someone's post or row, even one that links to this group ("Posted in").
      if (asked && !(name && up.contains(name)) && someonesIn(up, base)) return false;
      const groups = groupsIn(up, base);
      if (groups.size) return groups.size === 1 && groups.has(key);
    }
    return true;
  });
}

/** What a group's About says, a line a piece: its section's, or on its About page the page's. Never a link's words. */
function aboutOn(main: Element, page: boolean): string[] {
  const heading = [...main.querySelectorAll(`${HEADINGS}, span, div, strong, p`)].find(
    (el) =>
      (el.matches(HEADINGS) || el.childElementCount === 0) &&
      !el.closest('a, button') &&
      !inMenu(el) &&
      ABOUT_HEADING.test(clean(el.textContent)),
  );
  let part: Element | null = page && !heading ? main : null;
  if (heading)
    for (
      let up = heading.parentElement, steps = 0;
      up && main.contains(up) && steps < 4;
      up = up.parentElement, steps++
    )
      if (clean(up.textContent).length > clean(heading.textContent).length) {
        part = up;
        break;
      }
  if (!part) return [];
  const blocks = [...part.querySelectorAll('p, li, dd')];
  const lines = (
    blocks.length
      ? blocks
      : [...part.querySelectorAll('span, div')].filter((el) => !el.children.length)
  )
    .filter((el) => !el.closest(`a, button, ${HEADINGS}`) && !inMenu(el))
    .map((el) => clean(el.textContent).slice(0, ABOUT_LINE_MOST))
    .filter((line) => line && !ABOUT_HEADING.test(line));
  return [...new Set(lines)].slice(0, ABOUT_LINES);
}

/** The group page the tab shows (its own, its About, a page of its people): which group, and the page's main part. */
function groupHere(
  doc: Document,
  base: string,
): { readonly at: NonNullable<ReturnType<typeof groupOf>>; readonly main: Element } | null {
  const here = urlOf(base, base);
  const at = here ? groupOf(here) : null;
  if (!at || (at.page !== null && !GROUP_OWN_PAGES.has(at.page))) return null;
  return { at, main: mainOf(doc) };
}

/**
 * Where the person stands with the group the page is (its own page, its About, a page of its people), by its own
 * controls: in it, asked and waiting, or with its Join to press (its runner's, ./auto.ts). Null on any other page.
 */
export function groupStanding(
  doc: Document,
  base: string,
): (ReturnType<typeof standing> & { readonly group: GroupLink }) | null {
  const here = groupHere(doc, base);
  if (!here) return null;
  const { at, main } = here;
  return {
    group: { id: at.id, url: at.url, name: clean(main.querySelector('h1')?.textContent) || null },
    ...standing(ownControls(main, base, at.id)),
  };
}

/**
 * A group's own page, its About and the pages of its people (/groups/<group>, /about, /members): its name (its
 * heading), how many members it says, where the person stands by its own controls, what its About says, and on a page
 * of its people whether it showed its leaders. Null on any other page.
 */
export function groupFacts(doc: Document, base: string): GroupPage | null {
  const here = groupHere(doc, base);
  const now = groupStanding(doc, base);
  if (!here || !now) return null;
  const { at, main } = here;
  return {
    ...now.group,
    members: membersOn(main),
    joined: now.joined ? true : now.asked || now.join ? false : null,
    detail: null,
    asked: now.asked,
    join: now.join !== null,
    about: aboutOn(main, at.page === 'about'),
    leaders: at.page !== null && GROUP_PEOPLE_PAGES.has(at.page) && groupLeaders(doc, base).shown,
  };
}

/**
 * The business a member's link is to: their business's page, by its address in its town or Alignable's id, or their
 * own under it (/<town-st>/<business>/<person>, as ./site.ts's `profileOf` reads it), which goes to the business:
 * Alignable's people are their businesses, and a found check reads the business's page.
 */
export function memberBusiness(url: URL): ProfileRef | null {
  const [first = '', second = '', person, more] = parts(url);
  if (more !== undefined) return null;
  // Their own page, under their business's in its town: never a business by Alignable's id (/biz/businesses/<id>).
  if (person !== undefined && TOWN.test(first)) {
    if (!SLUG.test(person)) return null;
    return businessRef(new URL(`${HOST}/${first}/${second}`), idIn(url));
  }
  return businessRef(url, idIn(url));
}

/** A heading that starts a section of a group's people: its leaders, or its members. */
const peopleSection = (words: string) => LEADERS.test(words) || PEOPLE_SECTION.test(words);

/**
 * A member's row: the largest part around their links that links to nobody else's business, a few steps up, never
 * past a heading that starts a section of people (`sectionAt`: a group's leaders or members, an event's hosts or
 * guests).
 */
function rowsOf(
  main: Element,
  base: string,
  sectionAt: (words: string) => boolean = peopleSection,
): { row: Element; profile: ProfileRef; anchors: HTMLAnchorElement[] }[] {
  const byBusiness = new Map<string, { profile: ProfileRef; anchors: HTMLAnchorElement[] }>();
  const keyOf = (profile: ProfileRef) =>
    (profile.username ?? profile.id ?? profile.url).toLowerCase();
  for (const { a, url } of linksIn(main, base)) {
    if (inMenu(a) || a.closest(PART('discussion-comment'))) continue;
    const profile = memberBusiness(url);
    if (!profile) continue;
    const key = keyOf(profile);
    const seen = byBusiness.get(key);
    if (seen) seen.anchors.push(a);
    else byBusiness.set(key, { profile, anchors: [a] });
  }
  const businessesIn = (root: Element) =>
    new Set(
      linksIn(root, base).flatMap(({ url }) => {
        const profile = memberBusiness(url);
        return profile ? [keyOf(profile)] : [];
      }),
    );
  // A section's heading is never part of a row, even a section of one: its leaders, with one leader in it.
  const sections = [...main.querySelectorAll(HEADINGS)].filter((h) =>
    sectionAt(clean(h.textContent)),
  );
  return [...byBusiness].flatMap(([key, { profile, anchors }]) => {
    let row = around(anchors);
    for (
      let up = row?.parentElement ?? null, steps = 0;
      row && up && up !== main && main.contains(up) && steps < CARD_STEPS;
      up = up.parentElement, steps++
    ) {
      const businesses = businessesIn(up);
      if (businesses.size > 1 || !businesses.has(key)) break;
      if (sections.some((h) => up!.contains(h) && !row!.contains(h))) break;
      row = up;
    }
    return row ? [{ row, profile, anchors }] : [];
  });
}

/** The nearest heading before a part of the page, outside any row: what section of the page it's in. */
function headingBefore(row: Element, headings: readonly Element[]): string | null {
  let last: Element | null = null;
  for (const heading of headings)
    if (heading.compareDocumentPosition(row) & heading.DOCUMENT_POSITION_FOLLOWING) last = heading;
  return last ? clean(last.textContent) : null;
}

/** Whether a part of the page sits under a heading of its leaders: the nearest heading before it, outside any row. */
function underLeaders(row: Element, headings: readonly Element[]): boolean {
  const heading = headingBefore(row, headings);
  return heading !== null && LEADERS.test(heading);
}

/**
 * Who a row of people is, by their business: their own name on the link to them (/<town-st>/<business>/<person>),
 * else the first words on a link; their business's name; and the lines under them, never the page's words, the row's
 * own buttons or a mark beside them (`mark`: a group's leader's, an event's host's). Null when no link says a name.
 */
function personIn(
  { row, profile, anchors }: { row: Element; profile: ProfileRef; anchors: HTMLAnchorElement[] },
  base: string,
  mark: RegExp,
): { readonly member: Omit<Member, 'leader'>; readonly marked: boolean } | null {
  const said = anchors
    .map((a) => ({ a, words: clean(a.textContent) }))
    .filter(({ words }) => words && !pageWords(words));
  const own = said.find(({ a }) => {
    const url = urlOf(a.getAttribute('href'), base);
    return url !== null && parts(url).length === 3;
  });
  const name = (own ?? said[0])?.words;
  if (!name) return null;
  const business = said.find(({ words }) => words !== name)?.words ?? null;
  const all = leafLines(row);
  const lines = all.filter(
    (line) =>
      line !== name &&
      line !== business &&
      !pageWords(line) &&
      !mark.test(line) &&
      !ROW_CONTROLS.test(line),
  );
  return {
    member: {
      name,
      profile: { ...profile, id: profile.id ?? idAround(row, base) },
      business,
      lines,
    },
    marked: all.some((line) => mark.test(line)),
  };
}

/** Who a group's page of its people shows, each by their business, and its leaders marked. */
function peopleOn(
  doc: Document,
  base: string,
): { readonly members: Member[]; readonly shown: boolean } {
  const here = urlOf(base, base);
  const at = here ? groupOf(here) : null;
  if (!at?.page || !GROUP_PEOPLE_PAGES.has(at.page)) return { members: [], shown: false };
  const main = mainOf(doc);
  const rows = rowsOf(main, base);
  const headings = [...main.querySelectorAll(HEADINGS)].filter(
    (h) => !rows.some(({ row }) => row.contains(h)) && !inMenu(h),
  );
  let marked = false;
  const members = rows.slice(0, MEMBERS_MOST).flatMap((found): Member[] => {
    const person = personIn(found, base, LEADER_MARK);
    if (!person) return [];
    marked ||= person.marked;
    return [{ ...person.member, leader: person.marked || underLeaders(found.row, headings) }];
  });
  return {
    members,
    shown: marked || headings.some((h) => LEADERS.test(clean(h.textContent))),
  };
}

/** The people a group's page of them shows (its members page): each by their business, its leaders marked. */
export const memberRows = (doc: Document, base: string): Member[] => peopleOn(doc, base).members;

/**
 * A group's leaders, on a page of its people: whether it showed any (a section of them, or a leader's mark on a row),
 * and who. A page that shows none lets its members be read (decision 92's gate), and leaders are never reached.
 */
export function groupLeaders(
  doc: Document,
  base: string,
): { readonly shown: boolean; readonly leaders: Member[] } {
  const { members, shown } = peopleOn(doc, base);
  return { shown, leaders: members.filter((m) => m.leader) };
}

// ------------------------------------------------------------------------------------------------ events

/** What sits at …/events/<word> that's never one event: Alignable's own pages for them, as far as they can be told. */
const NOT_EVENTS = new Set([
  'new',
  'create',
  'search',
  'past',
  'upcoming',
  'calendar',
  'mine',
  'my_events',
  'my-events',
  'attending',
  'hosting',
  'all',
  'edit',
  'manage',
  'nearby',
  'local',
]);
/** An event's name in its address: "123-spring-mixer". */
const EVENT_SLUG = /^[A-Za-z0-9._-]{1,120}$/;
/** How many events a list of them keeps: a town's page shows a few dozen. */
const EVENTS_MOST = 40;
/** A link to an event that's only a way in, or its own buttons: never its name. */
const EVENT_CONTROLS =
  /^(view|view event|details|see details|more info|learn more|rsvp|going|interested|attend|register|sign up|share|save|add to calendar|maybe|not going)$/i;
/** A heading that starts an event's hosts, or its guests; and the mark beside a host in a row. */
const EVENT_HOSTS =
  /^(hosted by|hosts?|co-?hosts?|organi[sz]ed by|organi[sz]ers?|presented by)( \(\d[\d,]*\))?:?$/i;
const EVENT_GUESTS =
  /^(attendees|attending|going|guests|people going|who['’]s (going|attending|coming)|rsvps?)( \(\d[\d,]*\))?:?$/i;
const HOST_MARK = /^(host|co-?host|hosted by|organi[sz]er|organi[sz]ed by)$/i;
const eventSection = (words: string) => EVENT_HOSTS.test(words) || EVENT_GUESTS.test(words);

/**
 * An event's own page, from a link to it, as its address without anything after: one in a town
 * (/<town-st>/events/<event>), a group's (/groups/<group>/events/<event>), or the site's (/events/<event>,
 * /biz/events/<event>). A page of its own under it (its attendees) is the event's. Null for any other address, and for
 * Alignable's own pages of events (its search, its calendar). Guesses till the owner's next Check outlines one.
 */
export function eventOf(url: URL): string | null {
  if (!/^(www\.)?alignable\.com$/i.test(url.hostname)) return null;
  const all = parts(url);
  const at = all.findIndex((part) => part.toLowerCase() === 'events');
  const slug = all[at + 1];
  if (at < 0 || !slug || all.length > at + 3) return null;
  if (!EVENT_SLUG.test(slug) || NOT_EVENTS.has(slug.toLowerCase())) return null;
  const [first = '', second = ''] = all.map((p) => p.toLowerCase());
  const under =
    at === 0 ||
    (at === 1 && (TOWN.test(first) || first === 'biz')) ||
    (at === 2 && first === 'groups' && GROUP_SLUG.test(second));
  return under ? `${HOST}/${all.slice(0, at + 2).join('/')}` : null;
}

/** An event as a list of them showed it: its own page, its name, and the line under it (when, or where). */
export interface EventCard {
  readonly url: string;
  readonly name: string;
  readonly detail: string | null;
}

/** An event's own page: its name, who's hosting it and who's going, each by their business. */
export interface EventPage {
  readonly url: string;
  readonly name: string | null;
  readonly hosts: readonly Omit<Member, 'leader'>[];
  readonly guests: readonly Omit<Member, 'leader'>[];
}

/** Whether a page is a list of events (a town's, a search's): its address has events in it, and isn't one event. */
const eventsListAt = (url: URL) =>
  eventOf(url) === null && parts(url).some((part) => part.toLowerCase() === 'events');

/** The events a list of them shows (the person's town's events), each once by its own page, in the page's order. */
export function eventCards(doc: Document, base: string): EventCard[] {
  const here = urlOf(base, base);
  if (!here || !eventsListAt(here)) return [];
  const main = mainOf(doc);
  const byEvent = new Map<string, HTMLAnchorElement[]>();
  for (const { a, url } of linksIn(main, base)) {
    const event = inMenu(a) ? null : eventOf(url);
    if (!event) continue;
    const seen = byEvent.get(event);
    if (seen) seen.push(a);
    else byEvent.set(event, [a]);
  }
  const eventsIn = (root: Element) =>
    new Set(linksIn(root, base).flatMap(({ url }) => eventOf(url) ?? []));
  const found: EventCard[] = [];
  for (const [url, anchors] of byEvent) {
    let card = around(anchors);
    for (
      let up = card?.parentElement ?? null, steps = 0;
      card && up && up !== main && main.contains(up) && steps < CARD_STEPS;
      up = up.parentElement, steps++
    ) {
      const events = eventsIn(up);
      if (events.size > 1 || !events.has(url)) break;
      card = up;
    }
    if (!card) continue;
    // Its name: its card's heading, else the first words on a link to it that aren't a way in.
    const named = anchors
      .map((a) => clean(a.textContent) || clean(a.getAttribute('title')))
      .find((words) => words && words.length <= 160 && !EVENT_CONTROLS.test(words));
    const name = clean(card.querySelector(HEADINGS)?.textContent) || named;
    if (!name) continue;
    const lines = leafLines(card).filter(
      (line) => line !== name && !EVENT_CONTROLS.test(line) && !pageWords(line),
    );
    found.push({ url, name, detail: lines[0] ?? null });
    if (found.length >= EVENTS_MOST) break;
  }
  return found;
}

/**
 * An event's own page: its name (its first heading), who's hosting it (under a heading of its hosts, or marked as one)
 * and who's going (under a heading of its guests), each once by their business. Nobody elsewhere on the page (other
 * events, suggestions beside it) is either. Nothing on the page is pressed.
 */
export function eventPage(doc: Document, base: string): EventPage | null {
  const here = urlOf(base, base);
  const url = here ? eventOf(here) : null;
  if (!url) return null;
  const main = mainOf(doc);
  const rows = rowsOf(main, base, eventSection);
  const headings = [...main.querySelectorAll(HEADINGS)].filter(
    (h) => !rows.some(({ row }) => row.contains(h)) && !inMenu(h),
  );
  const hosts: Omit<Member, 'leader'>[] = [];
  const guests: Omit<Member, 'leader'>[] = [];
  for (const found of rows.slice(0, MEMBERS_MOST)) {
    const person = personIn(found, base, HOST_MARK);
    if (!person) continue;
    const under = headingBefore(found.row, headings);
    if (person.marked || (under !== null && EVENT_HOSTS.test(under))) hosts.push(person.member);
    else if (under !== null && EVENT_GUESTS.test(under)) guests.push(person.member);
  }
  const named = headings.find((h) => !eventSection(clean(h.textContent)));
  return { url, name: clean(named?.textContent) || null, hosts, guests };
}

/** Alignable's id for a discussion, from a link to it (/biz/discussions/<id>): how a post's own page is known. */
export function discussionIdOf(href: string | null | undefined): string | null {
  const url = urlOf(href, HOST);
  if (!url) return null;
  const [first, second, id] = parts(url);
  return first === 'biz' && second === 'discussions' && id && ID.test(id) ? id : null;
}

/**
 * Whether the page is one discussion's own (a post's, a forum question's): /biz/discussions/<id>, a group's discussion
 * at /groups/<group>/<discussion>, or a town's forum question (/<town-st>/forum/<id>/…).
 */
export function isDiscussionPage(href: string): boolean {
  const url = urlOf(href, href);
  if (!url) return false;
  if (discussionIdOf(url.toString())) return true;
  const group = groupOf(url);
  if (group?.page)
    return (
      !GROUP_OWN_PAGES.has(group.page) &&
      !GROUP_OTHER_PAGES.has(group.page) &&
      parts(url).length === 3
    );
  const [first = '', second = '', third] = parts(url);
  return TOWN.test(first) && second.toLowerCase() === 'forum' && !!third;
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
export const differ = (a: ProfileRef, b: ProfileRef) =>
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

/**
 * Send in Messages: `messaging-send-external` till the owner's sends of 30 Oct 2026, `messaging-send-desktop` since
 * (0.117.0's 19:02 UTC outline).
 */
export const MESSAGE_SEND = `${PART('messaging-send-external')}, ${PART('messaging-send-desktop')}`;

/**
 * The open conversation's header, which links to the business it's with: its own part (`channel-header-loaded`) till
 * 30 Oct 2026; since then a plain header with no test id, beside the conversation's messages and box to write in, so
 * the first one on the way up from that box, never past Messages itself (`inbox`), whose list has a header of its own,
 * and never the site's menu.
 */
export function chatHeader(doc: Document): Element | null {
  const own = doc.querySelector(PART('channel-header-loaded'));
  if (own) return own;
  const write = doc.querySelector(PART('full-view-write-message'));
  for (let at = write?.parentElement ?? null; at; at = at.parentElement) {
    const header = [...at.children].find(
      (child) => child.localName === 'header' && !child.querySelector('nav'),
    );
    if (header) return header;
    if (at.matches(PART('inbox'))) return null;
  }
  return null;
}

export function chatOpen(doc: Document, base: string): ChatOpen | null {
  const header = chatHeader(doc);
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
    send: doc.querySelector(MESSAGE_SEND) !== null,
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
  const group = groupFacts(doc, href);
  const events = eventCards(doc, href);
  const event = eventPage(doc, href);
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
    groups: groupCards(doc, href),
    members: memberRows(doc, href),
    ...(group ? { group } : {}),
    ...(events.length ? { events } : {}),
    ...(event ? { event } : {}),
  };
}
