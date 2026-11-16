/**
 * Posts keep their paragraphs (docs/outreach.md, decision 158): Facebook's box lost every line break when the whole post
 * was typed, so a post with line breaks is pasted into a box drawn to write in; one line, a plain box, or a box that
 * takes no paste is typed in as before. LinkedIn's box dropped the blank lines from the pasted words (the owner's post
 * of 15 Nov 2026), so a box that shows none gets them pasted again as a web page gives them.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { linesIn, lostBlankLines, postHtml, postLines, putPostIn } from '../src/networks/post-text';
import { canPaste, paragraphs, pastesLikeFacebook, pastesLikeLinkedIn } from './paste';

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

/**
 * A page with one box to write in, where typing goes; `pastes` when it takes a paste as Facebook's does, `linkedin`
 * when as LinkedIn's does (`html: false` when it ignores a web page's copy). Delete empties the box unless `stuck`.
 */
function page({ pastes = true, plain = false, linkedin = false, html = true, stuck = false } = {}) {
  const doc = new JSDOM('<body></body>').window.document;
  canPaste(doc);
  const box = doc.createElement(plain ? 'textarea' : 'div');
  if (!plain) box.setAttribute('contenteditable', 'true');
  doc.body.append(box);
  const typed: string[] = [];
  const pasted: string[] = [];
  box.addEventListener(
    'paste',
    (event) => {
      const data = (event as Event & { clipboardData: DataTransfer }).clipboardData;
      pasted.push(data.getData('text/html') ? 'page' : 'plain');
    },
    true,
  );
  doc.execCommand = (command: string, _ui?: boolean, text?: string) => {
    if (command === 'delete') {
      if (!stuck) box.replaceChildren();
      return true;
    }
    typed.push(text ?? '');
    if (plain) (box as HTMLTextAreaElement).value = text ?? '';
    else box.textContent = text ?? '';
    return true;
  };
  if (linkedin) pastesLikeLinkedIn(box, { html });
  else if (pastes && !plain) pastesLikeFacebook(box);
  return { doc, box, typed, pasted };
}

const written = (box: HTMLElement) =>
  box.tagName === 'TEXTAREA'
    ? (box as HTMLTextAreaElement).value.trim() !== ''
    : (box.textContent ?? '').trim() !== '';

describe('putting a post’s words in the box', () => {
  it('pastes a post with line breaks, so each paragraph and blank line stays', async () => {
    const { doc, box, typed, pasted } = page();
    expect(await putPostIn(doc, box, POST, written)).toBe('pasted');
    expect(paragraphs(box)).toEqual(POST.split('\n'));
    // Never typed as well, nor pasted again: the post goes in once.
    expect(typed).toEqual([]);
    expect(pasted).toEqual(['plain']);
  });

  it('pastes it again as a web page gives it when the box drops the blank lines, as LinkedIn’s did', async () => {
    const { doc, box, typed, pasted } = page({ linkedin: true });
    expect(await putPostIn(doc, box, POST, written)).toBe('pasted');
    expect(paragraphs(box)).toEqual(POST.split('\n'));
    expect(pasted).toEqual(['plain', 'page']);
    expect(typed).toEqual([]);
  });

  it('never leaves the words twice, nor an empty box, when the second paste can’t go', async () => {
    // The box won't empty: the words stay as they went in, once.
    const stuck = page({ linkedin: true, stuck: true });
    expect(await putPostIn(stuck.doc, stuck.box, POST, written)).toBe('pasted');
    expect(paragraphs(stuck.box)).toEqual(POST.split('\n').filter(Boolean));
    expect(stuck.pasted).toEqual(['plain']);

    // The box ignores a web page's copy: the plain words go back in.
    const ignores = page({ linkedin: true, html: false });
    const going = putPostIn(ignores.doc, ignores.box, POST, written);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await going).toBe('pasted');
    expect(paragraphs(ignores.box)).toEqual(POST.split('\n').filter(Boolean));
    expect(ignores.pasted).toEqual(['plain', 'page', 'plain']);
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

  it('gives the words as a web page does: a paragraph to a line, an empty one for a blank line', () => {
    expect(postHtml('Tips & tricks <3\n\nBook a call.\n#roofing')).toBe(
      '<p>Tips &amp; tricks &lt;3</p><p><br></p><p>Book a call.</p><p>#roofing</p>',
    );
  });
});

describe('the lines a box shows', () => {
  const box = (html: string) => {
    const doc = new JSDOM('<body></body>').window.document;
    const div = doc.createElement('div');
    div.innerHTML = html;
    return div;
  };

  it('reads paragraphs, empty ones and line breaks as a person sees them', () => {
    // Lexical's, Quill's and ProseMirror's: an empty paragraph holds a line break.
    expect(linesIn(box('<p>One.</p><p><br></p><p>Two.</p>'))).toEqual(['One.', '', 'Two.']);
    expect(linesIn(box('<p>One.</p><p><br class="trailing"></p><p>Two.<br></p>'))).toEqual([
      'One.',
      '',
      'Two.',
    ]);
    // Line breaks in one block, and the blocks in blocks Draft.js draws.
    expect(linesIn(box('<div>One.<br><br>Two.</div>'))).toEqual(['One.', '', 'Two.']);
    expect(
      linesIn(
        box(
          '<div><div><div><span><span>One.</span></span></div></div>' +
            '<div><div><span><br></span></div></div><div><div><span>Two.</span></div></div></div>',
        ),
      ),
    ).toEqual(['One.', '', 'Two.']);
    // Empty lines at either end aren't between paragraphs.
    expect(linesIn(box('<p><br></p><p>One.</p><p>\u200b</p>'))).toEqual(['One.']);
  });

  it('says when the box lost the blank lines the words have', () => {
    expect(lostBlankLines(box('<p>One.</p><p>Two.</p>'), 'One.\n\nTwo.')).toBe(true);
    expect(lostBlankLines(box('<p>One.</p><p><br></p><p>Two.</p>'), 'One.\n\nTwo.')).toBe(false);
    // Words with no blank line lose none.
    expect(lostBlankLines(box('<p>One.</p><p>Two.</p>'), 'One.\nTwo.')).toBe(false);
  });
});
