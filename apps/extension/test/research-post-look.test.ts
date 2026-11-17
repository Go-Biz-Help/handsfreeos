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
import { postsDrawing } from '../src/networks/facebook/posts';
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

const { failureFor, lookOn, POSTS_DRAW_MS, POSTS_NEWEST } = await import('../src/research/posting');
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
 * away).
 */
function facebookTab(opts: {
  drawsAfter: number | null;
  posts?: { text: string; url: string | null }[];
  front?: 'draws' | 'not_away';
  drawing?: boolean;
}) {
  let scrolls = 0;
  let inFront = false;
  const fronted: number[] = [];
  const posts = opts.posts ?? [{ text: TEXT, url: LINK }];
  const drawn = () => inFront || (opts.drawsAfter !== null && scrolls >= opts.drawsAfter);
  const tab = {
    open: async () => 0,
    hands: async (name: string, ...args: unknown[]) => {
      if (name === 'warnings') return [];
      if (name === 'read') return { kind: 'profile', posts: drawn() ? posts : [] };
      if (name === 'drawPosts') {
        // A network that draws its posts with the page (LinkedIn's) has nothing to wait on.
        if (opts.drawing === false) return { drawn: 0, loading: false, shown: true };
        const most = args[0] as number;
        const count = drawn() ? posts.length : 0;
        const loading = count < most && (!drawn() || count === 0);
        if (loading) scrolls++;
        return { drawn: count, loading, shown: false };
      }
      return null;
    },
    inFront: async <T>(work: () => Promise<T>) => {
      fronted.push(Date.now());
      if (opts.front !== 'draws') throw new NotAway();
      inFront = true;
      try {
        return await work();
      } finally {
        inFront = false;
      }
    },
  };
  return { tab: tab as unknown as ResearchTab, scrolls: () => scrolls, fronted };
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
    expect(await lookOn(tab, PAGE, TEXT)).toEqual({ link: LINK, seen: true });
    expect(scrolls()).toBe(3);
    expect(fronted).toEqual([]);
  });

  it('says it’s not there once the newest few are drawn without it', async () => {
    const posts = Array.from({ length: POSTS_NEWEST }, (_, i) => OTHER(i));
    const { tab, fronted } = facebookTab({ drawsAfter: 1, posts });
    expect(await lookOn(tab, PAGE, TEXT)).toEqual({ link: null, seen: true });
    expect(fronted).toEqual([]);
  });

  it('waits by the clock, then looks once more in front while the person is away', async () => {
    const started = Date.now();
    const { tab, fronted } = facebookTab({ drawsAfter: null, front: 'draws' });
    expect(await lookOn(tab, PAGE, TEXT)).toEqual({ link: LINK, seen: true });
    expect(fronted).toHaveLength(1);
    expect(fronted[0]! - started).toBeGreaterThanOrEqual(POSTS_DRAW_MS);
    expect(fronted[0]! - started).toBeLessThan(POSTS_DRAW_MS + 10_000);
  });

  it('says it couldn’t see them when they never drew and the person isn’t away', async () => {
    const { tab, fronted } = facebookTab({ drawsAfter: null, front: 'not_away' });
    expect(await lookOn(tab, PAGE, TEXT)).toEqual({ link: null, seen: false });
    expect(fronted).toHaveLength(1);
  });

  it('reads a page that draws its posts with it (LinkedIn’s) once, as before', async () => {
    const { tab, scrolls, fronted } = facebookTab({ drawsAfter: null, drawing: false });
    expect(await lookOn(tab, PAGE, TEXT)).toEqual({ link: null, seen: true });
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
    });
    expect(looked).toEqual([{ found: [{ place: 'page', link: LINK }], failure: null }]);
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
