/**
 * Looking for a post on the page that lists it (src/research/posting.ts `lookOn`; docs/socialcontent.md, "Posting"):
 * Facebook draws a profile's or a Page's posts only once they're scrolled near, and nothing in a window hidden behind
 * another. The owner's Page posts of 15 and 16 Nov 2026 were looked for while every post there still said
 * "Loading...", so four that may have gone up were marked as not. It now scrolls to the first still loading and waits
 * by the clock for the newest few to draw, looks once more in front while the person is away, and says it couldn't
 * check when they never drew, rather than that the post isn't there.
 */
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LookPost } from '@hfos/core/addons/socialcontent/content-shapes';
import { NotAway } from '../src/away';
import { postsDrawing, readPosts } from '../src/networks/facebook/posts';
import { postShown } from '../src/jobs/helpful';
import type { ResearchTab } from '../src/research/tab';

const looked: { found: unknown[]; failure: string | null }[] = [];

vi.mock('../src/research/hfos', async (actual) => ({
  ...(await actual<object>()),
  postLooked: vi.fn(async (_ws: string, _id: string, found: unknown[], failure: string | null) => {
    looked.push({ found, failure });
    return {};
  }),
}));
// Its waits pass at once in a test, moving the clock on by as long as each was.
vi.mock('../src/research/read', async (actual) => ({
  ...(await actual<object>()),
  pause: async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
  },
}));

const { failureFor, lookOn, POSTS_DRAW_MS, POSTS_HIDDEN_MS, POSTS_LOOKED_BACK, POSTS_NEWEST } =
  await import('../src/research/posting');
const { lookFor, unseenFailure } = await import('../src/research/look');

const PAGE = 'https://www.facebook.com/profile.php?id=61550000000000';
const TEXT =
  'What happens in the three minutes after you miss a call? Most leads are gone by then.';
const LINK = 'https://www.facebook.com/61550000000000/posts/pfbid0abc';
const OTHER = (i: number) => ({
  text: `An older post number ${i} about something else entirely`,
  url: `${LINK}${i}`,
});

/**
 * A reading window on a Facebook page that draws its posts as it's scrolled: `drawsAfter` scrolls (never, when null)
 * before the post shows among `posts`. `front`: what showing it in front does (draws it at once, or the person isn't
 * away: then only a look the person asked for comes in front, as src/tab.ts's `inFront` does). `shown`: whether Chrome
 * shows its window (not when it's behind the person's).
 */
function facebookTab(opts: {
  drawsAfter: number | null;
  posts?: { text: string; url: string | null }[];
  front?: 'draws' | 'not_away';
  drawing?: boolean;
  shown?: boolean;
}) {
  let scrolls = 0;
  let inFront = false;
  const fronted: number[] = [];
  const frontAsked: boolean[] = [];
  const asked: number[] = [];
  const posts = opts.posts ?? [{ text: TEXT, url: LINK }];
  const drawn = () => inFront || (opts.drawsAfter !== null && scrolls >= opts.drawsAfter);
  const tab = {
    open: async () => 0,
    hands: async (name: string, ...args: unknown[]) => {
      if (name === 'warnings') return [];
      if (name === 'read') return { kind: 'profile', posts: drawn() ? posts : [] };
      if (name === 'drawPosts') {
        asked.push(args[0] as number);
        // A network that draws its posts with the page (LinkedIn's) has nothing to wait on.
        if (opts.drawing === false) return { drawn: 0, loading: false, shown: true };
        const most = args[0] as number;
        const count = drawn() ? posts.length : 0;
        const loading = count < most && (!drawn() || count === 0);
        if (loading) scrolls++;
        return { drawn: count, loading, shown: inFront || opts.shown !== false };
      }
      return null;
    },
    inFront: async <T>(work: () => Promise<T>, personAsked = false) => {
      fronted.push(Date.now());
      frontAsked.push(personAsked);
      if (opts.front !== 'draws' && !personAsked) throw new NotAway();
      inFront = true;
      try {
        return await work();
      } finally {
        inFront = false;
      }
    },
  };
  return { tab: tab as unknown as ResearchTab, scrolls: () => scrolls, fronted, frontAsked, asked };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-16T19:48:00Z') });
  looked.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('looking for a post on a Facebook page that draws its posts as it’s scrolled', () => {
  it('scrolls to the posts still loading and waits for them, then finds it (the owner’s Page, 16 Nov)', async () => {
    const { tab, scrolls, fronted } = facebookTab({ drawsAfter: 3 });
    expect(await lookOn(tab, PAGE, TEXT)).toEqual({ found: true, link: LINK, seen: true });
    expect(scrolls()).toBe(3);
    expect(fronted).toEqual([]);
  });

  it('says it’s not there once the newest few are drawn without it', async () => {
    const posts = Array.from({ length: POSTS_NEWEST }, (_, i) => OTHER(i));
    const { tab, fronted } = facebookTab({ drawsAfter: 1, posts });
    expect(await lookOn(tab, PAGE, TEXT)).toEqual({ found: false, link: null, seen: true });
    expect(fronted).toEqual([]);
  });

  it('waits by the clock, then looks once more in front while the person is away', async () => {
    const started = Date.now();
    const { tab, fronted } = facebookTab({ drawsAfter: null, front: 'draws' });
    expect(await lookOn(tab, PAGE, TEXT)).toEqual({ found: true, link: LINK, seen: true });
    expect(fronted).toHaveLength(1);
    expect(fronted[0]! - started).toBeGreaterThanOrEqual(POSTS_DRAW_MS);
    expect(fronted[0]! - started).toBeLessThan(POSTS_DRAW_MS + 10_000);
  });

  it('says it couldn’t see them when they never drew and the person isn’t away', async () => {
    const { tab, fronted } = facebookTab({ drawsAfter: null, front: 'not_away' });
    expect(await lookOn(tab, PAGE, TEXT)).toEqual({ found: false, link: null, seen: false });
    expect(fronted).toHaveLength(1);
  });

  it('waits less on a window Chrome doesn’t show, as Facebook draws nothing more there', async () => {
    const started = Date.now();
    const { tab, fronted } = facebookTab({ drawsAfter: null, front: 'draws', shown: false });
    expect(await lookOn(tab, PAGE, TEXT)).toEqual({ found: true, link: LINK, seen: true });
    expect(fronted).toHaveLength(1);
    expect(fronted[0]! - started).toBeGreaterThanOrEqual(POSTS_HIDDEN_MS);
    expect(fronted[0]! - started).toBeLessThan(POSTS_DRAW_MS);
  });

  it('reads a page that draws its posts with it (LinkedIn’s) once, as before', async () => {
    const { tab, scrolls, fronted } = facebookTab({ drawsAfter: null, drawing: false });
    expect(await lookOn(tab, PAGE, TEXT)).toEqual({ found: false, link: null, seen: true });
    expect(scrolls()).toBe(0);
    expect(fronted).toEqual([]);
  });
});

describe('what the person reads when the Page’s posts never drew', () => {
  const pressed = { result: 'not_sent' as const, pressed: true, steps: ['post'], url: null };

  it('says it couldn’t check after Publish, not that the post isn’t there', () => {
    const unseen = failureFor('facebook', 'page', pressed, false, true);
    expect(unseen).toMatch(/didn’t load your Page’s posts/);
    expect(unseen).toMatch(/press Post it now/);
    expect(unseen.length).toBeLessThanOrEqual(300);
    expect(failureFor('facebook', 'page', pressed)).toMatch(/didn’t find the post on your Page/);
  });

  it('says Check if it posted couldn’t check, with nothing marked found', async () => {
    const { tab } = facebookTab({ drawsAfter: null, front: 'not_away' });
    const post: LookPost = {
      id: '7a1d0b6e-6a52-4a8e-9d0c-3e5f3c1b2a90',
      network: 'facebook',
      text: TEXT,
      places: ['page'],
      facebookPage: PAGE,
      postAt: '2026-11-16T18:00:00.000Z',
      asked: false,
    };
    await lookFor('ws', tab, post);
    expect(looked).toEqual([{ found: [], failure: unseenFailure('page') }]);
    expect(unseenFailure('page').length).toBeLessThanOrEqual(300);
  });

  it('marks it found when the Page drew it after a scroll', async () => {
    const { tab } = facebookTab({ drawsAfter: 2 });
    await lookFor('ws', tab, {
      id: '7a1d0b6e-6a52-4a8e-9d0c-3e5f3c1b2a90',
      network: 'facebook',
      text: TEXT,
      places: ['page'],
      facebookPage: PAGE,
      postAt: null,
      asked: false,
    });
    expect(looked).toEqual([{ found: [{ place: 'page', link: LINK }], failure: null }]);
  });
});

describe('a Facebook post found by its words, with no link and cut short', () => {
  // The owner's Page, 17 Nov 2026: the post was the first on the Page, its words cut to the first sentence and "…"
  // before See more, and its own time link empty, as Facebook leaves a new post's. It was marked as not posted.
  const FULL =
    'Ever get told you have to upgrade just to add one more tech or lead?\n\nA lot of CRMs cap your contacts or charge per seat.';
  const SHOWN = 'Ever get told you have to upgrade just to add one more tech or lead?…';

  it('counts it as there, without a link, after Publish and on Check if it posted', async () => {
    const { tab } = facebookTab({ drawsAfter: 0, posts: [{ text: SHOWN, url: null }] });
    expect(await lookOn(tab, PAGE, FULL)).toEqual({ found: true, link: null, seen: true });
    await lookFor('ws', tab, {
      id: '7a1d0b6e-6a52-4a8e-9d0c-3e5f3c1b2a90',
      network: 'facebook',
      text: FULL,
      places: ['page'],
      facebookPage: PAGE,
      postAt: null,
      asked: false,
    });
    expect(looked).toEqual([{ found: [{ place: 'page', link: null }], failure: null }]);
  });

  it('reads the Page’s post as Facebook draws it: its words up to the “…”, and no link', () => {
    const { window } = new JSDOM(
      `<body><div role="main"><div role="feed"><div><div role="article">
        <h3><a role="link" href="/profile.php?id=61550000000000"><b><span>Example Plumbing</span></b></a></h3>
        <a role="link" href="/profile.php"><span>Ssotnoepdr</span></a>
        <div data-ad-rendering-role="story_message"><div data-ad-comet-preview="message" data-ad-preview="message">
          <span dir="auto"><div dir="auto">Ever get told you have to upgrade just to add one more tech or lead?<!-- -->…
            <div role="button">See more</div></div></span></div></div>
        <a role="link" href="/photo/?fbid=111&amp;set=pcb.222"><img alt=""></a>
        <a role="link" href="/photo/?fbid=112&amp;set=pcb.222"><img alt=""></a>
        <div role="button" aria-label="Like">Like</div>
      </div></div></div></div></body>`,
      { url: PAGE },
    );
    const posts = readPosts(window.document.body, PAGE);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBeNull();
    // Its words up to the "…", which the reader keeps apart.
    expect(posts[0]!.text).toBe(SHOWN.replace('…', ' …'));
    expect(postShown({ posts }, FULL)).toEqual({ link: null });
    expect(
      postShown({ posts }, 'Something else we posted the week before, about drains.'),
    ).toBeNull();
  });

  it('looks further back on Check if it posted than right after posting', async () => {
    const { tab, asked } = facebookTab({ drawsAfter: 0 });
    await lookOn(tab, PAGE, 'Something nobody posted at all, not on this Page.');
    await lookFor('ws', tab, {
      id: '7a1d0b6e-6a52-4a8e-9d0c-3e5f3c1b2a90',
      network: 'facebook',
      text: 'Something nobody posted at all, not on this Page.',
      places: ['page'],
      facebookPage: PAGE,
      postAt: null,
      asked: false,
    });
    expect(asked).toEqual([POSTS_NEWEST, POSTS_LOOKED_BACK]);
    expect(POSTS_LOOKED_BACK).toBeGreaterThan(POSTS_NEWEST);
  });
});

describe('how far a Facebook page has drawn its posts', () => {
  /** A Page's posts as the owner's reports showed them: two boxes with nothing in them but "Loading...". */
  const LOADING = `<div role="article"><div role="status" aria-label="Loading..."><div></div></div></div>`;

  it('finds the first post still loading while none is drawn', () => {
    const { window } = new JSDOM(
      `<body><div role="main"><h2>Posts</h2><div id="a">${LOADING}</div>${LOADING}</div></body>`,
    );
    const now = postsDrawing(window.document);
    expect(now.drawn).toBe(0);
    expect(now.loading).toBe(window.document.querySelector('#a [role="article"]'));
  });

  it('counts the posts drawn and none loading once they are', () => {
    const { window } = new JSDOM(
      `<body><div role="main"><div role="feed">
        <div><span>What happens in the three minutes after you miss a call?</span></div>
        <div><span>An older post about something else</span></div>
      </div></div></body>`,
    );
    expect(postsDrawing(window.document)).toEqual({ drawn: 2, loading: null });
  });
});

describe('Check if it posted, pressed by the person (the owner, 18 Nov)', () => {
  // The owner's Page, 18 Nov 2026: Check if it posted found the newest post, but said Facebook didn't load the Page's
  // posts for the one under it. The reading window was behind theirs, where Facebook draws its newest post and nothing
  // past it, and a look comes in front on its own only while they're away (decision 120).
  const SECOND = [OTHER(0), { text: TEXT, url: null }];
  const post = (asked: boolean): LookPost => ({
    id: '7a1d0b6e-6a52-4a8e-9d0c-3e5f3c1b2a90',
    network: 'facebook',
    text: TEXT,
    places: ['page'],
    facebookPage: PAGE,
    postAt: '2026-11-17T18:00:00.000Z',
    asked,
  });

  it('brings its window in front right away, while they’re at their computer, and finds the post', async () => {
    const started = Date.now();
    const { tab, fronted, frontAsked } = facebookTab({
      drawsAfter: null,
      posts: SECOND,
      front: 'not_away',
      shown: false,
    });
    await lookFor('ws', tab, post(true));
    expect(looked).toEqual([{ found: [{ place: 'page', link: null }], failure: null }]);
    expect(frontAsked).toEqual([true]);
    expect(fronted[0]! - started).toBeLessThan(POSTS_DRAW_MS);
  });

  it('still waits for them to be away when nobody asked, and says it couldn’t check', async () => {
    const { tab, frontAsked } = facebookTab({
      drawsAfter: null,
      posts: SECOND,
      front: 'not_away',
      shown: false,
    });
    await lookFor('ws', tab, post(false));
    expect(looked).toEqual([{ found: [], failure: unseenFailure('page') }]);
    expect(frontAsked).toEqual([false]);
  });
});
