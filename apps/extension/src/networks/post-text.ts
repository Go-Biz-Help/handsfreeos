/**
 * Putting a post's words in a network's box with its paragraphs kept (docs/outreach.md, decision 158).
 *
 * Chrome's insertText with the whole post lost every line break in Facebook's box (Lexical, as Instagram's is): the
 * owner's helpful post of 10 Nov 2026 went up as "…and just wait.Turns out most folks…", where the AI wrote a blank
 * line. So a post with line breaks is pasted, as a person pasting it would, which Facebook's and Instagram's boxes take
 * paragraph by paragraph, the blank lines too. A plain box (a textarea), or one that takes no paste, is typed in as
 * before: Chrome's own typing keeps the lines there. A post of one line is typed as before.
 *
 * LinkedIn's box (Tiptap, on ProseMirror) takes pasted words a line to a paragraph but drops the blank lines between
 * them: the owner's posts of 15 and 18 Nov 2026 went up with every paragraph straight under the one before, the
 * hashtags too. Chrome's own typing keeps them there, each blank line an empty paragraph, as pressing Enter twice
 * does (tried in LinkedIn's own box, 18 Nov 2026). So when a box shows the words but none of their blank lines, it's
 * emptied and they're typed in. A box that takes the plain words with their blank lines never sees that.
 *
 * Words pasted as a web page gives them (HTML) can't help on LinkedIn: its page lets no script but its own read pasted
 * HTML (Trusted Types), so its box throws such a paste away. Extension 0.141.5 to 0.147.11 tried that, and the plain
 * words went back in without their blank lines.
 *
 * Typing goes where the focus is: the caller focuses and presses the box first, and checks after that it took them.
 */

import { pause, within as steadyWithin } from '../steady';

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

/** Pastes the words, as a person pasting them would. */
function paste(view: Window & typeof globalThis, box: HTMLElement, words: string) {
  const pasted = new view.DataTransfer();
  pasted.setData('text/plain', words);
  box.dispatchEvent(
    new view.ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }),
  );
}

/** Waits up to `ms` by the clock for `ready`, looking each `LOOK_MS` (../steady.ts). */
const within = (ms: number, ready: () => boolean): Promise<boolean> =>
  steadyWithin(ms, ready, LOOK_MS);

/** Empties the box as a person would (all of it picked, then deleted). Whether it's empty after. */
async function emptied(
  doc: Document,
  box: HTMLElement,
  written: (box: HTMLElement) => boolean,
): Promise<boolean> {
  const picked = doc.getSelection();
  if (!picked) return false;
  box.focus();
  picked.selectAllChildren(box);
  // Gives the box a moment to see what's picked before it's deleted.
  await pause(LOOK_MS);
  doc.execCommand('delete');
  return within(EMPTY_MS, () => !written(box));
}

/**
 * The box showed the pasted words without their blank lines: it's emptied and the words typed in, as Chrome types
 * them. A box that won't empty is left as it was. One that takes no typing, or shows fewer lines from it than the
 * paste gave, gets the plain words pasted back: never the words twice, never an empty box, and never worse than the
 * paste.
 */
async function typeAgain(
  doc: Document,
  view: Window & typeof globalThis,
  box: HTMLElement,
  words: string,
  written: (box: HTMLElement) => boolean,
): Promise<PutIn> {
  const pastedLines = linesIn(box).length;
  if (!(await emptied(doc, box, written))) return 'pasted';
  doc.execCommand('insertText', false, words);
  if (await within(PASTE_MS, () => written(box))) {
    if (linesIn(box).length >= pastedLines) return 'typed';
    if (!(await emptied(doc, box, written))) return 'typed';
  }
  paste(view, box, words);
  await within(PASTE_MS, () => written(box));
  return 'pasted';
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
      if (lostBlankLines(box, words)) return typeAgain(doc, view, box, words, written);
      return 'pasted';
    }
  }
  doc.execCommand('insertText', false, words);
  return 'typed';
}
