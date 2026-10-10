/**
 * What the extension presses on its own (docs/outreach.md, decisions 26 to 33), once the person turns it on in the
 * panel: on the profile of someone on their list for today, Add friend, or Confirm on a request they got, or Like on
 * their latest post; and on a post on their list, the comment the AI drafted. The background's runner opens each
 * page in a window of its own (src/auto/run.ts), checks it's the right one and where things stand, and asks this
 * script in that tab for one step at a time. A message goes only once it's drafted, and OK'd or let go as it is
 * (packages/core/src/addons/outreach/sends.ts).
 *
 * Add friend and Confirm go the way Cancel request and Unfriend do (./tidy.ts, ./fetch.ts); a like, a comment and a
 * message are their own: the like goes on the first post on the profile that's theirs, and only when it isn't liked
 * already; the comment is typed into the post's own box to comment in (never a reply's), and the message into the
 * chat's box (in Messenger, or the chat window their profile's Message opens), and each is sent with its button, or
 * Enter.
 */
import { COMMENT_BOX, hasWriting, MESSAGE_BOX, REPLY_BOX, SEND, WRITING } from './actions';
import { clean, inTopBar, isAfter, labelOf } from './dom';
import { shown, type FetchStep } from './fetch';
import { COMMENT, LIKE, postBoxes, readPost } from './posts';
import type { TidyPlan } from './tidy';
import type { ProfilePage, ProfileRef } from './types';

export type AutoJob = 'friend_request' | 'confirm';

export interface AutoPlan extends TidyPlan {
  /** Where things stand on the profile once it worked. */
  readonly after: ProfilePage['friendship'];
}

const press = (words: readonly string[], says: string, more: Partial<FetchStep> = {}) =>
  ({ action: 'press', words, says, ...more }) as const satisfies FetchStep;

export const AUTO_PLANS: Readonly<Record<AutoJob, AutoPlan>> = {
  friend_request: {
    before: 'not_friends',
    after: 'request_sent',
    path: [
      press(['Add friend', 'Add Friend'], 'Press “Add friend” under their name.', {
        exact: true,
        buttonsOnly: true,
      }),
    ],
    // Some accounts are asked whether they know the person first.
    then: [
      press(['Confirm', 'Send request', 'Send friend request'], 'Press “Confirm”.', {
        exact: true,
        inBox: true,
        optional: true,
      }),
    ],
  },
  confirm: {
    before: 'request_received',
    after: 'friends',
    // Respond opens a menu with Confirm in it; some profiles show Confirm request straight away.
    path: [
      press(['Respond', 'Confirm request', 'Confirm'], 'Press “Respond” under their name.', {
        exact: true,
        buttonsOnly: true,
      }),
    ],
    then: [
      press(['Confirm', 'Confirm request'], 'Press “Confirm”.', {
        exact: true,
        inBox: true,
        optional: true,
      }),
    ],
  },
};

/** On someone's profile, Message opens a chat with them: a small window over the page, or Messenger. */
export const MESSAGE_PATH: readonly FetchStep[] = [
  press(['Message'], 'Press “Message” under their name.', { exact: true }),
];

/** Whether two profiles are the same person: by number or by username, either way they were linked. */
export function sameRef(a: ProfileRef | null, b: ProfileRef | null): boolean {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  if (a.username && b.username) return a.username.toLowerCase() === b.username.toLowerCase();
  return a.url === b.url;
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const mainOf = (doc: Document): Element => doc.querySelector('[role="main"]') ?? doc.body;

/** How a like, a comment or a message went. */
export type AutoResult =
  /** Liked, or the comment or message sent. */
  | 'done'
  /** Their post was liked already. */
  | 'already'
  /** No post of theirs on the page to like, or no box to comment or write in. */
  | 'none'
  /** Written, but Facebook didn't take it. */
  | 'not_sent';

/** A post's own Like button, not one of its comments': "Like", or "Remove Like" once liked. */
function likeButton(box: Element): Element | null {
  return (
    [...box.querySelectorAll('[role="button"], button')].find((button) => {
      if (!LIKE.test(clean(button.getAttribute('aria-label'))) || !shown(button)) return false;
      // A comment is an article inside the post, or one labelled as a comment beside it.
      const article = button.closest('[role="article"]');
      if (!article || (article !== box && !box.contains(article))) return true;
      const outer = article.parentElement?.closest('[role="article"]');
      return (
        !(outer && (outer === box || box.contains(outer))) &&
        !COMMENT.test(clean(article.getAttribute('aria-label')))
      );
    }) ?? null
  );
}

/** The first post on the page by the person, as far as the page has drawn. */
function theirPost(
  doc: Document,
  href: string,
  profile: ProfileRef,
): { readonly box: Element; readonly url: string | null } | null {
  for (const box of postBoxes(mainOf(doc))) {
    const post = readPost(box, href);
    if (post?.author && sameRef(post.author.profile, profile)) return { box, url: post.url };
  }
  return null;
}

/**
 * Likes the latest post on someone's profile that's theirs (decision 33): scrolls a little for one when none is drawn
 * yet. The post's address, when the page gave it, for noting.
 */
export async function likeLatest(
  doc: Document,
  href: string,
  profile: ProfileRef,
  view: { scrollBy(x: number, y: number): void; readonly innerHeight: number },
): Promise<{ readonly result: AutoResult; readonly postUrl: string | null }> {
  let found = theirPost(doc, href, profile);
  for (let more = 0; !found && more < 4; more++) {
    view.scrollBy(0, view.innerHeight);
    await pause(1_200);
    found = theirPost(doc, href, profile);
  }
  if (!found) return { result: 'none', postUrl: null };
  const button = likeButton(found.box);
  if (!button) return { result: 'none', postUrl: found.url };
  if (!/^like$/i.test(clean(button.getAttribute('aria-label'))))
    return { result: 'already', postUrl: found.url };
  (button as HTMLElement).click();
  return { result: 'done', postUrl: found.url };
}

/** The post's own box to comment in, never a reply's. */
function commentBox(doc: Document): HTMLElement | null {
  const label = (box: Element) =>
    clean(box.getAttribute('aria-label')) || clean(box.getAttribute('aria-placeholder'));
  const dialog = [...doc.querySelectorAll('[role="dialog"]')].filter(shown).at(-1);
  const root = dialog ?? mainOf(doc);
  const box = [...root.querySelectorAll(WRITING)].find(
    (b) => shown(b) && !inTopBar(b) && COMMENT_BOX.test(label(b)) && !REPLY_BOX.test(label(b)),
  );
  return (box as HTMLElement | undefined) ?? null;
}

/** The button beside a box that sends what's in it, once Facebook shows it. */
function sendButton(box: Element): HTMLElement | null {
  let up = box.parentElement;
  for (let steps = 0; up && steps < 12; steps++, up = up.parentElement) {
    const send = [...up.querySelectorAll('[role="button"], button')].find(
      (b) =>
        SEND.test(labelOf(b)) &&
        shown(b) &&
        isAfter(b, box) &&
        b.getAttribute('aria-disabled') !== 'true',
    );
    if (send) return send as HTMLElement;
  }
  return null;
}

/**
 * Writes a comment under the post the page shows, and sends it (decision 26): types it into the post's box to
 * comment in, presses the button that sends it (or Enter), and waits for the box to empty.
 */
export async function writeComment(doc: Document, text: string): Promise<AutoResult> {
  let box = commentBox(doc);
  if (!box) {
    // Some posts open the box only once Comment is pressed.
    const opener = [...mainOf(doc).querySelectorAll('[role="button"], button')].find(
      (b) => /^(leave a comment|comment)$/i.test(labelOf(b)) && shown(b),
    );
    (opener as HTMLElement | undefined)?.click();
    await pause(1_200);
    box = commentBox(doc);
  }
  if (!box) return 'none';
  return typeAndSend(doc, box, text);
}

/**
 * The box to write a message in: the open chat's in Messenger, else the chat window's over the page that opened last.
 * Never a box to comment in.
 */
function messageBox(doc: Document): HTMLElement | null {
  const label = (box: Element) =>
    clean(box.getAttribute('aria-label')) || clean(box.getAttribute('aria-placeholder'));
  const boxes = [...doc.querySelectorAll(WRITING)].filter(
    (b) => shown(b) && !inTopBar(b) && MESSAGE_BOX.test(label(b)) && !COMMENT_BOX.test(label(b)),
  );
  return (boxes.at(-1) as HTMLElement | undefined) ?? null;
}

/**
 * Writes a message in the chat the page shows, and sends it (decisions 26 and 27): types it into the chat's box,
 * presses the button that sends it (or Enter), and waits for the box to empty. A box with writing in it already is
 * left alone: the person may be writing there.
 */
export async function writeMessage(doc: Document, text: string): Promise<AutoResult> {
  let box = messageBox(doc);
  for (let wait = 0; !box && wait < 10; wait++) {
    await pause(500);
    box = messageBox(doc);
  }
  if (!box) return 'none';
  return typeAndSend(doc, box, text);
}

/** Types into a box to write in, and sends it with the button beside it, or Enter. */
async function typeAndSend(doc: Document, box: HTMLElement, text: string): Promise<AutoResult> {
  if (hasWriting(box)) return 'not_sent';
  box.focus();
  box.click();
  await pause(300);
  doc.execCommand('insertText', false, text);
  await pause(800);
  if (!hasWriting(box)) return 'not_sent';
  const send = sendButton(box);
  if (send) send.click();
  else
    for (const type of ['keydown', 'keypress', 'keyup'])
      box.dispatchEvent(
        new doc.defaultView!.KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
  for (let wait = 0; wait < 20; wait++) {
    await pause(300);
    if (!hasWriting(box)) return 'done';
  }
  return 'not_sent';
}
