/**
 * AI Social Media Content Creator's hands for putting one of the business's own OK'd posts up (docs/socialcontent.md,
 * "Posting"; part 9), in its reading tab (./page.ts, `post`). The background opens the page first (./posting.ts):
 *
 * - **Facebook, the person's profile:** their home feed. It presses the box that starts a post ("What's on your
 *   mind…"), types the words into the box Facebook opens over the page (only while it's empty), adds the pictures,
 *   and presses **Next** when Facebook asks for it before **Post**.
 * - **Facebook, the business's Page:** Meta Business Suite's Create post for the Page (business.facebook.com), so the
 *   person's own profile is never switched to the Page: the words go in its text box, the pictures are added, a tick
 *   for Instagram that's on is turned off (Instagram has its own post, part 10), and it presses **Publish**.
 * - **LinkedIn:** their feed's **Start a post**, the same way, with LinkedIn's **Next** or **Done** after the pictures
 *   when it shows its picture editor.
 *
 * Pictures and the person's video come in as files from HandsFreeOS (the background fetches them). They're added the
 * ways a person can: the box's own file field (`input[type=file]`), pasting them into the words, the network's photo
 * button with the computer's file picker held back (./tab.ts, `holdPicker`: the button's field takes them instead of
 * a window opening), or dropping them on the box. Each way is tried until the box shows them.
 *
 * Like the readers, it goes by what a person sees (words, labels, roles, page order), never a network's class names.
 * It never presses anything but the box's own controls, and never posts twice: once Post is pressed it says so.
 */
import { clean, labelOf } from '../networks/facebook/dom';
import { shown } from '../networks/facebook/fetch';

/** A file to add, as the background fetched it. */
export interface PostFileIn {
  readonly name: string;
  readonly type: string;
  readonly base64: string;
}

/** Which composer: Facebook's over its feed, Business Suite's for a Page, or LinkedIn's over its feed. */
export type PostWhere = 'facebook' | 'business' | 'linkedin';

export interface PostAsk {
  readonly where: PostWhere;
  readonly text: string;
  readonly files: readonly PostFileIn[];
}

/**
 * How it went: `done` once the post went (the box closed, or Business Suite said so); `none` when there was no box to
 * write in; `no_media` when the box wouldn't take its pictures (nothing was posted); `not_sent` when it was written but
 * the network didn't take it. `pressed` says whether Post was pressed, so it's never tried again on its own.
 */
export interface PostDone {
  readonly result: 'done' | 'none' | 'no_media' | 'not_sent';
  readonly pressed: boolean;
  readonly url: string | null;
  /** What it did, for a problem report: "box", "typed", "media:paste", "next", "post"… */
  readonly steps: readonly string[];
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Where a person writes. */
export const WRITING_BOX = '[role="textbox"], [contenteditable="true"], textarea';
const CONTROLS = 'button, [role="button"], [role="menuitem"], a[role="link"]';
const OVER_THE_PAGE = '[role="dialog"], [role="alertdialog"], dialog';

/** The box at the top of a feed that starts a post. */
export const START = /^(what['’]s on your mind|create (a )?post|write something|start a post)\b/i;
/** What puts the post up, and what comes before it in the newer boxes. */
export const POST = /^(post|publish|share now|share)$/i;
export const NEXT = /^(next|done)$/i;
/** The network's photo button in the box: it opens a place for pictures (Facebook) or the file picker. */
export const MEDIA =
  /^(photo\/video|photo|photos|add (a )?photos?(\/videos?)?|add media|add photos? or videos?|media|add photo)\b/i;
/** LinkedIn's link to the post once it's up. */
const VIEW_POST = /^view post$/i;
/** Facebook's, Business Suite's and LinkedIn's words once a post is up. */
const PUBLISHED =
  /\b(your post (is|was|has been) (now )?(published|shared|live)|post published|post shared)\b/i;
/** A box to tick for Instagram in Business Suite's "Post to". */
const INSTAGRAM = /\binstagram\b/i;

const WAIT_MS = 8_000;
const POSTING_MS = 30_000;
const LOOK_MS = 400;

async function waitFor<T>(find: () => T | null, ms = WAIT_MS): Promise<T | null> {
  for (let waited = 0; waited <= ms; waited += LOOK_MS) {
    const found = find();
    if (found) return found;
    await pause(LOOK_MS);
  }
  return null;
}

/** What a control says: its label, else its words. */
const wordsOf = (e: Element) => labelOf(e);
const says = (e: Element, pattern: RegExp) => pattern.test(wordsOf(e));

/** The main part of the page, where a feed's box is. */
function mainOf(doc: Document): Element {
  return doc.querySelector('[role="main"]') ?? doc.body;
}

/** The box over the page to write a post in, while it's open: one to write in, with Post or Next of its own. */
export function composerIn(doc: Document): Element | null {
  return (
    [...doc.querySelectorAll(OVER_THE_PAGE)]
      .filter(shown)
      .reverse()
      .find(
        (box) =>
          [...box.querySelectorAll(WRITING_BOX)].some(shown) &&
          [...box.querySelectorAll(CONTROLS)].some((c) => says(c, POST) || says(c, NEXT)),
      ) ?? null
  );
}

/** Business Suite's Create post: the page itself, once it has a box to write in and its Publish. */
export function businessComposer(doc: Document): Element | null {
  const box = composerIn(doc);
  if (box) return box;
  const main = mainOf(doc);
  return [...main.querySelectorAll(WRITING_BOX)].some(shown) &&
    [...main.querySelectorAll(CONTROLS)].some((c) => says(c, POST))
    ? main
    : null;
}

/** The feed's box that starts a post. */
export function startIn(doc: Document): HTMLElement | null {
  return (
    [...mainOf(doc).querySelectorAll<HTMLElement>(`${CONTROLS}, ${WRITING_BOX}`)].find(
      (c) => shown(c) && !c.closest(OVER_THE_PAGE) && says(c, START),
    ) ?? null
  );
}

/** The box's control that says this, turned on. */
function controlIn(box: Element, pattern: RegExp): HTMLElement | null {
  return (
    [...box.querySelectorAll<HTMLElement>(CONTROLS)].find(
      (c) => shown(c) && c.getAttribute('aria-disabled') !== 'true' && says(c, pattern),
    ) ?? null
  );
}

/** What's in the box: its pictures and videos as the person sees them, to know when the files went in. */
export function mediaCount(box: Element): number {
  return box.querySelectorAll(
    'img[src^="blob:"], img[src^="data:"], video, [role="img"][style*="blob:"], img[src*="scontent"], [aria-label^="Remove" i], [aria-label*="remove photo" i], [aria-label*="edit photo" i]',
  ).length;
}

/** The page's own window, whose kinds of events and files the page hears. */
type PageWindow = Window &
  typeof globalThis & {
    DataTransfer?: typeof DataTransfer;
    ClipboardEvent?: typeof ClipboardEvent;
    DragEvent?: typeof DragEvent;
  };
const windowOf = (doc: Document) => (doc.defaultView ?? globalThis) as PageWindow;

/** The files, made from what the background fetched. */
export function filesOf(doc: Document, files: readonly PostFileIn[]): File[] {
  const FileOf = windowOf(doc).File ?? File;
  return files.map((f) => {
    const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
    return new FileOf([bytes], f.name, { type: f.type });
  });
}

function transferOf(doc: Document, files: readonly File[]): DataTransfer | null {
  const Transfer = windowOf(doc).DataTransfer;
  if (!Transfer) return null;
  const dt = new Transfer();
  for (const f of files) dt.items.add(f);
  return dt;
}

/** A file field that takes pictures or videos. */
function takesMedia(input: HTMLInputElement): boolean {
  const accept = (input.getAttribute('accept') ?? '').toLowerCase();
  return !accept || accept.includes('image') || accept.includes('video');
}

/** Puts the files in a file field as a person picking them would, and says it changed. */
export function giveFiles(input: HTMLInputElement, files: readonly File[]): void {
  const doc = input.ownerDocument;
  const dt = transferOf(doc, files);
  try {
    if (dt) input.files = dt.files;
  } catch {
    // A page that won't take them this way: the change below still tells it, and the next way follows.
  }
  const win = windowOf(doc);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
}

/** The file fields there: the box's own, else the page's (Business Suite keeps its outside the box). */
function fileFields(box: Element, doc: Document): HTMLInputElement[] {
  const inBox = [...box.querySelectorAll<HTMLInputElement>('input[type="file"]')].filter(
    takesMedia,
  );
  return inBox.length
    ? inBox
    : [...doc.querySelectorAll<HTMLInputElement>('input[type="file"]')].filter(takesMedia);
}

/** Whether the box shows more pictures than before, or the network's picture editor opened over it. */
async function tookThem(doc: Document, box: Element, before: number): Promise<boolean> {
  return !!(await waitFor(
    () =>
      mediaCount(box) > before || pictureEditor(doc, box) || (!box.isConnected && composerIn(doc))
        ? true
        : null,
    6_000,
  ));
}

/** LinkedIn's picture editor (or Facebook's) over the box after the files went in: it has Next or Done. */
function pictureEditor(doc: Document, box: Element): Element | null {
  return (
    [...doc.querySelectorAll(OVER_THE_PAGE)]
      .filter(shown)
      .reverse()
      .find(
        (d) =>
          d !== box &&
          !d.contains(box) &&
          mediaCount(d) > 0 &&
          [...d.querySelectorAll(CONTROLS)].some((c) => says(c, NEXT)),
      ) ?? null
  );
}

/**
 * Adds the files to the box, each way in turn, until it shows them: its file field, pasting into the words, its
 * photo button (with the file picker held back, so the button's field takes them), or dropping them on it.
 */
async function addFiles(
  doc: Document,
  box: Element,
  writing: HTMLElement,
  files: readonly File[],
  steps: string[],
): Promise<boolean> {
  const before = mediaCount(box);
  const field = fileFields(box, doc)[0];
  if (field) {
    giveFiles(field, files);
    steps.push('media:field');
    if (await tookThem(doc, box, before)) return true;
  }
  const win = windowOf(doc);
  const pasted = transferOf(doc, files);
  if (win.ClipboardEvent && pasted) {
    writing.focus();
    writing.dispatchEvent(
      new win.ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }),
    );
    steps.push('media:paste');
    if (await tookThem(doc, box, before)) return true;
  }
  const button = controlIn(box, MEDIA);
  if (button) {
    const fields = new Set(fileFields(box, doc));
    button.click();
    steps.push('media:button');
    // The field the button asked for (held back from opening the picker: ./tab.ts), or one it made.
    const asked = await waitFor(
      () =>
        doc.querySelector<HTMLInputElement>('input[type="file"][data-hfos-picked]') ??
        fileFields(box, doc).find((f) => !fields.has(f)) ??
        null,
      3_000,
    );
    const into = asked ?? fileFields(box, doc)[0];
    if (into) {
      into.removeAttribute('data-hfos-picked');
      giveFiles(into, files);
      steps.push(asked ? 'media:asked' : 'media:field2');
      if (await tookThem(doc, box, before)) return true;
    }
  }
  const dropped = transferOf(doc, files);
  if (!win.DragEvent || !dropped) return false;
  const target = box.querySelector('[role="presentation"]') ?? box;
  for (const type of ['dragenter', 'dragover', 'drop']) {
    target.dispatchEvent(
      new win.DragEvent(type, { dataTransfer: dropped, bubbles: true, cancelable: true }),
    );
    await pause(150);
  }
  steps.push('media:drop');
  return tookThem(doc, box, before);
}

/** Turns off a tick for Instagram that's on in Business Suite's "Post to": the Page's post goes to the Page only. */
function instagramOff(box: Element, steps: string[]): void {
  for (const tick of box.querySelectorAll<HTMLElement>(
    'input[type="checkbox"], [role="checkbox"], [role="switch"]',
  )) {
    const label =
      clean(tick.getAttribute('aria-label')) ||
      clean(tick.closest('label')?.textContent) ||
      clean(tick.parentElement?.textContent);
    const on =
      (tick as HTMLInputElement).checked === true || tick.getAttribute('aria-checked') === 'true';
    if (on && INSTAGRAM.test(label)) {
      tick.click();
      steps.push('instagram:off');
    }
  }
}

/** The link to the post just put up, when the network shows one (LinkedIn's View post). */
function linkShown(doc: Document): string | null {
  for (const anchor of doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (!says(anchor, VIEW_POST)) continue;
    try {
      const url = new URL(anchor.getAttribute('href') ?? '', doc.URL);
      if (url.protocol === 'https:') return url.href;
    } catch {
      // Not a link it can use.
    }
  }
  return null;
}

/** What an element says, each piece of words apart, as a person reads it ("Post shared" then "Your post has…"). */
function wordsIn(element: Element): string {
  const parts: string[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* text */);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    parts.push(node.nodeValue ?? '');
  return clean(parts.join(' '));
}

/** Puts the post up in the composer the page shows. */
export async function postHere(doc: Document, ask: PostAsk): Promise<PostDone> {
  const steps: string[] = [];
  const end = (
    result: PostDone['result'],
    pressed = false,
    url: string | null = null,
  ): PostDone => ({
    result,
    pressed,
    url,
    steps,
  });
  const find = ask.where === 'business' ? businessComposer : composerIn;
  let box = find(doc);
  if (!box && ask.where !== 'business') {
    const start = startIn(doc);
    if (!start) return end('none');
    start.click();
    steps.push('start');
    box = await waitFor(() => composerIn(doc));
  } else if (!box) box = await waitFor(() => businessComposer(doc), 15_000);
  if (!box) return end('none');
  steps.push('box');
  const writing = [...box.querySelectorAll<HTMLElement>(WRITING_BOX)].find(shown);
  if (!writing) return end('none');
  // Something written there already is the person's: left alone.
  if (clean(writing.textContent) || (writing as HTMLTextAreaElement).value) return end('not_sent');
  writing.focus();
  writing.click();
  await pause(300);
  if (writing.tagName === 'TEXTAREA') {
    (writing as HTMLTextAreaElement).value = ask.text;
    writing.dispatchEvent(new (windowOf(doc).Event)('input', { bubbles: true }));
  } else doc.execCommand('insertText', false, ask.text);
  await pause(800);
  if (!clean(writing.textContent) && !(writing as HTMLTextAreaElement).value)
    return end('not_sent');
  steps.push('typed');
  if (ask.files.length) {
    const files = filesOf(doc, ask.files);
    if (!(await addFiles(doc, box, writing, files, steps))) return end('no_media');
    steps.push('media');
    // LinkedIn's picture editor: Next (or Done) takes it back to the box with the pictures.
    const editor = pictureEditor(doc, box);
    if (editor) {
      const next = controlIn(editor, NEXT);
      if (next) {
        next.click();
        steps.push('editor:next');
        await waitFor(() => (pictureEditor(doc, box!) ? null : true), 6_000);
      }
    }
    // Facebook uploads the pictures before Post turns on: it's waited on below.
    if (!box.isConnected) box = find(doc) ?? box;
  }
  if (ask.where === 'business') instagramOff(box, steps);
  let post = await waitFor(() => controlIn(box!, POST), ask.files.length ? 20_000 : 4_000);
  if (!post) {
    // The newer Facebook box asks for Next first, then shows its own Post.
    const next = controlIn(box, NEXT);
    if (!next) return end('not_sent');
    next.click();
    steps.push('next');
    post = await waitFor(() => {
      const now = composerIn(doc) ?? box!;
      return controlIn(now, POST);
    }, 8_000);
    if (!post) return end('not_sent');
  }
  const posted = box;
  post.click();
  steps.push('post');
  const went = await waitFor(
    () =>
      !posted.isConnected ||
      !shown(posted) ||
      (ask.where === 'business' && PUBLISHED.test(wordsIn(doc.body))) ||
      linkShown(doc)
        ? true
        : null,
    POSTING_MS,
  );
  if (!went) return end('not_sent', true);
  return end('done', true, await waitFor(() => linkShown(doc), 4_000));
}

/**
 * The Page's number, from its own page: what Business Suite opens it by. Facebook says it in the page's app links
 * (`fb://page/?id=…`, `fb://profile/…`) and in the data the page came with.
 */
export function pageIdHere(doc: Document, href: string): string | null {
  try {
    const id = new URL(href).searchParams.get('id');
    if (id && /^\d{5,20}$/.test(id)) return id;
  } catch {
    // Not a link with its number in it.
  }
  for (const meta of doc.querySelectorAll('meta[property^="al:"], meta[content^="fb://"]')) {
    const m = /fb:\/\/(?:page\/\?id=|page\/|profile\/)(\d{5,20})/.exec(
      meta.getAttribute('content') ?? '',
    );
    if (m) return m[1]!;
  }
  for (const script of doc.querySelectorAll('script')) {
    const text = script.textContent ?? '';
    if (text.length > 2_000_000) continue;
    const m =
      /"pageID":"(\d{5,20})"/.exec(text) ??
      /"delegate_page":\{"id":"(\d{5,20})"/.exec(text) ??
      /"page_id":"(\d{5,20})"/.exec(text);
    if (m) return m[1]!;
  }
  return null;
}
