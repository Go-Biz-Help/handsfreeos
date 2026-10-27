/**
 * What the extension presses on its own (docs/outreach.md, decisions 26 to 33), once the person turns it on in the
 * panel: on the profile of someone on their list for today, Add friend, or Confirm on a request they got, or Like on
 * the one of their latest posts the AI picked; and on a post on their list, the comment the AI drafted. The background's runner opens each
 * page in a window of its own (src/auto/run.ts), checks it's the right one and where things stand, and asks this
 * script in that tab for one step at a time. A message goes only once it's drafted, and OK'd or let go as it is
 * (packages/core/src/addons/outreach/sends.ts).
 *
 * Add friend and Confirm go the way Cancel request and Unfriend do (./tidy.ts, ./fetch.ts); a like, a comment and a
 * message are their own: the like goes on the post of theirs the AI picked from their latest few (the words alone pick
 * without it), and only when it isn't liked already; the comment is typed into the post's own box to comment in (never a reply's), and the message into the
 * chat's box (in Messenger, or the chat window their profile's Message opens), and each is sent with its button, or
 * Enter. A message goes only into a chat the page shows is with them, never into another one left open.
 */
import { COMMENT_BOX, hasWriting, MESSAGE_BOX, REPLY_BOX, SEND, WRITING } from './actions';
import { conversationWith, isConversation, readChat } from './chat';
import { clean, inTopBar, isAfter, labelOf, textWithEmoji } from './dom';
import { shown, type FetchStep } from './fetch';
import { isNameLike, nameForms, peopleLinked, sameName } from './people';
import { COMMENT, LIKE, postBoxes, readPost } from './posts';
import type { TidyPlan } from './tidy';
import type { ProfilePage, ProfileRef } from './types';
import { classifyUrl } from './urls';
import { UI_WORDS } from './vocabulary';

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

/**
 * A profile's steps with the person's name after their words too, first: from October 2026 Add friend's label has it
 * for screen readers ("Add Friend Jane Doe", the owner's problem reports of 26 Oct 2026), Cancel request's may too, and
 * an exact step missed it. Their name whole and without its nickname, as the profile's reader takes it (./profile.ts),
 * and only theirs: a button with theirs is pressed before a plain one, and never one with someone else's under People
 * you may know.
 */
export function withTheirName(
  steps: readonly FetchStep[],
  names: readonly (string | null)[],
): FetchStep[] {
  const known = [...new Set(names.flatMap((name) => (name ? nameForms(name) : [])))];
  return steps.map((step) =>
    step.action === 'press'
      ? {
          ...step,
          words: [
            ...step.words.flatMap((word) => known.map((name) => `${word} ${name}`)),
            ...step.words,
          ],
        }
      : step,
  );
}

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

/**
 * Whether two profiles are the same person by a key both have, by number or by username; null when they share none,
 * as a link by number and one by username don't: those prove nothing either way.
 */
export function sameByKey(a: ProfileRef | null, b: ProfileRef | null): boolean | null {
  if (!a || !b || !((a.id && b.id) || (a.username && b.username))) return null;
  return sameRef(a, b);
}

/**
 * Whether the profile on the page is the one HandsFreeOS listed: by number, or by username, when both have one; else
 * by name, as someone saved by number from a group may open at their username.
 */
export function samePerson(
  shown: ProfileRef,
  shownName: string | null,
  want: ProfileRef,
  name: string,
): boolean {
  if ((shown.id && want.id) || (shown.username && want.username)) return sameRef(shown, want);
  return shownName !== null && sameName(shownName, name);
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
  | 'not_sent'
  /**
   * A message the extension didn't send itself: the typing didn't land in their chat's box only, or the box stopped
   * being theirs before it went. What it typed is taken out again.
   */
  | 'not_theirs';

/** A post's own Like button, not one of its comments': "Like", or "Remove Like" once liked. */
export function likeButton(box: Element): Element | null {
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

/** What a post's pictures show, as Facebook describes them to screen readers: never a face beside a name. */
function picturesOf(box: Element): string[] {
  const seen = new Set<string>();
  for (const img of box.querySelectorAll('img[alt]')) {
    // A comment's pictures aren't the post's.
    const article = img.closest('[role="article"]');
    if (article && box.contains(article) && COMMENT.test(clean(article.getAttribute('aria-label'))))
      continue;
    const alt = clean(img.getAttribute('alt'));
    if (/^(may be |could be |an? |image|photo|no photo description)/i.test(alt)) seen.add(alt);
  }
  return [...seen];
}

/** One of their posts the extension read, to pick one to like (`outreach.like.pick`). */
export interface TheirPost {
  readonly url: string | null;
  readonly when: string | null;
  readonly text: string;
  readonly pictures: readonly string[];
  /** Liked by the person already. */
  readonly liked: boolean;
}

/** The posts on the page by the person, as far as the page has drawn, the latest first. */
export function theirPosts(
  doc: Document,
  href: string,
  profile: ProfileRef,
): { readonly box: Element; readonly post: TheirPost }[] {
  const found: { readonly box: Element; readonly post: TheirPost }[] = [];
  for (const box of postBoxes(mainOf(doc))) {
    const post = readPost(box, href);
    if (!post?.author || !sameRef(post.author.profile, profile)) continue;
    const like = likeButton(box);
    found.push({
      box,
      post: {
        url: post.url,
        when: post.when,
        text: post.text,
        pictures: picturesOf(box),
        liked: like !== null && !/^like$/i.test(clean(like.getAttribute('aria-label'))),
      },
    });
  }
  return found;
}

/**
 * Reads the latest few posts on someone's profile that are theirs (decision 33), scrolling a little while fewer are
 * drawn, for the AI to pick one to like.
 */
export async function readTheirPosts(
  doc: Document,
  href: string,
  profile: ProfileRef,
  view: { scrollBy(x: number, y: number): void; readonly innerHeight: number },
  most: number,
): Promise<TheirPost[]> {
  let found = theirPosts(doc, href, profile);
  for (let more = 0; found.length < most && more < 4; more++) {
    view.scrollBy(0, view.innerHeight);
    await pause(1_200);
    found = theirPosts(doc, href, profile);
  }
  return found.slice(0, most).map((f) => f.post);
}

/**
 * Likes the one of their posts picked, by its place among those `readTheirPosts` read, checked by its link when the
 * page gave one. The post's address, when the page gave it, for noting.
 */
export async function likeTheirPost(
  doc: Document,
  href: string,
  profile: ProfileRef,
  pick: { readonly index: number; readonly url: string | null },
): Promise<{ readonly result: AutoResult; readonly postUrl: string | null }> {
  const found = theirPosts(doc, href, profile);
  const one =
    (pick.url ? found.find((f) => f.post.url === pick.url) : undefined) ??
    (pick.url ? undefined : found[pick.index]);
  if (!one) return { result: 'none', postUrl: pick.url };
  const button = likeButton(one.box);
  if (!button) return { result: 'none', postUrl: one.post.url };
  if (!/^like$/i.test(clean(button.getAttribute('aria-label'))))
    return { result: 'already', postUrl: one.post.url };
  (button as HTMLElement).click();
  return { result: 'done', postUrl: one.post.url };
}

/** The post's own box to comment in, never a reply's. */
export function commentBox(doc: Document): HTMLElement | null {
  const label = (box: Element) =>
    clean(box.getAttribute('aria-label')) || clean(box.getAttribute('aria-placeholder'));
  const dialog = [...doc.querySelectorAll('[role="dialog"]')].filter(shown).at(-1);
  const root = dialog ?? mainOf(doc);
  const box = [...root.querySelectorAll(WRITING)].find(
    (b) => shown(b) && !inTopBar(b) && COMMENT_BOX.test(label(b)) && !REPLY_BOX.test(label(b)),
  );
  return (box as HTMLElement | undefined) ?? null;
}

/**
 * The button beside a box that sends what's in it, once Facebook shows it: never past a box around it that holds
 * another box to write in, whose button that would be (another chat window's).
 */
export function sendButton(box: Element): HTMLElement | null {
  let up = box.parentElement;
  for (let steps = 0; up && steps < 12; steps++, up = up.parentElement) {
    if (up.querySelectorAll(WRITING).length > 1) break;
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

/** The post's Comment, which some posts need pressed before they show their box to comment in. */
export function commentOpener(doc: Document): HTMLElement | null {
  return (
    [...mainOf(doc).querySelectorAll<HTMLElement>('[role="button"], button')].find(
      (b) => /^(leave a comment|comment)$/i.test(labelOf(b)) && shown(b),
    ) ?? null
  );
}

/**
 * Writes a comment under the post the page shows, and sends it (decision 26): types it into the post's box to
 * comment in, presses the button that sends it (or Enter), and waits for the box to empty.
 */
export async function writeComment(doc: Document, text: string): Promise<AutoResult> {
  let box = commentBox(doc);
  if (!box) {
    commentOpener(doc)?.click();
    await pause(1_200);
    box = commentBox(doc);
  }
  if (!box) return 'none';
  return typeAndSend(doc, box, text);
}

/** Every box to write a message in on the page, in page order: Messenger's open chat, and each chat window's. */
export function messageBoxes(doc: Document): HTMLElement[] {
  const label = (box: Element) =>
    clean(box.getAttribute('aria-label')) || clean(box.getAttribute('aria-placeholder'));
  return [...doc.querySelectorAll<HTMLElement>(WRITING)].filter(
    (b) => shown(b) && !inTopBar(b) && MESSAGE_BOX.test(label(b)) && !COMMENT_BOX.test(label(b)),
  );
}

/** Close chat, on a small chat window's header. */
const CLOSE_CHAT = /^close chat$/i;

/**
 * Whether a chat is with them. One that links to a profile is theirs only by a key both have, by number or by
 * username, as `sameByKey` goes: someone else may have their name, and a link by the other kind proves nothing. One
 * that links to nobody is theirs by one of the names Facebook showed for them, whole or without a nickname.
 */
function chatIsThem(
  profile: ProfileRef | null,
  name: string | null,
  them: ProfileRef,
  names: readonly string[],
): boolean {
  if (profile) return sameByKey(profile, them) === true;
  if (!name) return false;
  const shownAs = nameForms(name);
  return names.some((one) => nameForms(one).some((form) => shownAs.some((s) => sameName(s, form))));
}

/** The Close chat buttons in a part of the page: one for each chat window in it. */
const closesIn = (scope: Element) =>
  [...scope.querySelectorAll('[role="button"], button')].filter((b) => CLOSE_CHAT.test(labelOf(b)));

/**
 * The small chat window a box to write a message in is in, over a page that isn't a chat's own: the nearest box around
 * it with a Close chat in it, as each window's header has, with that Close chat. Null when a box around it holds a
 * second box to write in, a second chat's messages or a second Close chat first, or the main column: that's past the
 * window, and a window without its own Close chat is never taken for anyone's. Facebook wraps each part in boxes of
 * its own, so this goes by what each box holds, never by how deep it is.
 */
function chatWindowOf(
  box: Element,
  main: Element,
): { readonly chatWindow: Element; readonly close: Element } | null {
  for (let up = box.parentElement; up && !up.contains(main); up = up.parentElement) {
    const closes = closesIn(up);
    if (
      closes.length > 1 ||
      up.querySelectorAll(WRITING).length > 1 ||
      [...up.querySelectorAll('[aria-label]')].filter(isConversation).length > 1
    )
      return null;
    if (closes.length === 1) return { chatWindow: up, close: closes[0]! };
  }
  return null;
}

/**
 * A chat window's header: the widest box around its Close chat that holds neither the box to write in nor the chat's
 * messages. Their link, their name and the window's buttons are there; a new chat's introduction, which may link to a
 * mutual friend or a Page, and what's typed are not.
 */
function headerOf(chatWindow: Element, close: Element, box: Element): Element {
  const messages = [...chatWindow.querySelectorAll('[aria-label]')].find(isConversation);
  let header = close;
  for (
    let up = close.parentElement;
    up && up !== chatWindow && !up.contains(box) && !(messages && up.contains(messages));
    up = up.parentElement
  )
    header = up;
  return header;
}

/** The name a header's heading gives: the one on Chat settings. */
function headingIn(header: Element): string | null {
  for (const heading of header.querySelectorAll('h1, h2, h3, [role="heading"]')) {
    const text = clean(heading.textContent);
    if (isNameLike(text) && !UI_WORDS.has(text.toLowerCase())) return text;
  }
  return null;
}

/**
 * Whether a small chat window is with them, by its header only: everyone the header links to is them, or, where it
 * links to nobody, the name its heading gives, else its messages' label ("Messages in conversation with Jane Doe"), is
 * theirs.
 */
function windowIsThem(
  chatWindow: Element,
  header: Element,
  base: string,
  them: ProfileRef,
  names: readonly string[],
): boolean {
  const linked = peopleLinked(header.querySelectorAll('a[href]'), base);
  if (linked.length > 0)
    return linked.every((person) => chatIsThem(person.profile, person.name, them, names));
  const messages = [...chatWindow.querySelectorAll('[aria-label]')].find(isConversation);
  const name = headingIn(header) ?? (messages ? conversationWith(messages) : null);
  return chatIsThem(null, name, them, names);
}

/**
 * The box to write a message to them in, and only theirs. On a chat's own page in Messenger, the chat's box in the
 * main column, when the chat shows it's with them. On any other page, the box of the one small chat window over it
 * that is with them: Facebook keeps the windows of earlier chats open from page to page, and a new one may draw its
 * box after them, or before. Null when there's none, or more than one: never another box.
 */
export function messageBoxFor(
  doc: Document,
  href: string,
  them: ProfileRef,
  names: readonly string[],
): HTMLElement | null {
  // Without the main column, there's no telling a chat's own page from a window over another.
  const main = doc.querySelector('[role="main"]');
  if (!main) return null;
  const address = classifyUrl(href);
  if (address.kind === 'chat') {
    const chat = readChat(doc, address, href);
    if (!chatIsThem(chat.profile, chat.name, them, names)) return null;
    const own = messageBoxes(doc).filter((box) => main.contains(box));
    return own.length === 1 ? own[0]! : null;
  }
  const theirs = messageBoxes(doc).filter((box) => {
    if (main.contains(box)) return false;
    const around = chatWindowOf(box, main);
    return (
      around !== null &&
      windowIsThem(
        around.chatWindow,
        headerOf(around.chatWindow, around.close, box),
        href,
        them,
        names,
      )
    );
  });
  return theirs.length === 1 ? theirs[0]! : null;
}

/**
 * Writes a message in their chat, and sends it (decisions 26 and 27): waits a few seconds for their chat's box, types
 * it there, presses the button that sends it (or Enter), and waits for the box to empty. A box with writing in it
 * already is left alone: the person may be writing there. Nothing is typed unless the focus is in their box, and
 * nothing is sent unless, once typed, it's still their chat's box and no other box took the writing; else what was
 * typed is taken out again, of every box it went in (`not_theirs`).
 */
export async function writeMessage(
  doc: Document,
  href: string,
  text: string,
  them: ProfileRef,
  names: readonly string[],
): Promise<AutoResult> {
  // Message on their profile may move the tab to Messenger meanwhile.
  const theirs = () => messageBoxFor(doc, doc.location?.href ?? href, them, names);
  let box = theirs();
  for (let wait = 0; !box && wait < 10; wait++) {
    await pause(500);
    box = theirs();
  }
  if (!box) return 'none';
  return typeAndSend(doc, box, text, theirs);
}

/** Whether the focus is in a box: on it, or on something inside it. */
const focusIn = (doc: Document, box: Element) =>
  doc.activeElement !== null && box.contains(doc.activeElement);

/** Takes what was typed out of a box that was empty before, only with the focus in it. */
function takeOut(doc: Document, box: HTMLElement): void {
  box.focus();
  if (!focusIn(doc, box)) return;
  doc.getSelection()?.selectAllChildren(box);
  doc.execCommand('delete', false);
}

/**
 * Types into a box to write in, and sends it with the button beside it, or Enter. For a message, `theirs` finds their
 * chat's box again, for the checks before typing and before sending.
 */
async function typeAndSend(
  doc: Document,
  box: HTMLElement,
  text: string,
  theirs?: () => HTMLElement | null,
): Promise<AutoResult> {
  if (hasWriting(box)) return 'not_sent';
  // What each box says before typing, to see that no other one takes the writing.
  const before = new Map([...doc.querySelectorAll(WRITING)].map((b) => [b, textWithEmoji(b)]));
  box.focus();
  box.click();
  await pause(300);
  if (theirs && !focusIn(doc, box)) return 'not_theirs';
  doc.execCommand('insertText', false, text);
  await pause(800);
  if (theirs) {
    const elsewhere = [...doc.querySelectorAll<HTMLElement>(WRITING)].filter(
      (other) =>
        other !== box &&
        !other.contains(box) &&
        !box.contains(other) &&
        textWithEmoji(other) !== (before.get(other) ?? ''),
    );
    if (elsewhere.length > 0 || (hasWriting(box) && theirs() !== box)) {
      // Any other box the writing went in is emptied again, as it was; one with the person's writing is left alone.
      for (const other of elsewhere) if (before.get(other) === '') takeOut(doc, other);
      if (hasWriting(box)) takeOut(doc, box);
      return 'not_theirs';
    }
  }
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
