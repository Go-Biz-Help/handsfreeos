/**
 * Check Facebook's tries (docs/outreach.md, decision 77): each of the extension's steps on Facebook taken up to its last
 * press, in the tab, so one press of Check Facebook says what works and what doesn't, all at once, rather than one step
 * at a time as each is first asked for. Each try finds what its step finds, with the step's own functions, and stops
 * before anything that changes Facebook: nothing is ever saved, posted, sent, liked, added, confirmed, cancelled,
 * unfriended or joined.
 *
 * - **Bio:** Edit bio (or Add bio) on their own profile opens its box; a word written in it, and its own put back; its
 *   Save found, never pressed; the box closed again with its Cancel (./own-profile.ts). Nothing's written in a box with
 *   no Cancel to close it.
 * - **Posting:** a group's Write something… opens the composer, with a box to write in and its Post; it's closed again,
 *   nothing written (./compose.ts).
 * - **Commenting:** on a post's own page, the post's box to comment in; a word written in it, the button that sends it
 *   looked for (Enter sends it without one), and the word taken out again (./auto.ts).
 * - **A friend request:** Add friend on the profile of someone they aren't friends with; never pressed.
 * - **Messaging:** Message on a friend's profile opens the chat, in a window over the page or in Messenger, with its box
 *   to write in; nothing's written (Messenger shows the other person someone's typing), and a window over the page is
 *   closed again.
 * - **Liking:** one of a friend's posts on their profile, and its Like; never pressed.
 * - **Confirming:** on their friend requests, each request's Confirm; never pressed.
 * - **Cancelling:** Cancel request on the profile of someone they sent one to; never pressed (./tidy.ts).
 * - **Unfriending:** Friends on a friend's profile opens its menu, with Unfriend in it; never pressed, and the menu is
 *   closed again (./tidy.ts).
 * - **Joining:** Join group on a group they aren't in; never pressed (./join.ts).
 * - **The file:** on Download your information, its first step; nothing pressed (./fetch.ts).
 *
 * Each says what it found (counts, yes or no), what it couldn't find, in the extension's own words, and, where that
 * helps, the names of what it looked among as the outline shows them (Facebook's own words; anything else hidden).
 */
import { hasWriting, WRITING } from './actions';
import {
  AUTO_PLANS,
  commentBox,
  commentOpener,
  likeButton,
  MESSAGE_PATH,
  messageBoxes,
  sendButton,
  theirPosts,
} from './auto';
import { composer, POST, startButton } from './compose';
import { clean, labelOf } from './dom';
import { FETCH_PLANS, findStep, shown, visible, waitingForPerson } from './fetch';
import { CONFIRM } from './friends';
import { joinState, typeInto } from './join';
import { maskText, outlinePage } from './outline';
import { bioBox, bioButton } from './own-profile';
import { readPage } from './page';
import { readProfile } from './profile';
import { TIDY_PLANS } from './tidy';
import type { ProfilePage, ProfileRef } from './types';
import { classifyUrl } from './urls';
import { missingOf, TRY_WORD, untried, went, type StepTry, type TryStep } from '../tries';

/** The steps Check Facebook tries, in the order it tries them. */
export const FACEBOOK_TRY_STEPS = [
  'bio',
  'confirm',
  'post',
  'comment',
  'request',
  'join',
  'like',
  'unfriend',
  'message',
  'cancel',
  'file',
] as const satisfies readonly TryStep[];

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const mainOf = (doc: Document): Element => doc.querySelector('[role="main"]') ?? doc.body;
const BUTTONS = '[role="button"], button';

/** Looks for something till it shows, or `ms` is up. */
async function waitFor<T>(find: () => T | null | undefined, ms = 5_000): Promise<T | null> {
  for (let waited = 0; ; waited += 300) {
    const found = find();
    if (found) return found;
    if (waited >= ms) return null;
    await pause(300);
  }
}

/** What a control is called, as the outline shows it. */
const seenAs = (element: Element) =>
  maskText(labelOf(element)).slice(0, 60) || `(${element.tagName.toLowerCase()})`;

/** The shown buttons in a box, as the outline would name them: what was there when what's wanted wasn't. */
const namesIn = (root: ParentNode, most = 12) =>
  [...root.querySelectorAll(BUTTONS)].filter(shown).slice(0, most).map(seenAs);

/**
 * The page's outline as it is now, as a note's would be: the page's kind and what the readers found, the extension's
 * version and the window's size.
 */
export function outlineNow(doc: Document): string {
  const view = doc.defaultView;
  const runtime = (
    globalThis as { chrome?: { runtime?: { getManifest?: () => { version: string } } } }
  ).chrome?.runtime;
  const version = runtime?.getManifest?.().version;
  const href = doc.location.href;
  return outlinePage(doc, href, {
    found: readPage(doc, href),
    ...(version ? { version } : {}),
    ...(view ? { window: { width: view.innerWidth, height: view.innerHeight } } : {}),
  });
}

/** The button in a box that says one of these, shown (or, `offToo`, in sight though Facebook has it off). */
const buttonIn = (root: ParentNode, words: RegExp, offToo = false): HTMLElement | null =>
  [...root.querySelectorAll<HTMLElement>(BUTTONS)].find(
    (b) => words.test(labelOf(b)) && (offToo ? visible : shown)(b),
  ) ?? null;

/** What's written in a box: a plain box's value, or a rich box's words. */
const textOf = (box: HTMLElement): string =>
  'value' in box && typeof box.value === 'string' ? box.value : clean(box.textContent);

/** Where things stand on the profile the page shows, as the profile reader says. */
const friendshipOn = (doc: Document, href: string): ProfilePage['friendship'] =>
  readProfile(mainOf(doc), classifyUrl(href), href, doc.title).profile.friendship;

/** Why a step isn't tried on someone, by where things stand with them. */
const STANDING: Readonly<Record<ProfilePage['friendship'], string>> = {
  self: 'it’s your own profile',
  friends: 'you’re friends with them already',
  request_sent: 'your friend request to them is waiting already',
  request_received: 'they asked to be friends with you',
  not_friends: 'you aren’t friends with them',
  unknown: 'the profile doesn’t say where things stand',
};

const SAVE = /^save$/i;
const CANCEL = /^cancel$/i;
const CLOSE = /^close( chat)?$/i;
const LEAVE = /^(leave|discard|leave page)$/i;

// ------------------------------------------------------------------------------------------------ each step

/** Putting the bio in, on their own profile: its box opened, a word written and their own put back, closed again. */
export async function tryBio(doc: Document): Promise<StepTry> {
  const button = bioButton(doc);
  if (!button)
    return went(
      'bio',
      { button: false },
      ['no Edit bio or Add bio on your profile'],
      namesIn(mainOf(doc)),
    );
  button.click();
  const box = await waitFor(() => bioBox(doc), 8_000);
  if (!box)
    return {
      ...went(
        'bio',
        { button: true, box: false },
        ['Edit bio opened no box to write the bio in'],
        namesIn(mainOf(doc)),
      ),
      outline: outlineNow(doc),
    };
  const save = buttonIn(mainOf(doc), SAVE, true);
  const cancel = buttonIn(mainOf(doc), CANCEL);
  // A word written only where Cancel can close the box again, and their own bio put back before that.
  const before = textOf(box);
  let typed = false;
  let restored = true;
  if (cancel) {
    typeInto(doc, box, `${before}${before ? ' ' : ''}${TRY_WORD}`, true);
    await pause(500);
    typed = textOf(box).includes(TRY_WORD);
    typeInto(doc, box, before, true);
    await pause(300);
    restored = clean(textOf(box)) === clean(before);
  }
  const missing = missingOf([
    !save && 'no Save by the bio’s box',
    !cancel && 'no Cancel by the bio’s box, so nothing was written in it',
    cancel !== null && !typed && 'writing in the bio’s box didn’t take',
    !restored && 'your bio didn’t go back in its box',
  ]);
  // What's missing shows in the box: the page's outline is taken before it's closed.
  const outline = missing.length ? outlineNow(doc) : undefined;
  cancel?.click();
  const closed = cancel ? (await waitFor(() => !bioBox(doc), 4_000)) === true : false;
  if (cancel && !closed) missing.push('the bio’s box didn’t close again');
  return {
    ...went(
      'bio',
      { button: true, box: true, save: Boolean(save), cancel: Boolean(cancel), typed, closed },
      missing,
      missing.length ? namesIn(box.closest('form') ?? box.parentElement ?? mainOf(doc)) : [],
    ),
    ...(outline ? { outline } : {}),
  };
}

/** Closes a box over the page without anything in it going anywhere: its Close, then Leave if Facebook asks. */
async function closeOver(doc: Document, box: Element): Promise<boolean> {
  const close = [...box.querySelectorAll<HTMLElement>(BUTTONS)].find(
    (c) => shown(c) && CLOSE.test(labelOf(c)),
  );
  if (!close) return false;
  close.click();
  const closed = await waitFor(() => {
    if (!box.isConnected || !shown(box)) return true;
    [...doc.querySelectorAll('[role="dialog"]')]
      .filter((other) => other !== box && shown(other))
      .flatMap((other) => [...other.querySelectorAll<HTMLElement>(BUTTONS)])
      .find((c) => shown(c) && LEAVE.test(labelOf(c)))
      ?.click();
    return null;
  }, 5_000);
  return closed === true;
}

/** Posting, on a group's page: the composer opened and closed again, nothing written. */
export async function tryPost(doc: Document): Promise<StepTry> {
  let box = composer(doc);
  const start = box ? null : startButton(doc);
  if (!box && !start)
    return went(
      'post',
      { start: false },
      ['no Write something… on the group’s page'],
      namesIn(mainOf(doc)),
    );
  start?.click();
  box ??= await waitFor(() => composer(doc), 8_000);
  if (!box) {
    // What opened instead, if anything: a box over the page, and its buttons.
    const other = [...doc.querySelectorAll('[role="dialog"]')].filter((d) => shown(d)).pop();
    return {
      ...went(
        'post',
        { start: true, composer: false, box: Boolean(other) },
        [
          other
            ? 'the box Write something… opened has no Post, or nowhere to write'
            : 'Write something… opened nothing',
        ],
        other ? namesIn(other) : [],
      ),
      outline: outlineNow(doc),
    };
  }
  const writing = [...box.querySelectorAll(WRITING)].some(shown);
  // Post, whether or not Facebook has it on yet: it stays off till something's written.
  const post = [...box.querySelectorAll(BUTTONS)].some((b) => POST.test(labelOf(b)) && visible(b));
  const missing = missingOf([
    !writing && 'no box to write the post in',
    !post && 'no Post in the composer',
  ]);
  const outline = missing.length ? outlineNow(doc) : undefined;
  const closed = await closeOver(doc, box);
  if (!closed) missing.push('the composer didn’t close again');
  return {
    ...went('post', { start: true, composer: true, writing, post, closed }, missing),
    ...(outline ? { outline } : {}),
  };
}

/** Takes everything written in a box out again. */
async function emptyBox(doc: Document, box: HTMLElement): Promise<boolean> {
  box.focus();
  doc.execCommand('selectAll');
  doc.execCommand('delete');
  await pause(300);
  return !hasWriting(box);
}

/**
 * Commenting, on a post's own page: a word written in its box to comment in, the button that sends it looked for (Enter
 * sends it where there's none, as the runner does), and the word taken out again.
 */
export async function tryComment(doc: Document): Promise<StepTry> {
  let box = commentBox(doc);
  const open = box !== null;
  const opener = box ? null : commentOpener(doc);
  if (!box) {
    opener?.click();
    box = await waitFor(() => commentBox(doc), 3_000);
  }
  if (!box)
    return {
      ...went(
        'comment',
        { open, opener: Boolean(opener), box: false },
        [
          opener
            ? 'Comment opened no box to write in'
            : 'no box to comment in, and no Comment, on the post',
        ],
        namesIn(mainOf(doc)),
      ),
      outline: outlineNow(doc),
    };
  if (hasWriting(box))
    return untried('comment', 'writing in the comment box already, left alone', { box: true });
  box.focus();
  box.click();
  await pause(300);
  doc.execCommand('insertText', false, TRY_WORD);
  await pause(800);
  const typed = hasWriting(box);
  const send = typed ? sendButton(box) : null;
  const emptied = typed ? await emptyBox(doc, box) : true;
  const missing = missingOf([
    !typed && 'writing in the comment box didn’t take',
    !emptied && 'the comment box didn’t empty again',
  ]);
  return {
    ...went(
      'comment',
      { open, opener: Boolean(opener), box: true, typed, send: Boolean(send), emptied },
      missing,
    ),
    ...(missing.length ? { outline: outlineNow(doc) } : {}),
  };
}

/** A friend request, on the profile of someone they aren't friends with: Add friend found, never pressed. */
export function tryRequest(doc: Document, href: string): StepTry {
  const standing = friendshipOn(doc, href);
  if (standing !== 'not_friends' && standing !== 'unknown')
    return untried('request', STANDING[standing]);
  const add = findStep(doc, AUTO_PLANS.friend_request.path[0]!);
  return went(
    'request',
    { addFriend: Boolean(add), standingKnown: standing !== 'unknown' },
    add ? [] : ['no Add friend under their name'],
    add ? [] : namesIn(mainOf(doc)),
  );
}

/** The box around a chat window's box to write in that has its own Close: the window over the page. */
function chatWindowOf(box: Element): Element | null {
  for (let up = box.parentElement, steps = 0; up && steps < 20; up = up.parentElement, steps++)
    if ([...up.querySelectorAll(BUTTONS)].some((c) => shown(c) && CLOSE.test(labelOf(c))))
      return up;
  return null;
}

/**
 * Messaging, from a friend's profile: Message opens a chat with its box to write in, in a window over the page or in
 * Messenger; nothing is written, and a window over the page is closed again. A chat window open before it doesn't
 * count.
 */
export async function tryMessage(doc: Document, href: string): Promise<StepTry> {
  const standing = friendshipOn(doc, href);
  if (standing === 'self') return untried('message', STANDING.self);
  const message = findStep(doc, MESSAGE_PATH[0]!) as HTMLElement | null;
  if (!message)
    return went(
      'message',
      { message: false },
      ['no Message under their name'],
      namesIn(mainOf(doc)),
    );
  const before = new Set(messageBoxes(doc));
  message.click();
  const box = await waitFor(() => messageBoxes(doc).find((b) => !before.has(b)) ?? null, 6_000);
  const page = classifyUrl(doc.location.href).kind === 'chat';
  const area = box && !page ? chatWindowOf(box) : null;
  const missing = missingOf([!box && 'Message opened no chat to write in']);
  const outline = missing.length ? outlineNow(doc) : undefined;
  const close = area
    ? [...area.querySelectorAll<HTMLElement>(BUTTONS)].find(
        (c) => shown(c) && CLOSE.test(labelOf(c)),
      )
    : null;
  close?.click();
  return {
    ...went(
      'message',
      { message: true, box: Boolean(box), page, window: Boolean(area), closed: Boolean(close) },
      missing,
    ),
    ...(outline ? { outline } : {}),
  };
}

/**
 * Liking, on a friend's profile: one of their posts, and its Like, never pressed. Their posts are below the top, so the
 * page is scrolled a little while none are drawn, as the runner reads them.
 */
export async function tryLike(
  doc: Document,
  href: string,
  them: ProfileRef,
  view: { scrollBy(x: number, y: number): void; readonly innerHeight: number },
): Promise<StepTry> {
  let posts = theirPosts(doc, href, them);
  for (let more = 0; !posts.length && more < 4; more++) {
    view.scrollBy(0, view.innerHeight);
    await pause(1_200);
    posts = theirPosts(doc, href, them);
  }
  if (!posts.length) return untried('like', 'none of their posts on their profile', { posts: 0 });
  const liked = posts.filter((p) => p.post.liked).length;
  const pick = posts.find((p) => !p.post.liked) ?? posts[0]!;
  const like = likeButton(pick.box);
  return went(
    'like',
    { posts: posts.length, liked, like: Boolean(like) },
    like ? [] : ['no Like on their post'],
    like ? [] : namesIn(pick.box),
  );
}

/** Closes a menu Facebook opened over the page: Escape, then the button that opened it pressed again. */
async function closeMenu(doc: Document, opener: HTMLElement): Promise<boolean> {
  const open = () => [...doc.querySelectorAll('[role="menu"]')].some(shown);
  const view = doc.defaultView;
  if (view)
    (doc.activeElement ?? doc.body).dispatchEvent(
      new view.KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        bubbles: true,
      }),
    );
  if (await waitFor(() => !open(), 1_000)) return true;
  opener.click();
  return (await waitFor(() => !open(), 2_000)) === true;
}

/** Unfriending, on a friend's profile: Friends opens its menu, with Unfriend in it, never pressed; the menu closed again. */
export async function tryUnfriend(doc: Document, href: string): Promise<StepTry> {
  const standing = friendshipOn(doc, href);
  if (standing !== 'friends' && standing !== 'unknown')
    return untried('unfriend', STANDING[standing]);
  const [friendsStep, unfriendStep] = TIDY_PLANS.unfriend.path;
  const friends = findStep(doc, friendsStep!) as HTMLElement | null;
  if (!friends)
    return went(
      'unfriend',
      { friends: false },
      ['no Friends under their name'],
      namesIn(mainOf(doc)),
    );
  friends.click();
  const unfriend = await waitFor(() => findStep(doc, unfriendStep!), 3_000);
  const menu =
    [...doc.querySelectorAll('[role="menu"], [role="dialog"]')].filter((m) => shown(m)).pop() ??
    null;
  const missing = missingOf([
    !unfriend && (menu ? 'no Unfriend in the menu Friends opened' : 'Friends opened no menu'),
  ]);
  const seen =
    !unfriend && menu
      ? [...menu.querySelectorAll('[role="menuitem"], ' + BUTTONS)]
          .filter(shown)
          .slice(0, 12)
          .map(seenAs)
      : [];
  const outline = missing.length ? outlineNow(doc) : undefined;
  const closed = menu ? await closeMenu(doc, friends) : true;
  return {
    ...went(
      'unfriend',
      { friends: true, menu: Boolean(menu), unfriend: Boolean(unfriend), closed },
      missing,
      seen,
    ),
    ...(outline ? { outline } : {}),
  };
}

/** Confirming, on their friend requests: each request's Confirm, never pressed. */
export function tryConfirm(doc: Document, href: string): StepTry {
  const read = readPage(doc, href);
  const requests = (read.people ?? []).filter((p) => p.request === 'received').length;
  const confirms = [...doc.querySelectorAll(BUTTONS)].filter(
    (b) => shown(b) && CONFIRM.test(labelOf(b)),
  ).length;
  if (!requests && !confirms)
    return untried('confirm', 'no friend requests waiting for you', { requests: 0 });
  return went(
    'confirm',
    { requests, confirm: confirms },
    missingOf([
      !confirms && 'no Confirm by the requests you’ve got',
      confirms > 0 && !requests && 'Confirm, but no request the reader could read',
    ]),
  );
}

/** Cancelling, on the profile of someone they sent a request to: Cancel request found, never pressed. */
export function tryCancel(doc: Document, href: string): StepTry {
  const standing = friendshipOn(doc, href);
  if (standing !== 'request_sent' && standing !== 'unknown')
    return untried(
      'cancel',
      standing === 'friends'
        ? 'they’ve accepted your friend request since'
        : standing === 'not_friends'
          ? 'your friend request to them isn’t waiting any more'
          : STANDING[standing],
    );
  const cancel = findStep(doc, TIDY_PLANS.cancel_request.path[0]!);
  return went(
    'cancel',
    { cancel: Boolean(cancel), standingKnown: standing !== 'unknown' },
    cancel ? [] : ['no Cancel request under their name'],
    cancel ? [] : namesIn(mainOf(doc)),
  );
}

/** Joining, on a group they aren't in: Join group found, never pressed. */
export function tryJoin(doc: Document): StepTry {
  const now = joinState(doc);
  if (now.state === 'joined') return untried('join', 'you’re in this group already');
  if (now.state === 'asked') return untried('join', 'you’ve asked to join this group already');
  return went(
    'join',
    { join: now.state === 'join' },
    now.state === 'join' ? [] : ['no Join group on the group’s page'],
    now.state === 'join' ? [] : namesIn(mainOf(doc)),
  );
}

/** Getting the file, on Download your information: its first step there; nothing pressed. */
export function tryFile(doc: Document): StepTry {
  if (waitingForPerson(doc))
    return untried('file', 'Facebook asks for your password first, so its steps don’t show', {
      password: true,
    });
  const text = clean(doc.body.textContent).toLowerCase();
  const plan = FETCH_PLANS.request;
  const making = plan.steps.find((s) => s.action === 'stopIf');
  if (making?.words.some((words) => text.includes(words.toLowerCase())))
    return untried('file', 'Facebook is making your file already, so its steps don’t show', {
      preparing: true,
    });
  const first = plan.steps.find((s) => s.action === 'press' && !s.optional)!;
  const found = findStep(doc, first);
  return went(
    'file',
    { first: Boolean(found) },
    found ? [] : [`nothing saying “${first.words[0]}”`],
    found ? [] : namesIn(doc.body),
  );
}
