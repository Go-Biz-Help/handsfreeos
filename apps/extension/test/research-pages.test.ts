/**
 * AI Social Media Content Creator's reading on Facebook and LinkedIn (src/research/page-read.ts; docs/socialcontent.md,
 * part 6): pages written here by hand in the shapes the extension's own readers give (src/networks/facebook and
 * src/networks/linkedin `readPage`), of made-up people, with HandsFreeOS, the extension's storage and the reading tab
 * stood in for. It reads someone's posts back to `since`, leaving out others' posts on their page; finds creators by a
 * niche's post search, then its people search, passing over those known; and when a page doesn't show what it reads,
 * has the AI helper look and sends a report that never names anyone. A sign-in page says to sign in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResearchWork } from '../src/research/hfos';

const LI = 'https://www.linkedin.com';
const FB = 'https://www.facebook.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const WORK = '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901';
const CREATOR = '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b';
const NOW = Date.UTC(2026, 10, 8, 12);
const daysAgo = (n: number) => NOW - n * 86_400_000;
/** A LinkedIn activity number posted at a time: its first 41 bits are the milliseconds. */
const activity = (ms: number) => (BigInt(ms) << 22n).toString();
const liPost = (ms: number) => `${LI}/feed/update/urn:li:activity:${activity(ms)}/`;

const world = vi.hoisted(() => ({
  stored: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown[] }[],
}));

vi.mock('../src/research/hfos', () => {
  class ResearchRefused extends Error {
    constructor(
      message: string,
      readonly rule: string | null,
      readonly status: number | null,
    ) {
      super(message);
    }
  }
  const call =
    (name: string, answer: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      world.calls.push({ name, args });
      return answer(...args);
    };
  return {
    ResearchRefused,
    creatorsFound: call('found', () => ({ suggested: 1, didntFit: 0 })),
    creatorRead: call('creatorRead', () => ({ ok: true })),
    postsSave: call('postsSave', (_b, _c, posts) => ({
      saved: (posts as unknown[]).length,
      standouts: 0,
      newStandouts: [],
    })),
    reportProblem: call('report', () => ({ reportId: 'r1' })),
    workProgress: call('progress', () => ({ ok: true })),
    helperLook: call('helperLook', () => ({
      verdict: 'unclear',
      said: 'Nothing in the way.',
      move: { do: 'none', ref: null, dir: null },
      asked: true,
    })),
    watchSend: call('watchSend', () => ({ watched: true, failure: null })),
  };
});

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: world.stored[key] }),
      set: async (values: Record<string, unknown>) => void Object.assign(world.stored, values),
      remove: async (key: string) => void delete world.stored[key],
    },
  },
  runtime: { getManifest: () => ({ version: '0.127.0' }) },
});

const pages = await import('../src/research/page-read');
const { RESEARCH_PACE } = await import('../src/research/read');
RESEARCH_PACE.openMs = [0, 0];
RESEARCH_PACE.answerMs = [0, 0];
RESEARCH_PACE.settleMs = 0;

/** Each page's reads by address: one for each screen scrolled. */
type Screens = Record<string, Record<string, unknown>[]>;

function tabWith(screens: Screens) {
  const opened: string[] = [];
  let at = '';
  let screen = 0;
  return {
    opened,
    tabId: 7,
    open: async (url: string) => {
      opened.push(url);
      at = url;
      screen = 0;
    },
    close: async () => undefined,
    hands: async (name: string): Promise<unknown> => {
      const list = screens[at] ?? [];
      if (name === 'warnings') return [];
      if (name === 'read') return list[Math.min(screen, list.length - 1)] ?? null;
      if (name === 'scroll') {
        const moved = screen < list.length - 1;
        if (moved) screen++;
        return { moved, atEnd: screen >= list.length - 1 };
      }
      if (name === 'outline')
        return {
          result: { kind: list[0]?.kind ?? 'other', warnings: [] },
          outline: 'Page: activity /in/{1}/recent-activity/all/\n  h2 "[2 words]"',
          shown: false,
        };
      if (name === 'view') return 'Page: activity\nOn top:\n  nothing';
      return null;
    },
  };
}

const work = (over: Partial<ResearchWork>): ResearchWork => ({
  id: WORK,
  kind: 'posts',
  network: 'linkedin',
  niche: null,
  creator: { id: CREATOR, handle: 'in/jane-maker', link: `${LI}/in/jane-maker/`, name: null },
  since: new Date(daysAgo(30)).toISOString(),
  known: [],
  most: 30,
  post: null,
  ...over,
});

const ctxOf = (w: ResearchWork, screens: Screens) => {
  const tab = tabWith(screens);
  return { tab, ctx: { businessId: BUSINESS, work: w, tab: tab as never } };
};

const linked = (name: string, url: string) => ({ name, profile: { url } });
const post = (author: ReturnType<typeof linked> | null, url: string, over = {}) => ({
  author,
  url,
  when: null,
  text: 'A tip   about\nhomes',
  comments: 4,
  reactions: 120,
  ...over,
});
/** A post as these reads hold it, once a page's read is taken in. */
const held = (p: ReturnType<typeof post>) =>
  pages.shownOf({ kind: 'feed', url: '', posts: [p] })!.posts[0]!;
const jane = linked('Jane Maker', `${LI}/in/jane-maker/`);
const janeProfile = {
  platform: 'linkedin',
  kind: 'profile',
  url: `${LI}/in/jane-maker/`,
  profile: {
    name: 'Jane Maker',
    headline: 'I teach small shops to post',
    about: 'Ten years of tips.',
    followers: 12_400,
  },
  warnings: [],
};

beforeEach(() => {
  world.stored = {};
  world.calls = [];
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

describe('what a page shows', () => {
  it('reads a profile, its posts and the people a page lists', () => {
    const shown = pages.shownOf({
      kind: 'profile',
      url: `${FB}/tidyhomes`,
      profile: { name: 'Tidy Homes', intro: ['Tips for tidy homes', ''], followers: 48_000 },
      posts: [post(linked('Tidy Homes', `${FB}/tidyhomes`), `${FB}/tidyhomes/posts/pfbid1`)],
      people: [linked('Sam Tidy', `${FB}/sam.tidy`), { name: '' }],
      warnings: [],
    });
    expect(shown).toMatchObject({
      kind: 'profile',
      profile: { name: 'Tidy Homes', bio: 'Tips for tidy homes', followers: 48_000 },
      posts: [{ author: { name: 'Tidy Homes', url: `${FB}/tidyhomes` }, reactions: 120 }],
      people: [{ name: 'Sam Tidy', url: `${FB}/sam.tidy` }],
    });
    expect(pages.shownOf(null)).toBeNull();
  });

  it('tells when a LinkedIn post went up from its number, or from how long ago it says', () => {
    const at = daysAgo(3);
    expect(pages.linkedInPostedAt(liPost(at))).toBe(new Date(at).toISOString());
    expect(pages.linkedInPostedAt(`${LI}/in/jane-maker/`)).toBeNull();
    const ways = pages.PAGE_WAYS.linkedin;
    expect(ways.postedAt(held(post(jane, `${LI}/posts/x`, { when: '2d' })), new Date(NOW))).toBe(
      new Date(daysAgo(2)).toISOString(),
    );
  });

  it('keeps a post with its reactions as likes, and no views', () => {
    const p = pages.postInOf(
      pages.PAGE_WAYS.linkedin,
      held(post(jane, liPost(daysAgo(1)))),
      new Date(),
    );
    expect(p).toMatchObject({
      postKey: `activity:${activity(daysAgo(1))}`,
      kind: 'other',
      caption: 'A tip about homes',
      views: null,
      likes: 120,
      comments: 4,
    });
    // No time to weigh it by: left out.
    expect(
      pages.postInOf(pages.PAGE_WAYS.facebook, held(post(null, `${FB}/x/posts/1`)), new Date()),
    ).toBe(null);
  });
});

describe('reading someone’s posts', () => {
  it('reads a LinkedIn member’s recent activity back to since, leaving out others’ posts', async () => {
    const activityPage = `${LI}/in/jane-maker/recent-activity/all/`;
    const other = linked('Someone Else', `${LI}/in/someone-else/`);
    const { ctx, tab } = ctxOf(work({}), {
      [`${LI}/in/jane-maker/`]: [janeProfile],
      [activityPage]: [
        {
          kind: 'activity',
          url: activityPage,
          posts: [post(jane, liPost(daysAgo(1))), post(other, liPost(daysAgo(2)))],
        },
        {
          kind: 'activity',
          url: activityPage,
          posts: [
            post(jane, liPost(daysAgo(1))),
            post(jane, liPost(daysAgo(10))),
            post(jane, liPost(daysAgo(45))),
          ],
        },
      ],
    });
    expect(await pages.PAGE_READS_BY_KIND.posts(ctx)).toEqual({ failure: null });
    expect(tab.opened).toEqual([`${LI}/in/jane-maker/`, activityPage]);
    const read = world.calls.find((c) => c.name === 'creatorRead')!;
    expect(read.args[2]).toMatchObject({
      name: 'Jane Maker',
      bio: 'I teach small shops to post · Ten years of tips.',
      followers: 12_400,
    });
    const saved = world.calls
      .filter((c) => c.name === 'postsSave')
      .flatMap((c) => c.args[2] as { postKey: string }[]);
    expect(saved.map((p) => p.postKey)).toEqual([
      `activity:${activity(daysAgo(1))}`,
      `activity:${activity(daysAgo(10))}`,
    ]);
    expect(world.calls.some((c) => c.name === 'report')).toBe(false);
  });

  it('reads a Facebook profile’s own posts on the profile', async () => {
    const page = `${FB}/tidyhomes`;
    const tidy = linked('Tidy Homes', page);
    const { ctx, tab } = ctxOf(
      work({
        network: 'facebook',
        creator: { id: CREATOR, handle: 'tidyhomes', link: page, name: null },
      }),
      {
        [page]: [
          {
            kind: 'profile',
            url: page,
            profile: { name: 'Tidy Homes', intro: [], followers: 9_000 },
            posts: [post(tidy, `${page}/posts/pfbid1`, { when: '3h' })],
          },
        ],
      },
    );
    expect(await pages.PAGE_READS_BY_KIND.posts(ctx)).toEqual({ failure: null });
    expect(tab.opened).toEqual([page]);
    const saved = world.calls.find((c) => c.name === 'postsSave')!.args[2] as {
      postKey: string;
      likes: number;
    }[];
    expect(saved).toMatchObject([{ postKey: '/tidyhomes/posts/pfbid1', likes: 120 }]);
  });

  it('says a LinkedIn company page’s posts come later', async () => {
    const { ctx, tab } = ctxOf(
      work({ creator: { id: CREATOR, handle: 'company/tidy-co', link: '', name: null } }),
      {},
    );
    const end = await pages.PAGE_READS_BY_KIND.posts(ctx);
    expect(end.failure).toMatch(/comes later/);
    expect(tab.opened).toEqual([]);
  });
});

describe('finding creators', () => {
  it('gathers post authors, then people, passing over those known, and reads their profiles', async () => {
    const search = `${LI}/search/results/content/?keywords=home%20tips`;
    const people = `${LI}/search/results/people/?keywords=home%20tips`;
    const known = linked('Known One', `${LI}/in/known-one/`);
    const sam = linked('Sam Tidy', `${LI}/in/sam-tidy/`);
    const { ctx, tab } = ctxOf(
      work({
        kind: 'find',
        creator: null,
        known: ['in/known-one'],
        most: 5,
        niche: { id: 'n1', name: 'Home tips', searches: ['home tips'] } as never,
      }),
      {
        [search]: [
          {
            kind: 'search-posts',
            url: search,
            posts: [post(jane, liPost(daysAgo(2))), post(known, liPost(daysAgo(1)))],
          },
        ],
        [people]: [{ kind: 'search-people', url: people, people: [sam, jane] }],
        [`${LI}/in/jane-maker/`]: [janeProfile],
        [`${LI}/in/sam-tidy/`]: [
          {
            kind: 'profile',
            url: `${LI}/in/sam-tidy/`,
            profile: { name: 'Sam Tidy', headline: 'Tidy tips', followers: 300 },
          },
        ],
      },
    );
    expect(await pages.PAGE_READS_BY_KIND.find(ctx)).toEqual({ failure: null });
    expect(tab.opened).toEqual([search, people, `${LI}/in/jane-maker/`, `${LI}/in/sam-tidy/`]);
    const found = world.calls.find((c) => c.name === 'found')!.args[2];
    expect(found).toEqual([
      {
        handle: 'in/jane-maker',
        name: 'Jane Maker',
        bio: 'I teach small shops to post · Ten years of tips.',
        followers: 12_400,
        lastPostAt: new Date(daysAgo(2)).toISOString(),
      },
      {
        handle: 'in/sam-tidy',
        name: 'Sam Tidy',
        bio: 'Tidy tips',
        followers: 300,
        lastPostAt: null,
      },
    ]);
    // What it's doing, for the Creators page: the search, everyone it showed (the known one too), the profiles read.
    const said = world.calls
      .filter((c) => c.name === 'progress')
      .map((c) => c.args[2] as Record<string, unknown>);
    expect(said[0]).toMatchObject({ now: 'Searching LinkedIn for “home tips”', searches: 1 });
    expect(said.at(-1)).toMatchObject({
      now: 'Done',
      searched: ['home tips'],
      accounts: 3,
      profiles: 2,
    });
  });
});

describe('when a page doesn’t show what it reads', () => {
  it('has the helper look, then reports it without a name and rests the network', async () => {
    const { ctx } = ctxOf(work({}), {
      [`${LI}/in/jane-maker/`]: [{ kind: 'profile', url: `${LI}/in/jane-maker/`, profile: {} }],
    });
    const end = await pages.PAGE_READS_BY_KIND.posts(ctx);
    expect(end).toMatchObject({ halt: 'while' });
    expect(end.failure).toMatch(/LinkedIn’s page didn’t show/);
    expect(world.calls.filter((c) => c.name === 'helperLook')).toHaveLength(1);
    const report = world.calls.find((c) => c.name === 'report')!.args[1] as Record<string, unknown>;
    expect(report).toMatchObject({ addonId: 'socialcontent', area: 'linkedin', job: 'read.posts' });
    expect(JSON.stringify(report)).not.toMatch(/jane/i);
  });

  it('says to sign in when the network sent it to its sign-in', async () => {
    const { ctx } = ctxOf(work({}), {
      [`${LI}/in/jane-maker/`]: [{ kind: 'other', url: `${LI}/authwall?trk=x` }],
    });
    const end = await pages.PAGE_READS_BY_KIND.posts(ctx);
    expect(end).toMatchObject({ halt: 'while' });
    expect(end.failure).toMatch(/asked to sign in/);
    expect(world.calls.some((c) => c.name === 'report')).toBe(false);
  });

  it('leaves watching to Instagram', async () => {
    expect((await pages.PAGE_READS_BY_KIND.watch()).failure).toMatch(/Instagram/);
  });
});
