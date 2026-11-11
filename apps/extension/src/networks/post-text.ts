/**
 * Putting a post's words in a network's box with its paragraphs kept (docs/outreach.md, decision 158).
 *
 * Chrome's insertText with the whole post lost every line break in Facebook's box (Lexical, as Instagram's is): the
 * owner's helpful post of 10 Nov 2026 went up as "…and just wait.Turns out most folks…", where the AI wrote a blank
 * line. So a post with line breaks is pasted, as a person pasting it would, which Facebook's and Instagram's boxes take
 * paragraph by paragraph, the blank lines too. A plain box (a textarea), or one that takes no paste, is typed in as
 * before: Chrome's own typing keeps the lines there. A post of one line is typed as before.
 *
 * Typing goes where the focus is: the caller focuses and presses the box first, and checks after that it took them.
 */

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** How long a box is given to show what was pasted (a page may draw it a moment later), and how often it's looked at. */
const PASTE_MS = 1_500;
const LOOK_MS = 100;

/** How the words went in: pasted with their lines, or typed. */
export type PutIn = 'pasted' | 'typed';

/** The post's words as pasted: one kind of line break, and none at either end. */
export function postLines(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
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
    const pasted = new view.DataTransfer();
    pasted.setData('text/plain', words);
    box.dispatchEvent(
      new view.ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }),
    );
    for (let waited = 0; waited < PASTE_MS; waited += LOOK_MS) {
      if (written(box)) return 'pasted';
      await pause(LOOK_MS);
    }
    if (written(box)) return 'pasted';
  }
  doc.execCommand('insertText', false, words);
  return 'typed';
}
