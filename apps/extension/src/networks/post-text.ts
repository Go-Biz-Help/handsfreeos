/**
 * Putting a post's words in a network's box with its paragraphs kept (docs/outreach.md, decision 158).
 *
 * Chrome's insertText with the whole post lost every line break in Facebook's box (Lexical, as Instagram's is): the
 * owner's helpful post of 10 Nov 2026 went up as "…and just wait.Turns out most folks…", where the AI wrote a blank
 * line. So a post with line breaks is pasted, as a person pasting it would, which Facebook's and Instagram's boxes take
 * paragraph by paragraph, the blank lines too. A plain box (a textarea), or one that takes no paste, is typed in as
 * before: Chrome's own typing keeps the lines there. A post of one line is typed as before.
 *
 * LinkedIn's box takes pasted words a line to a paragraph but drops the blank lines between them, as a ProseMirror box
 * does: the owner's post of 15 Nov 2026 went up with every paragraph straight under the one before, the hashtags too.
 * Copied from a web page, the same words come with the page's paragraphs (HTML), an empty one for each blank line, and
 * those boxes keep them. So when a box shows the words but none of their blank lines, it's emptied and they're pasted
 * again as a page gives them (`postHtml`). A box that takes the plain words with their blank lines never sees that.
 *
 * Typing goes where the focus is: the caller focuses and presses the box first, and checks after that it took them.
 */

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** How long a box is given to show what was pasted (a page may draw it a moment later), and how often it's looked at. */
const PASTE_MS = 1_500;
const LOOK_MS = 100;
/** How long an emptied box is given to show nothing. */
const EMPTY_MS = 1_000;

/** How the words went in: pasted with their lines, or typed. */
export type PutIn = 'pasted' | 'typed';

/** The post's words as pasted: one kind of line break, and none at either end. */
export function postLines(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

const escaped = (line: string) =>
  line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The words as a web page gives them when copied: each line its own paragraph, a blank line an empty one. */
export function postHtml(words: string): string {
  return postLines(words)
    .split('\n')
    .map((line) => (line.trim() ? `<p>${escaped(line)}</p>` : '<p><br></p>'))
    .join('');
}

/** What starts a line of its own in a box. */
const BLOCK = /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE)$/;
/** Spaces and the invisible marks some boxes keep in an empty line. */
const blank = (line: string) => line.replace(/[\s\u200b\ufeff]/g, '') === '';

/**
 * The lines a box shows, as a person reads them: each paragraph (or block) a line, and a line break inside one ends
 * a line, except the one that only holds an empty paragraph open (`<p><br></p>` is one empty line).
 */
export function linesIn(box: Element): string[] {
  const lines: string[] = [];
  let line: string | null = null;
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent ?? '';
        if (line !== null || !blank(text)) line = (line ?? '') + text;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      if (el.tagName === 'BR') {
        lines.push(line ?? '');
        line = null;
        continue;
      }
      if (!BLOCK.test(el.tagName)) {
        walk(el);
        continue;
      }
      if (line !== null) lines.push(line);
      line = null;
      const before = lines.length;
      walk(el);
      if (line !== null) lines.push(line);
      else if (lines.length === before) lines.push('');
      line = null;
    }
  };
  walk(box);
  if (line !== null) lines.push(line);
  // Empty lines at either end aren't between paragraphs.
  while (lines.length && blank(lines[0]!)) lines.shift();
  while (lines.length && blank(lines[lines.length - 1]!)) lines.pop();
  return lines;
}

/** Whether the words have a blank line between paragraphs and the box shows none. */
export function lostBlankLines(box: Element, words: string): boolean {
  const wanted = postLines(words).split('\n').some(blank);
  return wanted && !linesIn(box).some(blank);
}

/** Pastes the words, with a web page's paragraphs when `html` is given. */
function paste(view: Window & typeof globalThis, box: HTMLElement, words: string, html?: string) {
  const pasted = new view.DataTransfer();
  pasted.setData('text/plain', words);
  if (html) pasted.setData('text/html', html);
  box.dispatchEvent(
    new view.ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }),
  );
}

/** Waits up to `ms` for `ready`, looking each `LOOK_MS`. */
async function within(ms: number, ready: () => boolean): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += LOOK_MS) {
    if (ready()) return true;
    await pause(LOOK_MS);
  }
  return ready();
}

/**
 * The box showed the words without their blank lines: it's emptied (all of it picked, then deleted, as a person
 * would), and the words pasted again with a web page's paragraphs. A box that won't empty is left as it was, and one
 * that ignores the second paste gets the plain words back: never the words twice, and never an empty box.
 */
async function pasteAsPage(
  doc: Document,
  view: Window & typeof globalThis,
  box: HTMLElement,
  words: string,
  written: (box: HTMLElement) => boolean,
): Promise<void> {
  const picked = doc.getSelection();
  if (!picked) return;
  box.focus();
  picked.selectAllChildren(box);
  // Gives the box a moment to see what's picked before it's deleted.
  await pause(LOOK_MS);
  doc.execCommand('delete');
  if (!(await within(EMPTY_MS, () => !written(box)))) return;
  paste(view, box, words, postHtml(words));
  if (await within(PASTE_MS, () => written(box))) return;
  paste(view, box, words);
  await within(PASTE_MS, () => written(box));
}

/**
 * Puts the post's words in the box that has the focus. `written` says whether the box shows words: each network's
 * own check, as a placeholder or an emoji counts differently on each.
 */
export async function putPostIn(
  doc: Document,
  box: HTMLElement,
  text: string,
  written: (box: HTMLElement) => boolean,
): Promise<PutIn> {
  const words = postLines(text);
  const view = doc.defaultView as (Window & typeof globalThis) | null;
  const drawn = box.tagName !== 'TEXTAREA' && box.tagName !== 'INPUT';
  if (drawn && words.includes('\n') && view?.ClipboardEvent && view.DataTransfer) {
    paste(view, box, words);
    if (await within(PASTE_MS, () => written(box))) {
      if (lostBlankLines(box, words)) await pasteAsPage(doc, view, box, words, written);
      return 'pasted';
    }
  }
  doc.execCommand('insertText', false, words);
  return 'typed';
}
