/**
 * Their story on Instagram (decision 111, 0.103.0): the ring round their picture read on their account (never a
 * highlight's), the story liked on its own page (View story pressed where Instagram asks first, watched a few seconds,
 * the viewer's own Like pressed, and the viewer closed), and Check Instagram's look at it, which presses no Like. From
 * Instagram's usual markup, written here by hand with made-up people, till the owner's next Check outlines a story.
 */
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { likeTheirStory, storyLikeOf } from '../src/networks/instagram/auto';
import { readInstagram } from '../src/networks/instagram/read';
import { INSTAGRAM } from '../src/networks/instagram/site';
import { storyOf, storyUrl } from '../src/networks/instagram/urls';

const IG = 'https://www.instagram.com';
const page = (path: string, body: string) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: `${IG}${path}` }).window
    .document;
const dana = { id: null, username: 'dana.reyes', url: `${IG}/dana.reyes/` };

afterEach(() => vi.useRealTimers());

/** Someone's account: their picture (with a story's ring, or a link to it, or neither), then a highlight's ring. */
const account = (picture: string) =>
  page(
    '/dana.reyes/',
    `<main role="main"><div><header>
      <section>${picture}</section>
      <section><h2>dana.reyes</h2><span dir="auto">Dana Reyes</span>
        <button><div dir="auto">Follow</div></button></section>
      <section><div role="menu"><ul><li><div role="button"><canvas></canvas>
        <img alt="Highlights"><span>Jobs</span></div></li></ul></div></section>
    </header></div></main>`,
  );

describe('a story on their account', () => {
  it('reads the ring round their picture, or a link to their story, as a story to see', () => {
    const ring = account(
      `<div role="button" tabindex="0"><canvas></canvas><span role="link"><img alt="dana.reyes's profile picture"></span></div>`,
    );
    expect(readInstagram(ring, ring.location.href).profile?.story).toBe(true);
    const link = account(
      `<a role="link" href="/stories/dana.reyes/"><img alt="dana.reyes's profile picture"></a>`,
    );
    expect(readInstagram(link, link.location.href).profile?.story).toBe(true);
  });

  it('never takes a highlight’s ring for their story', () => {
    const none = account(
      `<a role="link" href="/dana.reyes/"><img alt="dana.reyes's profile picture"></a>`,
    );
    expect(readInstagram(none, none.location.href).profile?.story).toBe(false);
  });

  it('knows a story’s address by the name in it, never a highlight’s', () => {
    expect(storyUrl('dana.reyes')).toBe(`${IG}/stories/dana.reyes/`);
    expect(storyOf(new URL(`${IG}/stories/dana.reyes/3100000000000000001/`))).toBe('dana.reyes');
    expect(storyOf(new URL(`${IG}/stories/highlights/17900000000000001/`))).toBeNull();
    expect(storyOf(new URL(`${IG}/dana.reyes/`))).toBeNull();
  });
});

/** Their story's viewer: who it is, the picture, its box to reply in with its Like, and its Close. */
const VIEWER = `<section><div><div>
  <header><a role="link" href="/dana.reyes/"><img alt="dana.reyes's profile picture"></a>
    <a role="link" href="/dana.reyes/">dana.reyes</a><time>3h</time>
    <div role="button"><svg role="img" aria-label="Pause"></svg></div>
    <div role="button"><svg role="img" aria-label="Menu"></svg></div></header>
  <div><img alt="Photo by Dana Reyes"></div>
  <div><form><textarea aria-label="Reply to dana.reyes…" placeholder="Reply to dana.reyes…"></textarea></form>
    <div role="button" id="story-like"><svg role="img" aria-label="Like"></svg></div>
    <div role="button"><svg role="img" aria-label="Share"></svg></div></div>
  </div><div role="button" id="close"><svg role="img" aria-label="Close"></svg></div></div></section>`;

/** What Instagram asks first on a story's own address: view it as the person, who they'll see viewed it. */
const ASKS_FIRST = `<section><div><img alt="dana.reyes's profile picture">
  <span>View as me.owner?</span><span>dana.reyes will be able to see that you viewed their story.</span>
  <div role="button" id="view">View story</div><div role="button">Cancel</div></div></section>`;

/** Their story's page: asking first, with View story drawing the viewer at the story's own address. */
function storyPage(liked = false) {
  const doc = page('/stories/dana.reyes/', ASKS_FIRST);
  const presses: string[] = [];
  doc.querySelector('#view')!.addEventListener('click', () => {
    presses.push('view');
    doc.defaultView!.history.pushState({}, '', '/stories/dana.reyes/3100000000000000001/');
    doc.body.innerHTML = VIEWER;
    const like = doc.querySelector('#story-like')!;
    if (liked) like.querySelector('svg')!.setAttribute('aria-label', 'Unlike');
    like.addEventListener('click', () => {
      presses.push('like');
      like.querySelector('svg')!.setAttribute('aria-label', 'Unlike');
    });
    doc.querySelector('#close')!.addEventListener('click', () => presses.push('close'));
  });
  return { doc, presses };
}

/** A press that waits, run with the clock moved on till it's done. */
async function settled<T>(going: Promise<T>): Promise<T> {
  let done = false;
  void going.finally(() => (done = true));
  for (let i = 0; i < 100 && !done; i++) await vi.advanceTimersByTimeAsync(500);
  return going;
}

describe('liking their story', () => {
  it('presses View story, watches it, likes it with the viewer’s own Like, and closes it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { doc, presses } = storyPage();
    expect(await settled(likeTheirStory(doc, doc.location.href, dana))).toEqual({
      result: 'done',
      storyUrl: `${IG}/stories/dana.reyes/3100000000000000001/`,
    });
    expect(presses).toEqual(['view', 'like', 'close']);
  });

  it('says a story liked already is, pressing no Like', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { doc, presses } = storyPage(true);
    expect((await settled(likeTheirStory(doc, doc.location.href, dana))).result).toBe('already');
    expect(presses).toEqual(['view', 'close']);
  });

  it('likes nothing on someone else’s story, or a page with no Like', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { doc, presses } = storyPage();
    const sam = { id: null, username: 'sam.lee', url: `${IG}/sam.lee/` };
    expect(await likeTheirStory(doc, doc.location.href, sam)).toEqual({
      result: 'none',
      storyUrl: null,
    });
    expect(presses).toEqual([]);
    const bare = page('/stories/dana.reyes/', '<section><img alt="A photo"></section>');
    expect((await settled(likeTheirStory(bare, bare.location.href, dana))).result).toBe('none');
  });

  it('finds the viewer’s own Like beside its box to reply in', () => {
    const doc = page(
      '/stories/dana.reyes/3100000000000000001/',
      `<div><div role="button" id="other"><svg aria-label="Like"></svg></div></div>${VIEWER}`,
    );
    expect(storyLikeOf(doc)?.id).toBe('story-like');
  });
});

describe('Check Instagram’s look at a story', () => {
  it('watches it, finds its Like without pressing it, and closes it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { doc, presses } = storyPage();
    const tried = await settled(
      Promise.resolve(INSTAGRAM.looks.story!.look(doc, doc.location.href)),
    );
    expect(tried).toMatchObject({
      step: 'story',
      works: true,
      found: { viewStory: true, like: true, liked: false, close: true },
      missing: [],
    });
    expect(presses).toEqual(['view', 'close']);
  });
});
