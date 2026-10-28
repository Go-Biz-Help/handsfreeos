/**
 * A commenter's comment liked as the warm-up before following them (docs/outreach.md, decision 116): on a good post's
 * own page, their comment read first (what it says, its link, whether it's liked), then only its own Like pressed,
 * never the post's nor another comment's, on Instagram, LinkedIn (both layouts) and Alignable (an answer). From each
 * network's usual markup, written here by hand with made-up people, and LinkedIn's post pages in test/fixtures.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { likeTheirAnswer, theirAnswer } from '../src/networks/alignable/auto';
import {
  likeTheirComment as likeOnInstagram,
  theirComment as onInstagram,
} from '../src/networks/instagram/auto';
import {
  likeTheirComment as likeOnLinkedIn,
  theirComment as onLinkedIn,
} from '../src/networks/linkedin/compose';
import { load } from './load';

const page = (url: string, body: string) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url }).window.document;

/** Pressing it turns it to what it says once liked, as each network draws it. */
function turnsTo(control: Element, liked: () => void): { pressed: () => number } {
  let pressed = 0;
  control.addEventListener('click', () => {
    pressed++;
    liked();
  });
  return { pressed: () => pressed };
}

describe('a comment’s Like on Instagram', () => {
  const IG = 'https://www.instagram.com';
  const POST_URL = `${IG}/p/C3xyzabcd/`;
  const sam = { id: null, username: 'sam.lee', url: `${IG}/sam.lee/` };
  /** A comment as Instagram draws one: its writer, its time on its own link, its words, its Reply, and its Like. */
  const comment = (who: string, id: string, words: string, like: string) =>
    `<div><div><div><a role="link" href="/${who}/"><img alt=""></a>
      <div><div><div><div><span dir="auto"><a role="link" href="/${who}/"><span dir="auto">${who}</span></a></span>
        <span dir="auto"><a role="link" href="/p/C3xyzabcd/c/${id}/"><time>2w</time></a></span></div>
        <span dir="auto">${words}</span></div>
        <div><div role="button"><span dir="auto"><span>Reply</span></span></div></div></div>
        <div role="button" id="${who}-like"><svg role="img" aria-label="${like}"></svg></div></div></div></div></div>`;
  const post = (samsLike = 'Like') =>
    page(
      `${IG}/dana.reyes/p/C3xyzabcd/`,
      `<main role="main"><div>
        <div><a role="link" href="/dana.reyes/"><span dir="auto">dana.reyes</span></a></div>
        <div>${comment('kim_bakes', '17900000000000002', 'Do you do water heaters?', 'Like')}
          ${comment('sam.lee', '17900000000000001', 'Great work, thank you!', samsLike)}</div>
        <section><div role="button" id="post-like"><svg role="img" aria-label="Like"></svg></div>
          <div role="button"><svg role="img" aria-label="Comment"></svg></div></section>
      </div></main>`,
    );
  const SAMS = `${IG}/p/C3xyzabcd/c/17900000000000001/`;

  it('reads their comment on the post asked for, its own link, and that it isn’t liked yet', () => {
    const doc = post();
    expect(onInstagram(doc, doc.location.href, sam, POST_URL)).toEqual({
      text: 'Great work, thank you!',
      commentUrl: SAMS,
      liked: false,
    });
    expect(onInstagram(post('Unlike'), doc.location.href, sam, POST_URL)?.liked).toBe(true);
    // Not on another post, nor for someone who didn't comment.
    expect(onInstagram(doc, doc.location.href, sam, `${IG}/p/C9other12/`)).toBeNull();
    const ada = { id: null, username: 'ada.finch', url: `${IG}/ada.finch/` };
    expect(onInstagram(doc, doc.location.href, ada, POST_URL)).toBeNull();
  });

  it('presses only their comment’s own Like, never the post’s or another comment’s, and once', async () => {
    const doc = post();
    const like = doc.querySelector('#sam\\.lee-like')!;
    const { pressed } = turnsTo(like, () =>
      like.querySelector('svg')!.setAttribute('aria-label', 'Unlike'),
    );
    const others = turnsTo(doc.querySelector('#post-like')!, () => {});
    const kims = turnsTo(doc.querySelector('#kim_bakes-like')!, () => {});
    expect(await likeOnInstagram(doc, doc.location.href, sam, POST_URL)).toEqual({
      result: 'done',
      commentUrl: SAMS,
      text: 'Great work, thank you!',
    });
    expect([pressed(), others.pressed(), kims.pressed()]).toEqual([1, 0, 0]);
    // Liked already: nothing more is pressed.
    expect((await likeOnInstagram(doc, doc.location.href, sam, POST_URL)).result).toBe('already');
    expect(pressed()).toBe(1);
  });

  it('presses nothing on another post’s page', async () => {
    const doc = post();
    const { pressed } = turnsTo(doc.querySelector('#sam\\.lee-like')!, () => {});
    expect(await likeOnInstagram(doc, doc.location.href, sam, `${IG}/p/C9other12/`)).toEqual({
      result: 'none',
      commentUrl: null,
      text: null,
    });
    expect(pressed()).toBe(0);
  });
});

describe('a comment’s Like on LinkedIn', () => {
  const LI = 'https://www.linkedin.com';
  const OLDER = `${LI}/feed/update/urn:li:activity:7380000000000000611/`;
  const NEWER = `${LI}/feed/update/urn:li:activity:7380000000000000777/`;
  const sam = { id: null, username: 'sam-lee-77', url: `${LI}/in/sam-lee-77/` };
  const hector = { id: null, username: 'hector-ruiz-pm', url: `${LI}/in/hector-ruiz-pm/` };

  it('reads and likes their comment in the older layout by its own React Like, never the post’s', async () => {
    const doc = load('linkedin-post.html', OLDER);
    const theirs = onLinkedIn(doc, OLDER, sam, OLDER);
    expect(theirs).toMatchObject({
      text: 'Good reminder. Ours is 11 years old, booking a check now.',
      liked: false,
    });
    expect(theirs?.commentUrl).toMatch(/[?&]commentUrn=/);
    const like = doc.querySelector('[aria-label="React Like to Sam Lee’s comment"]')!;
    const { pressed } = turnsTo(like, () =>
      like.setAttribute('aria-label', 'Unreact Like to Sam Lee’s comment'),
    );
    const posts = turnsTo(doc.querySelector('[aria-label="React Like"]')!, () => {});
    expect((await likeOnLinkedIn(doc, OLDER, sam, OLDER)).result).toBe('done');
    expect([pressed(), posts.pressed()]).toEqual([1, 0]);
    expect((await likeOnLinkedIn(doc, OLDER, sam, OLDER)).result).toBe('already');
    expect(pressed()).toBe(1);
  });

  it('likes their comment in the newer layout by its own reaction button, never the reply’s under it', async () => {
    const doc = load('linkedin-post-2026-10.html', NEWER);
    expect(onLinkedIn(doc, NEWER, hector, NEWER)).toEqual({
      text: 'Following. We need the same for our units on Hopkins Street.',
      commentUrl: null,
      liked: false,
    });
    const buttons = [...doc.querySelectorAll('[aria-label="Reaction button state: no reaction"]')];
    const before = buttons.map((b) => b.closest('[role="button"], button')!);
    const presses = before.map((b) =>
      turnsTo(b, () =>
        b.querySelector('[aria-label]')?.setAttribute('aria-label', 'Reaction button state: like'),
      ),
    );
    expect((await likeOnLinkedIn(doc, NEWER, hector, NEWER)).result).toBe('done');
    // Hector's own, the second (the post's is first, Priya's reply under his third): nobody else's.
    expect(presses.map((p) => p.pressed())).toEqual(before.map((_, i) => (i === 1 ? 1 : 0)));
  });

  it('presses nothing on another post’s page, nor for someone who didn’t comment', async () => {
    const doc = load('linkedin-post.html', OLDER);
    const like = doc.querySelector('[aria-label="React Like to Sam Lee’s comment"]')!;
    const { pressed } = turnsTo(like, () => {});
    expect((await likeOnLinkedIn(doc, OLDER, sam, NEWER)).result).toBe('none');
    const ada = { id: null, username: 'ada-finch', url: `${LI}/in/ada-finch/` };
    expect(onLinkedIn(doc, OLDER, ada, OLDER)).toBeNull();
    expect((await likeOnLinkedIn(doc, OLDER, ada, OLDER)).result).toBe('none');
    expect(pressed()).toBe(0);
  });
});

describe('an answer’s Like on Alignable', () => {
  const AL = 'https://www.alignable.com';
  const DISCUSSION = `${AL}/biz/discussions/91`;
  const sam = {
    id: null,
    username: 'round-rock-tx-best-bakery',
    url: `${AL}/round-rock-tx/best-bakery`,
  };
  /** The discussion's own page: the post, then Sam Lee's answer with Kim's reply under it, each with its Like. */
  const discussion = (samsLike = 'Like') =>
    page(
      DISCUSSION,
      `<section><div><div><div><a href="/austin-tx/acme-plumbing?user=5"><span>Dana Reyes</span><span>at</span><span>Acme Plumbing</span></a>
          <span>4h</span></div></div>
        <div><div title="Need a roofer">Can anyone recommend a roofer?</div></div>
        <div><div><a id="likes" href="/biz/likes?resource=9"><span>3</span><span>Like</span></a></div><hr>
          <div><a href="/biz/discussions/91">Comment</a><a id="post-like" href="/biz/likes"><svg></svg><div>Like</div></a></div></div></div>
      <div data-testid="discussion-comment"><a href="/round-rock-tx/best-bakery?user=6">Sam Lee</a><span>3h</span>
        <div data-testid="discussion-comment-body">We can help.</div><button>Reply</button><button id="sam-like">${samsLike}</button>
        <div data-testid="discussion-comment"><a href="/austin-tx/kims-cakes?user=7">Kim Park</a><span>2h</span>
          <div data-testid="discussion-comment-body">Same here.</div><button id="kim-like">Like</button></div></div></section>`,
    );

  it('reads their answer on the discussion asked for, its link, and that it isn’t liked yet', () => {
    expect(theirAnswer(discussion(), DISCUSSION, sam, DISCUSSION)).toEqual({
      text: 'We can help.',
      commentUrl: DISCUSSION,
      liked: false,
    });
    expect(theirAnswer(discussion('Liked'), DISCUSSION, sam, DISCUSSION)?.liked).toBe(true);
    expect(theirAnswer(discussion(), DISCUSSION, sam, `${AL}/biz/discussions/92`)).toBeNull();
  });

  it('presses only their answer’s own Like, never the post’s, its count or a reply’s, and once', async () => {
    const doc = discussion();
    const like = doc.querySelector('#sam-like')!;
    const { pressed } = turnsTo(like, () => (like.textContent = 'Liked'));
    const others = ['#post-like', '#likes', '#kim-like'].map((id) =>
      turnsTo(doc.querySelector(id)!, () => {}),
    );
    expect(await likeTheirAnswer(doc, DISCUSSION, sam, DISCUSSION)).toEqual({
      result: 'done',
      commentUrl: DISCUSSION,
      text: 'We can help.',
    });
    expect([pressed(), ...others.map((o) => o.pressed())]).toEqual([1, 0, 0, 0]);
    expect((await likeTheirAnswer(doc, DISCUSSION, sam, DISCUSSION)).result).toBe('already');
    expect(pressed()).toBe(1);
  });

  it('presses nothing on another discussion’s page', async () => {
    const doc = discussion();
    const { pressed } = turnsTo(doc.querySelector('#sam-like')!, () => {});
    expect((await likeTheirAnswer(doc, DISCUSSION, sam, `${AL}/biz/discussions/92`)).result).toBe(
      'none',
    );
    expect(pressed()).toBe(0);
  });
});
