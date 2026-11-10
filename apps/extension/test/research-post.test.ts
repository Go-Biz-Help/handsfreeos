/**
 * AI Social Media Content Creator putting the business's own OK'd posts up (src/research/post-here.ts; part 9): on
 * made-up pages shaped like Facebook's box over its feed, Business Suite's Create post and LinkedIn's box, it types the
 * words, adds the pictures the ways a person can, presses Next when asked, then Post; never twice, never over the
 * person's own writing. And a Page's number, from its page.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { pageIdHere, postHere, type PostAsk } from '../src/research/post-here';
import { failureFor } from '../src/research/posting';

vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
// The hands wait as a page would (a few seconds for a link to show); the tests wait with them.
vi.setConfig({ testTimeout: 60_000 });

const PICTURE = { name: 'post.png', type: 'image/png', base64: btoa('png bytes') };

/** A stand-in for Chrome's DataTransfer, which jsdom doesn't have: it holds the files given to it. */
class FakeTransfer {
  readonly list: File[] = [];
  readonly items = { add: (f: File) => this.list.push(f) };
  get files() {
    return this.list;
  }
}

interface Made {
  doc: Document;
  posted: string[];
  pictures: () => number;
}

/**
 * A page with a box to start a post that opens a box over the page. `field`: the box has its own file field (else
 * only a photo button that asks for one); `next`: Post shows only after Next; `after`: what Post does.
 */
function page(
  url: string,
  start: string,
  opts: { field?: boolean; next?: boolean; after?: 'close' | 'stay'; written?: string } = {},
): Made {
  const { window } = new JSDOM(
    `<body><div role="main"><div role="button" id="start">${start}</div></div></body>`,
    { url },
  );
  const doc = window.document;
  (window as unknown as { DataTransfer: unknown }).DataTransfer = FakeTransfer;
  const posted: string[] = [];
  const withPictures: number[] = [];
  doc.getElementById('start')!.addEventListener('click', () => {
    const box = doc.createElement('div');
    box.setAttribute('role', 'dialog');
    box.innerHTML = `
      <div role="textbox" contenteditable="true" id="words">${opts.written ?? ''}</div>
      <div id="media"></div>
      ${opts.field ? '<input type="file" accept="image/*,video/*" id="field">' : ''}
      <div role="button" aria-label="Photo/video" id="photo"></div>
      <div role="button" id="go">${opts.next ? 'Next' : 'Post'}</div>`;
    doc.body.append(box);
    const words = box.querySelector('#words')!;
    doc.execCommand = (_c: string, _u?: boolean, text?: string) => {
      words.textContent = text ?? '';
      return true;
    };
    const took = () => {
      const img = doc.createElement('img');
      img.setAttribute('src', 'blob:https://example/1');
      box.querySelector('#media')!.append(img);
    };
    box.querySelector('#field')?.addEventListener('change', took);
    // The photo button asks for a file field, as a page does: held back, it's marked for the hands.
    box.querySelector('#photo')!.addEventListener('click', () => {
      const input = doc.createElement('input');
      input.type = 'file';
      input.setAttribute('data-hfos-picked', '1');
      input.addEventListener('change', took);
      doc.body.append(input);
    });
    const go = box.querySelector('#go')!;
    go.addEventListener('click', () => {
      if (go.textContent === 'Next') {
        go.textContent = 'Post';
        return;
      }
      posted.push(words.textContent ?? '');
      withPictures.push(box.querySelectorAll('img[src^="blob:"]').length);
      if (opts.after !== 'stay') box.remove();
    });
  });
  return { doc, posted, pictures: () => withPictures.at(-1) ?? 0 };
}

const ask = (where: PostAsk['where'], files = [PICTURE]): PostAsk => ({
  where,
  text: 'Three ways to save time.\n\n#crm',
  files,
});

describe('putting one of the business’s posts up', () => {
  it('types the words, adds the picture with the box’s own field, and presses Post', async () => {
    const made = page('https://www.facebook.com/', 'What’s on your mind, Sam?', { field: true });
    const done = await postHere(made.doc, ask('facebook'));
    expect(done.result).toBe('done');
    expect(done.pressed).toBe(true);
    expect(made.posted).toEqual(['Three ways to save time.\n\n#crm']);
    expect(made.pictures()).toBe(1);
    expect(done.steps).toEqual(expect.arrayContaining(['start', 'typed', 'media:field', 'post']));
  });

  it('asks the photo button for a field when the box has none, and presses Next before Post', async () => {
    const made = page('https://www.linkedin.com/feed/', 'Start a post', { next: true });
    const done = await postHere(made.doc, ask('linkedin'));
    expect(done.result).toBe('done');
    expect(done.steps).toEqual(expect.arrayContaining(['media:button', 'media:asked', 'next']));
    expect(made.posted).toHaveLength(1);
  });

  it('posts words alone without looking for pictures', async () => {
    const made = page('https://www.linkedin.com/feed/', 'Start a post');
    const done = await postHere(made.doc, ask('linkedin', []));
    expect(done.result).toBe('done');
    expect(done.steps.some((s) => s.startsWith('media'))).toBe(false);
  });

  it('leaves the person’s own writing alone, and says when there’s no box', async () => {
    const mine = page('https://www.facebook.com/', 'What’s on your mind?', { written: 'my draft' });
    expect((await postHere(mine.doc, ask('facebook'))).result).toBe('not_sent');
    expect(mine.posted).toEqual([]);
    const none = page('https://www.facebook.com/', 'Something else');
    expect((await postHere(none.doc, ask('facebook'))).result).toBe('none');
  });

  it('says it pressed Post when the box never closed, so it isn’t pressed again', async () => {
    const made = page('https://www.facebook.com/', 'What’s on your mind?', {
      field: true,
      after: 'stay',
    });
    const going = postHere(made.doc, ask('facebook'));
    await vi.advanceTimersByTimeAsync(40_000);
    const done = await going;
    expect(done).toMatchObject({ result: 'not_sent', pressed: true });
    expect(failureFor('facebook', 'profile', done)).toMatch(/pressed Post on your profile/);
  });
});

describe('a Facebook Page’s number', () => {
  it('comes from the link, the page’s app links, or its own data', () => {
    const at = (html: string, url: string) => new JSDOM(html, { url }).window.document;
    expect(
      pageIdHere(
        at('', 'https://www.facebook.com/profile.php?id=61550000000001'),
        'https://www.facebook.com/profile.php?id=61550000000001',
      ),
    ).toBe('61550000000001');
    expect(
      pageIdHere(
        at(
          '<head><meta property="al:android:url" content="fb://profile/100064000000002"></head>',
          'https://www.facebook.com/example',
        ),
        'https://www.facebook.com/example',
      ),
    ).toBe('100064000000002');
    expect(
      pageIdHere(
        at('<script>{"pageID":"123456789012"}</script>', 'https://www.facebook.com/example'),
        'https://www.facebook.com/example',
      ),
    ).toBe('123456789012');
    expect(
      pageIdHere(at('', 'https://www.facebook.com/example'), 'https://www.facebook.com/example'),
    ).toBeNull();
  });
});
