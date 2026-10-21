/**
 * The steps a person takes on Instagram themselves, noticed as they take them (the Instagram and Alignable plan's part
 * 11, "Noting your own steps"), as ../alignable/actions.ts notices Alignable's: the content script hears the person's
 * own click or Enter, and this works out from the page around it what it was and who it was to. It reads the page and
 * never changes it, and never keeps what a comment or a message says: only that one was sent.
 *
 * - **Follow** (or **Follow Back**), on an account's own page or on a row of a list (their followers, the accounts
 *   Instagram suggests, a post's header): a follow, kept as a request (`friend_request`) to that account. Instagram
 *   follows at once, or asks a private account; it's noted a moment later, once the button says Following or
 *   Requested, so a press Instagram blocked notes nothing.
 * - **Like** on a post (its icon labelled Like, in the bar with its Comment; never a comment's Like): to whoever posted
 *   it, with the post's link.
 * - **A comment:** Post by a post's box to comment in, with something written, or Enter in it once the box empties: to
 *   whoever posted it, or to the one it starts by naming (@name) when it answers their comment.
 * - **A message:** Send in a chat, with something written, or Enter in its box once the box empties: to who the chat
 *   is with, with the chat's id from its address (/direct/t/<id>/). A chat with more than one other person isn't one.
 *
 * A step to yourself isn't one, and neither is a step the page can't tie to one account. Like the readers, it goes by
 * Instagram's own words, labels, roles and link addresses, never class names.
 */
import type { Reached, Step } from '../facebook/actions';
import { clean } from '../facebook/dom';
import type { ThreadRef } from '../facebook/types';
import type { Noticed, Noticer } from '../kit';
import { nameOf } from '../looking/read';
import {
  authorOf,
  chatOn,
  leafLines,
  linksIn,
  OWN_WORDS,
  ownOf,
  postRootOf,
  profileOn,
  says,
  type Account,
} from './read';
import { instagramUrl, kindOf, partsOf, postOf, profileOf, threadOf } from './urls';

const HOST = 'https://www.instagram.com';
/** What a person presses. */
const CONTROLS = 'button, [role="button"], a[href], input[type="submit"]';
/** Where a person writes. */
const WRITING = 'textarea, [contenteditable="true"], [role="textbox"]';
/** How far up a press looks for the row, the post or the chat it's in. */
const UP_STEPS = 12;
/** How long after a press or Enter the page is looked at again: Following shows, or the box empties. */
const AFTER_MS = 1_500;

const FOLLOW = /^(follow|follow back)$/i;
const FOLLOWED = /^(following|requested)$/i;
const LIKE = /^like$/i;
const COMMENT = /^comment$/i;
const POST = /^post$/i;
const SEND = /^send$/i;
/** The box to comment in, and a chat's box, as their labels and placeholders say. */
const COMMENT_BOX = /^add a comment/i;
const CHAT_BOX = /^(message|write a message)/i;
/** A comment that answers someone's starts by naming them. */
const NAMED = /^@([A-Za-z0-9._]{1,30})\b/;

/** The control pressed: the button or link the click was in. */
const controlAt = (target: Element): Element | null => target.closest(CONTROLS);

/** Whether a box has something written in it. */
const writingIn = (box: Element | null | undefined): boolean =>
  !!box &&
  ('value' in box && typeof (box as HTMLTextAreaElement).value === 'string'
    ? (box as HTMLTextAreaElement).value.trim() !== ''
    : clean(box.textContent) !== '');

/** What's written in a box, only to see whom it names first: never kept. */
const writtenIn = (box: Element): string =>
  'value' in box && typeof (box as HTMLTextAreaElement).value === 'string'
    ? (box as HTMLTextAreaElement).value.trim()
    : clean(box.textContent);

/** What a box to write in is for: its label or its placeholder. */
const boxName = (box: Element): string =>
  clean(box.getAttribute('aria-label')) ||
  clean(box.getAttribute('placeholder')) ||
  clean(box.getAttribute('aria-placeholder'));

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

const reached = (account: Account, name: string | null = null): Reached => ({
  name: name || account.username,
  profile: { id: null, username: account.username, url: account.url },
});

/** A step to themselves: their own account, as the menu's Profile links it. */
const isYours = (to: Reached, doc: Document, base: string): boolean =>
  to.profile.username?.toLowerCase() === ownOf(doc, base)?.toLowerCase();

/**
 * The one account a part of the page around an element is about: the nearest part that links to exactly one, never
 * the person's own. Null when the nearest part with any links to more than one (a list's whole box).
 */
function oneAccountAround(
  element: Element,
  base: string,
  own: string | null,
  steps = UP_STEPS,
): { root: Element; account: Account } | null {
  for (let up = element.parentElement, n = 0; up && n < steps; up = up.parentElement, n++) {
    const accounts = new Map<string, Account>();
    for (const { url } of linksIn(up, base)) {
      const account = profileOf(url);
      if (account && account.username.toLowerCase() !== own?.toLowerCase())
        accounts.set(account.username.toLowerCase(), account);
    }
    if (accounts.size > 1) return null;
    if (accounts.size === 1) return { root: up, account: [...accounts.values()][0]! };
  }
  return null;
}

/** A row's name: its first line that isn't the username or Instagram's own words. */
const nameIn = (root: Element, username: string): string | null =>
  leafLines(root).find(
    ({ el, text }) =>
      !el.closest('button, [role="button"]') &&
      text.toLowerCase() !== username.toLowerCase() &&
      !OWN_WORDS.test(text),
  )?.text ?? null;

// ------------------------------------------------------------------------------------------------ the steps

/**
 * Follow or Follow Back: on an account's own page, to that account; on a row of a list or a post's header, to the one
 * account it's about. Noted a moment later, once the button says Following or Requested.
 */
function follow(control: Element, doc: Document, base: string): Noticed | null {
  if (!FOLLOW.test(nameOf(control))) return null;
  const own = ownOf(doc, base);
  const header = control.closest('main header');
  const page = instagramUrl(base);
  let to: Reached | null = null;
  let root: Element | null = null;
  if (header && page && kindOf(page) === 'profile') {
    const profile = profileOn(doc, base);
    if (profile) {
      to = reached(profile, profile.name);
      root = header;
    }
  }
  if (!to) {
    const around = oneAccountAround(control, base, own);
    if (around) {
      to = reached(around.account, nameIn(around.root, around.account.username));
      root = around.root;
    }
  }
  if (!to || !root || isYours(to, doc, base)) return null;
  const within = root;
  return {
    kind: 'maybe',
    step: step('friend_request', to),
    afterMs: AFTER_MS,
    // Instagram follows at once, or asks a private account: its button then says Following or Requested. A press it
    // blocked leaves Follow, and notes nothing.
    went: () =>
      control.isConnected
        ? FOLLOWED.test(nameOf(control))
        : within.isConnected
          ? says(within, FOLLOWED)
          : true,
  };
}

/** The post a control is part of: the article around it on a feed, else the page's own post. */
function postAround(control: Element, doc: Document, base: string): string | null {
  const article = control.closest('article');
  if (article)
    for (const { url } of linksIn(article, base)) {
      const post = postOf(url);
      if (post) return post;
    }
  const page = instagramUrl(base);
  return page && kindOf(page) === 'post' ? postOf(page) : null;
}

/** Whoever posted it, by its own link, or the account beside its More options. */
function posterOf(control: Element, doc: Document, base: string, post: string): Account | null {
  const root = control.closest('article') ?? postRootOf(doc);
  return authorOf(root, base, partsOf(new URL(post))[1]!);
}

/** Like on a post, in the bar with its Comment: to whoever posted it, with its link. Never a comment's Like. */
function like(control: Element, doc: Document, base: string): Step | null {
  if (!LIKE.test(nameOf(control))) return null;
  let bar: Element | null = control.parentElement;
  for (let n = 0; bar && n < 3 && !says(bar, COMMENT); n++) bar = bar.parentElement;
  if (!bar || !says(bar, COMMENT)) return null;
  const post = postAround(control, doc, base);
  const by = post ? posterOf(control, doc, base, post) : null;
  if (!post || !by) return null;
  const to = reached(by);
  if (isYours(to, doc, base)) return null;
  return step('like', to, { postUrl: post });
}

/** A post's box to comment in, around a control or a box: its form's. */
const commentBoxIn = (root: Element | null): HTMLElement | null =>
  root
    ? ([...root.querySelectorAll<HTMLElement>(WRITING)].find((b) => COMMENT_BOX.test(boxName(b))) ??
      null)
    : null;

/** A comment from a post's box: to whoever posted it, or to the one it starts by naming when that's a commenter. */
function commentTo(box: Element, doc: Document, base: string): Step | null {
  if (!writingIn(box)) return null;
  const post = postAround(box, doc, base);
  if (!post) return null;
  const root = box.closest('article') ?? postRootOf(doc);
  const named = NAMED.exec(writtenIn(box))?.[1]?.toLowerCase();
  const answering = named
    ? linksIn(root, base)
        .map(({ url }) => profileOf(url))
        .find((a): a is Account => a !== null && a.username.toLowerCase() === named)
    : undefined;
  const by = answering ?? posterOf(box, doc, base, post);
  if (!by) return null;
  const to = reached(by);
  if (isYours(to, doc, base)) return null;
  return step('comment', to, { postUrl: post });
}

/** Post by a post's box to comment in, with something written. */
function comment(control: Element, doc: Document, base: string): Step | null {
  if (!POST.test(nameOf(control))) return null;
  const box = commentBoxIn(control.closest('form') ?? control.parentElement?.parentElement ?? null);
  return box ? commentTo(box, doc, base) : null;
}

/** A chat's box around a control: in its form, or the nearest part around it holding one. */
function chatBoxAround(control: Element): HTMLElement | null {
  for (let up = control.parentElement, n = 0; up && n < 6; up = up.parentElement, n++) {
    const box = [...up.querySelectorAll<HTMLElement>(WRITING)].find((b) =>
      CHAT_BOX.test(boxName(b)),
    );
    if (box) return box;
  }
  return null;
}

/**
 * The chat a box is in: on its own page (/direct/t/<id>/), who it's with and its id; in a chat over another page, the
 * one account it's about, with its id when it links to its own page. Null for a group, or anyone the page doesn't link.
 */
function chatOf(
  box: Element,
  doc: Document,
  base: string,
): { to: Reached; thread: ThreadRef | null } | null {
  const own = ownOf(doc, base);
  const page = instagramUrl(base);
  if (page && kindOf(page) === 'chat' && box.closest('main, [role="main"]')) {
    const chat = chatOn(doc, base, own);
    if (!chat?.with) return null;
    const id = chat.thread ?? threadOf(page);
    return {
      to: reached(chat.with, chat.name && chat.name !== chat.with.username ? chat.name : null),
      thread: id ? { id, encrypted: false, url: `${HOST}/direct/t/${id}/` } : null,
    };
  }
  const around = oneAccountAround(box, base, own, 20);
  if (!around) return null;
  const id =
    linksIn(around.root, base)
      .map(({ url }) => threadOf(url))
      .find((t): t is string => t !== null) ?? null;
  return {
    to: reached(around.account),
    thread: id ? { id, encrypted: false, url: `${HOST}/direct/t/${id}/` } : null,
  };
}

/** Send in a chat, with something written. */
function message(control: Element, doc: Document, base: string): Step | null {
  if (!SEND.test(nameOf(control))) return null;
  const box = chatBoxAround(control);
  if (!box || !writingIn(box)) return null;
  const chat = chatOf(box, doc, base);
  if (!chat || isYours(chat.to, doc, base)) return null;
  return step('message', chat.to, { thread: chat.thread });
}

/** What a press of the person's was, if it's one of their steps that's noted at once. */
export function stepFromClick(target: Element, doc: Document, href: string): Step | null {
  const control = controlAt(target);
  if (!control) return null;
  return like(control, doc, href) ?? comment(control, doc, href) ?? message(control, doc, href);
}

/** What a press of the person's was: a step, or a follow, noted once Instagram shows it went. */
export function noticedFromClick(target: Element, doc: Document, href: string): Noticed | null {
  const control = controlAt(target);
  if (!control) return null;
  const followed = follow(control, doc, href);
  if (followed) return followed;
  const found = stepFromClick(target, doc, href);
  return found ? { kind: 'step', step: found } : null;
}

export function instagramNoticer(): Noticer {
  return {
    click: (target, doc, href) => noticedFromClick(target, doc, href),
    enter: (target, doc, href): Noticed | null => {
      // Enter in a box sends it, or only starts a new line: it went once the box empties.
      const box = target.closest(WRITING);
      if (!box || !writingIn(box)) return null;
      const name = boxName(box);
      const found = COMMENT_BOX.test(name)
        ? commentTo(box, doc, href)
        : CHAT_BOX.test(name)
          ? (() => {
              const chat = chatOf(box, doc, href);
              return chat && !isYours(chat.to, doc, href)
                ? step('message', chat.to, { thread: chat.thread })
                : null;
            })()
          : null;
      if (!found) return null;
      return { kind: 'maybe', step: found, afterMs: AFTER_MS, went: () => !writingIn(box) };
    },
  };
}
