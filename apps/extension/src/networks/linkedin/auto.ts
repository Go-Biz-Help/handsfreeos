/**
 * The presses LinkedIn's runner makes on its own (src/auto/linkedin.ts; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
 * "LinkedIn, part by part", 5), once the person lets it, each only on the page it's for, in the tab (./work.ts):
 *
 * - **Like** the post of theirs the runner picked, on their activity, or (decision 92) the post of theirs a search
 *   found, on that post's own page: only a post they wrote, only its own Like (never a comment's), and only when none
 *   of the person's reactions is on it already. In LinkedIn's newer layout (the owner's outlines of 16 Oct 2026)
 *   that's the post bar's reaction button, found by where it is (./posts.ts, `barOf`), and it's liked once the button
 *   shows a reaction given (`reactionChange`).
 * - **Connect** on their profile, without a note (Chris: LinkedIn invitations go with no note): Connect in the top
 *   card, or under More when Follow comes first; then the box's **Send without a note**. It never types a note, and a
 *   box that asks for anything (their email, a note it insists on) is left for the person.
 * - **Accept** or **Ignore** their invitation (decision 136, from 0.118.0), in their profile's top card, once the
 *   person pressed Confirm or Delete in HandsFreeOS or the AI said to as they chose.
 * - **A comment** in the post's own box, never a reply's, sent with that box's own button: one saying Comment or Post
 *   (or, a best reading of LinkedIn's newer words, "Post comment", "Submit comment"); anything else is left for the
 *   person.
 * - **A message** in the conversation with them: on its page, or in the window their profile's **Message** opens,
 *   typing only into that conversation's box, and leaving one with writing in it alone.
 *
 * Like the readers, it goes by what a person sees (words, labels, links, page order), never LinkedIn's class names.
 */
import type { AutoResult, TheirPost } from '../facebook/auto';
import { isAfter, squashed, timesShown } from '../facebook/dom';
import { shown, visible } from '../facebook/fetch';
import { hasWriting, reacted } from './actions';
import { readChat } from './chat';
import { CONTROLS, inPageBar, mainOf, placesOf, wordsOf } from './dom';
import { peopleLinked } from './people';
import {
  barOf,
  otherReactions,
  postBoxes,
  postIn,
  reactionChange,
  reactionState,
  readPost,
} from './posts';
import { inTopCard, readProfile } from './profile';
import type { ProfileRef } from './types';
import {
  byMemberId,
  classifyUrl,
  comparable,
  linkedinUrl,
  memberIdFrom,
  sameMember,
  threadOf,
} from './urls';
import { ACCEPT, CONNECT, IGNORE, MESSAGE, MORE } from './vocabulary';

export type { AutoResult, TheirPost };

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** What LinkedIn draws over the page: the invitation's box. */
export const OVER_THE_PAGE = '[role="dialog"], [role="alertdialog"], dialog';
/** Where a person writes. */
export const WRITING = '[role="textbox"], [contenteditable="true"], textarea';
/** What's inside a post and isn't it: its comments and a link's preview. */
const NESTED = 'article, [role="article"]';
/** A post's own Like: "React Like" (or "Like"), not one of its comments'. */
const OWN_LIKE = /^(react like|like)$/i;
/** The box's button that sends an invitation as it is. */
const WITHOUT_NOTE = /^send without a note$/i;
/** Its other ways of sending: when it offers no note at all. */
const SEND_INVITE = /^(send|send now|send invitation)$/i;
/** What sends a comment, in the comment's own form. */
export const SENDS_COMMENT = /^(comment|post|post comment|submit comment)$/i;
/** What sends a message. */
export const SENDS_MESSAGE = /^(send|send message)$/i;
/** A reply's box, which a comment never goes in. */
const REPLY_BOX = /^(add a reply|reply to\b|write a reply)/i;
/** How long a box, a menu and a change are waited on, and how often they're looked at. */
const WAIT_MS = 8_000;
const LOOK_MS = 300;
/** How long a sent message has to show it went. */
const SENT_MS = 8_000;
/** How long a box to write to them in may take to show: a new conversation's is drawn in the interop frame, which
 * loads all of LinkedIn's messaging first (the owner's sends of 30 Oct 2026, on 0.114.0). */
const BOX_MS = 5_000;
const NEW_BOX_MS = 15_000;

export const says = (control: Element, pattern: RegExp) =>
  wordsOf(control).some((w) => pattern.test(w));

/** Looks for something until it shows or `ms` is up. */
export async function waitFor<T>(find: () => T | null, ms = WAIT_MS): Promise<T | null> {
  for (let waited = 0; waited <= ms; waited += LOOK_MS) {
    const found = find();
    if (found) return found;
    await pause(LOOK_MS);
  }
  return null;
}

/** Whether something in a post is in one of its comments (or a preview), not the post itself. */
export function inNested(element: Element, post: Element): boolean {
  const own = postIn(post);
  const nested = element.closest(NESTED);
  return nested !== null && nested !== own && nested !== post && post.contains(nested);
}

// ------------------------------------------------------------------------------------------------ likes

/**
 * The posts on the page that they wrote, as far as the page has drawn, the latest first. On a post's own page (decision
 * 92: the post a search found, liked there) the post it's about is at the page's own address when it has no link to
 * itself, as LinkedIn's newer layout draws few.
 */
export function theirPosts(
  doc: Document,
  href: string,
  profile: ProfileRef,
): { readonly box: Element; readonly post: TheirPost }[] {
  const page = classifyUrl(href);
  return postBoxes(mainOf(doc)).flatMap((box, i) => {
    const read = readPost(box, href);
    if (!read?.author?.profile || read.company || !sameMember(read.author.profile, profile))
      return [];
    return [
      {
        box,
        post: {
          url: read.url ?? (page.kind === 'post' && i === 0 ? page.post : null),
          when: read.when,
          text: read.text,
          pictures: [],
          liked: reacted(box),
        },
      },
    ];
  });
}

/** A post's own Like, shown: the older layout's says so; the newer's is its bar's reaction button. */
export function likeOf(box: Element): HTMLElement | null {
  const older = [...box.querySelectorAll<HTMLElement>(CONTROLS)].find(
    (control) => !inNested(control, box) && shown(control) && says(control, OWN_LIKE),
  );
  if (older) return older;
  const reaction = barOf(box)?.reaction as HTMLElement | null | undefined;
  return reaction && shown(reaction) ? reaction : null;
}

/** Likes the post of theirs picked (by its link, else its place among theirs), and waits for the like to show. */
export async function likeTheirPost(
  doc: Document,
  href: string,
  profile: ProfileRef,
  pick: { readonly index: number; readonly url: string | null },
): Promise<{ readonly result: AutoResult; readonly postUrl: string | null }> {
  const found = theirPosts(doc, href, profile);
  const one = pick.url ? found.find((f) => f.post.url === pick.url) : found[pick.index];
  if (!one) return { result: 'none', postUrl: pick.url };
  if (reacted(one.box)) return { result: 'already', postUrl: one.post.url };
  const like = likeOf(one.box);
  if (!like) return { result: 'none', postUrl: one.post.url };
  const before = reactionState(like);
  const others = otherReactions(mainOf(doc), one.box);
  like.click();
  // Liked: it says so, or (the newer layout) its button shows a reaction given since.
  const given = () => {
    if (reacted(one.box)) return true;
    const now = barOf(one.box)?.reaction;
    return !!now && reactionChange(before, reactionState(now), others) === 'added';
  };
  const went = await waitFor(() => (given() ? true : null), 5_000);
  return { result: went ? 'done' : 'not_sent', postUrl: one.post.url };
}

// ------------------------------------------------------------------------------------------------ connect

/** How connecting went. */
export type ConnectResult =
  /** The invitation went: the profile says Pending. */
  | 'done'
  /** It was pending already. */
  | 'already'
  /** No Connect to press, or a box that wants more than Send: nothing sent, for the person to do. */
  | 'none'
  /** Pressed, but the profile doesn't say Pending after. */
  | 'not_sent';

export const profileOn = (doc: Document, href: string) =>
  readProfile(mainOf(doc), classifyUrl(href), href, doc.title);

/** A shown control in the profile's top card that says this. */
export function topCardControl(doc: Document, pattern: RegExp): HTMLElement | null {
  const main = mainOf(doc);
  return (
    [...main.querySelectorAll<HTMLElement>(`${CONTROLS}, a[href]`)].find(
      (control) =>
        inTopCard(control, main) &&
        shown(control) &&
        !control.closest(OVER_THE_PAGE) &&
        says(control, pattern),
    ) ?? null
  );
}

/** The invitation box's way to send as it is, when it asks nothing else: no field to fill in. */
function sendAsItIs(doc: Document): HTMLElement | 'asks' | null {
  for (const box of doc.querySelectorAll(OVER_THE_PAGE)) {
    if (!shown(box)) continue;
    const controls = [...box.querySelectorAll<HTMLElement>(CONTROLS)].filter(shown);
    const without = controls.find((c) => says(c, WITHOUT_NOTE));
    if (without) return without;
    const send = controls.find((c) => says(c, SEND_INVITE));
    if (!send) continue;
    // A box with something to fill in (their email, a note it insists on) is the person's.
    const fields = [
      ...box.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]'),
    ];
    return fields.some(shown) ? 'asks' : send;
  }
  return null;
}

/** Sends them an invitation without a note, from their profile, and waits for it to say Pending. */
export async function connect(doc: Document, href: string): Promise<ConnectResult> {
  const before = profileOn(doc, href).connection;
  if (before === 'pending') return 'already';
  if (before !== 'not_connected' && before !== 'unknown') return 'none';
  let press = topCardControl(doc, CONNECT);
  if (!press) {
    // Follow first: Connect is in the More menu.
    const more = topCardControl(doc, MORE);
    if (!more) return 'none';
    more.click();
    press = await waitFor(() => topCardControl(doc, CONNECT), 3_000);
  }
  if (!press) return 'none';
  press.click();
  const pending = () => profileOn(doc, href).connection === 'pending';
  const next = await waitFor<HTMLElement | 'asks' | 'sent'>(
    () => sendAsItIs(doc) ?? (pending() ? 'sent' : null),
  );
  if (next === 'sent') return 'done';
  if (next === null || next === 'asks') return next === 'asks' ? 'none' : 'not_sent';
  next.click();
  return (await waitFor(() => (pending() ? true : null))) ? 'done' : 'not_sent';
}

/** The box LinkedIn may open to be sure of an Ignore: its own Ignore. */
const SURE_IGNORE = /^(ignore|ignore invitation)$/i;

/**
 * Answers their invitation from their profile (decision 136): Accept, or Ignore, in its top card (Ignore under More
 * when it isn't beside Accept), then the box's own Ignore where LinkedIn asks to be sure. It went once their profile
 * no longer has Accept. `already` when there's nothing to answer: connected for Accept, or no invitation of theirs
 * waiting for Ignore; `none` when there's no such button, which is the person's.
 */
export async function answerInvitation(
  doc: Document,
  href: string,
  answer: 'confirm' | 'delete',
): Promise<ConnectResult> {
  const before = profileOn(doc, href).connection;
  if (before !== 'received')
    return (answer === 'confirm' ? before === 'connected' : before === 'not_connected')
      ? 'already'
      : 'none';
  const pattern = answer === 'confirm' ? ACCEPT : IGNORE;
  let press = topCardControl(doc, pattern);
  if (!press && answer === 'delete') {
    const more = topCardControl(doc, MORE);
    if (!more) return 'none';
    more.click();
    press = await waitFor(() => topCardControl(doc, pattern), 3_000);
  }
  if (!press) return 'none';
  press.click();
  const answered = () => profileOn(doc, href).connection !== 'received';
  const next = await waitFor<HTMLElement | 'answered'>(() => {
    if (answered()) return 'answered';
    if (answer !== 'delete') return null;
    for (const box of doc.querySelectorAll(OVER_THE_PAGE)) {
      if (!shown(box)) continue;
      const sure = [...box.querySelectorAll<HTMLElement>(CONTROLS)].find(
        (c) => shown(c) && says(c, SURE_IGNORE),
      );
      if (sure) return sure;
    }
    return null;
  });
  if (next === 'answered') return 'done';
  if (!next) return 'not_sent';
  next.click();
  return (await waitFor(() => (answered() ? true : null))) ? 'done' : 'not_sent';
}

// ------------------------------------------------------------------------------------------------ writing

/**
 * The button that sends what's in a box: after the box, saying `pattern`, among its own buttons: in the form around
 * it, or (LinkedIn's newer layout has none) the boxes around it that link nowhere. A box that links somewhere holds
 * more than the box's own buttons: a comment and its writer, the next post. With `offToo`, one LinkedIn keeps off till
 * something's written counts too (a conversation's Send: the owner's Check LinkedIn of 17 Oct 2026, on 0.53.0).
 */
export function sendFor(box: Element, pattern: RegExp, offToo = false): HTMLElement | null {
  let up = box.parentElement;
  for (let steps = 0; up && steps < 12; steps++, up = up.parentElement) {
    if ([...up.querySelectorAll('a[href]')].some((link) => !box.contains(link))) return null;
    const sends = [...up.querySelectorAll<HTMLElement>(`${CONTROLS}, [type="submit"]`)].filter(
      (control) =>
        isAfter(control, box) && (offToo ? visible : shown)(control) && says(control, pattern),
    );
    if (sends.length) return sends[0]!;
    if (up.matches('form')) return null;
  }
  return null;
}

/** Whether the focus is in a box, on its own page or in the interop box it's drawn in. */
function focusIn(box: Element): boolean {
  const focused = (box.getRootNode() as Document | ShadowRoot).activeElement;
  return !!focused && box.contains(focused);
}

/** Takes what was typed out of a box that was empty before, only with the focus in it. */
function takeOut(box: HTMLElement): void {
  box.focus();
  if (!focusIn(box)) return;
  if (box.tagName === 'TEXTAREA') (box as HTMLTextAreaElement).select();
  else box.ownerDocument.getSelection()?.selectAllChildren(box);
  box.ownerDocument.execCommand('delete', false);
}

/**
 * Types into a box to write in, and sends it with its button; it's sent once the box empties. It types with the box's
 * own page, which for a box in LinkedIn's interop frame is the frame's. For a message, `theirs` finds their
 * conversation's box again, for the checks before typing and before sending.
 */
async function typeAndSend(
  box: HTMLElement,
  text: string,
  pattern: RegExp,
  theirs?: () => HTMLElement | null,
): Promise<AutoResult> {
  // Something written there already is the person's: left alone.
  if (hasWriting(box)) return 'not_sent';
  box.focus();
  box.click();
  await pause(300);
  if (theirs && !focusIn(box)) return 'not_theirs';
  box.ownerDocument.execCommand('insertText', false, text);
  await pause(800);
  if (theirs && hasWriting(box) && theirs() !== box) {
    takeOut(box);
    return 'not_theirs';
  }
  if (!hasWriting(box)) return 'not_sent';
  const send = sendFor(box, pattern);
  if (!send) return 'none';
  // It went once the box empties, or what was typed shows once more where the box is: LinkedIn sometimes draws the
  // box afresh, or leaves the writing in it a while (the owner's sends of 30 Oct 2026, on 0.114.0, said "didn't take"
  // of a message that was in the conversation).
  const place = box.getRootNode();
  const before = timesShown(place, text, WRITING);
  send.click();
  const went = await waitFor(
    () => (!hasWriting(box) || timesShown(place, text, WRITING) > before ? true : null),
    SENT_MS,
  );
  if (!went) return 'not_sent';
  // What was typed left in the box after it went is taken out, so the next message finds it empty.
  if (
    box.isConnected &&
    hasWriting(box) &&
    !(await waitFor(() => (hasWriting(box) ? null : true), 2_000)) &&
    squashed(box.tagName === 'TEXTAREA' ? (box as HTMLTextAreaElement).value : box.textContent) ===
      squashed(text)
  )
    takeOut(box);
  return 'done';
}

/** The post the page is about: its own page's, the first. */
export const postOnPage = (doc: Document) => postBoxes(mainOf(doc))[0] ?? null;

/** The post's own box to comment in: in the post, not in a comment, and not a reply's. */
export function commentBoxOf(post: Element): HTMLElement | null {
  return (
    [...post.querySelectorAll<HTMLElement>(WRITING)].find(
      (box) =>
        !inNested(box, post) &&
        shown(box) &&
        !REPLY_BOX.test(
          box.getAttribute('aria-placeholder') ?? box.getAttribute('aria-label') ?? '',
        ),
    ) ?? null
  );
}

/** What opens a post's own box to comment in: the Comment in its bar, not a form's. */
export function commentOpener(post: Element): HTMLElement | null {
  return (
    [...post.querySelectorAll<HTMLElement>(CONTROLS)].find(
      (control) =>
        !inNested(control, post) &&
        !control.closest('form') &&
        shown(control) &&
        says(control, /^comment$/i),
    ) ?? null
  );
}

/** Writes a comment in the post's own box and sends it with that box's button. */
export async function writeComment(doc: Document, text: string): Promise<AutoResult> {
  const post = postOnPage(doc);
  if (!post) return 'none';
  let box = commentBoxOf(post);
  if (!box) {
    commentOpener(post)?.click();
    box = await waitFor(() => commentBoxOf(post), 3_000);
  }
  if (!box) return 'none';
  return typeAndSend(box, text, SENDS_COMMENT);
}

/** The boxes to write a message in: in a form with Send, on or not yet. */
const messageBoxes = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>(WRITING)].filter(
    (box) => shown(box) && sendFor(box, SENDS_MESSAGE, true) !== null,
  );

/** The pages a conversation may be drawn on: the page, and LinkedIn's interop frame's own (./dom.ts). */
const pagesOf = (doc: Document) =>
  placesOf(doc).filter((place): place is Document => place.nodeType === 9);

/** A conversation window's own Close, in its header: "Close your conversation with Dana Reyes". */
const CLOSE_CONVERSATION = /^close your\b.*\bconversation\b/i;
/** Where a conversation's messages are, whose links may lead to anyone: its log, its list's items, an article. */
const IN_MESSAGES = '[role="log"], li, [role="listitem"], article, [role="article"]';

/** The links in a part of the page outside its conversation's messages. */
function linksOutsideMessages(part: Element): Element[] {
  return [...part.querySelectorAll('a[href]')].filter((link) => {
    const messages = link.closest(IN_MESSAGES);
    return !messages || messages === part || !part.contains(messages);
  });
}

/**
 * Who the window over the page a box is in is with, as its header links to them: the people linked outside its
 * messages in the nearest box around it with the window's own Close (its header may be a `header`: only the page's own
 * top bar is left out). Nobody when there's no such box: a window whose Close it can't tell has nobody it's surely
 * with, as the links further up may be another window's. Never the main column or past it, nor a box with a second
 * box to write in or a second Close, as shown: past those, the links are the page's or another window's.
 */
function windowLinks(box: Element, doc: Document, href: string): ProfileRef[] {
  const main = mainOf(doc);
  let up = box.parentElement;
  for (let steps = 0; up && steps < 20 && !up.contains(main); steps++, up = up.parentElement) {
    const closes = [...up.querySelectorAll(CONTROLS)].filter(
      (c) => shown(c) && says(c, CLOSE_CONVERSATION),
    );
    if (closes.length > 1 || [...up.querySelectorAll(WRITING)].filter(shown).length > 1) break;
    if (closes.length === 1)
      return peopleLinked(linksOutsideMessages(up), href, inPageBar).map((p) => p.profile);
  }
  return [];
}

/**
 * Who a new conversation's box is to, as the part around it links to them: the people linked outside its messages in
 * the nearest part around the box that links to anyone, short of the list of conversations or a second box to write
 * in. In LinkedIn's newer messaging, the card over the box with their picture and name (the owner's sends of 30 Oct
 * 2026, on 0.114.0).
 */
function composeLinks(box: Element, href: string): ProfileRef[] {
  let up = box.parentElement;
  for (let steps = 0; up && steps < 12; steps++, up = up.parentElement) {
    if ([...up.querySelectorAll(WRITING)].filter(shown).length > 1) break;
    if (
      [...up.querySelectorAll('a[href]')].some((a) => threadOf(a.getAttribute('href') ?? '', href))
    )
      break;
    const linked = peopleLinked(linksOutsideMessages(up), href, inPageBar).map((p) => p.profile);
    if (linked.length) return linked;
  }
  return [];
}

/** A new conversation's own page: what Message on their profile opens (/messaging/thread/new/?recipient=…). */
const NEW_CONVERSATION = /^\/messaging\/(thread\/new|compose)(\/|$)/i;

/**
 * The box to write to them in: the conversation's own on its page (when it's with them, as far as it says), or the
 * one window over the page that links to them, wherever LinkedIn draws it (its interop box among them: ./dom.ts).
 * Null when there's none, or more than one.
 */
export function messageBoxFor(doc: Document, href: string, them: ProfileRef): HTMLElement | null {
  const address = classifyUrl(href);
  const main = mainOf(doc);
  const url = linkedinUrl(href);
  // The new conversation Message on their profile opens names whom it's to (/messaging/thread/new/?recipient=…).
  const fresh = address.kind === 'messaging' && !!url && NEW_CONVERSATION.test(url.pathname);
  const toId = fresh ? memberIdFrom(url!) : null;
  const to = toId ? { id: toId, username: null, url: href } : null;
  if (address.kind === 'chat' || fresh) {
    // Their conversation's own page: the runner opened it by its id and checked it's theirs, or Message on their
    // profile opened it for them. Only something plainly saying it's someone else's is a reason to stop: an id of the
    // same kind as theirs that isn't theirs (LinkedIn writes one member's id two ways: ./urls.ts), or a card over the
    // box linking to someone else. A new conversation whose address names nobody it can read is theirs only by that
    // card. LinkedIn's newer pages draw it in the interop frame's own page.
    if (to && byMemberId(to, them) && to.id !== them.id) return null;
    const boxes = pagesOf(doc).flatMap((page) => {
      if (address.kind === 'chat') {
        const chat = readChat(page, address, href);
        if (chat.profile && comparable(chat.profile, them) && !sameMember(chat.profile, them))
          return [];
      }
      return messageBoxes(page === doc ? main : page).filter((box) => {
        if (!fresh) return true;
        const linked = composeLinks(box, href);
        if (linked.some((p) => comparable(p, them) && !sameMember(p, them))) return false;
        return to !== null || linked.some((p) => sameMember(p, them));
      });
    });
    return boxes.length === 1 ? boxes[0]! : null;
  }
  // On their profile, the member id its own Message carries (./profile.ts): a window that links to them by it, as
  // LinkedIn's in its interop box does (the owner's Check LinkedIn of 17 Oct 2026, on 0.54.0), is known as theirs.
  const page = address.kind === 'profile' ? profileOn(doc, href).profile : null;
  const known = page?.id && !them.id && sameMember(page, them) ? { ...them, id: page.id } : them;
  // Everyone the window links to outside its messages is them: one left open from someone else never counts.
  const isTheirs = (box: HTMLElement) => {
    const linked = windowLinks(box, doc, href);
    return linked.length > 0 && linked.every((p) => sameMember(p, known));
  };
  const theirs = placesOf(doc)
    .flatMap(messageBoxes)
    .filter((box) => !main.contains(box) && isTheirs(box));
  return theirs.length === 1 ? theirs[0]! : null;
}

/** On their profile, the top card's Message: whether there was one to press. */
export function openMessage(doc: Document): boolean {
  const message = topCardControl(doc, MESSAGE);
  if (!message) return false;
  message.click();
  return true;
}

/**
 * Writes a message to them in their conversation and sends it, waiting a little for the box to show. Nothing is typed
 * unless the focus is in their box, and nothing is sent unless, once typed, it's still their conversation's box; else
 * what was typed is taken out again (`not_theirs`).
 */
export async function writeMessage(
  doc: Document,
  href: string,
  text: string,
  them: ProfileRef,
): Promise<AutoResult> {
  const theirs = () => messageBoxFor(doc, href, them);
  const box = await waitFor(theirs, classifyUrl(href).kind === 'messaging' ? NEW_BOX_MS : BOX_MS);
  if (!box) return 'none';
  return typeAndSend(box, text, SENDS_MESSAGE, theirs);
}
