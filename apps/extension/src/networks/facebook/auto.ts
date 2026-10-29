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
import { findStep, shown, type FetchStep } from './fetch';
import { isNameLike, nameForms, peopleLinked, sameName } from './people';
import { COMMENT, LIKE, postBoxes, readPost } from './posts';
import type { TidyPlan } from './tidy';
import type { Named, ProfilePage, ProfileRef } from './types';
import { classifyUrl, FACEBOOK } from './urls';
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
   * being theirs before it went. What it typed is taken out again, or said where it couldn't be (`MessageWrote`).
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

/** One post in a group's feed (decision 114): for the day's likes there and its question for a reply. */
export interface GroupFeedPost extends TheirPost {
  readonly author: Named | null;
  readonly comments: number | null;
  readonly reactions: number | null;
}

/** The posts in the group's feed on the page, as far as it has drawn, in page order: anyone's, with words. */
export function groupFeedPosts(
  doc: Document,
  href: string,
): { readonly box: Element; readonly post: GroupFeedPost }[] {
  const found: { readonly box: Element; readonly post: GroupFeedPost }[] = [];
  for (const box of postBoxes(mainOf(doc))) {
    const post = readPost(box, href);
    if (!post?.text) continue;
    const like = likeButton(box);
    found.push({
      box,
      post: {
        url: post.url,
        when: post.when,
        text: post.text,
        pictures: picturesOf(box),
        liked: like !== null && !/^like$/i.test(clean(like.getAttribute('aria-label'))),
        author: post.author,
        comments: post.comments,
        reactions: post.reactions,
      },
    });
  }
  return found;
}

/** Reads the newest few posts in a group's feed (decision 114), scrolling a little while fewer are drawn. */
export async function readGroupFeed(
  doc: Document,
  href: string,
  view: { scrollBy(x: number, y: number): void; readonly innerHeight: number },
  most: number,
): Promise<GroupFeedPost[]> {
  let found = groupFeedPosts(doc, href);
  for (let more = 0; found.length < most && more < 3; more++) {
    view.scrollBy(0, view.innerHeight);
    await pause(1_200);
    found = groupFeedPosts(doc, href);
  }
  return found.slice(0, most).map((f) => f.post);
}

/**
 * Likes one of the posts `readGroupFeed` read, by its place among them, checked by its link when the page gave one
 * (decision 114). The post's address, when the page gave it, for noting.
 */
export function likeGroupPost(
  doc: Document,
  href: string,
  pick: { readonly index: number; readonly url: string | null },
): { readonly result: AutoResult; readonly postUrl: string | null } {
  const found = groupFeedPosts(doc, href);
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
  return (await typeAndSend(doc, box, text)).result;
}

/** What a box to write in is called: its label, else its placeholder. */
const boxLabel = (box: Element) =>
  clean(box.getAttribute('aria-label')) || clean(box.getAttribute('aria-placeholder'));

/** Every box to write a message in on the page, in page order: Messenger's open chat, and each chat window's. */
export function messageBoxes(doc: Document): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>(WRITING)].filter(
    (b) =>
      shown(b) && !inTopBar(b) && MESSAGE_BOX.test(boxLabel(b)) && !COMMENT_BOX.test(boxLabel(b)),
  );
}

/** Close chat, on a small chat window's header. */
const CLOSE_CHAT = /^close chat$/i;
/** Who a box to write a message in says it writes to: "Write to Jane Doe" in a chat window, "Message Jane Doe". */
const WRITES_TO = /^(?:write to|message)\s+(.+?)(?:…|\.\.\.)?$/i;
/** How long their profile's Message is looked for. */
const MESSAGE_WAIT_MS = 8_000;

/** Whether a name is one of the names Facebook showed for them, whole or without a nickname. */
function namedAs(name: string, names: readonly string[]): boolean {
  const shownAs = nameForms(name);
  return names.some((one) => nameForms(one).some((form) => shownAs.some((s) => sameName(s, form))));
}

/**
 * Whether two names may be the same person's, for a check that turns a chat down: the same whole or without a
 * nickname, or one the other's first name or names ("Dana" may be "Dana Reyes").
 */
function mayBeSame(a: string, b: string): boolean {
  return nameForms(a).some((x) =>
    nameForms(b).some((y) => {
      const [one, other] = [x.toLowerCase(), y.toLowerCase()];
      return one === other || one.startsWith(`${other} `) || other.startsWith(`${one} `);
    }),
  );
}

/**
 * Whether a chat on its own page in Messenger is with them. One that links to a profile is theirs only by a key both
 * have, by number or by username, as `sameByKey` goes: someone else may have their name, and a link by the other kind
 * proves nothing. One that links to nobody is theirs by one of the names Facebook showed for them, whole or without a
 * nickname, only where names may count (`byName`).
 */
function chatIsThem(
  profile: ProfileRef | null,
  name: string | null,
  them: ProfileRef,
  names: readonly string[],
  byName: boolean,
): boolean {
  if (profile) return sameByKey(profile, them) === true;
  return byName && name !== null && namedAs(name, names);
}

/**
 * Whether a box's own label agrees with whose chat it seems to be in: one that names someone ("Write to Riley Quinn")
 * names one of them, or who its chat's header shows. A box taken for under another window's header never does.
 */
function boxAgrees(box: Element, shownAs: readonly (string | null)[]): boolean {
  const named = WRITES_TO.exec(boxLabel(box))?.[1];
  return !named || shownAs.some((name) => name !== null && mayBeSame(named, name));
}

/** The Close chat buttons in a part of the page: one for each chat window in it. */
const closesIn = (scope: Element) =>
  [...scope.querySelectorAll('[role="button"], button')].filter((b) => CLOSE_CHAT.test(labelOf(b)));

/** A chat's messages, labelled as the conversation, in a part of the page. */
const conversationsIn = (scope: Element) =>
  [...scope.querySelectorAll('[aria-label]')].filter(isConversation);

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
      conversationsIn(up).length > 1
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
  const messages = conversationsIn(chatWindow)[0];
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
 * The people some links in a chat window lead to, read from Facebook's own root: a link that leads nowhere ("#", or
 * nothing) is never the profile the tab is on.
 */
const linkedIn = (links: Iterable<Element>) => peopleLinked(links, FACEBOOK);

/**
 * How a small chat window shows it's with them, by its header: `key` when everyone the header links to is them by a
 * key HandsFreeOS keeps too, by number or by username. Else, only for a window that opened on their profile's
 * Message (`fresh`), `name`: the header links to them by the other kind of key, or to nobody, with one of the names
 * Facebook showed for them (on its links, else its heading, else its messages' label), and nothing else in the window
 * outside its messages and its part to write in links to someone else. Null when it shows neither, or its box's own
 * label names someone else.
 */
function windowProof(
  box: Element,
  main: Element,
  them: ProfileRef,
  names: readonly string[],
  fresh: boolean,
): 'key' | 'name' | null {
  const around = chatWindowOf(box, main);
  if (!around) return null;
  const { chatWindow, close } = around;
  const header = headerOf(chatWindow, close, box);
  const linked = linkedIn(header.querySelectorAll('a[href]'));
  const heading = headingIn(header);
  if (!boxAgrees(box, [...names, heading, ...linked.map((person) => person.name)])) return null;
  const keyed = linked.map((person) => sameByKey(person.profile, them));
  if (linked.length > 0 && keyed.every((same) => same === true)) return 'key';
  if (!fresh || keyed.includes(false)) return null;
  const messages = conversationsIn(chatWindow)[0] ?? null;
  const shownAs =
    linked.length > 0
      ? linked.map((person) => person.name)
      : [heading ?? (messages ? conversationWith(messages) : null)];
  if (!shownAs.every((name) => name !== null && namedAs(name, names))) return null;
  const composer = composerOf(chatWindow, close, box, messages);
  const elsewhere = linkedIn(
    [...chatWindow.querySelectorAll('a[href]')].filter(
      (link) => !messages?.contains(link) && !composer.contains(link),
    ),
  );
  return elsewhere.some((person) => sameByKey(person.profile, them) === false) ? null : 'name';
}

/**
 * A chat window's part to write in: the widest box around its box to write in that holds neither its Close chat nor
 * its messages. What's typed is there, and the preview Facebook draws of a link typed (a business's own Page, say).
 */
function composerOf(
  chatWindow: Element,
  close: Element,
  box: Element,
  messages: Element | null,
): Element {
  let composer = box;
  for (
    let up = box.parentElement;
    up && up !== chatWindow && !up.contains(close) && !(messages && up.contains(messages));
    up = up.parentElement
  )
    composer = up;
  return composer;
}

/**
 * The chats open on a page as the extension pressed their profile's Message (`openMessage`): the boxes to write in
 * then, and every name their windows showed. Facebook keeps the windows of earlier chats open from page to page, and
 * any of them may be someone else's with their name.
 */
export interface ChatsBefore {
  readonly doc: Document;
  readonly boxes: ReadonlySet<Element>;
  readonly names: readonly string[];
  /**
   * Where the cursor went first after Message was pressed, in a box to write in that wasn't open before: the chat
   * Message opened, as Facebook puts the cursor in it. A window that pops up for a message coming in doesn't take it.
   * Null till it goes there.
   */
  readonly cursor: () => Element | null;
  /** The box the message's last text went into, for its next one. */
  sentIn: HTMLElement | null;
}

/** The names a chat window shows: on its links, its headings, its messages' label and its box's label. */
function namesIn(scope: Element): string[] {
  const names = linkedIn(scope.querySelectorAll('a[href]')).flatMap((person) => person.name ?? []);
  for (const link of scope.querySelectorAll('a, [role="link"]'))
    names.push(clean(link.getAttribute('aria-label')));
  for (const heading of scope.querySelectorAll('h1, h2, h3, [role="heading"]'))
    names.push(clean(heading.textContent));
  for (const messages of conversationsIn(scope)) names.push(conversationWith(messages) ?? '');
  for (const box of scope.querySelectorAll(WRITING))
    names.push(WRITES_TO.exec(boxLabel(box))?.[1] ?? '');
  return names.filter((name) => isNameLike(name) && !UI_WORDS.has(name.toLowerCase()));
}

/** The widest box around a chat window's Close chat that holds nothing of another window's, nor the main column. */
function windowAround(close: Element, main: Element): Element {
  let chatWindow = close;
  for (
    let up = close.parentElement;
    up &&
    !up.contains(main) &&
    closesIn(up).length === 1 &&
    up.querySelectorAll(WRITING).length <= 1 &&
    conversationsIn(up).length <= 1;
    up = up.parentElement
  )
    chatWindow = up;
  return chatWindow;
}

/** The chats open over the page now: noted as their profile's Message is pressed. */
export function chatsOpen(doc: Document): ChatsBefore {
  const main = mainOf(doc);
  const names = new Set<string>();
  for (const close of closesIn(doc.body))
    if (!main.contains(close))
      for (const name of namesIn(windowAround(close, main))) names.add(name);
  return {
    doc,
    boxes: new Set(doc.querySelectorAll(WRITING)),
    names: [...names],
    cursor: () => null,
    sentIn: null,
  };
}

/**
 * Watches, from just before Message is pressed, for where the cursor goes first in a place to write that's in none
 * of the boxes open before: there, once it goes. Chrome may not say the cursor moved while the window isn't in front,
 * so where it is is looked at too, each time it's asked, till it's gone somewhere.
 */
function cursorAfter(doc: Document, open: ReadonlySet<Element>): () => Element | null {
  let first: Element | null = null;
  function take(at: Element | null): void {
    if (first || typeof at?.closest !== 'function' || !at.closest(WRITING)) return;
    if ([...open].some((box) => box.contains(at))) return;
    first = at;
    doc.removeEventListener('focusin', went, true);
  }
  function went(event: Event): void {
    take(event.target as Element | null);
  }
  doc.addEventListener('focusin', went, true);
  return () => {
    take(doc.activeElement);
    return first;
  };
}

/** How often their profile's Message is looked for again while Facebook draws it. */
const LOOK_AGAIN_MS = 300;

/**
 * Presses Message on their profile, noting the chats open just then, in the same moment (one drawn while Message was
 * looked for was open before it), and watching where the cursor goes after: whether it could, and those chats, for
 * `writeMessage`. A window open before it is theirs only by a link to them by key, never by a name.
 */
export async function openMessage(
  doc: Document,
): Promise<{ readonly pressed: boolean; readonly before: ChatsBefore }> {
  const until = Date.now() + MESSAGE_WAIT_MS;
  for (;;) {
    const message = findStep(doc, MESSAGE_PATH[0]!) as HTMLElement | null;
    if (message) {
      const before = chatsOpen(doc);
      const cursor = cursorAfter(doc, before.boxes);
      message.click();
      return { pressed: true, before: { ...before, cursor } };
    }
    if (Date.now() >= until) return { pressed: false, before: chatsOpen(doc) };
    await pause(LOOK_AGAIN_MS);
  }
}

/**
 * The box to write a message to them in, and only theirs. On a chat's own page in Messenger, the chat's box in the
 * main column, when the chat shows it's with them. On any other page, the box of the one small chat window over it
 * that links to them by key, else the one that shows it's theirs by name: Facebook keeps the windows of earlier chats
 * open from page to page, and a new one may draw its box after them, or before. A chat counts by name only with the
 * chats open before their profile's Message was pressed (`before`, on this page), only when it opened on it, and only
 * when none open before showed their name; a window, only when it's where the cursor went first after the press, as
 * one popping up for a message coming in isn't. Null when there's none, or more than one: never another box.
 */
export function messageBoxFor(
  doc: Document,
  href: string,
  them: ProfileRef,
  names: readonly string[],
  before: ChatsBefore | null = null,
): HTMLElement | null {
  // Without the main column, there's no telling a chat's own page from a window over another.
  const main = doc.querySelector('[role="main"]');
  if (!main) return null;
  const pressed = before?.doc === doc ? before : null;
  const byName =
    pressed !== null && !pressed.names.some((name) => names.some((one) => mayBeSame(name, one)));
  const fresh = (box: Element) => byName && !pressed!.boxes.has(box);
  const address = classifyUrl(href);
  if (address.kind === 'chat') {
    const chat = readChat(doc, address, href);
    const own = messageBoxes(doc).filter((box) => main.contains(box));
    if (own.length !== 1 || !boxAgrees(own[0]!, [...names, chat.name])) return null;
    return chatIsThem(chat.profile, chat.name, them, names, fresh(own[0]!)) ? own[0]! : null;
  }
  const opened = (box: Element) => {
    const cursor = pressed?.cursor() ?? null;
    return cursor !== null && box.contains(cursor);
  };
  const proofs = messageBoxes(doc)
    .filter((box) => !main.contains(box))
    .map((box) => ({
      box,
      proof: windowProof(box, main, them, names, fresh(box) && opened(box)),
    }));
  // A link to them by key outweighs a name.
  const keyed = proofs.filter(({ proof }) => proof === 'key');
  if (keyed.length > 0) return keyed.length === 1 ? keyed[0]!.box : null;
  const named = proofs.filter(({ proof }) => proof === 'name');
  return named.length === 1 ? named[0]!.box : null;
}

/** How a message went: with, when its typing went into another chat's box and stayed there, whose that is. */
export interface MessageWrote {
  readonly result: AutoResult;
  /**
   * Typing that couldn't be taken out of a box it went in: the name on that box ("Write to Riley Quinn" is Riley
   * Quinn's), or null when it names nobody. The person's to take out.
   */
  readonly left?: { readonly with: string | null };
}

/**
 * Writes a message in their chat, and sends it (decisions 26 and 27): waits a few seconds for their chat's box, types
 * it there, presses the button that sends it (or Enter), and waits for the box to empty. It waits the whole time for a
 * chat that links to them by key, and takes one by name only after, unless the message's text before went into that
 * same box. A box with writing in it already is left alone: the person may be writing there. Nothing is typed unless
 * the focus is in their box, and nothing is sent unless, once typed, it's still their chat's box and no other box took
 * the writing; else what was typed is taken out again, of every box it went in (`not_theirs`), and where it can't be,
 * that's said (`left`).
 */
export async function writeMessage(
  doc: Document,
  href: string,
  text: string,
  them: ProfileRef,
  names: readonly string[],
  before: ChatsBefore | null = null,
): Promise<MessageWrote> {
  // Message on their profile may move the tab to Messenger meanwhile.
  const here = () => doc.location?.href ?? href;
  const byKey = () => messageBoxFor(doc, here(), them, names);
  const theirs = () => messageBoxFor(doc, here(), them, names, before);
  const last = before?.doc === doc ? before.sentIn : null;
  let box = byKey() ?? (last && theirs() === last ? last : null);
  for (let wait = 0; !box && wait < 10; wait++) {
    await pause(500);
    box = byKey();
  }
  box ??= theirs();
  if (!box) return { result: 'none' };
  const wrote = await typeAndSend(doc, box, text, theirs);
  if (wrote.result === 'done' && before?.doc === doc) before.sentIn = box;
  return wrote;
}

/** Whether the focus is in a box: on it, or on something inside it. */
const focusIn = (doc: Document, box: Element) =>
  doc.activeElement !== null && box.contains(doc.activeElement);

/** Takes what was typed out of a box that was empty before, only with the focus in it: whether it's empty again. */
function takeOut(doc: Document, box: HTMLElement): boolean {
  box.focus();
  if (focusIn(doc, box)) {
    doc.getSelection()?.selectAllChildren(box);
    doc.execCommand('delete', false);
  }
  return !hasWriting(box);
}

/** Writing without its spaces and line breaks, as a box may keep a text's lines apart. */
const squash = (text: string) => clean(text).replace(/\s/g, '');

/** The part of a box's text from one place to another, as a range on the page. */
function rangeIn(box: Element, from: number, to: number): Range | null {
  const doc = box.ownerDocument;
  const range = doc.createRange();
  const walker = doc.createTreeWalker(box, 4 /* text */);
  let at = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (!started && from <= at + length) {
      range.setStart(node, from - at);
      started = true;
    }
    if (started && to <= at + length) {
      range.setEnd(node, to - at);
      return range;
    }
    at += length;
  }
  return null;
}

/**
 * Takes what was typed out of a box with the person's own writing in it, leaving theirs as it was: what was put in
 * between what's the same at its start and at its end, only with the focus in it. Whether it's as it was again.
 */
function takeOutTyped(doc: Document, box: HTMLElement, was: string): boolean {
  const now = box.textContent ?? '';
  let start = 0;
  while (start < was.length && start < now.length && now[start] === was[start]) start++;
  let same = 0;
  while (
    same < was.length - start &&
    same < now.length - start &&
    now[now.length - 1 - same] === was[was.length - 1 - same]
  )
    same++;
  // Anything of theirs changed, not only put beside: not the extension's to undo.
  if (start + same !== was.length || now.length <= was.length) return now === was;
  const range = rangeIn(box, start, now.length - same);
  const selection = doc.getSelection();
  box.focus();
  if (!range || !selection || !focusIn(doc, box)) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  doc.execCommand('delete', false);
  return (box.textContent ?? '') === was;
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
): Promise<MessageWrote> {
  if (hasWriting(box)) return { result: 'not_sent' };
  // What each box says before typing, to see that no other one takes the writing, and to leave the person's as it was.
  const before = new Map(
    [...doc.querySelectorAll(WRITING)].map((b) => [
      b,
      { said: textWithEmoji(b), text: b.textContent ?? '' },
    ]),
  );
  box.focus();
  box.click();
  await pause(300);
  if (theirs && !focusIn(doc, box)) return { result: 'not_theirs' };
  doc.execCommand('insertText', false, text);
  await pause(800);
  if (theirs) {
    // A box drawn while it typed (another chat's window opening, with what the person wrote there before) took the
    // writing only when what was typed is in it.
    const typed = squash(text);
    const tookIt = (other: Element) => {
      const was = before.get(other);
      return was ? textWithEmoji(other) !== was.said : squash(textWithEmoji(other)).includes(typed);
    };
    const elsewhere = [...doc.querySelectorAll<HTMLElement>(WRITING)].filter(
      (other) => other !== box && !other.contains(box) && !box.contains(other) && tookIt(other),
    );
    if (elsewhere.length > 0 || (hasWriting(box) && theirs() !== box)) {
      // Taken out of every box it went in; one with the person's own writing keeps theirs. One it can't be is said,
      // as is one drawn while it typed that holds more than what was typed: never wiped.
      let left: { readonly with: string | null } | undefined;
      for (const other of [...elsewhere, ...(hasWriting(box) ? [box] : [])]) {
        const was = before.get(other);
        const out = !was
          ? squash(textWithEmoji(other)) === typed && takeOut(doc, other)
          : was.said
            ? takeOutTyped(doc, other, was.text)
            : takeOut(doc, other);
        if (!out) left ??= { with: WRITES_TO.exec(boxLabel(other))?.[1] ?? null };
      }
      return { result: 'not_theirs', ...(left ? { left } : {}) };
    }
  }
  if (!hasWriting(box)) return { result: 'not_sent' };
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
    if (!hasWriting(box)) return { result: 'done' };
  }
  return { result: 'not_sent' };
}
