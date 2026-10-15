/**
 * The steps a person takes on LinkedIn themselves, noticed as they take them
 * (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part by part", 2), as ../facebook/actions.ts
 * notices Facebook's: the content script hears the person's own click or Enter, and these work out from the page
 * around it what it was and who it was to. They read the page and never change it, and they never keep what a
 * comment, a note or a message says: only that one was sent. Each is noted with the same steps as Facebook's, on
 * LinkedIn:
 *
 * - **Invitation to connect** (a friend request): Connect, or its label "Invite Dana Reyes to connect", with or without
 *   a note. LinkedIn mostly opens a box over the page first (Add a note, Send without a note), and the invitation goes
 *   when that box's Send is pressed; when no box opens, it went at once and the button no longer says Connect. Either
 *   way, it's noted only once it went (`linkedInNoticer`). On a profile, the Connect in its top card, or under its
 *   More, is theirs; anywhere else it's the one person the card around it names.
 * - **Accept** and **Ignore** on an invitation they got, in My Network's lists or at the top of the profile of whoever
 *   sent it: noted as Facebook's Confirm and Delete are. Invitations to follow a page, go to an event or read a
 *   newsletter aren't these.
 * - **Like:** a post's Like ("React Like"), before it's pressed ("Unreact Like" takes it back), or one of the
 *   reactions LinkedIn shows over it while the post has none of theirs yet, to whoever wrote the post; a comment's
 *   ("React Like to Sam Lee’s comment"), to whoever wrote the comment.
 * - **Comment:** the button that sends a comment box's words (Comment, Post, Reply), to whoever wrote the post, or for
 *   a reply, the comment it answers.
 * - **Message:** Send in a conversation in LinkedIn messaging, to who it's with, with the conversation's id; or in a
 *   chat window over another page, to the one person the window links to.
 *
 * Enter in a comment's or a message's box counts only when the box empties after it: in LinkedIn's boxes Enter may
 * only start a new line. A step to yourself isn't one, and neither is a step the page can't tie to exactly one person
 * (a company's post, a group chat). Like the readers, they go by labels, links and page order, never class names, and
 * in English for now.
 */
import type { Answered, Reached, Step } from '../facebook/actions';
import { clean, isBefore, labelOf, textWithEmoji } from '../facebook/dom';
import { sameName } from '../facebook/people';
import type { Noticed, Noticer } from '../kit';
import { readChat } from './chat';
import { CONTROLS, inTopBar, mainOf, shownLines, wordsOf, yourName } from './dom';
import { notToConnect } from './invitations';
import { aboutWhom, peopleLinked, rowLines } from './people';
import { postBoxes, postIn, readPost } from './posts';
import { inTopCard, readProfile } from './profile';
import type { ChatPage, PageAddress, ProfileRef, ThreadRef } from './types';
import {
  classifyUrl,
  LINKEDIN,
  linkedinUrl,
  pathParts,
  profileFromUrl,
  threadFromUrl,
} from './urls';
import { ACCEPT, CONNECT, IGNORE } from './vocabulary';

/** "Invite Dana Reyes to connect": who a Connect is for, when its label says. */
const INVITE_NAMED = /^invite (.+) to connect$/i;
/** The invitation box's buttons that send it: with a note, or without. */
const SENDS_INVITE = /^(send|send now|send invitation|send invite|send without a note|connect)$/i;
/** Words that make a box over the page the invitation's: "Add a note to your invitation?". */
const ABOUT_INVITING = /\binvit/i;
/** The person the invitation box names, when it does: "Personalize your invitation to Dana Reyes by adding a note." */
const INVITING_WHOM = /\binvitation to (.+?)(?:\s+by adding a note)?\s*[.?!]/i;
/** "Accept an invitation to follow Lane Landscaping": an invitation to something other than connecting. */
const NOT_CONNECTING = /\binvitation to (follow|attend|join|subscribe)\b/i;

/** A reaction: Like, and the ones LinkedIn shows over it. */
const REACTION = /^(?:react\s+)?(like|celebrate|support|love|insightful|funny)$/i;
/** A comment's own: "React Like to Sam Lee’s comment". */
const COMMENT_REACTION =
  /^react (?:like|celebrate|support|love|insightful|funny) to (.+?)[’']s? comment$/i;
/** Taking a reaction back. */
const UNREACT = /^unreact\b/i;
/** The post's own reaction button, which says whether it has one of theirs. */
const POST_REACTION = /^(?:(?:un)?react\s+)?(like|celebrate|support|love|insightful|funny)$/i;

/** The buttons that send what's written: a comment box's, a conversation's. */
const SENDS_COMMENT = /^(comment|post|reply|submit|post comment|post reply)$/i;
const SENDS_MESSAGE = /^(send|send message)$/i;
/** A box to reply to a comment in. */
const REPLY_BOX = /^(add a reply|reply to\b|write a reply)/i;

/** The boxes to write in: a comment's, a message's, and the invitation's note. */
const WRITING = '[role="textbox"], [contenteditable="true"], textarea';
/** What's over the page: the invitation's box, a post opened over the feed. */
const OVER_THE_PAGE = '[role="dialog"], [role="alertdialog"], dialog';
/** What somebody wrote, inside a post: its comments, and the preview of a link. */
const NESTED = 'article, [role="article"]';

/** How far up from a button the card it's on can be: LinkedIn wraps each thing in many boxes. */
const CARD_STEPS = 16;
/** How far up from a send button the box it sends can be. */
const SEND_STEPS = 12;
/** How far up from the box to write in a chat window over another page its link to who it's with can be. */
const WINDOW_STEPS = 20;

/** How long after Connect it looks whether LinkedIn opened its box or sent the invitation at once. */
export const CONNECT_LOOK_MS = 2_500;
/** How long a Connect waits for the box it opened to send it. */
export const INVITE_WAIT_MS = 5 * 60_000;
/** How long after Enter it looks whether the box was sent, and emptied. */
export const ENTER_LOOK_MS = 1_500;

const isShown = (element: Element) =>
  !element.closest('[aria-hidden="true"], [hidden]') &&
  element.getAttribute('aria-disabled') !== 'true';

/** The part of the page something is in: a box over the page, the main column, or the rest. */
function rootOf(element: Element, doc: Document): Element {
  const over = element.closest(OVER_THE_PAGE);
  if (over) return over;
  const main = mainOf(doc);
  return main.contains(element) ? main : doc.body;
}

/** Whether someone is you: the name on the top bar's Me. */
function isYou(person: Pick<Reached, 'name'>, doc: Document): boolean {
  const you = yourName(doc);
  return you !== null && sameName(you, person.name);
}

/** Whether a box to write in has something in it: words, or only an emoji. */
export function hasWriting(box: Element): boolean {
  if (box.tagName === 'TEXTAREA') return (box as HTMLTextAreaElement).value.trim() !== '';
  return textWithEmoji(box) !== '';
}

/** A box's label: what it says it's for, or the words it shows while empty. */
const boxLabel = (box: Element) =>
  clean(box.getAttribute('aria-label')) ||
  clean(box.getAttribute('aria-placeholder')) ||
  clean(box.getAttribute('data-placeholder')) ||
  clean(box.getAttribute('placeholder'));

/** A button, or a control LinkedIn draws as one, that the person can press: never the top bar's. */
function controlAt(target: Element, links = false): Element | null {
  const control = target.closest(links ? `${CONTROLS}, a[href]` : CONTROLS);
  if (!control || inTopBar(control) || control.getAttribute('aria-disabled') === 'true')
    return null;
  return control;
}

const says = (control: Element, pattern: RegExp) => wordsOf(control).some((w) => pattern.test(w));

// ------------------------------------------------------------------------------------------------ people

/** Whose profile the page is, by its top card: its name, and its id where its links show one. */
function pagePerson(
  doc: Document,
  address: PageAddress,
  base: string,
): (Reached & { readonly mutual: number | null }) | null {
  if (address.kind !== 'profile' || !address.profile) return null;
  const read = readProfile(mainOf(doc), address, base, doc.title);
  return read.name && read.profile
    ? { name: read.name, profile: read.profile, mutual: read.mutualConnections }
    : null;
}

/**
 * The one person the card a button is on is about: the people linked from the nearest box around it that links to
 * anyone. When the button names someone, the one with that name; otherwise the only one, or the one the card names
 * in words where the rest are faces of mutual connections.
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
        const person = match ?? (people.length === 1 ? people[0] : undefined);
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

// ------------------------------------------------------------------------------------------------ connect

/** The member a link to LinkedIn's invitation box is for: /preload/search-custom-invite/?vanityName=<name>. */
function invitedByLink(control: Element, base: string): ProfileRef | null {
  if (!control.matches('a[href]')) return null;
  const url = linkedinUrl(control.getAttribute('href') ?? '', base);
  const name = url?.searchParams.get('vanityName');
  if (!url || !name || pathParts(url)[0]?.toLowerCase() !== 'preload') return null;
  return profileFromUrl(new URL(`${LINKEDIN}/in/${encodeURIComponent(name)}/`));
}

/** A press of Connect, and who it's for: null as `step` when the page can't tie it to one person. */
export interface ConnectPress {
  readonly control: Element;
  readonly step: Step | null;
}

/** Whether a click is on a Connect, and who it invites: the profile's own, or the one person its card names. */
export function connectFrom(target: Element, doc: Document, href: string): ConnectPress | null {
  const control = controlAt(target, true);
  if (!control || !says(control, CONNECT) || control.closest(OVER_THE_PAGE)) return null;
  const named =
    wordsOf(control)
      .map((w) => INVITE_NAMED.exec(w)?.[1])
      .find(Boolean) ?? null;
  const main = mainOf(doc);
  const page = pagePerson(doc, classifyUrl(href), href);
  let to: Reached | null = null;
  if (page && (inTopCard(control, main) || (named && sameName(named, page.name))))
    to = { name: page.name, profile: page.profile };
  if (!to) {
    // LinkedIn's own link to its invitation box names the member in its address; the card names them in words.
    const linked = invitedByLink(control, href);
    const near = personNear(control, rootOf(control, doc), href, named);
    const name = named ?? near?.name ?? null;
    to = linked ? (name ? { name, profile: linked } : null) : near;
  }
  if (!to || isYou(to, doc)) return { control, step: null };
  return {
    control,
    step: { kind: 'friend_request', to, group: null, postUrl: null, thread: null, replying: null },
  };
}

/** The box over the page an element is in, when that box is about an invitation to connect. */
function invitationBoxOf(element: Element): Element | null {
  const box = element.closest(OVER_THE_PAGE);
  if (!box) return null;
  const words = [labelOf(box), ...shownLines(box, { max: 30 })].join(' ');
  return ABOUT_INVITING.test(words) && !NOT_CONNECTING.test(words) ? box : null;
}

/** The invitation box open over the page, if one is. */
export function openInvitation(doc: Document): Element | null {
  for (const box of doc.querySelectorAll(OVER_THE_PAGE))
    if (isShown(box) && invitationBoxOf(box) === box) return box;
  return null;
}

/** Whether a click is on the invitation box's Send (with a note or without): the box, when it is. */
export function invitationSentBy(target: Element): Element | null {
  const control = controlAt(target);
  if (!control || !says(control, SENDS_INVITE)) return null;
  return invitationBoxOf(control);
}

/** Whether the box sending an invitation names someone else than the Connect pressed was for. */
function namesSomeoneElse(box: Element, step: Step): boolean {
  const named = INVITING_WHOM.exec(shownLines(box, { max: 30 }).join(' '))?.[1];
  return !!named && !sameName(named, step.to.name);
}

// -------------------------------------------------------------------------------------- likes, comments

/** The post something is in, as the readers find posts (./posts.ts). */
function postAround(element: Element, doc: Document): Element | null {
  return postBoxes(doc.body).find((box) => box.contains(element)) ?? null;
}

/** The comment something is in, inside a post: an article that isn't the post's own. */
function commentAround(element: Element, post: Element): Element | null {
  const own = postIn(post);
  for (
    let up = element.closest(NESTED);
    up && post.contains(up);
    up = up.parentElement?.closest(NESTED) ?? null
  )
    if (up !== own && up !== post) return up;
  return null;
}

/** The comments in a post, in page order: its articles that aren't the post's own. */
const commentsIn = (post: Element) => {
  const own = postIn(post);
  return [...post.querySelectorAll(NESTED)].filter((article) => article !== own);
};

/** Who wrote a comment: the first member it links to, leaving out any reply inside it. */
function commentAuthor(article: Element, base: string): Reached | null {
  const own = [...article.querySelectorAll('a[href]')].filter(
    (anchor) => anchor.closest(NESTED) === article,
  );
  const first = peopleLinked(own, base)[0];
  return first?.name ? { name: first.name, profile: first.profile } : null;
}

/** Whether the post already has one of the person's reactions: its own button pressed, or saying Unreact. */
function reacted(post: Element): boolean {
  const own = postIn(post);
  return [...post.querySelectorAll(CONTROLS)].some((control) => {
    const nested = control.closest(NESTED);
    if (nested && nested !== own && nested !== post) return false;
    return (
      says(control, POST_REACTION) &&
      (control.getAttribute('aria-pressed') === 'true' || says(control, UNREACT))
    );
  });
}

function like(control: Element, doc: Document, href: string): Step | null {
  if (control.getAttribute('aria-pressed') === 'true' || says(control, UNREACT)) return null;
  const onComment = says(control, COMMENT_REACTION);
  if (!onComment && !says(control, REACTION)) return null;
  const post = postAround(control, doc);
  if (!post) return null;
  const comment = commentAround(control, post);
  // A reaction picked over a post that has one of theirs changes it: it isn't a new one.
  if (!comment && reacted(post)) return null;
  const read = readPost(post, href);
  const to = comment
    ? commentAuthor(comment, href)
    : read?.author?.profile
      ? { name: read.author.name, profile: read.author.profile }
      : null;
  if (!to || isYou(to, doc)) return null;
  return {
    kind: 'like',
    to,
    group: null,
    postUrl: read?.url ?? null,
    thread: null,
    replying: null,
  };
}

/**
 * A comment sent from a box in a post: to whoever wrote the post, or for a reply, the comment it answers. A box is a
 * reply's when it sits in a comment, or says so ("Add a reply…"): then it's to the comment it's in, or the last one
 * before it.
 */
function comment(box: Element, post: Element, doc: Document, base: string): Step | null {
  const read = readPost(post, base);
  const inComment = commentAround(box, post);
  let to: Reached | null = inComment ? commentAuthor(inComment, base) : null;
  if (!inComment && REPLY_BOX.test(boxLabel(box)))
    to =
      commentsIn(post)
        .filter((article) => isBefore(article, box))
        .map((article) => commentAuthor(article, base))
        .filter((author): author is Reached => author !== null)
        .pop() ?? null;
  if (!to && read?.author?.profile) to = { name: read.author.name, profile: read.author.profile };
  if (!to || isYou(to, doc)) return null;
  return {
    kind: 'comment',
    to,
    group: null,
    postUrl: read?.url ?? null,
    thread: null,
    replying: null,
  };
}

// ------------------------------------------------------------------------------------------------ messages

/** A chat with more than one other person: "Dana Reyes, Sam Lee and Avery Lane". */
const SEVERAL = /,|\band\b/i;

/** A message sent in a conversation: to who it's with, answering them when its last message was theirs. */
function messageTo(chat: ChatPage, doc: Document): Step | null {
  if (!chat.profile || !chat.name || SEVERAL.test(chat.name)) return null;
  const to = { name: chat.name, profile: chat.profile };
  if (isYou(to, doc)) return null;
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

/** The conversation a part of the page links to: /messaging/thread/<id>/. */
function threadLinkedIn(box: Element, base: string): ThreadRef | null {
  for (const anchor of box.querySelectorAll('a[href]')) {
    const url = linkedinUrl(anchor.getAttribute('href') ?? '', base);
    const thread = url ? threadFromUrl(url) : null;
    if (thread) return thread;
  }
  return null;
}

/**
 * A message sent in a chat window over another page: to the one person, besides you, that the nearest box around
 * the box to write in links to. A window with someone else in it, or a second box to write in, is past the window.
 */
function messageNear(box: Element, doc: Document, base: string): Step | null {
  const main = mainOf(doc);
  let up = box.parentElement;
  for (let steps = 0; up && steps < WINDOW_STEPS && !up.contains(main); steps++) {
    const people = peopleLinked(up.querySelectorAll('a[href]'), base).filter(
      (person) => !(person.name && isYou({ name: person.name }, doc)),
    );
    if (people.length > 0) {
      const person = people[0]!;
      if (people.length > 1 || up.querySelectorAll(WRITING).length > 1 || !person.name) return null;
      return {
        kind: 'message',
        to: { name: person.name, profile: person.profile },
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

/** What writing sent from a box was: a comment or a reply on a post, or a message in a conversation or a window. */
function written(box: Element, doc: Document, href: string): Step | null {
  if (invitationBoxOf(box)) return null;
  const post = postAround(box, doc);
  if (post) return comment(box, post, doc, href);
  const address = classifyUrl(href);
  const main = mainOf(doc);
  if ((address.kind === 'chat' || address.kind === 'messaging') && main.contains(box))
    return messageTo(readChat(doc, address, href), doc);
  return messageNear(box, doc, href);
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

/** What a send button sent: the box, and the comment or message it was. */
export function sentFrom(
  target: Element,
  doc: Document,
  href: string,
): { readonly box: Element; readonly step: Step } | null {
  const control = controlAt(target);
  if (!control || (!says(control, SENDS_COMMENT) && !says(control, SENDS_MESSAGE))) return null;
  const box = boxSentBy(control);
  const step = box ? written(box, doc, href) : null;
  return box && step ? { box, step } : null;
}

/** The step a click takes, when it's a like or sends a comment or a message (Connect goes its own way). */
export function stepFromClick(target: Element, doc: Document, href: string): Step | null {
  const control = controlAt(target);
  if (!control) return null;
  return like(control, doc, href) ?? sentFrom(target, doc, href)?.step ?? null;
}

/**
 * What Enter in a box to write in would send, when something is written: a comment or a message, and the box, to
 * look at after (it's sent when it empties). Not while a list under the box is open: there Enter picks a name.
 */
export function stepFromEnter(
  target: Element,
  doc: Document,
  href: string,
): { readonly box: Element; readonly step: Step } | null {
  const box = target.closest(WRITING);
  if (!box || inTopBar(box) || !hasWriting(box)) return null;
  if (box.getAttribute('aria-expanded') === 'true' || box.getAttribute('aria-activedescendant'))
    return null;
  const step = written(box, doc, href);
  return step ? { box, step } : null;
}

// ------------------------------------------------------------------------------------- answering an invitation

/** How many invitations' Accepts a box holds: more than one, and it's a list of them. */
const acceptsIn = (box: Element) =>
  [...box.querySelectorAll(CONTROLS)].filter((control) => isShown(control) && says(control, ACCEPT))
    .length;

/**
 * The row an invitation's button is on: the nearest box around it that has both its Accept and its Ignore and links
 * to the one member it names in words. A box with another invitation's Accept is the list, not a row.
 */
function rowOf(
  control: Element,
  root: Element,
  base: string,
): { readonly box: Element; readonly to: Reached } | null {
  let box = control.parentElement;
  for (let steps = 0; box && steps < CARD_STEPS; steps++) {
    if (acceptsIn(box) > 1) return null;
    const people = peopleLinked(box.querySelectorAll('a[href]'), base);
    if (people.length) {
      const both = [...box.querySelectorAll(CONTROLS)];
      const paired =
        both.some((c) => says(c, ACCEPT)) && both.some((c) => says(c, IGNORE) && !says(c, ACCEPT));
      const person = aboutWhom(people);
      return paired && person?.inWords && person.name
        ? { box, to: { name: person.name, profile: person.profile } }
        : null;
    }
    if (box === root) break;
    box = box.parentElement;
  }
  return null;
}

/** The answer a click gives an invitation they got, when it's Accept or Ignore on one: Facebook's Confirm and Delete. */
export function answerFromClick(target: Element, doc: Document, href: string): Answered | null {
  const control = controlAt(target);
  if (!control) return null;
  const accept = says(control, ACCEPT);
  if (!accept && !says(control, IGNORE)) return null;
  if (says(control, NOT_CONNECTING)) return null;
  const main = mainOf(doc);
  const page = main.contains(control) ? pagePerson(doc, classifyUrl(href), href) : null;
  let to: Reached | null = null;
  let mutual: number | null = null;
  if (page && inTopCard(control, main)) {
    to = { name: page.name, profile: page.profile };
    mutual = page.mutual;
  } else {
    const row = rowOf(control, rootOf(control, doc), href);
    if (!row || notToConnect(row.box, href)) return null;
    to = row.to;
    mutual = rowLines(row.box, row.to.name).mutualConnections;
  }
  if (isYou(to, doc)) return null;
  return { answer: accept ? 'confirm' : 'delete', to, mutualFriends: mutual };
}

// ------------------------------------------------------------------------------------------------ the noticer

/**
 * Noting the person's steps on one LinkedIn page. It remembers the last Connect pressed until the box it opened sends
 * the invitation (or a few minutes pass, or another Connect is pressed), and when each box sent a comment or a message
 * from its button, so an Enter in it isn't noted again.
 */
export function linkedInNoticer(now: () => number = Date.now): Noticer {
  let invited: { readonly press: ConnectPress; readonly step: Step; readonly at: number } | null =
    null;
  const sentAt = new WeakMap<Element, number>();
  return {
    click(target, doc, href): Noticed | null {
      const box = invitationSentBy(target);
      if (box) {
        const pressed = invited;
        invited = null;
        if (!pressed || now() - pressed.at > INVITE_WAIT_MS || namesSomeoneElse(box, pressed.step))
          return null;
        return { kind: 'step', step: pressed.step };
      }
      const press = connectFrom(target, doc, href);
      if (press) {
        const step = press.step;
        if (!step) {
          // A Connect it can't tie to one person: the box it opens sends nobody's.
          invited = null;
          return null;
        }
        const mine = { press, step, at: now() };
        invited = mine;
        return {
          kind: 'maybe',
          step,
          afterMs: CONNECT_LOOK_MS,
          went: () => {
            // Sent from its box already, or another Connect pressed since.
            if (invited !== mine) return false;
            // The box is open: its Send notes it.
            if (openInvitation(doc)) return false;
            invited = null;
            // No box, and the button still says Connect: nothing went.
            return !(mine.press.control.isConnected && says(mine.press.control, CONNECT));
          },
        };
      }
      const sent = sentFrom(target, doc, href);
      if (sent) {
        sentAt.set(sent.box, now());
        return { kind: 'step', step: sent.step };
      }
      const control = controlAt(target);
      const liked = control ? like(control, doc, href) : null;
      if (liked) return { kind: 'step', step: liked };
      const answered = answerFromClick(target, doc, href);
      return answered ? { kind: 'answer', answered } : null;
    },
    enter(target, doc, href): Noticed | null {
      const found = stepFromEnter(target, doc, href);
      if (!found) return null;
      const at = now();
      const { box } = found;
      return {
        kind: 'maybe',
        step: found.step,
        afterMs: ENTER_LOOK_MS,
        // Sent: the box emptied, or went with the chat. Its button sent it since, and that was noted.
        went: () => (!box.isConnected || !hasWriting(box)) && !((sentAt.get(box) ?? -1) >= at),
      };
    },
  };
}
