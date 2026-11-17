/**
 * AI Social Media Content Creator putting the business's own OK'd posts up on Threads and X (src/research/post-short.ts;
 * decision 41): on made-up pages shaped like X's box over its compose page and Threads' box over its feed, it types the
 * first post, adds its picture, adds each post of its chain in a box of its own, then presses Post once, and finds the
 * link in the note the network shows. Never over the person's own writing.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { postHere, type PostAsk } from '../src/research/post-here';
import { threadsPostedLink, xSentLink } from '../src/research/post-short';

vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
vi.setConfig({ testTimeout: 60_000 });

const PICTURE = { name: 'post.png', type: 'image/png', base64: btoa('png bytes') };

class FakeTransfer {
  readonly list: File[] = [];
  readonly items = { add: (f: File) => this.list.push(f) };
  get files() {
    return this.list;
  }
}

interface Made {
  doc: Document;
  /** Each press of Post: the words of each box, in order, and how many pictures it had. */
  posted: { words: string[]; pictures: number }[];
}

/** Typing goes where the focus is, as Chrome's does. */
function typing(doc: Document): void {
  doc.execCommand = (command: string, _u?: boolean, text?: string) => {
    const at = doc.activeElement as HTMLElement | null;
    if (command === 'insertText' && at && at !== doc.body) at.textContent = text ?? '';
    return true;
  };
}

/** X's compose page: its box over the page with test ids, Add post, and Post (Post all with a chain). */
function xPage(opts: { written?: string; postOff?: boolean } = {}): Made {
  const { window } = new JSDOM(
    `<body><div role="main"></div>
      <div role="dialog" id="composer">
        <div id="boxes">
          <div data-testid="tweetTextarea_0"><div role="textbox" contenteditable="true" tabindex="0">${opts.written ?? ''}</div></div>
        </div>
        <div id="media"></div>
        <input type="file" data-testid="fileInput" accept="image/*,video/*">
        <button data-testid="addButton" aria-label="Add post">+</button>
        <button data-testid="tweetButton" ${opts.postOff ? 'aria-disabled="true"' : ''}>Post</button>
      </div></body>`,
    { url: 'https://x.com/compose/post' },
  );
  const doc = window.document;
  (window as unknown as { DataTransfer: unknown }).DataTransfer = FakeTransfer;
  typing(doc);
  const posted: Made['posted'] = [];
  const composer = doc.getElementById('composer')!;
  composer.querySelector('input[type="file"]')!.addEventListener('change', () => {
    const img = doc.createElement('img');
    img.setAttribute('src', 'blob:https://x.com/1');
    composer.querySelector('#media')!.append(img);
  });
  composer.querySelector('[data-testid="addButton"]')!.addEventListener('click', () => {
    const n = composer.querySelectorAll('[data-testid^="tweetTextarea_"]').length;
    const part = doc.createElement('div');
    part.setAttribute('data-testid', `tweetTextarea_${n}`);
    part.innerHTML = '<div role="textbox" contenteditable="true" tabindex="0"></div>';
    composer.querySelector('#boxes')!.append(part);
    composer.querySelector('[data-testid="tweetButton"]')!.textContent = 'Post all';
  });
  composer.querySelector('[data-testid="tweetButton"]')!.addEventListener('click', () => {
    posted.push({
      words: [...composer.querySelectorAll('[role="textbox"]')].map((b) => b.textContent ?? ''),
      pictures: composer.querySelectorAll('img[src^="blob:"]').length,
    });
    composer.remove();
    const toast = doc.createElement('div');
    toast.setAttribute('data-testid', 'toast');
    toast.setAttribute('role', 'alert');
    toast.innerHTML =
      'Your post was sent. <a href="/samsplumbing/status/1850000000000000001">View</a>';
    doc.body.append(toast);
  });
  return { doc, posted };
}

/**
 * Threads' home page: "What's new?" opens its box over the page, with Add to thread and Post. With `menu`, as Threads
 * drew it on 16 Nov 2026: the feed's own box is named by a label that isn't its words, so Create at the page's foot
 * opens the New thread box, drawn as a menu, while a More menu with no box to write in is open beside it.
 */
function threadsPage(opts: { menu?: boolean; newThread?: 'feed' | 'side' } = {}): Made {
  const feedBox = (id: string) =>
    `<div role="button" ${id} aria-label="Empty text field. Type to compose a new post."><span>What’s new?</span></div>`;
  const { window } = new JSDOM(
    opts.menu
      ? `<body><div role="main">${feedBox('')}</div>
        <div role="button" id="start" aria-expanded="false"><svg role="img"><title>Create</title></svg></div></body>`
      : opts.newThread
        ? // As Threads drew it on 17 Nov 2026: New thread in its side menu, and no Create. With `side` the feed's box
          // opens nothing, and New thread opens the box.
          `<body><div role="navigation">
            <div role="button" ${opts.newThread === 'side' ? 'id="start"' : ''}><svg></svg><div>New thread</div></div>
          </div>
          <div role="main">${feedBox(opts.newThread === 'feed' ? 'id="start"' : '')}</div></body>`
        : `<body><div role="main"><div role="button" id="start">What’s new?</div></div></body>`,
    { url: 'https://www.threads.com/' },
  );
  const doc = window.document;
  (window as unknown as { DataTransfer: unknown }).DataTransfer = FakeTransfer;
  typing(doc);
  const posted: Made['posted'] = [];
  doc.getElementById('start')!.addEventListener('click', () => {
    const box = doc.createElement('div');
    box.setAttribute('role', opts.menu ? 'menu' : 'dialog');
    if (opts.menu) {
      const more = doc.createElement('div');
      more.setAttribute('role', 'menu');
      more.innerHTML = '<div role="menuitem">Mute</div><div role="menuitem">Report</div>';
      doc.body.append(box, more);
    }
    box.innerHTML = `
      <h1>New thread</h1>
      <div id="boxes"><div role="textbox" contenteditable="true" tabindex="0"></div></div>
      <div id="media"></div>
      <input type="file" accept="image/*,video/*">
      <div role="button" id="add">Add to thread</div>
      <div role="button" id="post">Post</div>`;
    if (!opts.menu) doc.body.append(box);
    box.querySelector('input[type="file"]')!.addEventListener('change', () => {
      const img = doc.createElement('img');
      img.setAttribute('src', 'blob:https://www.threads.com/1');
      box.querySelector('#media')!.append(img);
    });
    box.querySelector('#add')!.addEventListener('click', () => {
      const next = doc.createElement('div');
      next.setAttribute('role', 'textbox');
      next.setAttribute('contenteditable', 'true');
      next.setAttribute('tabindex', '0');
      box.querySelector('#boxes')!.append(next);
    });
    box.querySelector('#post')!.addEventListener('click', () => {
      posted.push({
        words: [...box.querySelectorAll('[role="textbox"]')].map((b) => b.textContent ?? ''),
        pictures: box.querySelectorAll('img[src^="blob:"]').length,
      });
      box.remove();
      const note = doc.createElement('div');
      note.innerHTML = '<span>Posted</span> <a href="/@samsplumbing/post/DAbc123xyz">View</a>';
      doc.body.append(note);
    });
  });
  return { doc, posted };
}

const ask = (where: PostAsk['where'], chain: string[] = [], files = [PICTURE]): PostAsk => ({
  where,
  text: 'Missed calls are missed jobs. #smallbusiness',
  files,
  chain,
});

describe('putting one of the business’s posts up on X (decision 41)', () => {
  it('types the post, adds its picture, adds each post of the chain, and presses Post all once', async () => {
    const made = xPage();
    const done = await postHere(
      made.doc,
      ask('x', ['Step one: answer fast.', 'Step two: follow up.']),
    );
    expect(done.result).toBe('done');
    expect(done.pressed).toBe(true);
    expect(made.posted).toEqual([
      {
        words: [
          'Missed calls are missed jobs. #smallbusiness',
          'Step one: answer fast.',
          'Step two: follow up.',
        ],
        pictures: 1,
      },
    ]);
    expect(done.url).toBe('https://x.com/samsplumbing/status/1850000000000000001');
    expect(done.steps).toEqual(
      expect.arrayContaining(['box', 'typed', 'media', 'chain:1', 'chain:2', 'post']),
    );
  });

  it('posts words alone, and leaves the person’s own writing alone', async () => {
    const plain = xPage();
    expect((await postHere(plain.doc, ask('x', [], []))).result).toBe('done');
    expect(plain.posted[0]!.pictures).toBe(0);
    const mine = xPage({ written: 'my draft' });
    expect((await postHere(mine.doc, ask('x'))).result).toBe('not_sent');
    expect(mine.posted).toEqual([]);
  });

  it('never presses a Post that X keeps off (too long), and says it didn’t go', async () => {
    const made = xPage({ postOff: true });
    const done = await postHere(made.doc, ask('x', [], []));
    expect(done).toMatchObject({ result: 'not_sent', pressed: false });
    expect(made.posted).toEqual([]);
  });

  it('finds the link in X’s note that the post was sent', () => {
    const { window } = new JSDOM(
      '<body><div data-testid="toast" role="alert">Your post was sent. <a href="/sam/status/42">View</a></div></body>',
      { url: 'https://x.com/home' },
    );
    expect(xSentLink(window.document)).toBe('https://x.com/sam/status/42');
  });
});

describe('putting one of the business’s posts up on Threads (decision 41)', () => {
  it('opens its box from What’s new?, adds the picture and the chain, and presses Post once', async () => {
    const made = threadsPage();
    const done = await postHere(made.doc, ask('threads', ['More on it here.']));
    expect(done.result).toBe('done');
    expect(made.posted).toEqual([
      { words: ['Missed calls are missed jobs. #smallbusiness', 'More on it here.'], pictures: 1 },
    ]);
    expect(done.url).toBe('https://www.threads.com/@samsplumbing/post/DAbc123xyz');
    expect(done.steps).toEqual(
      expect.arrayContaining(['start', 'box', 'typed', 'media', 'chain:1', 'post']),
    );
  });

  it('finds the New thread box Threads draws as a menu from Create, not the More menu beside it', async () => {
    // The owner's problem reports of 16 Nov 2026 (19:54 and 23:19 UTC, 0.142.0): Create opened the box, which Threads
    // now draws as a menu, and the post stopped at "didn’t show the box to write a post".
    const made = threadsPage({ menu: true });
    const done = await postHere(made.doc, ask('threads', ['More on it here.']));
    expect(done.result).toBe('done');
    expect(made.posted).toEqual([
      { words: ['Missed calls are missed jobs. #smallbusiness', 'More on it here.'], pictures: 1 },
    ]);
    expect(done.url).toBe('https://www.threads.com/@samsplumbing/post/DAbc123xyz');
    expect(done.steps).toEqual(
      expect.arrayContaining(['start', 'box', 'typed', 'media', 'chain:1', 'post']),
    );
  });

  it('opens the box from the feed’s What’s new? when its label says otherwise, with New thread in place of Create', async () => {
    // The owner's problem reports of 17 Nov 2026 (05:38 and 05:44 UTC, 0.147.4): Threads showed New thread where Create
    // was, and the feed's box is labelled "Empty text field…", so nothing was pressed and no box opened.
    const made = threadsPage({ newThread: 'feed' });
    const done = await postHere(made.doc, ask('threads'));
    expect(done.result).toBe('done');
    expect(made.posted).toEqual([
      { words: ['Missed calls are missed jobs. #smallbusiness'], pictures: 1 },
    ]);
    expect(done.steps.filter((step) => step === 'start')).toHaveLength(1);
  });

  it('presses New thread when the feed’s box opens nothing to write in', async () => {
    const made = threadsPage({ newThread: 'side' });
    const done = await postHere(made.doc, ask('threads', ['More on it here.']));
    expect(done.result).toBe('done');
    expect(made.posted).toEqual([
      { words: ['Missed calls are missed jobs. #smallbusiness', 'More on it here.'], pictures: 1 },
    ]);
    expect(done.steps.filter((step) => step === 'start')).toHaveLength(2);
  });

  it('says when there’s no box to write in', async () => {
    const { window } = new JSDOM('<body><div role="main">Nothing here</div></body>', {
      url: 'https://www.threads.com/',
    });
    expect((await postHere(window.document, ask('threads'))).result).toBe('none');
    expect(threadsPostedLink(window.document)).toBeNull();
  });
});
