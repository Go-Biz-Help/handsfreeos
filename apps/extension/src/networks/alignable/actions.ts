/**
 * The steps a person takes on Alignable themselves, noticed as they take them (partners stage 6c; the Instagram and
 * Alignable plan's part 2, "Noting your own steps"), as ../linkedin/actions.ts notices LinkedIn's: the content script
 * hears the person's own click or Enter, and this works out from the page around it what it was and who it was to,
 * from the owner's Check Alignable (0.66.0 to 0.68.0). It reads the page and never changes it, and never keeps what a
 * comment or a message says: only that one was sent.
 *
 * - **Connection request:** a Connect, which on Alignable is a link that makes the request at once
 *   (/biz/connection_requests/make_connection?business_id=…). It's to the business on whose page it is, or the one the
 *   search result, post or answer around it names, by Alignable's id for the business.
 * - **Like:** a post's Like (a link drawn as a button; the count beside it is another link, to who liked it), to whoever
 *   wrote the post; an answer's Like, to whoever wrote the answer.
 * - **Comment:** Send in a forum question's box to answer in, with something written, to whoever asked it; in a reply's
 *   box under an answer, to whoever wrote the answer.
 * - **Message:** Send in Messages (`messaging-send-external`) with something written, to who the conversation is with,
 *   by Alignable's id for their business; or Enter in its box, once the box empties.
 * - **Recommendation:** its Recommend is a link to a page to write one on (/biz/recommendations/new?id=…), so the press
 *   that counts is the one sending what's written there, to the business that page is for, by Alignable's id. Today
 *   suggests one a day; it's only ever the person's own (the plan's question 8).
 *
 * A step to yourself isn't one, and neither is a step the page can't tie to one business. Like the readers, it goes by
 * Alignable's own test ids, its links' addresses and its words, never class names.
 */
import type { Reached, Step } from '../facebook/actions';
import { clean } from '../facebook/dom';
import type { ProfileRef, ThreadRef } from '../facebook/types';
import type { Noticed, Noticer } from '../kit';
import { nameOf } from '../looking/read';
import {
  authorIn,
  businessPage,
  businessRef,
  chatOpen,
  CONNECT_AT,
  idIn,
  linksIn,
  PART,
  urlOf,
} from './read';

const HOST = 'https://www.alignable.com';
/** What a person presses. */
const CONTROLS = 'a[href], button, [role="button"], input[type="submit"]';
/** How far up a press looks for the post, answer or result it's in. */
const UP_STEPS = 12;
/** Where a person writes. */
const WRITING = '[contenteditable="true"], textarea, [role="textbox"]';
/** How long after Enter its box is looked at again: emptied, it sent. */
const AFTER_ENTER_MS = 1_500;

/** `Node.DOCUMENT_POSITION_PRECEDING`: the other comes before it. */
const BEFORE = 2;

const LIKE = /^like$/i;
const SEND = /^send$/i;
/** Where a recommendation is written. */
const RECOMMEND_AT = /^\/biz\/recommendations\/new\/?$/i;
/** What sends it. */
const SEND_IT =
  /^(submit|send|post|save|publish|recommend)( (my |your )?recommendation| it| now)?$/i;
/** Its page's heading, the business's name after it: "Recommend Pine Street Bakery". */
const RECOMMEND_TITLE = /^(write an? )?(recommend(ation)?|vouch)( for)?\s+/i;

/** The control pressed: the button or link the click was in. */
const controlAt = (target: Element): Element | null => target.closest(CONTROLS);

/** Whether a box has something written in it. */
const writingIn = (box: Element | null | undefined): boolean =>
  !!box &&
  ('value' in box && typeof (box as HTMLTextAreaElement).value === 'string'
    ? (box as HTMLTextAreaElement).value.trim() !== ''
    : clean(box.textContent) !== '');

/** A step to themselves: on their own profile (it's shown at their business's address, with its own editors). */
function isYours(profile: ProfileRef, doc: Document, base: string): boolean {
  const url = urlOf(base, base);
  return (
    !!url &&
    profile.url === `${HOST}${url.pathname}` &&
    doc.querySelector(PART('elevator-pitch-cta-button')) !== null
  );
}

function step(
  kind: Step['kind'],
  to: Reached,
  extra: { postUrl?: string | null; thread?: ThreadRef | null } = {},
): Step {
  return {
    kind,
    to,
    group: null,
    postUrl: extra.postUrl ?? null,
    thread: extra.thread ?? null,
    replying: null,
  };
}

/** The nearest part of the page around an element that names one business: a result, a post, an answer. */
function whoAround(element: Element, base: string): Reached | null {
  let up: Element | null = element.parentElement;
  for (let steps = 0; up && steps < UP_STEPS; steps++, up = up.parentElement) {
    const author = authorIn(up, base);
    if (author?.profile) return { name: author.name, profile: author.profile };
  }
  return null;
}

/** The discussion a post or an answer is part of: its Comment's link, or the page's own address on a discussion. */
function discussionOf(element: Element, doc: Document, base: string): string | null {
  for (
    let up: Element | null = element.parentElement, steps = 0;
    up && steps < UP_STEPS;
    steps++, up = up.parentElement
  ) {
    const link = linksIn(up, base).find(({ url }) =>
      /^\/biz\/discussions\/[^/]+/i.test(url.pathname),
    );
    if (link) return `${HOST}${link.url.pathname}`;
  }
  const url = urlOf(base, base);
  return url && /^\/groups\/[^/]+\/[^/]+\/?$/i.test(url.pathname) ? `${HOST}${url.pathname}` : null;
}

// ------------------------------------------------------------------------------------------------ the steps

/** A Connect: to the page's business, or the one around it, by Alignable's id for it. */
function connect(control: Element, doc: Document, base: string): Step | null {
  if (!control.matches('a[href]')) return null;
  const url = urlOf(control.getAttribute('href'), base);
  if (!url || !CONNECT_AT.test(url.pathname)) return null;
  const id = idIn(url);
  if (!id) return null;
  const page = businessPage(doc, base);
  const inPart = control.closest(
    `${PART('discussion-comment')}, [role="contentinfo"] li, ul > div`,
  );
  const to =
    page?.profile && !inPart && page.profile.id === id
      ? { name: page.name ?? '', profile: { ...page.profile, id } }
      : (() => {
          const near = whoAround(control, base);
          return near ? { name: near.name, profile: { ...near.profile, id } } : null;
        })();
  if (!to?.name || isYours(to.profile, doc, base)) return null;
  return step('friend_request', to);
}

/** A Like: a post's (a link drawn as a button, never its count), or an answer's. */
function like(control: Element, doc: Document, base: string): Step | null {
  if (!LIKE.test(nameOf(control))) return null;
  if (control.matches('a[href]')) {
    const url = urlOf(control.getAttribute('href'), base);
    // The count beside it ("3 Likes") is its own link, to who liked it.
    if (!url || url.searchParams.has('resource')) return null;
  }
  const to = whoAround(control, base);
  if (!to || isYours(to.profile, doc, base)) return null;
  return step('like', to, { postUrl: discussionOf(control, doc, base) });
}

/** Send in a box to answer in: a comment to whoever asked, or for a reply, whoever wrote the answer. */
function answer(control: Element, doc: Document, base: string): Step | null {
  if (!SEND.test(nameOf(control))) return null;
  const form = control.closest(`${PART('discussion-comment-reply-form')}, form`);
  if (!form || !writingIn(form.querySelector(WRITING))) return null;
  const under = form.parentElement?.closest(PART('discussion-comment'));
  const author = under ? authorIn(under, base) : null;
  const to = author?.profile
    ? { name: author.name, profile: author.profile }
    : askerOf(form, doc, base);
  if (!to || isYours(to.profile, doc, base)) return null;
  return step('comment', to, { postUrl: discussionOf(form, doc, base) });
}

/** Whoever asked: the post nearest before the box, by its Comment's link, never an answer's. */
function askerOf(form: Element, doc: Document, base: string): Reached | null {
  const before = linksIn(doc, base).filter(
    ({ a, url }) =>
      /^\/biz\/discussions\/[^/]+/i.test(url.pathname) &&
      !a.closest(PART('discussion-comment')) &&
      (form.compareDocumentPosition(a) & BEFORE) !== 0,
  );
  const comment = before[before.length - 1];
  return comment ? whoAround(comment.a, base) : null;
}

/** The conversation open on Messages, as a chat: who it's with, by Alignable's id for their business. */
function chatHere(doc: Document, base: string): { to: Reached; thread: ThreadRef } | null {
  const chat = chatOpen(doc, base);
  const page = urlOf(base, base);
  const id = page?.searchParams.get('with_business_id') ?? chat?.profile?.id ?? null;
  if (!chat?.name || !id) return null;
  const profile = chat.profile ?? businessRef(new URL(`${HOST}/biz/businesses/${id}`), id);
  if (!profile) return null;
  return {
    to: { name: chat.name, profile: { ...profile, id } },
    thread: { id, encrypted: false, url: `${HOST}/biz/conversations?with_business_id=${id}` },
  };
}

/** Send in Messages, with something written. */
function message(control: Element, doc: Document, base: string): Step | null {
  const send = control.closest(PART('messaging-send-external'));
  if (!send) return null;
  if (!writingIn(doc.querySelector(PART('full-view-write-message'))?.querySelector(WRITING)))
    return null;
  const chat = chatHere(doc, base);
  return chat ? step('message', chat.to, { thread: chat.thread }) : null;
}

/** The business a recommendation's page is for: its name, from its heading or a link to it, and Alignable's id. */
function recommendedOn(doc: Document, base: string): Reached | null {
  const page = urlOf(base, base);
  const id = page && RECOMMEND_AT.test(page.pathname) ? idIn(page) : null;
  if (!id) return null;
  const main = doc.querySelector('main, [role="main"]') ?? doc.body;
  const heading = [...main.querySelectorAll('h1, h2, h3')]
    .map((h) => clean(h.textContent))
    .find((words) => RECOMMEND_TITLE.test(words));
  // Else the link to it: by its id, or the first to a business's page (the page is for that one business).
  const links = linksIn(main, base).filter(
    ({ a, url }) => !RECOMMEND_AT.test(url.pathname) && clean(a.textContent),
  );
  const linked =
    links.find(({ url }) => idIn(url) === id) ?? links.find(({ url }) => businessRef(url, null));
  const name =
    heading
      ?.replace(RECOMMEND_TITLE, '')
      .replace(/[.!?]+$/, '')
      .trim() || (linked ? clean(linked.a.textContent) : '');
  if (!name) return null;
  return { name, profile: { id, username: null, url: `${HOST}/biz/businesses/${id}` } };
}

/** Send on a recommendation's page, with something written: the recommendation, to the business it's for. */
function recommend(control: Element, doc: Document, base: string): Step | null {
  const pressed =
    control.matches('button[type="submit"], input[type="submit"]') || SEND_IT.test(nameOf(control));
  if (!pressed) return null;
  const to = recommendedOn(doc, base);
  if (!to) return null;
  const around = control.closest('form') ?? doc.querySelector('main, [role="main"]') ?? doc.body;
  if (!writingIn(around.querySelector(WRITING))) return null;
  return step('recommend', to);
}

/** What a press of the person's was, if it's one of their steps. */
export function stepFromClick(target: Element, doc: Document, href: string): Step | null {
  const control = controlAt(target);
  if (!control) return null;
  return (
    recommend(control, doc, href) ??
    connect(control, doc, href) ??
    message(control, doc, href) ??
    answer(control, doc, href) ??
    like(control, doc, href)
  );
}

export function alignableNoticer(): Noticer {
  return {
    click: (target, doc, href) => {
      const found = stepFromClick(target, doc, href);
      return found ? { kind: 'step', step: found } : null;
    },
    enter: (target, doc, href): Noticed | null => {
      // Enter in Messages' box may send it, or only start a new line: it sent once the box empties.
      const box = target.closest(WRITING);
      if (!box?.closest(PART('full-view-write-message')) || !writingIn(box)) return null;
      const chat = chatHere(doc, href);
      if (!chat) return null;
      return {
        kind: 'maybe',
        step: step('message', chat.to, { thread: chat.thread }),
        afterMs: AFTER_ENTER_MS,
        went: () => !writingIn(box),
      };
    },
  };
}
