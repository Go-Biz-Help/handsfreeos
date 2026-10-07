/**
 * The steps a person takes on Facebook themselves, noticed as they take them (docs/outreach.md, decisions 7 and 8): a
 * friend request, a like, a comment and a message; and their answer to a friend request they got, Confirm or Delete
 * (decisions 10 to 13). The content script hears the click or the Enter that takes one, and these work out from the
 * page around it what it was, who it was to, and the group they were found in. They read the page and never change
 * it, and they never keep what a comment or a message says: only that one was sent.
 *
 * Like the readers, they go by labels, links and page order, never class names, and in English for now:
 *
 * - **Friend request:** an "Add friend" button ("Add friend Jane Doe" in a list). On a profile, the one at its top,
 *   before its tabs, is theirs; anywhere else it's the one person the card around the button links to.
 * - **Like:** a post's or a comment's "Like" button, before it's pressed ("Remove Like" takes it back), to whoever
 *   wrote the post or the comment. Facebook's other reactions open in a box away from the post, so they aren't noted.
 * - **Comment:** Enter in a box to comment in with something written in it, or the button beside it that sends it. It's
 *   to whoever wrote the post, or for a reply, the comment it answers.
 * - **Message:** the same in an open chat, to who it's with; or in a chat open in a small window over another page, to
 *   who the window's header links to.
 * - **Confirm or Delete** on a friend request: the two buttons side by side on its card (the requests page, /friends,
 *   a notification), to the one person the card links to; the same on their profile, at its top or under its intro,
 *   or on the profile open beside the requests; or in the menu their profile's Respond opens.
 *
 * A step to yourself (your own post) isn't one, and neither is a step the page can't tie to exactly one person.
 */
import { isConversation, readChat, readChatIn } from './chat';
import {
  clean,
  inTopBar,
  isAfter,
  isBefore,
  labelOf,
  namesOn,
  tabsIn,
  textLines,
  textWithEmoji,
} from './dom';
import { CONFIRM, DELETE, mutualFriendsIn, requestRows, shown } from './friends';
import { aboutWhom, bestName, isNameLike, peopleLinked, sameName } from './people';
import { commentAround, commentsIn, postAround, postBefore, readPost } from './posts';
import { nameFromTitle } from './profile';
import type { ChatPage, GroupRef, Named, PageAddress, ProfileRef, ThreadRef } from './types';
import {
  classifyUrl,
  facebookUrl,
  groupFromUrl,
  pathParts,
  profileFromUrl,
  profileKey,
  threadFromUrl,
} from './urls';

export type StepKind = 'friend_request' | 'like' | 'comment' | 'message';

/** A group someone was found in: its link, and its name when the page showed it. */
export interface StepGroup extends GroupRef {
  readonly name: string | null;
}

/** Who a step was to: their name as the page showed it, and their profile. */
export interface Reached {
  readonly name: string;
  readonly profile: ProfileRef;
}

/** One step the person took. Plain data: it crosses from the tab to the background as JSON. */
export interface Step {
  readonly kind: StepKind;
  readonly to: Reached;
  /** The group they were found in: the one the page is in, or the post. */
  readonly group: StepGroup | null;
  /** The post liked or commented on. */
  readonly postUrl: string | null;
  /** The chat a message went in. */
  readonly thread: ThreadRef | null;
  /** For a message: whether it answers theirs (the chat's last message was from them), when the page said. */
  readonly replying: boolean | null;
}

/**
 * Someone opened from a group: from its pages, or from a post in it. The background remembers the group, for a step
 * taken later on their own profile, whose address doesn't say it.
 */
export interface Seen {
  readonly profile: ProfileRef;
  readonly name: string | null;
  readonly group: StepGroup;
}

/** "Add friend", or "Add friend Jane Doe" where a list has many. */
const ADD_FRIEND = /^add friend(?:\s+(.+))?$/i;
/** The Like button before it's pressed: "Remove Like" takes it back, and "Like: 2 people" lists who reacted. */
const LIKE = /^like$/i;
/** The box to comment in, and the box to reply to a comment in. */
const COMMENT_BOX =
  /^(comment as\b|write a (public )?comment|reply (to|as)\b|write a (public )?reply|answer as\b|write an answer)/i;
const REPLY_BOX = /^(reply (to|as)\b|write a (public )?reply)/i;
/** "Reply to Jane Doe": who a reply answers. */
const REPLY_TO = /^reply to\s+(.+?)(?:…|\.\.\.)?$/i;
/** The box to write in, in a chat open over another page. */
const MESSAGE_BOX = /^(message\b|aa$|write (a message|to)\b|type a message)/i;
/** The buttons that send what's written: a chat's, a comment's. Facebook shows them once something is. */
const SEND = /^(press enter to send|send|comment|post comment|post reply|submit)$/i;
/** Your own name, in the box you write a comment in: "Comment as Jane Doe". */
const WRITING_AS = /^(?:comment|reply|answer) as\s+(.+?)(?:…|\.\.\.)?$/i;
const YOUR_PROFILE = /^your profile$/i;

/** How far up from a button the card it's on can be: Facebook wraps each thing in many boxes. */
const CARD_STEPS = 16;
/** How far up from a send button the box it sends can be. */
const SEND_STEPS = 12;
/** How far up from the box to write in a window without a chat's label its link to who it's with can be. */
const WINDOW_STEPS = 20;

/** The boxes to write in. */
const WRITING = '[role="textbox"], [contenteditable="true"]';

const mainOf = (doc: Document): Element => doc.querySelector('[role="main"]') ?? doc.body;

/** The part of the page something is in: a box over the page (a post opened from the feed), the main column, or the rest. */
function rootOf(element: Element, doc: Document): Element {
  const dialog = element.closest('[role="dialog"]');
  if (dialog) return dialog;
  const main = mainOf(doc);
  return main.contains(element) ? main : doc.body;
}

const urlOf = (anchor: Element, base: string) =>
  facebookUrl(anchor.getAttribute('href') ?? '', base);

const reachedOf = (named: Named | null | undefined): Reached | null =>
  named?.profile && named.name ? { name: named.name, profile: named.profile } : null;

/** Whether someone is you: the profile the top bar's "Your profile" links to, or the name you comment as. */
function isYou(
  person: { readonly profile: ProfileRef; readonly name: string | null },
  doc: Document,
  base: string,
): boolean {
  const key = profileKey(person.profile);
  for (const anchor of doc.querySelectorAll('[role="banner"] a[href]')) {
    if (!YOUR_PROFILE.test(labelOf(anchor))) continue;
    const url = urlOf(anchor, base);
    const profile = url ? profileFromUrl(url) : null;
    if (profile && profileKey(profile) === key) return true;
  }
  for (const box of doc.querySelectorAll('[role="textbox"][aria-label]')) {
    const yours = WRITING_AS.exec(clean(box.getAttribute('aria-label')))?.[1];
    if (yours && person.name && sameName(yours, person.name)) return true;
  }
  return false;
}

/** Whether a box to write in has something in it: words, or only an emoji. */
const hasWriting = (box: Element) => textWithEmoji(box) !== '';

// ------------------------------------------------------------------------------------------------- groups

/** A group's name as the page shows it: the heading on its own pages, else the words on a link to it. */
function groupName(
  group: GroupRef,
  doc: Document,
  address: PageAddress,
  base: string,
): string | null {
  const key = group.id.toLowerCase();
  const onItsPage =
    (address.kind === 'group' || address.kind === 'group-members') &&
    address.group?.id.toLowerCase() === key;
  if (onItsPage) {
    const heading = clean(mainOf(doc).querySelector('h1')?.textContent);
    const name = (isNameLike(heading) ? heading : null) ?? nameFromTitle(doc.title);
    if (name) return name;
  }
  const anchors = [...doc.querySelectorAll('a[href]')].filter((anchor) => {
    const url = urlOf(anchor, base);
    return (
      url !== null &&
      pathParts(url).length === 2 &&
      groupFromUrl(url)?.id.toLowerCase() === key &&
      !inTopBar(anchor)
    );
  });
  return bestName(namesOn(anchors));
}

/** The group a post is in, from its links outside its comments: the group's own, its author's, its address. */
function groupInPost(box: Element, base: string): GroupRef | null {
  for (const anchor of box.querySelectorAll('a[href]')) {
    if (commentAround(anchor, box)) continue;
    const url = urlOf(anchor, base);
    const group = url ? groupFromUrl(url) : null;
    if (group) return group;
  }
  return null;
}

/** The group someone was found in: the one the page is in, else the one the post is in. */
function groupOf(
  post: Element | null,
  doc: Document,
  address: PageAddress,
  base: string,
): StepGroup | null {
  const group = address.group ?? (post ? groupInPost(post, base) : null);
  return group ? { ...group, name: groupName(group, doc, address, base) } : null;
}

// ------------------------------------------------------------------------------------------ friend requests

/** The person whose profile the page is, by the name it heads with (or its title), else the links to them. */
function pagePerson(doc: Document, address: PageAddress, base: string): Reached | null {
  if (address.kind !== 'profile' || !address.profile) return null;
  const main = mainOf(doc);
  const key = profileKey(address.profile);
  const linked = peopleLinked(main.querySelectorAll('a[href]'), base).find(
    (person) => profileKey(person.profile) === key,
  )?.name;
  // A member's page in a group has the group's name at its top, and in its title.
  const heading = address.group ? '' : clean(main.querySelector('h1')?.textContent);
  const name =
    (isNameLike(heading) ? heading : null) ??
    (address.group ? null : nameFromTitle(doc.title)) ??
    linked;
  return name ? { name, profile: address.profile } : null;
}

/**
 * The one person the card a button is on is about: the people linked from the nearest box around it that links to
 * anyone. When the button names someone, the one with that name; otherwise the only one, or the one the card names
 * in words where the rest are the faces of mutual friends (./people.ts `aboutWhom`).
 */
function personNear(
  control: Element,
  root: Element,
  base: string,
  named: string | null,
): Reached | null {
  let box: Element | null = control;
  for (let steps = 0; box && steps < CARD_STEPS; steps++) {
    const people = peopleLinked(box.querySelectorAll('a[href]'), base);
    if (people.length > 0) {
      if (named) {
        const match = people.find((person) => person.name && sameName(person.name, named));
        const only = people.length === 1 ? people[0] : undefined;
        const person = match ?? only;
        return person ? { name: named, profile: person.profile } : null;
      }
      const person = aboutWhom(people);
      return person?.name ? { name: person.name, profile: person.profile } : null;
    }
    if (box === root) break;
    box = box.parentElement;
  }
  return null;
}

function friendRequest(control: Element, label: string, doc: Document, href: string): Step | null {
  const address = classifyUrl(href);
  const main = mainOf(doc);
  const root = rootOf(control, doc);
  const named = clean(ADD_FRIEND.exec(label)?.[1]) || null;
  let to: Reached | null = null;
  const page = main.contains(control) ? pagePerson(doc, address, href) : null;
  if (page) {
    // The button at the top of someone's profile, above its tabs, is theirs; so is one that names them.
    const tabs = tabsIn(main);
    if ((tabs && isBefore(control, tabs)) || (named && sameName(named, page.name))) to = page;
  }
  to ??= personNear(control, root, href, named);
  if (!to || isYou(to, doc, href)) return null;
  return {
    kind: 'friend_request',
    to,
    group: groupOf(postAround(control, root), doc, address, href),
    postUrl: null,
    thread: null,
    replying: null,
  };
}

// ------------------------------------------------------------------------------------------ likes, comments

/** Who wrote a comment: the first person it links to, leaving out any reply inside it. */
function commentAuthor(article: Element, base: string): Reached | null {
  const own = [...article.querySelectorAll('a[href]')].filter(
    (anchor) => anchor.closest('[role="article"]') === article,
  );
  const first = peopleLinked(own, base)[0];
  return first?.name ? { name: first.name, profile: first.profile } : null;
}

function like(control: Element, doc: Document, href: string): Step | null {
  const root = rootOf(control, doc);
  const box = postAround(control, root);
  if (!box) return null;
  const post = readPost(box, href);
  const comment = commentAround(control, box);
  const to = comment ? commentAuthor(comment, href) : reachedOf(post?.author);
  if (!to || isYou(to, doc, href)) return null;
  return {
    kind: 'like',
    to,
    group: groupOf(box, doc, classifyUrl(href), href),
    postUrl: post?.url ?? null,
    thread: null,
    replying: null,
  };
}

/**
 * A comment sent from a box in a post: to whoever wrote the post, or for a reply, the comment it answers. A box is a
 * reply's when it says so ("Reply to Jane Doe"), when it sits in a comment, or when comments follow it: the box to
 * comment on the post comes after them all.
 */
function comment(
  box: Element,
  postBox: Element,
  label: string,
  doc: Document,
  address: PageAddress,
  base: string,
): Step | null {
  const post = readPost(postBox, base);
  const comments = commentsIn(postBox);
  const reply =
    REPLY_BOX.test(label) ||
    commentAround(box, postBox) !== null ||
    (!COMMENT_BOX.test(label) && comments.some((article) => isAfter(article, box)));
  let to: Reached | null = null;
  if (reply) {
    const named = clean(REPLY_TO.exec(label)?.[1]) || null;
    const above = comments
      .filter((article) => isBefore(article, box))
      .map((article) => commentAuthor(article, base))
      .filter((author): author is Reached => author !== null)
      .reverse();
    to =
      (named ? above.find((author) => sameName(author.name, named)) : undefined) ??
      above[0] ??
      null;
  }
  to ??= reachedOf(post?.author);
  if (!to || isYou(to, doc, base)) return null;
  return {
    kind: 'comment',
    to,
    group: groupOf(postBox, doc, address, base),
    postUrl: post?.url ?? null,
    thread: null,
    replying: null,
  };
}

// ------------------------------------------------------------------------------------------------ messages

/** A message sent in a chat: to who it's with, answering them when the chat's last message was theirs. */
function messageTo(chat: ChatPage, doc: Document, base: string): Step | null {
  if (!chat.profile || !chat.name) return null;
  const to = { name: chat.name, profile: chat.profile };
  if (isYou(to, doc, base)) return null;
  const last = chat.messages[chat.messages.length - 1];
  return {
    kind: 'message',
    to,
    group: null,
    postUrl: null,
    thread: chat.thread,
    replying: !last ? false : last.from === 'unknown' ? null : last.from === 'them',
  };
}

/** The chat a link in a part of the page opens: "Open in Messenger". */
function threadLinkedIn(box: Element, base: string): ThreadRef | null {
  for (const anchor of box.querySelectorAll('a[href]')) {
    const url = urlOf(anchor, base);
    const thread = url ? threadFromUrl(url) : null;
    if (thread) return thread;
  }
  return null;
}

/**
 * The small chat window a box to write in is in, over another page: the nearest box around it that holds a chat's
 * messages ("Messages in conversation with Jane Doe") and links to someone outside them, as the window's header does.
 * Never past a box over the page or into the main column; a box with a second chat or a second box to write in is
 * past the window.
 */
function chatWindowOf(box: Element, doc: Document, base: string): Element | null {
  const chats = [...doc.querySelectorAll('[aria-label]')].filter(isConversation);
  if (chats.length === 0) return null;
  const boxes = [...doc.querySelectorAll(WRITING)];
  const root = rootOf(box, doc);
  const main = mainOf(doc);
  for (let up = box.parentElement; up && root.contains(up); up = up.parentElement) {
    const here = up;
    if (here.contains(main)) break;
    const inside = chats.filter((chat) => here.contains(chat));
    if (inside.length > 1 || boxes.filter((other) => here.contains(other)).length > 1) return null;
    const chat = inside[0];
    if (!chat) continue;
    const outside = [...here.querySelectorAll('a[href]')].filter(
      (anchor) => !chat.contains(anchor),
    );
    if (peopleLinked(outside, base).length > 0) return here;
  }
  return null;
}

/**
 * A message sent in a chat window with no chat's label in it: to the one person the window links to. The window is
 * the nearest box around the box to write in that links to anyone, and it has no other box to write in.
 */
function messageNear(box: Element, doc: Document, base: string): Step | null {
  const main = mainOf(doc);
  let up = box.parentElement;
  for (let steps = 0; up && steps < WINDOW_STEPS && !up.contains(main); steps++) {
    const people = peopleLinked(up.querySelectorAll('a[href]'), base);
    if (people.length > 0) {
      const person = people[0]!;
      if (people.length > 1 || up.querySelectorAll(WRITING).length > 1 || !person.name) return null;
      const to = { name: person.name, profile: person.profile };
      if (isYou(to, doc, base)) return null;
      return {
        kind: 'message',
        to,
        group: null,
        postUrl: null,
        thread: threadLinkedIn(up, base),
        replying: null,
      };
    }
    up = up.parentElement;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ sending

/** What writing sent from a box was: a message in a chat or a chat window, or a comment or a reply on a post. */
function written(box: Element, doc: Document, href: string): Step | null {
  const address = classifyUrl(href);
  if (address.kind === 'chat' && mainOf(doc).contains(box))
    return messageTo(readChat(doc, address, href), doc, href);
  const chatWindow = chatWindowOf(box, doc, href);
  if (chatWindow)
    return messageTo(readChatIn(chatWindow, threadLinkedIn(chatWindow, href), href), doc, href);
  const label =
    clean(box.getAttribute('aria-label')) || clean(box.getAttribute('aria-placeholder'));
  const root = rootOf(box, doc);
  const commentBox = COMMENT_BOX.test(label);
  const post = postAround(box, root) ?? (commentBox ? postBefore(box, root) : null);
  if (post && (commentBox || !MESSAGE_BOX.test(label)))
    return comment(box, post, label, doc, address, href);
  return MESSAGE_BOX.test(label) ? messageNear(box, doc, href) : null;
}

/**
 * The box a send button sends: the last box to write in before it, in the nearest box around the button that has
 * any. Nothing when that box is empty, or comes after the button (a post's Comment button only opens its box).
 */
function boxSentBy(control: Element): Element | null {
  let up = control.parentElement;
  for (let steps = 0; up && steps < SEND_STEPS; steps++) {
    const boxes = [...up.querySelectorAll(WRITING)];
    if (boxes.length > 0) {
      const box = boxes.filter((b) => isBefore(b, control)).pop();
      return box && hasWriting(box) ? box : null;
    }
    up = up.parentElement;
  }
  return null;
}

/** The step a click takes, when it's on one of the buttons that take one. */
export function stepFromClick(target: Element, doc: Document, href: string): Step | null {
  const control = target.closest('[role="button"], button');
  if (!control || inTopBar(control) || control.getAttribute('aria-disabled') === 'true')
    return null;
  const label = labelOf(control);
  if (ADD_FRIEND.test(label)) return friendRequest(control, label, doc, href);
  if (LIKE.test(label)) return like(control, doc, href);
  if (SEND.test(label)) {
    const box = boxSentBy(control);
    return box ? written(box, doc, href) : null;
  }
  return null;
}

/**
 * The step Enter takes in a box to write in: sending a comment or a message, when something is written. Not while
 * a list under the box is open: there Enter picks a name or an emoji.
 */
export function stepFromEnter(target: Element, doc: Document, href: string): Step | null {
  const box = target.closest(WRITING);
  if (!box || inTopBar(box) || !hasWriting(box)) return null;
  if (box.getAttribute('aria-expanded') === 'true' || box.getAttribute('aria-activedescendant'))
    return null;
  return written(box, doc, href);
}

/** Someone opened from a group: a click on a link to them on the group's pages, or in a post from it. */
export function seenFromClick(target: Element, doc: Document, href: string): Seen | null {
  const anchor = target.closest('a[href]');
  if (!anchor || inTopBar(anchor)) return null;
  const url = urlOf(anchor, href);
  const profile = url ? profileFromUrl(url) : null;
  if (!url || !profile) return null;
  const address = classifyUrl(href);
  const root = rootOf(anchor, doc);
  // A member's link in a group (/groups/<group>/user/<id>/) says which itself.
  const linked = groupFromUrl(url);
  const group = linked
    ? { ...linked, name: groupName(linked, doc, address, href) }
    : groupOf(postAround(anchor, root), doc, address, href);
  if (!group) return null;
  const name = bestName(namesOn([anchor]));
  return isYou({ profile, name }, doc, href) ? null : { profile, name, group };
}

// ------------------------------------------------------------------------------------- answering a request

/** The person's answer to a friend request they got, and who asked. Plain data, like a step. */
export interface Answered {
  readonly answer: 'confirm' | 'delete';
  readonly to: Reached;
  /** As the card said: "12 mutual friends". */
  readonly mutualFriends: number | null;
}

/** A request's two buttons in the menu a profile's Respond opens: only these words, since other menus say "Delete". */
const MENU_CONFIRM = /^confirm(?: request)?$/i;
const MENU_DELETE = /^delete(?: friend)? request$/i;
const RESPOND = /^respond$/i;

/** The buttons in a box the person can see: Facebook keeps a hidden copy of each request's beside the ones shown. */
const controlsIn = (box: Element) =>
  [...box.querySelectorAll('[role="button"], button')].filter(shown);

/**
 * The two buttons a request's button is one of: the nearest box around it that has the other one too. A box that
 * has the other button of more than one request is a list of them, so this one has none beside it.
 */
function requestButtons(control: Element, other: RegExp, root: Element): Element | null {
  let box = control.parentElement;
  for (let steps = 0; box && steps < CARD_STEPS; steps++) {
    const others = controlsIn(box).filter(
      (found) => found !== control && other.test(labelOf(found)),
    );
    if (others.length) return others.length === 1 ? box : null;
    if (box === root) break;
    box = box.parentElement;
  }
  return null;
}

/** The keys a profile goes by: its number's and its username's, when it has both. */
const keysOf = (profile: ProfileRef): string[] => [
  profileKey(profile),
  ...(profile.id && profile.username ? [profileKey({ ...profile, id: null })] : []),
];

/** The card someone's request is on: the nearest box around its button that links to them. */
function cardOf(control: Element, to: Reached, root: Element, base: string): Element | null {
  const keys = keysOf(to.profile);
  let box = control.parentElement;
  for (let steps = 0; box && steps < CARD_STEPS; steps++) {
    const linked = peopleLinked(box.querySelectorAll('a[href]'), base);
    if (linked.some((person) => keys.includes(profileKey(person.profile)))) return box;
    if (box === root) break;
    box = box.parentElement;
  }
  return null;
}

/**
 * Whose profile is open beside the requests list (/friends/requests/?profile_id=…): the number in the address, and
 * the username its tabs link to (/jane.doe.5/about) when one of them links to that number too; named by the links to
 * either, else its heading.
 */
function previewPerson(doc: Document, href: string): Reached | null {
  const url = facebookUrl(href);
  if (!url || pathParts(url)[0]?.toLowerCase() !== 'friends') return null;
  const number = profileFromUrl(url);
  if (!number) return null;
  const main = mainOf(doc);
  const tabs = tabsIn(main);
  const tabbed = tabs
    ? [...tabs.querySelectorAll('a[href]')].flatMap((tab) => {
        const profile = classifyUrl(urlOf(tab, href)?.href ?? '').profile;
        return profile ? [profile] : [];
      })
    : [];
  const usernames = new Set(tabbed.flatMap((p) => (p.username ? [p.username.toLowerCase()] : [])));
  const username =
    usernames.size === 1 && tabbed.some((p) => p.id === number.id)
      ? (tabbed.find((p) => p.username)?.username ?? null)
      : null;
  const profile = { ...number, username };
  const keys = keysOf(profile);
  const anchors = [...doc.querySelectorAll('a[href]')].filter((anchor) => {
    if (inTopBar(anchor)) return false;
    const linked = urlOf(anchor, href);
    const person = linked ? profileFromUrl(linked) : null;
    return person !== null && keys.includes(profileKey(person));
  });
  const heading = clean(main.querySelector('h1')?.textContent);
  const name = bestName(namesOn(anchors)) ?? (isNameLike(heading) ? heading : null);
  return name ? { name, profile } : null;
}

/** What their row in the requests list beside their profile says: "16 mutual friends". */
function mutualFriendsBeside(doc: Document, to: Reached, base: string): number | null {
  const keys = keysOf(to.profile);
  for (const list of doc.querySelectorAll('[role="navigation"]')) {
    if (inTopBar(list)) continue;
    const rows = requestRows(list, base);
    const row = keys.map((key) => rows.get(key)).find((found) => found !== undefined);
    if (row) return mutualFriendsIn(textLines(row.box, 12));
  }
  return null;
}

/** The answer a click gives a friend request, when it's on one of the buttons that answer one. */
export function answerFromClick(target: Element, doc: Document, href: string): Answered | null {
  const item = target.closest('[role="menuitem"]');
  if (item) {
    // The menu a profile's Respond opens, on a profile that shows a request from them.
    const label = labelOf(item);
    const answer = MENU_CONFIRM.test(label) ? 'confirm' : MENU_DELETE.test(label) ? 'delete' : null;
    const address = classifyUrl(href);
    const main = mainOf(doc);
    const responding = controlsIn(main).some((control) => RESPOND.test(labelOf(control)));
    const to =
      answer && responding ? (pagePerson(doc, address, href) ?? previewPerson(doc, href)) : null;
    if (!answer || !to || isYou(to, doc, href)) return null;
    return { answer, to, mutualFriends: mutualFriendsBeside(doc, to, href) };
  }
  const control = target.closest('[role="button"], button');
  if (!control || inTopBar(control) || control.getAttribute('aria-disabled') === 'true')
    return null;
  const label = labelOf(control);
  const confirm = CONFIRM.exec(label);
  const remove = confirm ? null : DELETE.exec(label);
  if (!confirm && !remove) return null;
  const answer = confirm ? 'confirm' : 'delete';
  const root = rootOf(control, doc);
  if (!requestButtons(control, confirm ? DELETE : CONFIRM, root)) return null;
  const named = clean((confirm ?? remove)?.[1]) || null;
  const address = classifyUrl(href);
  const main = mainOf(doc);
  let to: Reached | null = null;
  if (main.contains(control)) {
    // At the top of their profile, above its tabs, or of the profile open beside the requests list.
    const page = pagePerson(doc, address, href) ?? previewPerson(doc, href);
    const tabs = tabsIn(main);
    if (page && (!tabs || isBefore(control, tabs) || (named && sameName(named, page.name))))
      to = page;
  }
  to ??= personNear(control, root, href, named);
  if (!to || isYou(to, doc, href)) return null;
  const card = cardOf(control, to, root, href);
  const mutualFriends =
    (card ? mutualFriendsIn(textLines(card, 12)) : null) ?? mutualFriendsBeside(doc, to, href);
  return { answer, to, mutualFriends };
}
