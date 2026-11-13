/**
 * AI Social Media Content Creator's hands for putting a post up on Threads or X (decision 41 in
 * HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md), in its reading tab, called from ./post-here.ts's `postHere`. The
 * background opens the page first (./posting.ts):
 *
 * - **X:** x.com/compose/post, which opens X's box to write a post over the page: the words go in its first box
 *   (`tweetTextarea_0`), the pictures in its file field, each post of a chain in a box of its own after its **Add
 *   post** (`addButton`; `tweetTextarea_1`, `_2`…), then its **Post** (**Post all** with a chain; `tweetButton`). Its
 *   note that the post was sent carries a link to it.
 * - **Threads:** its home page's "What's new?" (or **Create** in its side menu) opens its box over the page: the words
 *   go in its first box, the pictures in its file field (or by its picture button with the file picker held back),
 *   each post of a chain after its **Add to thread**, then its own **Post**. Its note that it posted carries a link.
 *
 * Only while the boxes are empty: something written there already is the person's. Like the other hands it goes by
 * what a person sees (words, labels, roles) and X's test ids, never class names, and never presses Post twice.
 */
import { clean, labelOf } from '../networks/facebook/dom';
import { shown } from '../networks/facebook/fetch';
import { putPostIn } from '../networks/post-text';
import type { PostDone, PostFileIn } from './post-here';

/** A post for Threads or X: its words (hashtags at the end), the posts under it, and its files. */
export interface ShortAsk {
  readonly where: 'threads' | 'x';
  readonly text: string;
  readonly chain: readonly string[];
  readonly files: readonly PostFileIn[];
}

/** What the caller gives: how the files go in (./post-here.ts's ways) and how it ends. */
export interface ShortTools {
  readonly addFiles: (
    box: Element,
    writing: HTMLElement,
    files: readonly File[],
  ) => Promise<boolean>;
  readonly filesOf: (files: readonly PostFileIn[]) => File[];
  readonly end: (result: PostDone['result'], pressed?: boolean, url?: string | null) => PostDone;
  readonly steps: string[];
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const LOOK_MS = 400;
const WAIT_MS = 8_000;
/** How long Post may take to turn on once pictures are added (they upload first), and the post to go. */
const UPLOAD_MS = 25_000;
const POSTING_MS = 30_000;

const OVER_THE_PAGE = '[role="dialog"], [role="alertdialog"], dialog';
const CONTROLS = 'button, [role="button"], a[role="link"], [role="menuitem"]';
const WRITING = '[contenteditable="true"], [role="textbox"], textarea';

/** Threads' box at the top of its feed, and Create in its side menu, that open its box to write a post. */
const THREADS_START = /^(what['’]s new\??|start a thread\b.*|create)$/i;
/** The control that adds a post under the one before. */
const THREADS_ADD = /^add to thread$/i;
const X_ADD = /^add (post|another post)$/i;
const POST = /^(post|post all)$/i;
/** The note once it went, with its link. */
const THREADS_POSTED = /^(posted|view)$/i;
const X_SENT = /\byour posts? (was|were) sent\b/i;

async function waitFor<T>(find: () => T | null, ms = WAIT_MS): Promise<T | null> {
  for (let waited = 0; waited <= ms; waited += LOOK_MS) {
    const found = find();
    if (found) return found;
    await pause(LOOK_MS);
  }
  return null;
}

const says = (e: Element, pattern: RegExp) => pattern.test(labelOf(e));
const written = (box: Element) =>
  'value' in box && typeof box.value === 'string' ? box.value.trim() : clean(box.textContent);
const off = (c: HTMLElement) =>
  c.getAttribute('aria-disabled') === 'true' || c.hasAttribute('disabled');

/** The box over the page now, its newest. */
function dialogOf(doc: Document): Element | null {
  return [...doc.querySelectorAll(OVER_THE_PAGE)].filter(shown).at(-1) ?? null;
}

// ------------------------------------------------------------------------------------------------ X

/** X's box to write post `n` of the chain in (0 the first), where it takes the typing. */
export function xBox(doc: Document, n: number): HTMLElement | null {
  const part = [...doc.querySelectorAll<HTMLElement>(`[data-testid="tweetTextarea_${n}"]`)]
    .filter(shown)
    .at(-1);
  if (!part) return null;
  return part.querySelector<HTMLElement>('[contenteditable="true"], [role="textbox"]') ?? part;
}

/** The part of X's page its box sits in: the box over the page, else the column it's drawn in. */
function xComposer(doc: Document, box: HTMLElement): Element {
  return (
    box.closest(OVER_THE_PAGE) ??
    box.closest('[data-testid="primaryColumn"]') ??
    doc.querySelector('[role="main"]') ??
    doc.body
  );
}

/** X's Post (Post all with a chain). */
function xPost(composer: Element): HTMLElement | null {
  return (
    composer.querySelector<HTMLElement>('[data-testid="tweetButton"]') ??
    composer.querySelector<HTMLElement>('[data-testid="tweetButtonInline"]') ??
    [...composer.querySelectorAll<HTMLElement>(CONTROLS)].find((c) => shown(c) && says(c, POST)) ??
    null
  );
}

/** X's link to the post just sent, from its note ("Your post was sent. View"). */
export function xSentLink(doc: Document): string | null {
  for (const note of doc.querySelectorAll(
    '[data-testid="toast"], [role="alert"], [role="status"]',
  )) {
    if (!X_SENT.test(clean(note.textContent))) continue;
    const link = note.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
    if (link) return new URL(link.getAttribute('href') ?? '', doc.URL).href;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ Threads

/** Threads' boxes to write in, in its box over the page, in order: one for each post of the chain. */
export function threadsBoxes(doc: Document): HTMLElement[] {
  const over = dialogOf(doc);
  if (!over) return [];
  return [...over.querySelectorAll<HTMLElement>(WRITING)].filter(
    (b) => shown(b) && !b.parentElement?.closest(WRITING),
  );
}

/** What opens Threads' box: "What's new?" at the top of the feed, else Create in the side menu. */
function threadsStart(doc: Document): HTMLElement | null {
  const controls = [...doc.querySelectorAll<HTMLElement>(`${CONTROLS}, a[href]`)].filter(
    (c) => shown(c) && !c.closest(OVER_THE_PAGE),
  );
  return (
    controls.find((c) => says(c, THREADS_START)) ??
    controls.find((c) => !!c.querySelector('svg[aria-label="Create" i]')) ??
    null
  );
}

/** Threads' link to the post just put up, from its note ("Posted · View"). */
export function threadsPostedLink(doc: Document): string | null {
  for (const link of doc.querySelectorAll<HTMLAnchorElement>('a[href*="/post/"]')) {
    if (link.closest(OVER_THE_PAGE) || link.closest('[role="main"]')) continue;
    if (!says(link, THREADS_POSTED) && !THREADS_POSTED.test(clean(link.parentElement?.textContent)))
      continue;
    return new URL(link.getAttribute('href') ?? '', doc.URL).href;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ both

/** Types one post's words in a box: only while it's empty, and only once it shows them. */
async function typeIn(doc: Document, box: HTMLElement, text: string): Promise<boolean> {
  if (written(box)) return false;
  box.focus();
  box.click();
  await pause(300);
  await putPostIn(doc, box, text, (b) => !!written(b));
  return !!(await waitFor(() => (written(box) ? true : null), 2_000));
}

/** Puts a post up on Threads or X: the first post, its pictures, the posts under it, then Post. */
export async function postShort(
  doc: Document,
  ask: ShortAsk,
  tools: ShortTools,
): Promise<PostDone> {
  const { steps, end } = tools;
  const onX = ask.where === 'x';
  const first = async (): Promise<HTMLElement | null> => {
    if (onX) return waitFor(() => xBox(doc, 0));
    const open = threadsBoxes(doc)[0];
    if (open) return open;
    const start = threadsStart(doc);
    if (!start) return null;
    start.click();
    steps.push('start');
    return waitFor(() => threadsBoxes(doc)[0] ?? null);
  };
  const box = await first();
  if (!box) return end('none');
  steps.push('box');
  if (written(box)) return end('not_sent');
  if (!(await typeIn(doc, box, ask.text))) return end('not_sent');
  steps.push('typed');
  const composer = () => (onX ? xComposer(doc, box) : (dialogOf(doc) ?? box));
  if (ask.files.length) {
    if (!(await tools.addFiles(composer(), box, tools.filesOf(ask.files)))) return end('no_media');
    steps.push('media');
  }
  // Each post of the chain in a box of its own, after Add post (X) or Add to thread (Threads).
  for (const [k, text] of ask.chain.entries()) {
    const had = onX ? null : threadsBoxes(doc).length;
    const add = [
      ...composer().querySelectorAll<HTMLElement>(`${CONTROLS}, [data-testid="addButton"]`),
    ]
      .filter((c) => shown(c) && !off(c))
      .find(
        (c) =>
          (onX && c.getAttribute('data-testid') === 'addButton') ||
          says(c, onX ? X_ADD : THREADS_ADD),
      );
    if (!add) return end('not_sent');
    add.click();
    const next = await waitFor(() =>
      onX ? xBox(doc, k + 1) : threadsBoxes(doc).length > had! ? threadsBoxes(doc).at(-1)! : null,
    );
    if (!next || !(await typeIn(doc, next, text))) return end('not_sent');
    steps.push(`chain:${k + 1}`);
  }
  const post = await waitFor(
    () => {
      const now = composer();
      const button = onX
        ? xPost(now)
        : ([...now.querySelectorAll<HTMLElement>(CONTROLS)]
            .filter((c) => shown(c) && says(c, POST))
            .at(-1) ?? null);
      return button && !off(button) ? button : null;
    },
    ask.files.length ? UPLOAD_MS : 4_000,
  );
  if (!post) return end('not_sent');
  const posted = box;
  post.click();
  steps.push('post');
  const went = await waitFor(
    () =>
      !posted.isConnected ||
      !shown(posted) ||
      (onX ? xSentLink(doc) : threadsPostedLink(doc)) ||
      (onX && X_SENT.test(clean(doc.body.textContent)))
        ? true
        : null,
    POSTING_MS,
  );
  if (!went) return end('not_sent', true);
  const link = await waitFor(() => (onX ? xSentLink(doc) : threadsPostedLink(doc)), 4_000);
  return end('done', true, link);
}
