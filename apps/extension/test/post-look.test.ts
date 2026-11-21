/**
 * A look at a post before its comment is drafted (docs/outreach.md, decision 166; src/networks/post-look.ts in the
 * tab, src/auto/post-look.ts in the background): which picture on the page is the post's, a photo handed over as its
 * address and fetched only from the network's own picture servers, a video's frames drawn from the page's own player
 * and its poster or cover when none can be, and nothing at all rather than a wrong picture. On a post written here by
 * hand from Instagram's usual markup, with made-up people; the drawing and the fetching are stood in for.
 */
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST_PICTURE_CHARS } from '@hfos/core/addons/outreach/comment-says';
import { PostLook } from '@hfos/core/addons/outreach/today';
import { PLATFORM_KEYS, type Platform } from '@hfos/core/addons/outreach/networks';
import { LOOK_WANT, lookAtPost, looksAtPosts, pictureFrom } from '../src/auto/post-look';
import type { PostLookAnswer, PostLookAsk } from '../src/messages';
import { INSTAGRAM } from '../src/networks/instagram/site';
import type { CommentOn } from '../src/networks/looking/site';
import { postMediaIn, seePost, type Frame, type FrameDrawer } from '../src/networks/post-look';

const IG = 'https://www.instagram.com';
const CDN = 'https://scontent-dfw5-1.cdninstagram.com/v/t51.2885-15';
const ON: CommentOn = {
  profile: { id: null, username: 'dana.reyes', url: `${IG}/dana.reyes/` },
  postUrl: `${IG}/p/C3xyzabcd/`,
};
const JPEG = `/9j/${'A'.repeat(5_000)}`;
const jpegOf = (n: number) => `/9j/${String(n).repeat(5_000)}`;

/**
 * The post's own page: who wrote it (a small face beside the name), what it shows (`media`), a comment with its
 * writer's face, the post's own link, and under the post the tiles of "More posts from", each a link to another post.
 */
const postPage = ({
  path = '/p/C3xyzabcd/',
  by = 'dana.reyes',
  media = `<div role="button"><img alt="Photo by Dana Reyes" width="468" height="585" src="${CDN}/photo.jpg?sig=1"></div>`,
  tiles = true,
} = {}) =>
  new JSDOM(
    `<!doctype html><html><body><main role="main"><article>
      <div><img alt="dana.reyes’s profile picture" width="32" height="32" src="${CDN}/face.jpg">
        <a role="link" href="/${by}/"><span dir="auto">${by}</span></a></div>
      <div id="media">${media}</div>
      <div><img alt="sam.lee’s profile picture" width="32" height="32" src="${CDN}/sam.jpg">
        <a role="link" href="/p/C3xyzabcd/c/17900000000000001/"><time>2w</time></a><span>Looks great!</span></div>
      <div dir="auto"><a role="link" href="/${by}/p/C3xyzabcd/"><time>October 1</time></a></div>
      ${
        tiles
          ? `<div id="more"><a href="/dana.reyes/p/C1other111/"><img width="600" height="600" src="${CDN}/other1.jpg"></a>
        <a href="/p/C2other222/"><img width="600" height="600" src="${CDN}/other2.jpg"></a></div>`
          : ''
      }
    </article></main></body></html>`,
    { url: `${IG}${path}` },
  ).window.document;

const part = (doc: Document, on: CommentOn = ON, href = doc.location.href) =>
  INSTAGRAM.auto!.postPart!(doc, href, on);

/** A player the page drew, with a length and a moment it's at; moving it says so, as a real one does. */
function player(doc: Document, { length = 20, at = 1, poster = '' as string, ready = true } = {}) {
  const video = doc.createElement('video');
  video.setAttribute('width', '468');
  video.setAttribute('height', '832');
  if (poster) video.setAttribute('poster', poster);
  let now = at;
  const moves: number[] = [];
  Object.defineProperties(video, {
    duration: { get: () => length },
    paused: { get: () => true },
    readyState: { get: () => (ready ? 4 : 0) },
    currentTime: {
      get: () => now,
      set: (to: number) => {
        now = to;
        moves.push(to);
        queueMicrotask(() => video.dispatchEvent(new doc.defaultView!.Event('seeked')));
      },
    },
  });
  return { video, moves, at: () => now };
}

/** Draws a different frame at each moment, as `frames` says: a JPEG named by the moment, or why there's none. */
const drawing =
  (frames: (at: number) => Frame = (at) => ({ jpeg: jpegOf(Math.round(at)) })): FrameDrawer =>
  (video) =>
    frames(video.currentTime);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('which picture on the page is the post’s', () => {
  it('is the big one in the post’s own part: never a face beside a name, never a tile that opens another post', () => {
    const doc = postPage();
    const found = part(doc)!;
    expect(found.root.tagName).toBe('ARTICLE');
    expect(postMediaIn(found.root, found.skip)?.getAttribute('src')).toBe(`${CDN}/photo.jpg?sig=1`);
    // Without the site's rule the tiles under the post are bigger: the rule is what keeps them out.
    expect(postMediaIn(found.root, () => false)?.getAttribute('src')).toBe(`${CDN}/other1.jpg`);
    // A post of words only has no picture: none, rather than someone else's.
    const words = postPage({ media: '<h1>Big news coming Friday</h1>' });
    const none = part(words)!;
    expect(postMediaIn(none.root, none.skip)).toBeNull();
  });

  it('is its video before the cover drawn over it, and the first of several to swipe through', () => {
    const video = postPage({
      media: `<img width="468" height="832" src="${CDN}/cover.jpg"><video width="468" height="832"></video>`,
    });
    const found = part(video)!;
    expect(postMediaIn(found.root, found.skip)?.tagName).toBe('VIDEO');
    const several = postPage({
      media: `<ul><li><img width="468" height="585" src="${CDN}/one.jpg"></li>
        <li><img width="468" height="585" src="${CDN}/two.jpg"></li></ul>`,
    });
    const first = part(several)!;
    expect(postMediaIn(first.root, first.skip)?.getAttribute('src')).toBe(`${CDN}/one.jpg`);
  });

  it('is given only on the post asked for, on its own page, when its own link names them', () => {
    expect(part(postPage())).not.toBeNull();
    expect(part(postPage({ path: '/dana.reyes/p/C3xyzabcd/' }))).not.toBeNull();
    // Another post's page, someone else's post, their profile, or a post asked for by another address.
    expect(part(postPage({ path: '/p/C9zzzzzzz/' }))).toBeNull();
    expect(part(postPage({ by: 'kim_bakes' }))).toBeNull();
    expect(part(postPage({ path: '/dana.reyes/' }))).toBeNull();
    expect(part(postPage(), { ...ON, postUrl: `${IG}/p/C9zzzzzzz/` })).toBeNull();
    expect(part(postPage(), { ...ON, postUrl: 'https://example.com/p/C3xyzabcd/' })).toBeNull();
  });

  // The owner's problem report of 15 Nov 2026 (23:29 UTC): a comment's draft on a reel opened the reels player
  // (/reels/<code>/), which draws the reel and the next one under it with no article and no link to the reel itself,
  // so no part was given, nothing was looked at, and the AI had only the reel's words: nothing to say. Here as the
  // reports outlined it: each reel's account over its video, and its bar with Like, its count and Comment by its count.
  const reelPart = (by: string, video: string, others = '') => `<div>
    <div><img aria-hidden="true" alt=""><div>
      <video width="468" height="832" poster="${CDN}/${video}.jpg"></video>
      <div role="group" aria-label="Video player"><div role="presentation"><div role="button"><div>
        <a role="link" aria-label="${by} reels" href="/${by}/reels/"><div>
          <span role="link"><img alt="${by}'s profile picture" width="32" height="32" src="${CDN}/face.jpg"></span></div></a>
        <div><span dir="auto"><a role="link" aria-label="${by} reels" href="/${by}/reels/">${by}</a>${others}</span></div>
      </div></div></div></div></div></div>
    <div><div><div role="button"><svg role="img" aria-label="Like"></svg></div>
        <div role="button"><span dir="auto"><span>218</span></span></div></div>
      <div role="button" aria-expanded="false"><div><svg role="img" aria-label="Comment"></svg>
        <span dir="auto"><span>77</span></span></div></div>
      <div><div role="button"><svg role="img" aria-label="Share"></svg></div></div>
      <a role="link" href="/reels/audio/1234567/"><div><img alt="Original audio"></div></a></div>
  </div>`;
  const reels = (first: string, next: string, others = '') =>
    new JSDOM(
      `<!doctype html><html><body><main role="main"><div>${reelPart(first, 'first', others)}${reelPart(next, 'next')}</div></main></body></html>`,
      { url: `${IG}/reels/C4ddddddd/` },
    ).window.document;
  const REEL: CommentOn = { ...ON, postUrl: `${IG}/reel/C4ddddddd/` };

  it('is the reel the reels player opened on, when it’s theirs or made with them: never the next one', () => {
    const found = part(reels('dana.reyes', 'sam.lee'), REEL)!;
    expect(found).not.toBeNull();
    expect(postMediaIn(found.root, found.skip)?.getAttribute('poster')).toBe(`${CDN}/first.jpg`);
    const made = part(
      reels('sam.lee', 'kim_bakes', '<span>and</span><div role="button">2 others</div>'),
      REEL,
    )!;
    expect(postMediaIn(made.root, made.skip)?.getAttribute('poster')).toBe(`${CDN}/first.jpg`);
    // Someone else's reel opened, though theirs is next; or another reel asked for.
    expect(part(reels('sam.lee', 'dana.reyes'), REEL)).toBeNull();
    expect(
      part(reels('dana.reyes', 'sam.lee'), { ...ON, postUrl: `${IG}/reel/C9zzzzzzz/` }),
    ).toBeNull();
  });
});

describe('what the tab hands over', () => {
  it('is a photo’s address, whole and over https: nothing is drawn in the page', async () => {
    const found = part(postPage())!;
    expect(await seePost(found.root, LOOK_WANT, { skip: found.skip })).toEqual({
      kind: 'photo',
      url: `${CDN}/photo.jpg?sig=1`,
    });
    // A picture the page made up itself (no server's address) is nothing to fetch.
    for (const src of ['blob:https://www.instagram.com/1-2-3', 'data:image/png;base64,AAAA', '']) {
      const made = part(postPage({ media: `<img width="468" height="585" src="${src}">` }))!;
      expect(await seePost(made.root, LOOK_WANT, { skip: made.skip })).toBeNull();
    }
  });

  it('is up to three frames of a video: where it is, then further through, and it’s put back where it was', async () => {
    const doc = postPage({ media: '' });
    const { video, moves, at } = player(doc, { length: 20, at: 1 });
    doc.querySelector('#media')!.append(video);
    const found = part(doc)!;
    const seen = await seePost(found.root, LOOK_WANT, { skip: found.skip, draw: drawing() });
    expect(seen).toEqual({
      kind: 'video',
      jpegs: [jpegOf(1), jpegOf(8), jpegOf(16)],
      poster: null,
    });
    expect(moves).toEqual([8, 16, 1]);
    expect(at()).toBe(1);
    // One frame is enough when that's all that's asked for, and a short clip isn't moved through.
    const one = await seePost(
      found.root,
      { ...LOOK_WANT, most: 1 },
      { skip: found.skip, draw: drawing() },
    );
    expect(one).toEqual({ kind: 'video', jpegs: [jpegOf(1)], poster: null });
    const short = postPage({ media: '' });
    const clip = player(short, { length: 2, at: 0.5 });
    short.querySelector('#media')!.append(clip.video);
    const shortPart = part(short)!;
    expect(
      await seePost(shortPart.root, LOOK_WANT, { skip: shortPart.skip, draw: drawing() }),
    ).toEqual({ kind: 'video', jpegs: [jpegOf(1)], poster: null });
    expect(clip.moves).toEqual([]);
  });

  it('skips a black screen for a later moment, and never sends the same frame twice', async () => {
    const doc = postPage({ media: '' });
    const { video } = player(doc, { length: 10, at: 0 });
    doc.querySelector('#media')!.append(video);
    const found = part(doc)!;
    const dark = await seePost(found.root, LOOK_WANT, {
      skip: found.skip,
      draw: drawing((at) => (at === 0 ? { no: 'blank' } : { jpeg: jpegOf(Math.round(at)) })),
    });
    expect(dark).toEqual({ kind: 'video', jpegs: [jpegOf(4), jpegOf(8)], poster: null });
    const still = await seePost(found.root, LOOK_WANT, {
      skip: found.skip,
      draw: drawing(() => ({ jpeg: JPEG })),
    });
    expect(still).toEqual({ kind: 'video', jpegs: [JPEG], poster: null });
  });

  it('gives a player it can’t read by its poster, else the cover drawn over it, else nothing', async () => {
    const unreadable = drawing(() => ({ no: 'unreadable' }));
    const withPoster = postPage({ media: '' });
    const first = player(withPoster, { poster: `${CDN}/poster.jpg` });
    withPoster.querySelector('#media')!.append(first.video);
    const a = part(withPoster)!;
    expect(await seePost(a.root, LOOK_WANT, { skip: a.skip, draw: unreadable })).toEqual({
      kind: 'video',
      jpegs: [],
      poster: `${CDN}/poster.jpg`,
    });
    // It's never moved when it can't be read at all.
    expect(first.moves).toEqual([]);
    const withCover = postPage({
      media: `<img width="468" height="832" src="${CDN}/cover.jpg">`,
    });
    const second = player(withCover);
    withCover.querySelector('#media')!.append(second.video);
    const b = part(withCover)!;
    expect(await seePost(b.root, LOOK_WANT, { skip: b.skip, draw: unreadable })).toEqual({
      kind: 'video',
      jpegs: [],
      poster: `${CDN}/cover.jpg`,
    });
    // No poster, no cover: the tiles under the post are never its cover.
    const bare = postPage({ media: '' });
    const third = player(bare);
    bare.querySelector('#media')!.append(third.video);
    const c = part(bare)!;
    expect(await seePost(c.root, LOOK_WANT, { skip: c.skip, draw: unreadable })).toBeNull();
  });

  it('waits a moment for a player with nothing to draw yet, then goes by its poster', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const doc = postPage({ media: '' });
    const { video } = player(doc, { ready: false, poster: `${CDN}/poster.jpg` });
    doc.querySelector('#media')!.append(video);
    const found = part(doc)!;
    const going = seePost(found.root, LOOK_WANT, {
      skip: found.skip,
      draw: drawing(() => ({ no: 'unready' })),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await going).toEqual({ kind: 'video', jpegs: [], poster: `${CDN}/poster.jpg` });
  });
});

describe('a photo fetched by the background', () => {
  const picture = (type = 'image/jpeg', size = 40_000) =>
    new Response(new Blob([new Uint8Array(size)], { type }), {
      status: 200,
      headers: { 'content-type': type },
    });
  const make = vi.fn(async () => JPEG);

  it('comes only from the network’s own picture servers, over https, with no cookies', async () => {
    const fetched: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      fetched.push({ url, init });
      return picture();
    });
    expect(await pictureFrom(`${CDN}/photo.jpg?sig=1`, 'instagram', 768, make)).toBe(JPEG);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(make).toHaveBeenLastCalledWith(expect.anything(), 768, POST_PICTURE_CHARS);
    expect(await pictureFrom('https://scontent.xx.fbcdn.net/v/a.jpg', 'instagram', 512, make)).toBe(
      JPEG,
    );
    // Any other host, plain http, an address that isn't one, and a network that isn't looked at: never fetched.
    for (const [address, platform] of [
      ['https://example.com/photo.jpg', 'instagram'],
      ['https://cdninstagram.com.example.com/photo.jpg', 'instagram'],
      ['https://www.instagram.com/accounts/edit/', 'instagram'],
      ['http://scontent.cdninstagram.com/photo.jpg', 'instagram'],
      ['not an address', 'instagram'],
      [`${CDN}/photo.jpg`, 'facebook'],
      [`${CDN}/photo.jpg`, 'linkedin'],
    ] as const)
      expect(await pictureFrom(address, platform, 768, make)).toBeNull();
    expect(fetched).toHaveLength(2);
  });

  it('fetches each network’s photos only from its own picture servers (decision 172)', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return picture();
    });
    const own: readonly (readonly [string, Platform])[] = [
      ['https://scontent.xx.fbcdn.net/v/t39.30808-6/a.jpg', 'facebook'],
      ['https://scontent-dfw5-1.cdninstagram.com/v/t51.2885-15/a.jpg', 'threads'],
      ['https://media.licdn.com/dms/image/v2/D4E22AQ/feedshare-shrink_800/0/1.jpg', 'linkedin'],
      ['https://pbs.twimg.com/media/GabcDEF.jpg?format=jpg&name=small', 'x'],
      ['https://assets.alignable.com/discussions/photo.jpg', 'alignable'],
    ];
    for (const [address, platform] of own)
      expect(await pictureFrom(address, platform, 768, make)).toBe(JPEG);
    // Another network's servers, or a look-alike host: never fetched.
    for (const [address, platform] of [
      ['https://pbs.twimg.com/media/GabcDEF.jpg', 'linkedin'],
      ['https://media.licdn.com/dms/image/1.jpg', 'x'],
      ['https://scontent-dfw5-1.cdninstagram.com/v/a.jpg', 'facebook'],
      ['https://alignable.com.example.com/photo.jpg', 'alignable'],
      ['https://twimg.com.example.com/media/a.jpg', 'x'],
    ] as const)
      expect(await pictureFrom(address, platform, 768, make)).toBeNull();
    expect(fetched).toHaveLength(own.length);
  });

  it('is nothing when the servers refuse, send something that isn’t a picture, or send too much', async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response('gone', { status: 404, headers: { 'content-type': 'image/jpeg' } }),
      () => picture('text/html'),
      () =>
        new Response(new Blob([new Uint8Array(10)]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': String(9 * 1024 * 1024) },
        }),
      () => picture('image/jpeg', 0),
      () => Promise.reject(new Error('offline')),
    ];
    for (const answer of answers) {
      vi.stubGlobal('fetch', async () => answer());
      expect(await pictureFrom(`${CDN}/photo.jpg`, 'instagram', 768, make)).toBeNull();
    }
    // A picture that can't be made small enough isn't sent.
    vi.stubGlobal('fetch', async () => picture());
    expect(await pictureFrom(`${CDN}/photo.jpg`, 'instagram', 768, async () => null)).toBeNull();
    expect(
      await pictureFrom(`${CDN}/photo.jpg`, 'instagram', 768, async () => {
        throw new Error('not a picture');
      }),
    ).toBeNull();
  });
});

describe('the look that goes with a comment’s draft', () => {
  const tab = (answer: PostLookAnswer | (() => never)) => {
    const asks: PostLookAsk[] = [];
    return {
      asks,
      runner: (platform: Platform = 'instagram') => ({
        platform,
        tab: {
          ask: async (message: PostLookAsk) => {
            asks.push(message);
            return typeof answer === 'function' ? answer() : answer;
          },
        },
      }),
    };
  };
  const make = async () => JPEG;

  it('is the photo made small, or the video’s frames as the tab drew them', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new Blob([new Uint8Array(100)]), {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        }),
    );
    const photo = tab({ ok: true, seen: { kind: 'photo', url: `${CDN}/photo.jpg` } });
    const look = await lookAtPost(photo.runner(), ON, make);
    expect(look).toEqual({ kind: 'photo', jpegs: [JPEG] });
    expect(photo.asks).toEqual([
      { type: 'hfos-post-look', profile: ON.profile, postUrl: ON.postUrl, want: LOOK_WANT },
    ]);
    // What it gives is what HandsFreeOS takes.
    expect(PostLook.safeParse(look).success).toBe(true);
    const frames = [jpegOf(1), jpegOf(2), jpegOf(3), jpegOf(4)];
    const video = tab({ ok: true, seen: { kind: 'video', jpegs: frames, poster: null } });
    const watched = await lookAtPost(video.runner(), ON, make);
    expect(watched).toEqual({ kind: 'video', jpegs: frames.slice(0, 3) });
    expect(PostLook.safeParse(watched).success).toBe(true);
    // No frame could be drawn: its poster, as one frame.
    const poster = tab({
      ok: true,
      seen: { kind: 'video', jpegs: [], poster: `${CDN}/poster.jpg` },
    });
    expect(await lookAtPost(poster.runner(), ON, make)).toEqual({ kind: 'video', jpegs: [JPEG] });
  });

  it('is nothing, never an error, when there’s no picture or anything goes wrong', async () => {
    vi.stubGlobal('fetch', async () => new Response('no', { status: 403 }));
    expect(await lookAtPost(tab({ ok: true, seen: null }).runner(), ON, make)).toBeNull();
    expect(await lookAtPost(tab({ ok: false, error: 'closed' }).runner(), ON, make)).toBeNull();
    expect(
      await lookAtPost(
        tab({ ok: true, seen: { kind: 'photo', url: `${CDN}/photo.jpg` } }).runner(),
        ON,
        make,
      ),
    ).toBeNull();
    expect(
      await lookAtPost(
        tab({ ok: true, seen: { kind: 'video', jpegs: [], poster: null } }).runner(),
        ON,
        make,
      ),
    ).toBeNull();
    // Frames that aren't JPEGs are never passed on.
    expect(
      await lookAtPost(
        tab({
          ok: true,
          seen: { kind: 'video', jpegs: ['iVBORw0KGgo', ''], poster: null },
        }).runner(),
        ON,
        make,
      ),
    ).toBeNull();
    expect(
      await lookAtPost(
        tab(() => {
          throw new Error('The tab was closed.');
        }).runner(),
        ON,
        make,
      ),
    ).toBeNull();
  });

  it('is on every network built from 0.144.0 (decision 172), and never on one whose picture servers it doesn’t know', async () => {
    for (const platform of PLATFORM_KEYS) expect(looksAtPosts(platform)).toBe(true);
    for (const platform of PLATFORM_KEYS) {
      const asked = tab({ ok: true, seen: { kind: 'video', jpegs: [JPEG], poster: null } });
      expect(await lookAtPost(asked.runner(platform), ON, make)).toEqual({
        kind: 'video',
        jpegs: [JPEG],
      });
      expect(asked.asks).toHaveLength(1);
    }
    // A network added later is never looked at till its picture servers are listed: the tab isn't asked.
    const later = 'myspace' as Platform;
    expect(looksAtPosts(later)).toBe(false);
    const asked = tab({ ok: true, seen: { kind: 'video', jpegs: [JPEG], poster: null } });
    expect(await lookAtPost(asked.runner(later), ON, make)).toBeNull();
    expect(asked.asks).toEqual([]);
  });
});
