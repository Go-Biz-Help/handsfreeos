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
 * - **Messaging:** Message on a connection's profile opens the conversation, with its box to write in and its Send;
 *   nothing is written (LinkedIn shows the other person someone's typing), and the conversation is closed again.
 * - **Liking:** one of their posts on their activity, and its Like; never pressed.
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
import { composer, startOf } from './compose';
import { LINKEDIN_FILE_PLANS, PREPARING } from './data';
import { CONTROLS, controlsIn, mainOf, wordsOf } from './dom';
import { readInvitations } from './invitations';
import { maskText } from './outline';
import { headlineMissing, tryHeadline } from './own-profile';
import type { ProfileRef } from './types';
import { CONNECT, MESSAGE, MORE, WITHDRAW } from './vocabulary';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The steps Check LinkedIn tries. */
export const TRY_STEPS = [
  'headline',
  'post',
  'comment',
  'connect',
  'message',
  'like',
  'withdraw',
  'file',
] as const;
export type TryStep = (typeof TRY_STEPS)[number];

/** How trying one step went. */
export interface StepTry {
  readonly step: TryStep;
  /** Whether there was something to try it on: a post of theirs, someone to connect with, an invitation sent. */
  readonly tried: boolean;
  /** Everything it needed was there and did what it should. */
  readonly works: boolean;
  /** What it found: counts, and yes or no. */
  readonly found: Readonly<Record<string, number | boolean>>;
  /** What it couldn't find or do, in the extension's own words; empty when it works. */
  readonly missing: readonly string[];
  /** The names of what it looked among, as the outline shows them. */
  readonly seen?: readonly string[];
}

const went = (
  step: TryStep,
  found: Record<string, number | boolean>,
  missing: readonly string[],
  seen?: readonly string[],
): StepTry => ({
  step,
  tried: true,
  works: missing.length === 0,
  found,
  missing,
  ...(seen?.length ? { seen } : {}),
});

/** Nothing to try it on: not a fault of the step's. */
const untried = (step: TryStep, why: string, found: Record<string, number | boolean> = {}) =>
  ({ step, tried: false, works: false, found, missing: [why] }) satisfies StepTry;

/** What a control or a box is called, as the outline shows it. */
const seenAs = (element: Element) =>
  maskText(wordsOf(element)[0] ?? '').slice(0, 60) || `(${element.tagName.toLowerCase()})`;

/** The shown controls in a box, as the outline would name them: what was there when what's wanted wasn't. */
const namesIn = (root: ParentNode, most = 12) =>
  [...root.querySelectorAll(CONTROLS)].filter(shown).slice(0, most).map(seenAs);

/** A word written to see a box take it, and taken out again: never sent. */
const TRY_WORD = 'Testing';
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
  const steps = await tryHeadline(doc);
  const { names, ...found } = steps;
  return went('headline', found, headlineMissing(steps, true), names);
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

/** Messaging, from a connection's profile: the conversation opened, its box and Send found, nothing written. */
export async function tryMessage(doc: Document, href: string, them: ProfileRef): Promise<StepTry> {
  const message = topCardControl(doc, MESSAGE);
  if (!message)
    return went(
      'message',
      { message: false },
      ['no Message on their profile'],
      namesIn(mainOf(doc)),
    );
  message.click();
  const box = await waitFor(() => messageBoxFor(doc, href, them), 5_000);
  const main = mainOf(doc);
  const opened = [...doc.querySelectorAll<HTMLElement>(WRITING)].filter(
    (b) => shown(b) && !main.contains(b),
  );
  const where = box ?? opened[0] ?? null;
  const area = where ? windowAround(where, doc) : null;
  // Send, whether or not LinkedIn has it on yet: it may stay off till something's written.
  const sends = area
    ? [...area.querySelectorAll(CONTROLS)].filter((c) => says(c, SENDS_MESSAGE))
    : [];
  const seen = !box && area ? namesIn(area) : [];
  const close = area
    ? [...area.querySelectorAll<HTMLElement>(CONTROLS)].find((c) => shown(c) && says(c, CLOSE))
    : null;
  close?.click();
  const missing = [
    !opened.length && 'Message opened no conversation to write in',
    opened.length > 0 &&
      !box &&
      (sends.length
        ? 'its Send stays off till something’s written, so the box isn’t found'
        : 'no Send by the box to write in'),
  ].filter((m): m is string => typeof m === 'string');
  return went(
    'message',
    {
      message: true,
      opened: opened.length > 0,
      box: Boolean(box),
      sends: sends.length,
      closed: Boolean(close),
    },
    missing,
    seen,
  );
}

/** Liking, on their activity: one of their posts, and its Like, never pressed. */
export function tryLike(doc: Document, href: string, profile: ProfileRef): StepTry {
  const posts = theirPosts(doc, href, profile);
  if (!posts.length) return untried('like', 'none of their posts on their activity', { posts: 0 });
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
