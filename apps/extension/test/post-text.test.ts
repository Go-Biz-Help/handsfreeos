/**
 * Posts keep their paragraphs (docs/outreach.md, decision 158): Facebook's box lost every line break when the whole post
 * was typed, so a post with line breaks is pasted into a box drawn to write in; one line, a plain box, or a box that
 * takes no paste is typed in as before.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { postLines, putPostIn } from '../src/networks/post-text';
import { canPaste, paragraphs, pastesLikeFacebook } from './paste';

// The wait for a box that takes no paste: none here.
vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });

/** The owner's helpful post of 10 Nov 2026, as the AI wrote it (shortened). */
const POST = [
  'We used to send a quote and just wait.',
  '',
  'Turns out most folks don’t say no, they just get busy and forget to reply.',
  '',
  'How do you guys follow up on quotes that go quiet?',
].join('\n');

/** A page with one box to write in, where typing goes; `pastes` when it takes a paste as Facebook's does. */
function page({ pastes = true, plain = false } = {}) {
  const doc = new JSDOM('<body></body>').window.document;
  canPaste(doc);
  const box = doc.createElement(plain ? 'textarea' : 'div');
  if (!plain) box.setAttribute('contenteditable', 'true');
  doc.body.append(box);
  const typed: string[] = [];
  doc.execCommand = (_command: string, _ui?: boolean, text?: string) => {
    typed.push(text ?? '');
    if (plain) (box as HTMLTextAreaElement).value = text ?? '';
    else box.textContent = text ?? '';
    return true;
  };
  if (pastes && !plain) pastesLikeFacebook(box);
  return { doc, box, typed };
}

const written = (box: HTMLElement) =>
  box.tagName === 'TEXTAREA'
    ? (box as HTMLTextAreaElement).value.trim() !== ''
    : (box.textContent ?? '').trim() !== '';

describe('putting a post’s words in the box', () => {
  it('pastes a post with line breaks, so each paragraph and blank line stays', async () => {
    const { doc, box, typed } = page();
    expect(await putPostIn(doc, box, POST, written)).toBe('pasted');
    expect(paragraphs(box)).toEqual(POST.split('\n'));
    // Never typed as well: the post goes in once.
    expect(typed).toEqual([]);
  });

  it('types a post of one line as before', async () => {
    const { doc, box, typed } = page();
    expect(await putPostIn(doc, box, 'One habit that won me more jobs.', written)).toBe('typed');
    expect(typed).toEqual(['One habit that won me more jobs.']);
  });

  it('types the whole post in a box that takes no paste, and in a plain box, which keep the lines', async () => {
    const ignores = page({ pastes: false });
    const going = putPostIn(ignores.doc, ignores.box, POST, written);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await going).toBe('typed');
    expect(ignores.typed).toEqual([POST]);

    const plain = page({ plain: true });
    expect(await putPostIn(plain.doc, plain.box, POST, written)).toBe('typed');
    expect((plain.box as HTMLTextAreaElement).value).toBe(POST);
  });

  it('pastes one kind of line break, with none at either end', () => {
    expect(postLines('\nFirst.\r\n\r\nSecond.\rThird.\n')).toBe('First.\n\nSecond.\nThird.');
  });
});
