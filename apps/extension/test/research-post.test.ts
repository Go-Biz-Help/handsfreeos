/**
 * AI Social Media Content Creator putting the business's own OK'd posts up (src/research/post-here.ts; part 9): on
 * made-up pages shaped like Facebook's box over its feed, Business Suite's Create post and LinkedIn's box, it types the
 * words, adds the pictures the ways a person can, presses Next when asked, then Post; never twice, never over the
 * person's own writing. And a Page's number, from its page.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { instagramMe, pageIdsHere, postHere, type PostAsk } from '../src/research/post-here';
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

/**
 * LinkedIn's newer box: Add media opens a window of its own over it, with a place to drop pictures and Upload from
 * computer (which asks for a file field), then Next back to the box with the pictures. `drop`: the window takes only
 * what's dropped on it.
 */
function linkedin(opts: { drop?: boolean } = {}) {
  const made = page('https://www.linkedin.com/feed/', 'Start a post');
  const { doc } = made;
  const win = doc.defaultView as unknown as { DragEvent: unknown; Event: typeof Event };
  // jsdom has no DragEvent: this one carries its files as Chrome's does.
  win.DragEvent = class extends win.Event {
    readonly dataTransfer: FakeTransfer | null;
    constructor(type: string, init: EventInit & { dataTransfer?: FakeTransfer } = {}) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  };
  doc.getElementById('start')!.addEventListener('click', () => {
    const box = doc.querySelector('[role="dialog"]')!;
    box.setAttribute('data-testid', 'dialog');
    // The newer box has no file field, and pasting and dropping on it do nothing.
    const photo = box.querySelector('#photo')!;
    const media = photo.cloneNode() as HTMLElement;
    media.setAttribute('aria-label', 'Add media');
    photo.replaceWith(media);
    media.addEventListener('click', () => {
      const window = doc.createElement('div');
      window.setAttribute('role', 'dialog');
      window.setAttribute('data-testid', 'dialog');
      window.innerHTML = `<h2>Editor</h2>
        <div role="region" data-testid="add-media-drop-zone">
          <h2>Select files to begin</h2><div>Share images or a single video in your post.</div>
          <button type="button" id="upload"><span>Upload from computer</span></button>
        </div>
        <button type="button">Back</button><button type="button" id="next" disabled>Next</button>`;
      doc.body.append(window);
      const took = (count: number) => {
        window.querySelector('[data-testid="add-media-drop-zone"]')!.remove();
        for (let i = 0; i < count; i++) {
          const img = doc.createElement('img');
          img.setAttribute('src', 'blob:https://www.linkedin.com/2');
          window.prepend(img);
        }
        window.querySelector('#next')!.removeAttribute('disabled');
      };
      window.querySelector('#upload')!.addEventListener('click', () => {
        if (opts.drop) return;
        const input = doc.createElement('input');
        input.type = 'file';
        input.setAttribute('data-hfos-picked', '1');
        input.addEventListener('change', () => took(1));
        doc.body.append(input);
      });
      window
        .querySelector('[data-testid="add-media-drop-zone"]')!
        .addEventListener('drop', (e) =>
          took((e as unknown as { dataTransfer: FakeTransfer }).dataTransfer.files.length),
        );
      window.querySelector('#next')!.addEventListener('click', () => {
        const pictures = window.querySelectorAll('img');
        window.remove();
        box.querySelector('#media')!.append(...pictures);
      });
    });
  });
  return made;
}

describe('putting a post up in LinkedIn’s newer box', () => {
  it('adds the pictures in its own window with Upload from computer, presses Next, then Post', async () => {
    const li = linkedin();
    const done = await postHere(li.doc, ask('linkedin'));
    expect(done).toMatchObject({ result: 'done', pressed: true });
    expect(done.steps).toEqual(
      expect.arrayContaining(['media:button', 'window:upload', 'window:field', 'window:next']),
    );
    expect(li.posted).toEqual(['Three ways to save time.\n\n#crm']);
    expect(li.pictures()).toBe(1);
  });

  it('drops them on the window when its button asks for no file field', async () => {
    const li = linkedin({ drop: true });
    const done = await postHere(li.doc, ask('linkedin'));
    expect(done.result).toBe('done');
    expect(done.steps).toEqual(expect.arrayContaining(['window:drop', 'window:next']));
    expect(li.pictures()).toBe(1);
  });
});

const VIDEO = { name: 'reel.mp4', type: 'video/mp4', base64: btoa('mp4 bytes') };

/**
 * A page shaped like Instagram's home: Create in its side menu opens a small menu (Post, AI), Post opens Create new
 * post with its file field; the files lead to a note about reels (a video), cropping and editing, each with Next, then
 * the caption box and Share. `menu`: whether Create asks which kind first.
 */
function instagram(opts: { menu?: boolean | 'hidden'; written?: string; fails?: boolean } = {}) {
  const { window } = new JSDOM(
    `<body>
      <div role="navigation">
        <a href="#" role="link" id="create"><svg aria-label="New post"></svg><span>Create</span></a>
        <a href="/sam.business/" role="link"><img alt="sam.business's profile picture"><span>Profile</span></a>
      </div>
      <div role="main"><article>A friend’s post <div role="button" id="comment-post">Post</div></article></div>
    </body>`,
    { url: 'https://www.instagram.com/' },
  );
  const doc = window.document;
  (window as unknown as { DataTransfer: unknown }).DataTransfer = FakeTransfer;
  const shared: { text: string; files: string[] }[] = [];
  let commentPressed = false;
  doc.getElementById('comment-post')!.addEventListener('click', () => {
    commentPressed = true;
  });
  const dialog = () => {
    const box = doc.createElement('div');
    box.setAttribute('role', 'dialog');
    box.innerHTML = `<h1>Create new post</h1><div role="presentation">Drag photos and videos here</div>
      <button>Select from computer</button>
      <form><input type="file" multiple accept="image/jpeg,image/png,image/heic,image/heif,video/mp4,video/quicktime"></form>`;
    doc.body.append(box);
    const input = box.querySelector('input')!;
    // jsdom's file field takes only its own lists: this one keeps what it's given, as Chrome's does.
    let given: File[] = [];
    Object.defineProperty(input, 'files', {
      get: () => given,
      set: (list: File[]) => {
        given = [...list];
      },
    });
    input.addEventListener('change', () => {
      const files = given;
      const step = (header: string, then: () => void) => {
        box.innerHTML = `<h1>${header}</h1><img src="blob:https://www.instagram.com/1"><div role="button" id="next">Next</div>`;
        box.querySelector('#next')!.addEventListener('click', then);
      };
      const caption = () => {
        box.innerHTML = `<h1>Create new post</h1>
          <div role="textbox" contenteditable="true" aria-label="Write a caption..." id="caption">${opts.written ?? ''}</div>
          <div role="button" id="share">Share</div>`;
        const words = box.querySelector('#caption')!;
        doc.execCommand = (_c: string, _u?: boolean, text?: string) => {
          words.textContent = text ?? '';
          return true;
        };
        box.querySelector('#share')!.addEventListener('click', () => {
          shared.push({ text: words.textContent ?? '', files: files.map((f) => f.type) });
          box.innerHTML = '<h1>Sharing</h1>';
          setTimeout(() => {
            box.innerHTML = opts.fails
              ? '<h1>Post couldn’t be shared</h1><p>Your post could not be shared. Please try again.</p>'
              : '<h1>Post shared</h1><p>Your post has been shared.</p><div role="button" aria-label="Close"></div>';
          }, 1_000);
        });
      };
      const crop = () => step('Crop', () => step('Edit', caption));
      if (files.some((f) => f.type.startsWith('video/'))) {
        const note = doc.createElement('div');
        note.setAttribute('role', 'dialog');
        note.innerHTML = `<p>Video posts are now shared as reels</p><button id="ok">OK</button>`;
        doc.body.append(note);
        note.querySelector('#ok')!.addEventListener('click', () => {
          note.remove();
          crop();
        });
      } else crop();
    });
  };
  if (opts.menu === 'hidden') {
    // Instagram's own: on the page from the start, hidden till Create is pressed, its icons titled as they read.
    const menu = doc.createElement('div');
    menu.setAttribute('aria-hidden', 'true');
    menu.innerHTML = `<a href="#" role="link" id="kind"><svg aria-label="Post"><title>Post</title></svg><span>Post</span></a>
      <a href="#" role="link"><svg aria-label="AI"><title>AI</title></svg><span>AI</span></a>`;
    doc.querySelector('[role="navigation"]')!.append(menu);
    menu.querySelector('#kind')!.addEventListener('click', () => {
      menu.setAttribute('aria-hidden', 'true');
      dialog();
    });
    doc
      .getElementById('create')!
      .addEventListener('click', () => menu.setAttribute('aria-hidden', 'false'));
    return { doc, shared, commentPressed: () => commentPressed };
  }
  doc.getElementById('create')!.addEventListener('click', () => {
    if (!opts.menu) return dialog();
    const menu = doc.createElement('div');
    menu.innerHTML = `<a href="#" role="link" id="kind"><svg aria-label="Post"></svg><span>Post</span></a><a href="#" role="link">AI</a>`;
    doc.querySelector('[role="navigation"]')!.append(menu);
    menu.querySelector('#kind')!.addEventListener('click', () => {
      menu.remove();
      dialog();
    });
  });
  return { doc, shared, commentPressed: () => commentPressed };
}

describe('putting one of the business’s posts up on Instagram (part 10)', () => {
  it('picks Post from Create’s menu, adds the picture, presses Next twice, writes the caption and shares', async () => {
    const ig = instagram({ menu: true });
    const done = await postHere(ig.doc, ask('instagram'));
    expect(done).toMatchObject({ result: 'done', pressed: true });
    expect(ig.shared).toEqual([{ text: 'Three ways to save time.\n\n#crm', files: ['image/png'] }]);
    expect(ig.commentPressed()).toBe(false);
    expect(done.steps).toEqual(
      expect.arrayContaining(['start', 'kind', 'media:field', 'next', 'typed', 'post']),
    );
    expect(done.steps.filter((s) => s === 'next')).toHaveLength(2);
  });

  it('picks Post from a menu that was on the page all along, hidden, with icons titled Post', async () => {
    const ig = instagram({ menu: 'hidden' });
    const done = await postHere(ig.doc, ask('instagram'));
    expect(done).toMatchObject({ result: 'done', pressed: true });
    expect(done.steps).toEqual(expect.arrayContaining(['start', 'kind', 'media:field', 'post']));
    expect(ig.shared).toHaveLength(1);
    expect(ig.commentPressed()).toBe(false);
  });

  it('presses OK when Instagram says a video goes up as a reel', async () => {
    const ig = instagram();
    const done = await postHere(ig.doc, ask('instagram', [VIDEO]));
    expect(done.result).toBe('done');
    expect(done.steps).toContain('reel:ok');
    expect(ig.shared[0]!.files).toEqual(['video/mp4']);
  });

  it('leaves a caption someone started alone, and says when Instagram didn’t take it', async () => {
    const mine = instagram({ written: 'my words' });
    expect(await postHere(mine.doc, ask('instagram'))).toMatchObject({
      result: 'not_sent',
      pressed: false,
    });
    expect(mine.shared).toEqual([]);
    const failed = instagram({ fails: true });
    expect(await postHere(failed.doc, ask('instagram'))).toMatchObject({
      result: 'not_sent',
      pressed: true,
    });
  });

  it('knows whose Instagram it is from the Profile link', () => {
    expect(instagramMe(instagram().doc)).toBe('sam.business');
    expect(
      failureFor(
        'instagram',
        'feed',
        { result: 'no_media', pressed: false, url: null, steps: [] },
        true,
      ),
    ).toMatch(/didn’t take its video on your Instagram/);
  });
});

describe('a Facebook Page’s numbers', () => {
  const at = (html: string, url: string) => new JSDOM(html, { url }).window.document;
  it('come from the link, the page’s app links, or its own data', () => {
    const link = 'https://www.facebook.com/profile.php?id=61550000000001';
    expect(pageIdsHere(at('', link), link)).toEqual(['61550000000001']);
    expect(
      pageIdsHere(
        at(
          '<head><meta property="al:android:url" content="fb://profile/100064000000002"></head>',
          'https://www.facebook.com/example',
        ),
        'https://www.facebook.com/example',
      ),
    ).toEqual(['100064000000002']);
    expect(
      pageIdsHere(
        at('<script>{"pageID":"123456789012"}</script>', 'https://www.facebook.com/example'),
        'https://www.facebook.com/example',
      ),
    ).toEqual(['123456789012']);
    expect(
      pageIdsHere(at('', 'https://www.facebook.com/example'), 'https://www.facebook.com/example'),
    ).toEqual([]);
  });

  it('put a newer Page’s own number before the one in its link, once each', () => {
    const link = 'https://www.facebook.com/profile.php?id=61550000000001';
    const doc = at(
      `<head><meta property="al:android:url" content="fb://profile/61550000000001"></head>
      <script>{"delegate_page":{"is_business_page_active":true,"id":"109876543210987"},"page_id":"55555555555"}</script>`,
      link,
    );
    expect(pageIdsHere(doc, link)).toEqual(['109876543210987', '61550000000001', '55555555555']);
  });
});
