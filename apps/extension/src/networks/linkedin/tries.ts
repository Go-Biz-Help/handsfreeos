/**
 * Check LinkedIn's tries (docs/outreach.md, decision 76): each of the extension's steps on LinkedIn taken up to its
 * last press, in the tab, so one press of Check LinkedIn says what works and what doesn't, all at once, rather than one
 * step at a time as each is first asked for. Each try finds what its step finds, with the step's own functions, and
 * stops before anything that changes LinkedIn: nothing is ever saved, posted, liked, sent, connected or withdrawn.
 *
 * - **Headline:** the pencil, the intro's box, its one field named Headline and its one Save; words written in the
 *   field and its own put back; the box closed again (./own-profile.ts, `tryHeadline`).
 * - **Posting:** the feed's Start a post opens the composer, with a box to write in and a Post; it's closed again,
 *   nothing written.
 * - **Commenting:** the post's Comment opens its box; a word written in it brings the box's own button that sends
 *   it, which isn't pressed; the word is taken out again.
 * - **Connecting:** Connect on someone's profile, in the top card or under More; never pressed.
 * - **Messaging:** Message on a connection's profile opens the conversation, over the page or (LinkedIn's newer
 *   profiles) on a page of its own drawn in the interop frame, with its box to write in and its Send, which LinkedIn
 *   keeps off till something's written; nothing is written (LinkedIn shows the other person someone's typing), and a
 *   window over the page is closed again.
 * - **Liking:** one of their posts on their activity, or (decision 92) the post on its own page, and its Like; never
 *   pressed.
 * - **Who reacted** (decision 92): on someone else's post, on its own page, its reactions count opens the box of who
 *   reacted, whose rows say each one's headline and how far they are; the box is closed again with its Dismiss.
 * - **Withdrawing:** on Sent invitations, each invitation's Withdraw; never pressed.
 * - **The data file:** on Get a copy of your data, what each step looks for; nothing ticked or pressed.
 *
 * Each says what it found (counts, yes or no), what it couldn't find, in the extension's own words, and, where that
 * helps, the names of what it looked among as the outline shows them (LinkedIn's own words; anything else hidden).
 */
import { shown } from '../facebook/fetch';
import { hasWriting } from './actions';
import {
  commentBoxOf,
  commentOpener,
  likeOf,
  messageBoxFor,
  OVER_THE_PAGE,
  postOnPage,
  profileOn,
  says,
  SENDS_COMMENT,
  SENDS_MESSAGE,
  sendFor,
  theirPosts,
  topCardControl,
  waitFor,
  WRITING,
} from './auto';
import {
  closeBox,
  composer,
  hiddenNow,
  reactionsBox,
  reactionsCount,
  reactionsOpened,
  reactorRows,
  startOf,
} from './compose';
import { LINKEDIN_FILE_PLANS, PREPARING } from './data';
import { CONTROLS, controlsIn, mainOf, placesOf, wordsOf } from './dom';
import { readChat } from './chat';
import { readInvitations } from './invitations';
import { maskText, outlineNow } from './outline';
import { readPost } from './posts';
import { aboutMissing, headlineMissing, tryAbout, tryHeadline } from './own-profile';
import type { ProfileRef } from './types';
import { classifyUrl, comparable, linkedinUrl, sameMember } from './urls';
import { CONNECT, MESSAGE, MORE, WITHDRAW } from './vocabulary';
import { TRY_WORD, untried, went, type StepTry, type TryStep } from '../tries';

export type { StepTry, TryStep };

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The steps Check LinkedIn tries. */
export const TRY_STEPS = [
  'headline',
  'about',
  'post',
  'comment',
  'connect',
  'message',
  'like',
  'reactors',
  'withdraw',
  'file',
] as const satisfies readonly TryStep[];

/** What a control or a box is called, as the outline shows it. */
const seenAs = (element: Element) =>
  maskText(wordsOf(element)[0] ?? '').slice(0, 60) || `(${element.tagName.toLowerCase()})`;

/** The shown controls in a box, as the outline would name them: what was there when what's wanted wasn't. */
const namesIn = (root: ParentNode, most = 12) =>
  [...root.querySelectorAll(CONTROLS)].filter(shown).slice(0, most).map(seenAs);

const CLOSE = /^(dismiss|close)\b/i;
const DISCARD = /^discard\b/i;

/** Closes a box over the page without anything in it going anywhere: its close, then Discard if LinkedIn asks. */
async function closeOver(doc: Document, box: Element): Promise<boolean> {
  const close = [...box.querySelectorAll<HTMLElement>(CONTROLS)].find(
    (c) => shown(c) && says(c, CLOSE),
  );
  if (!close) return false;
  close.click();
  const closed = await waitFor(() => {
    if (!box.isConnected || !shown(box)) return true;
    [...doc.querySelectorAll(OVER_THE_PAGE)]
      .filter((other) => shown(other))
      .flatMap((other) => [...other.querySelectorAll<HTMLElement>(CONTROLS)])
      .find((c) => shown(c) && says(c, DISCARD))
      ?.click();
    return null;
  }, 5_000);
  return closed === true;
}

/** Takes everything written in a box out again. */
async function emptyBox(doc: Document, box: HTMLElement): Promise<boolean> {
  box.focus();
  doc.execCommand('selectAll');
  doc.execCommand('delete');
  await pause(300);
  return !hasWriting(box);
}

// ------------------------------------------------------------------------------------------------ each step

/** Putting the headline in, on their own profile. */
export async function tryHeadlineStep(doc: Document): Promise<StepTry> {
  let outline: string | undefined;
  const steps = await tryHeadline(doc, (sofar) => {
    // What's missing shows in the box: the page's outline is taken before it's closed.
    if (headlineMissing({ ...sofar, closed: true }, true).length) outline = outlineNow(doc);
  });
  const { names, ...found } = steps;
  return {
    ...went('headline', found, headlineMissing(steps, true), names),
    ...(outline ? { outline } : {}),
  };
}

/** Putting the About in, on their own profile (decision 80): its box opened, written in and closed, nothing saved. */
export async function tryAboutStep(doc: Document): Promise<StepTry> {
  let outline: string | undefined;
  const steps = await tryAbout(doc, (sofar) => {
    if (aboutMissing({ ...sofar, closed: true }, true).length) outline = outlineNow(doc);
  });
  const { names, ...found } = steps;
  return {
    ...went('about', found, aboutMissing(steps, true), names),
    ...(outline ? { outline } : {}),
  };
}

/** Posting, on their feed: the composer opened and closed again, nothing written. */
export async function tryPost(doc: Document): Promise<StepTry> {
  let box = composer(doc);
  const start = box ? null : startOf(doc);
  if (!box && !start) return went('post', { start: false }, ['no Start a post on your feed']);
  start?.click();
  box ??= await waitFor(() => composer(doc));
  if (!box) {
    // What opened instead, if anything: a box over the page, and its controls.
    const other = [...doc.querySelectorAll(OVER_THE_PAGE)].filter((b) => shown(b)).pop();
    return went(
      'post',
      { start: true, composer: false, box: Boolean(other) },
      [
        other
          ? 'the box Start a post opened has no Post, or nowhere to write'
          : 'Start a post opened nothing',
      ],
      other ? namesIn(other) : [],
    );
  }
  const writing = [...box.querySelectorAll(WRITING)].some(shown);
  const closed = await closeOver(doc, box);
  const missing = [
    !writing && 'no box to write the post in',
    !closed && 'the composer didn’t close again',
  ].filter((m): m is string => typeof m === 'string');
  return went('post', { start: true, composer: true, writing, closed }, missing);
}

/** Commenting, on a post's own page: a word written to bring its button, never pressed, and taken out again. */
export async function tryComment(doc: Document): Promise<StepTry> {
  const post = postOnPage(doc);
  if (!post) return untried('comment', 'no post on the post’s own page');
  const ready = commentBoxOf(post);
  let box = ready;
  const opener = box ? null : commentOpener(post);
  if (!box) {
    opener?.click();
    box = await waitFor(() => commentBoxOf(post), 3_000);
  }
  if (!box)
    return went(
      'comment',
      { opener: Boolean(opener), box: false },
      [opener ? 'Comment opened no box to write in' : 'no Comment on the post'],
      namesIn(post),
    );
  if (hasWriting(box))
    return untried('comment', 'writing in the comment box already, left alone', { box: true });
  box.focus();
  box.click();
  await pause(300);
  doc.execCommand('insertText', false, TRY_WORD);
  await pause(800);
  const typed = hasWriting(box);
  const send = typed ? sendFor(box, SENDS_COMMENT) : null;
  const seen = typed && !send ? namesIn(box.closest('form') ?? box.parentElement ?? box) : [];
  const emptied = typed ? await emptyBox(doc, box) : true;
  const missing = [
    !typed && 'writing in the comment box didn’t take',
    typed && !send && 'no button to send the comment',
    !emptied && 'the comment box didn’t empty again',
  ].filter((m): m is string => typeof m === 'string');
  return went(
    'comment',
    {
      open: Boolean(ready),
      opener: Boolean(opener),
      box: true,
      typed,
      send: Boolean(send),
      emptied,
    },
    missing,
    seen,
  );
}

/** Connecting, on someone's profile: Connect found, in the top card or under More, never pressed. */
export async function tryConnect(doc: Document, href: string): Promise<StepTry> {
  const state = profileOn(doc, href).connection;
  if (state === 'connected' || state === 'pending' || state === 'self')
    return untried(
      'connect',
      state === 'self' ? 'it’s your own profile' : `you’re ${state} with them already`,
    );
  let press = topCardControl(doc, CONNECT);
  const direct = Boolean(press);
  let more: HTMLElement | null = null;
  if (!press) {
    more = topCardControl(doc, MORE);
    if (more) {
      more.click();
      press = await waitFor(() => topCardControl(doc, CONNECT), 3_000);
      // The menu closed again: More pressed again, as a person would.
      more.click();
    }
  }
  const main = mainOf(doc);
  return went(
    'connect',
    { connect: Boolean(press), direct, underMore: Boolean(press) && !direct, more: Boolean(more) },
    press ? [] : [more ? 'no Connect under More' : 'no Connect, and no More, on their profile'],
    press
      ? []
      : controlsIn(main)
          .filter((c) => shown(c))
          .slice(0, 12)
          .map(seenAs),
  );
}

/** The window over the page a box is in, by its own close: the nearest box around it with one. */
function windowAround(box: Element, doc: Document): Element | null {
  const main = mainOf(doc);
  for (let up = box.parentElement; up && !up.contains(main); up = up.parentElement)
    if ([...up.querySelectorAll(CONTROLS)].some((c) => shown(c) && says(c, CLOSE))) return up;
  return null;
}

/**
 * Messaging, from a connection's profile: the conversation opened, its box and Send found, nothing written. LinkedIn
 * may draw the conversation inside its interop box rather than on the page (./dom.ts), so it's looked for in each.
 * When nothing opens and Message is a link to a page of its own, as on LinkedIn's newer profiles, that page's address
 * comes back for the job to try it there (`tryMessagePage`).
 */
export async function tryMessage(doc: Document, href: string, them: ProfileRef): Promise<StepTry> {
  const message = topCardControl(doc, MESSAGE);
  if (!message)
    return went(
      'message',
      { message: false },
      ['no Message on their profile'],
      namesIn(mainOf(doc)),
    );
  const link = message.matches('a[href]') ? linkedinUrl(message.getAttribute('href')!, href) : null;
  message.click();
  // LinkedIn's newer profiles take the tab to the new conversation's page (/messaging/thread/new/?recipient=…).
  const box = await waitFor(() => messageBoxFor(doc, doc.location.href, them), 5_000);
  const tookTo = classifyUrl(doc.location.href).kind;
  const onPage = tookTo === 'chat' || tookTo === 'messaging';
  const main = mainOf(doc);
  const places = placesOf(doc);
  const opened = places
    .flatMap((place) => [...place.querySelectorAll<HTMLElement>(WRITING)])
    .filter((b) => shown(b) && !main.contains(b));
  const where = box ?? opened[0] ?? null;
  const area = where ? windowAround(where, doc) : null;
  // What's around the box it found: its form, or the window it's in.
  const around = where ? (where.closest('form') ?? area) : null;
  // Send, whether or not LinkedIn has it on yet: it stays off till something's written.
  const sends = around
    ? [...around.querySelectorAll(CONTROLS)].filter((c) => says(c, SENDS_MESSAGE))
    : [];
  const seen = !box && around ? namesIn(around) : [];
  const missing = [
    !opened.length && 'Message opened no conversation to write in',
    opened.length > 0 &&
      !box &&
      (!sends.length
        ? 'no Send by the box to write in'
        : onPage
          ? 'the conversation’s page isn’t plainly theirs, or has more than one box to write in'
          : 'the conversation that opened doesn’t link to them'),
  ].filter((m): m is string => typeof m === 'string');
  // What's missing shows in what Message opened: the page's outline is taken before it's closed.
  const outline = missing.length ? outlineNow(doc) : undefined;
  const inside = where !== null && where.getRootNode() !== doc;
  // A window over the page is closed again; a conversation's own page has nothing to close.
  const close =
    area && !onPage
      ? [...area.querySelectorAll<HTMLElement>(CONTROLS)].find((c) => shown(c) && says(c, CLOSE))
      : null;
  close?.click();
  const leadsTo = link ? classifyUrl(link.href).kind : null;
  const next =
    !opened.length && link && (leadsTo === 'messaging' || leadsTo === 'chat') ? link.href : null;
  return {
    ...went(
      'message',
      {
        message: true,
        link: Boolean(link),
        page: onPage,
        // LinkedIn's interop box and frame, as far as they can be read: 0 when neither can.
        places: places.length - 1,
        opened: opened.length > 0,
        inside,
        box: Boolean(box),
        sends: sends.length,
        closed: Boolean(close),
      },
      missing,
      seen,
    ),
    ...(outline ? { outline } : {}),
    ...(next ? { next } : {}),
  };
}

/**
 * Messaging a second way, on the page their profile's Message links to (`/messaging/compose/…` on LinkedIn's newer
 * profiles): one box to write in, a Send for it, and nothing plainly saying it's with someone else, as the runner
 * tells it (./auto.ts). Nothing is written.
 */
export function tryMessagePage(doc: Document, href: string, them: ProfileRef): StepTry {
  const boxes = placesOf(doc)
    .flatMap((place) => [...place.querySelectorAll<HTMLElement>(WRITING)])
    .filter((b) => shown(b));
  const box = boxes.length === 1 ? boxes[0]! : null;
  const area = box ? (box.closest('form') ?? windowAround(box, doc) ?? mainOf(doc)) : null;
  const sends = area
    ? [...area.querySelectorAll(CONTROLS)].filter((c) => says(c, SENDS_MESSAGE))
    : [];
  const chat = readChat(doc, classifyUrl(href), href);
  const withThem = chat.profile !== null && sameMember(chat.profile, them);
  const someoneElse =
    chat.profile !== null && comparable(chat.profile, them) && !sameMember(chat.profile, them);
  const missing = [
    !boxes.length && 'no box to write in on the page Message leads to',
    boxes.length > 1 && `${boxes.length} boxes to write in on the page Message leads to`,
    box && !sends.length && 'no Send by the box on the page Message leads to',
    someoneElse && 'the page Message leads to is with someone else',
  ].filter((m): m is string => typeof m === 'string');
  return went(
    'message',
    {
      page: true,
      boxes: boxes.length,
      sends: sends.length,
      them: withThem,
      named: chat.name !== null || chat.profile !== null,
    },
    missing,
    box && !sends.length && area ? namesIn(area) : [],
  );
}

/**
 * Liking, on their activity: one of their posts, and its Like, never pressed. On a post's own page (decision 92: the
 * post a search found, liked there), that post, when it's theirs.
 */
export function tryLike(doc: Document, href: string, profile: ProfileRef): StepTry {
  const posts = theirPosts(doc, href, profile);
  if (!posts.length)
    return untried(
      'like',
      classifyUrl(href).kind === 'post'
        ? 'the post on its own page isn’t theirs'
        : 'none of their posts on their activity',
      { posts: 0 },
    );
  const liked = posts.filter((p) => p.post.liked).length;
  const pick = posts.find((p) => !p.post.liked) ?? posts[0]!;
  const like = likeOf(pick.box);
  return went(
    'like',
    { posts: posts.length, liked, like: Boolean(like) },
    like ? [] : ['no Like on their post'],
    like ? [] : namesIn(pick.box),
  );
}

/**
 * Who reacted, on someone else's post on its own page (decision 92): its reactions count opens the box of who reacted,
 * whose rows are read as the runner reads them (the line under each name and how far they are), and its Dismiss closes
 * it again. Nothing in the box is pressed. With nobody's reaction on the post, there's nothing to try it on.
 */
export async function tryReactors(doc: Document, href: string): Promise<StepTry> {
  const post = postOnPage(doc);
  if (!post) return untried('reactors', 'no post on the post’s own page');
  const count = reactionsCount(post);
  if (!count) {
    if (readPost(post, href)?.reactions === 0)
      return untried('reactors', 'nobody has reacted to the post', { count: false });
    return went(
      'reactors',
      { count: false },
      ['no reactions count on the post to open who reacted'],
      namesIn(post),
    );
  }
  count.click();
  const box = await waitFor(() => reactionsBox(doc, href));
  if (!box) {
    const other =
      reactionsOpened(doc) ??
      [...doc.querySelectorAll(OVER_THE_PAGE)].filter((b) => shown(b)).pop();
    const outline = outlineNow(doc);
    // LinkedIn draws the box's rows only once Chrome shows its window.
    const hidden = Boolean(other) && hiddenNow(doc);
    if (other) await closeBox(other);
    return {
      ...went(
        'reactors',
        { count: true, box: false, other: Boolean(other), ...(hidden ? { shown: false } : {}) },
        [
          hidden
            ? 'the box its reactions count opened drew nobody, as its window was behind another'
            : other
              ? 'the box its reactions count opened shows nobody'
              : 'its reactions count opened no box of who reacted',
        ],
        other ? namesIn(other) : [],
      ),
      outline,
    };
  }
  const rows = reactorRows(box, href);
  const degrees = rows.filter((row) => row.degree !== null).length;
  const headlines = rows.filter((row) => row.headline !== null).length;
  // Your own row says neither: the rest each say how far they are.
  const missing = [rows.length > 1 && !degrees && 'no row in the box says how far they are'].filter(
    (m): m is string => typeof m === 'string',
  );
  const outline = missing.length ? outlineNow(doc) : undefined;
  const closed = await closeBox(box);
  if (!closed) missing.push('the box of who reacted didn’t close again');
  return {
    ...went(
      'reactors',
      { count: true, box: true, rows: rows.length, degrees, headlines, closed },
      missing,
    ),
    ...(outline ? { outline } : {}),
  };
}

/** Withdrawing, on Sent invitations: each invitation's Withdraw, never pressed. */
export function tryWithdraw(doc: Document, href: string): StepTry {
  const main = mainOf(doc);
  const invitations = readInvitations(main, href).filter((i) => i.direction === 'sent');
  const withdraws = controlsIn(main).filter(
    (c) => shown(c) && wordsOf(c).some((w) => WITHDRAW.test(w)),
  );
  if (!invitations.length && !withdraws.length)
    return untried('withdraw', 'no invitations you sent to look at', { invitations: 0 });
  return went(
    'withdraw',
    { invitations: invitations.length, withdraw: withdraws.length },
    withdraws.length ? [] : ['no Withdraw by the invitations you sent'],
  );
}

/** Getting the data file, on Get a copy of your data: what each step looks for, on the page; nothing ticked. */
export function tryFile(doc: Document): StepTry {
  const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ').toLowerCase();
  if (PREPARING.some((words) => text.includes(words)))
    return untried('file', 'LinkedIn is making a copy already, so its steps don’t show', {
      preparing: true,
    });
  const steps = LINKEDIN_FILE_PLANS.request.steps.filter(
    (s) => s.action !== 'stopIf' && s.action !== 'waitFor' && !s.optional,
  );
  const missing = steps
    .filter((s) => !s.words.some((words) => text.includes(words.toLowerCase())))
    .map((s) => `nothing saying “${s.words[0]}”`);
  return went('file', { steps: steps.length, found: steps.length - missing.length }, missing);
}
