/**
 * AI Social Media Content Creator's reading on Instagram (src/research/; docs/socialcontent.md, part 2): Instagram's
 * answers written here by hand in the shapes its pages load, of made-up accounts, with HandsFreeOS, the extension's
 * storage and the reading tab stood in for. It reads a profile and posts back to `since`, saving as it goes; finds
 * creators by a hashtag's top posts and a search, passing over those known and private; and when an answer doesn't
 * come, has the AI helper look and sends a report that never names anyone. A warning stops Instagram for the day,
 * for both social add-ons; searches stop before the day's room is used, leaving the rest for ticked creators. Watching a standout video opens its post, asks for its video, and sends the frames and
 * sound the tab took from it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResearchWork } from '../src/research/hfos';

const IG = 'https://www.instagram.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const WORK = '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901';
const CREATOR = '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b';
const NOW = Date.UTC(2026, 10, 8, 12);
const day = (n: number) => Math.round((NOW - n * 86_400_000) / 1000);

const world = vi.hoisted(() => ({
  stored: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown[] }[],
  /** The helper's answers in turn, then `helper`'s. */
  helperQueue: [] as Record<string, unknown>[],
  helper: {
    verdict: 'unclear',
    said: '',
    move: { do: 'none', ref: null, dir: null },
    asked: true,
  } as Record<string, unknown>,
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
    helperLook: call('helperLook', () => world.helperQueue.shift() ?? world.helper),
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

const { INSTAGRAM_READS_BY_KIND } = await import('../src/research/instagram-read');
const { RESEARCH_PACE, RESEARCH_SEARCH_STEPS_A_DAY, RESEARCH_STEPS_A_DAY, roomOn, searchRoomOn } =
  await import('../src/research/read');
const ig = await import('../src/research/instagram');
const { NotAway } = await import('../src/away');
RESEARCH_PACE.openMs = [0, 0];
RESEARCH_PACE.answerMs = [0, 0];
RESEARCH_PACE.settleMs = 0;

/** Instagram's answers by what's asked: a status and a body. */
type Answers = Record<string, { status?: number; json: unknown }>;

/** What the search page holds itself (the tab's `held`), behind another window and in front. */
interface Held {
  accounts?: { username: string; private: boolean | null }[];
  posts?: string[];
  loaded?: string[];
  /** Its posts once it's in front: the grid draws only on screen. */
  inFront?: string[];
  /** The person isn't away, so it never comes in front. */
  notAway?: boolean;
  /** What each profile's page holds itself (the tab's `profileHeld`): with the codes its grid links to. */
  profiles?: Record<string, { creator: unknown; posts: unknown[]; linked?: string[] }>;
  /** What a profile's page holds once it's in front, where its grid draws (and draws more as it's scrolled). */
  profilesInFront?: Record<string, { creator: unknown; posts: unknown[]; linked?: string[] }>;
}

function tabWith(answers: Answers, warnings: string[] = [], held: Held = {}) {
  const opened: string[] = [];
  const asked: string[] = [];
  const moves: unknown[] = [];
  let front = false;
  const tab = {
    opened,
    asked,
    moves,
    fronted: 0,
    tabId: 7,
    open: async (url: string) => void opened.push(url),
    close: async () => undefined,
    inFront: async <T>(work: () => Promise<T>): Promise<T> => {
      if (held.notAway) throw new NotAway();
      tab.fronted++;
      front = true;
      try {
        return await work();
      } finally {
        front = false;
      }
    },
    hands: async (name: string, ...args: unknown[]): Promise<unknown> => {
      if (name === 'warnings') return warnings;
      if (name === 'held')
        return {
          accounts: held.accounts ?? [],
          posts: front ? (held.inFront ?? []) : (held.posts ?? []),
          loaded: held.loaded ?? [],
        };
      if (name === 'scroll') return { moved: true, atEnd: false };
      if (name === 'profileHeld')
        return (
          (front ? held.profilesInFront?.[args[0] as string] : undefined) ??
          held.profiles?.[args[0] as string] ?? { creator: null, posts: [] }
        );
      if (name === 'get') {
        const path = args[0] as string;
        asked.push(path);
        const found = Object.entries(answers).find(([start]) => path.startsWith(start))?.[1];
        const status = found?.status ?? (found ? 200 : 404);
        return { ok: status < 300, status, json: found?.json ?? { message: 'not found' } };
      }
      if (name === 'outline')
        return {
          result: { kind: 'profile', warnings: [] },
          outline: 'Page: profile /{1}/\n  h2 "[1 word]"\n  button "Log in"',
          shown: false,
        };
      if (name === 'view')
        return 'Page: profile /{1}/\nOn top:\n  [1] dialog\n    [2] button "Not now"';
      if (name === 'move') {
        moves.push(args[0]);
        return { went: true, on: 'button "Not now"' };
      }
      return null;
    },
  };
  return tab;
}

const profileJson = (username: string, over: Record<string, unknown> = {}) => ({
  data: {
    user: {
      id: '5550001',
      username,
      full_name: 'Made Up Creator',
      biography: 'Tips for tidy homes',
      is_private: false,
      edge_followed_by: { count: 48_200 },
      edge_owner_to_timeline_media: {
        count: 310,
        edges: [
          {
            node: {
              shortcode: 'PINNED1',
              taken_at_timestamp: day(400),
              pinned_for_users: [{ id: '1' }],
            },
          },
          { node: { shortcode: 'NEWEST1', taken_at_timestamp: day(2) } },
          { node: { shortcode: 'OLDER01', taken_at_timestamp: day(9) } },
        ],
      },
      ...over,
    },
  },
});

const item = (code: string, daysAgo: number, over: Record<string, unknown> = {}) => ({
  code,
  taken_at: day(daysAgo),
  media_type: 1,
  like_count: 120,
  comment_count: 8,
  caption: { text: 'A made-up caption' },
  ...over,
});

const work = (over: Partial<ResearchWork>): ResearchWork => ({
  id: WORK,
  kind: 'posts',
  network: 'instagram',
  niche: null,
  creator: { id: CREATOR, handle: 'tidy.home.tips', link: `${IG}/tidy.home.tips/`, name: null },
  since: new Date(NOW - 30 * 86_400_000).toISOString(),
  known: [],
  most: 30,
  post: null,
  ...over,
});

beforeEach(() => {
  world.stored = {};
  world.calls = [];
  world.helperQueue = [];
  world.helper = {
    verdict: 'unclear',
    said: '',
    move: { do: 'none', ref: null, dir: null },
    asked: true,
  };
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

describe('Instagram’s answers', () => {
  it('reads a profile, leaving out an old pinned post for when they last posted', () => {
    const c = ig.creatorFrom(profileJson('Tidy.Home.Tips'))!;
    expect(c).toMatchObject({
      id: '5550001',
      username: 'tidy.home.tips',
      followers: 48_200,
      private: false,
      posts: 310,
      lastPostAt: new Date(day(2) * 1000).toISOString(),
    });
    expect(ig.creatorFrom({ status: 'ok' })).toBeNull();
  });

  it('reads a page of posts: kinds, a reel’s plays and link, hidden likes, pinned, and the next page', () => {
    const page = ig.postsFrom({
      items: [
        item('REEL001', 1, {
          media_type: 2,
          product_type: 'clips',
          play_count: 90_000,
          video_duration: 31.4,
        }),
        item('HIDDEN1', 3, { like_and_view_counts_disabled: true }),
        item('PINNED2', 200, { timeline_pinned_user_ids: [5550001], media_type: 8 }),
        { code: 'x', taken_at: 'soon' },
      ],
      more_available: true,
      next_max_id: 'NEXT_1',
    })!;
    expect(page.posts).toHaveLength(3);
    expect(page.posts[0]).toMatchObject({
      postKey: 'REEL001',
      link: `${IG}/reel/REEL001/`,
      kind: 'video',
      views: 90_000,
      seconds: 31,
      likes: 120,
    });
    expect(page.posts[1]).toMatchObject({ likes: null, views: null, kind: 'photo' });
    expect(page.posts[2]).toMatchObject({ pinned: true, kind: 'carousel' });
    expect(page.next).toBe('NEXT_1');
    expect(page.oldest).toBe(new Date(day(3) * 1000).toISOString());
    expect(ig.postsFrom({ data: {} })).toBeNull();
  });

  it('finds the accounts behind posts and a search, each once, in the order shown', () => {
    const found = ig.accountsFrom({
      data: {
        top: {
          sections: [
            {
              layout_content: {
                medias: [{ media: { code: 'A1', user: { username: 'First.One' } } }],
              },
            },
            {
              layout_content: {
                medias: [{ media: { code: 'A2', user: { username: 'first.one' } } }],
                fill_items: [{ media: { owner: { username: 'second_one', is_private: true } } }],
              },
            },
          ],
        },
      },
      users: [{ user: { username: 'third.one', is_private: false } }],
    });
    expect(found).toEqual([
      { username: 'first.one', private: null },
      { username: 'second_one', private: true },
      { username: 'third.one', private: false },
    ]);
  });

  it('sorts what went wrong, and makes hashtags of search words', () => {
    expect(ig.troubleOf(429, {})).toBe('warning');
    expect(ig.troubleOf(400, { message: 'Please wait a few minutes before you try again.' })).toBe(
      'warning',
    );
    expect(ig.troubleOf(401, { message: 'login_required' })).toBe('signed_out');
    expect(ig.troubleOf(404, {})).toBe('not_there');
    expect(ig.troubleOf(500, {})).toBe('other');
    expect(ig.tagOf('Home organizing!')).toBe('homeorganizing');
    expect(ig.tagOf('#')).toBeNull();
    expect(ig.INSTAGRAM_READS.test(ig.postsPath('5550001', 'N'))).toBe(true);
    expect(ig.INSTAGRAM_READS.test(ig.postsByNamePath('tidy.home.tips', 'N'))).toBe(true);
    expect(ig.INSTAGRAM_READS.test('/api/v1/feed/user/tidy.home.tips/following/?x')).toBe(false);
    expect(ig.INSTAGRAM_READS.test('/api/v1/friendships/create/1/?x')).toBe(false);
    expect(ig.INSTAGRAM_READS.test('/api/v1/fbsearch/web/keyword_serp/?query=x')).toBe(true);
    expect(ig.SEARCH_LOADED.test('/api/v1/feed/timeline/?x=1')).toBe(false);
    expect(ig.loadedShown('/api/v1/fbsearch/web/top_serp/?enable_metadata=true&query=crm')).toBe(
      '/api/v1/fbsearch/web/top_serp/?enable_metadata&query',
    );
  });
});

describe('reading a creator’s posts', () => {
  it('reads back to since, saving each post once with the profile’s numbers', async () => {
    const tab = tabWith({
      '/api/v1/users/web_profile_info/': { json: profileJson('tidy.home.tips') },
      '/api/v1/feed/user/5550001/?count=12&max_id=NEXT_1': {
        json: {
          items: [item('MID0001', 20), item('OLD0001', 45)],
          more_available: true,
          next_max_id: 'NEXT_2',
        },
      },
      '/api/v1/feed/user/5550001/': {
        json: {
          items: [item('PINNED3', 300, { timeline_pinned_user_ids: [1] }), item('NEW0001', 2)],
          more_available: true,
          next_max_id: 'NEXT_1',
        },
      },
    });
    const end = await INSTAGRAM_READS_BY_KIND.posts({
      businessId: BUSINESS,
      work: work({}),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    expect(tab.opened).toEqual([`${IG}/tidy.home.tips/`]);
    // It stopped once a page went past since, and never asked for NEXT_2.
    expect(tab.asked.some((p) => p.includes('NEXT_2'))).toBe(false);
    const read = world.calls.find((c) => c.name === 'creatorRead')!;
    expect(read.args[2]).toMatchObject({ followers: 48_200, name: 'Made Up Creator' });
    const saved = world.calls
      .filter((c) => c.name === 'postsSave')
      .flatMap((c) => c.args[2] as { postKey: string }[]);
    expect(saved.map((p) => p.postKey)).toEqual(['NEW0001', 'MID0001']);
    expect(world.stored['hfos-research-cursor']).toBeUndefined();
    // What it's doing, for the Creators page: whose posts, and how many it read.
    const said = world.calls
      .filter((c) => c.name === 'progress')
      .map((c) => c.args[2] as Record<string, unknown>);
    expect(said[0]).toMatchObject({ now: 'Reading @tidy.home.tips’s profile' });
    expect(said.at(-1)).toMatchObject({ now: 'Done', profiles: 1, posts: 2 });
  });

  it('reads their posts from their page when Instagram’s list of them isn’t there', async () => {
    const tab = tabWith(
      {
        '/api/v1/users/web_profile_info/': { json: profileJson('tidy.home.tips') },
        '/api/v1/feed/user/': { status: 404, json: { message: 'not found' } },
      },
      [],
      {
        profiles: {
          'tidy.home.tips': {
            creator: null,
            posts: [ig.postFrom(item('PAGE001', 3))!, ig.postFrom(item('PAGE002', 60))!],
          },
        },
      },
    );
    const end = await INSTAGRAM_READS_BY_KIND.posts({
      businessId: BUSINESS,
      work: work({}),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    const saved = world.calls
      .filter((c) => c.name === 'postsSave')
      .flatMap((c) => c.args[2] as { postKey: string }[]);
    // Since is 30 days back: the 60-day-old one is left out.
    expect(saved.map((p) => p.postKey)).toEqual(['PAGE001']);
    const sent = world.calls.find((c) => c.name === 'report')!.args[1] as { note: string };
    expect(sent.note).toContain('read from their page');
  });

  describe('when Instagram’s profile answer isn’t there', () => {
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    /** A post's code as Instagram makes one some days ago: its number starts with the time since Instagram's start. */
    const codeFor = (daysAgo: number, more = 1234n): string => {
      let n = ((BigInt(NOW - daysAgo * 86_400_000) - 1_314_220_021_721n) << 23n) | more;
      let code = '';
      while (n > 0n) {
        code = LETTERS[Number(n % 64n)] + code;
        n /= 64n;
      }
      return code;
    };
    const fromPage = (id: string | null, linked: string[] = []) => ({
      'tidy.home.tips': {
        creator: {
          id,
          username: 'tidy.home.tips',
          name: 'Made Up Creator',
          bio: null,
          followers: 48_000,
          private: false,
          lastPostAt: new Date(day(2) * 1000).toISOString(),
          posts: 310,
        },
        posts: [],
        linked,
      },
    });
    const savedKeys = () =>
      world.calls
        .filter((c) => c.name === 'postsSave')
        .flatMap((c) => (c.args[2] as { postKey: string }[]).map((p) => p.postKey));
    const read = (tab: ReturnType<typeof tabWith>) =>
      INSTAGRAM_READS_BY_KIND.posts({ businessId: BUSINESS, work: work({}), tab: tab as never });

    it('asks for their posts by the number their page names itself with', async () => {
      const tab = tabWith(
        {
          '/api/v1/feed/user/5550009/?': {
            json: { items: [item('NEW0001', 2), item('OLD0001', 45)], more_available: false },
          },
        },
        [],
        { profiles: fromPage('5550009') },
      );
      expect(await read(tab)).toEqual({ failure: null });
      expect(savedKeys()).toEqual(['NEW0001']);
      expect(tab.asked.filter((p) => p.startsWith('/api/v1/feed/'))).toEqual([
        '/api/v1/feed/user/5550009/?count=12',
      ]);
      expect(world.calls.some((c) => c.name === 'report' || c.name === 'helperLook')).toBe(false);
    });

    it('asks by their name when it has no number, or that list isn’t there, and reads on from it', async () => {
      const tab = tabWith(
        {
          '/api/v1/feed/user/tidy.home.tips/username/?count=12&max_id=NEXT_1': {
            json: { items: [item('MID0001', 20), item('OLD0001', 45)], more_available: false },
          },
          '/api/v1/feed/user/tidy.home.tips/username/': {
            json: { items: [item('NEW0001', 2)], more_available: true, next_max_id: 'NEXT_1' },
          },
          '/api/v1/feed/user/5550009/': { status: 500, json: null },
        },
        [],
        { profiles: fromPage('5550009') },
      );
      expect(await read(tab)).toEqual({ failure: null });
      expect(savedKeys()).toEqual(['NEW0001', 'MID0001']);
      expect(tab.asked.filter((p) => p.startsWith('/api/v1/feed/'))).toEqual([
        '/api/v1/feed/user/5550009/?count=12',
        '/api/v1/feed/user/tidy.home.tips/username/?count=12',
        '/api/v1/feed/user/tidy.home.tips/username/?count=12&max_id=NEXT_1',
      ]);
      // The first way not coming isn't a problem while another does: no helper, no report.
      expect(world.calls.some((c) => c.name === 'report' || c.name === 'helperLook')).toBe(false);
    });

    it('reads the posts their grid links to one at a time when no list comes', async () => {
      const newest = codeFor(2);
      const older = codeFor(10);
      const tab = tabWith(
        {
          [ig.mediaInfoPath(ig.mediaIdOf(newest)!)]: { json: { items: [item('NEWEST1', 2)] } },
          [ig.mediaInfoPath(ig.mediaIdOf(older)!)]: { json: { items: [item('OLDER01', 10)] } },
        },
        [],
        { profiles: fromPage(null, [newest, older, codeFor(60)]) },
      );
      expect(await read(tab)).toEqual({ failure: null });
      expect(savedKeys()).toEqual(['NEWEST1', 'OLDER01']);
      // The one from before since was never asked for.
      expect(tab.asked.filter((p) => p.startsWith('/api/v1/media/'))).toHaveLength(2);
      // Read one at a time is the usual way now: not a problem to report.
      expect(world.calls.some((c) => c.name === 'report')).toBe(false);
    });

    it('scrolls their page in front for more of their grid while it’s all since the read’s start', async () => {
      const first = [codeFor(2), codeFor(3)];
      const below = [codeFor(5, 7n), codeFor(8, 7n)];
      const answers = Object.fromEntries(
        [...first, ...below].map((code, i) => [
          ig.mediaInfoPath(ig.mediaIdOf(code)!),
          { json: { items: [item(`GRID00${i}`, [2, 3, 5, 8][i]!)] } },
        ]),
      );
      const tab = tabWith(answers, [], {
        profiles: fromPage(null, first),
        profilesInFront: fromPage(null, [...first, ...below, codeFor(45)]),
      });
      expect(await read(tab)).toEqual({ failure: null });
      expect(tab.fronted).toBe(1);
      expect(savedKeys()).toEqual(['GRID000', 'GRID001', 'GRID002', 'GRID003']);
      // The one from before since, further down, was never asked for.
      expect(tab.asked.filter((p) => p.startsWith('/api/v1/media/'))).toHaveLength(4);
    });

    it('reads what their page showed when you aren’t away to bring it in front', async () => {
      const first = [codeFor(2), codeFor(3)];
      const tab = tabWith(
        Object.fromEntries(
          first.map((code, i) => [
            ig.mediaInfoPath(ig.mediaIdOf(code)!),
            { json: { items: [item(`GRID00${i}`, i + 2)] } },
          ]),
        ),
        [],
        { notAway: true, profiles: fromPage(null, first) },
      );
      expect(await read(tab)).toEqual({ failure: null });
      expect(tab.fronted).toBe(0);
      expect(savedKeys()).toEqual(['GRID000', 'GRID001']);
    });

    it('reports what each way answered, and says so, when not one of their posts comes', async () => {
      const tab = tabWith({}, [], {
        profiles: fromPage(null, [codeFor(2), codeFor(3), codeFor(4)]),
      });
      const end = await read(tab);
      expect(end).toMatchObject({ halt: 'while' });
      expect(end.failure).toContain('HandsFreeOS got a report');
      // Two of their grid's posts didn't come, so the third was never asked for.
      expect(tab.asked.filter((p) => p.startsWith('/api/v1/media/'))).toHaveLength(2);
      expect(savedKeys()).toEqual([]);
      const sent = world.calls.filter((c) => c.name === 'report');
      expect(sent).toHaveLength(1);
      expect((sent[0]!.args[1] as { note: string }).note).toMatch(
        /list of their posts didn’t come \(by name: 404.*their grid’s posts didn’t either/,
      );
      expect(world.calls.some((c) => c.name === 'helperLook')).toBe(false);
    });

    it('finishes with nothing new when their grid’s posts are all from before the read’s start', async () => {
      const tab = tabWith({}, [], { profiles: fromPage(null, [codeFor(60), codeFor(90)]) });
      expect(await read(tab)).toEqual({ failure: null });
      expect(tab.asked.filter((p) => p.startsWith('/api/v1/media/'))).toEqual([]);
      expect(world.calls.some((c) => c.name === 'report')).toBe(false);
    });
  });

  it('says a private account’s posts can’t be read', async () => {
    const tab = tabWith({
      '/api/v1/users/web_profile_info/': {
        json: profileJson('tidy.home.tips', { is_private: true }),
      },
    });
    const end = await INSTAGRAM_READS_BY_KIND.posts({
      businessId: BUSINESS,
      work: work({}),
      tab: tab as never,
    });
    expect(end.failure).toContain('private');
    expect(tab.asked.some((p) => p.startsWith('/api/v1/feed/'))).toBe(false);
  });
});

describe('finding creators', () => {
  it('reads the hashtag’s authors first, then the search’s, passing over known and private accounts', async () => {
    const tab = tabWith({
      '/api/v1/tags/web_info/?tag_name=homeorganizing': {
        json: {
          data: {
            top: {
              sections: [
                {
                  layout_content: {
                    medias: [
                      { media: { code: 'A1', user: { username: 'known.one' } } },
                      { media: { code: 'A2', user: { username: 'tag.author' } } },
                      { media: { code: 'A3', user: { username: 'locked.one', is_private: true } } },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
      '/api/v1/web/search/topsearch/': { json: { users: [{ user: { username: 'search.one' } }] } },
      '/api/v1/users/web_profile_info/?username=tag.author': { json: profileJson('tag.author') },
      '/api/v1/users/web_profile_info/?username=search.one': { json: profileJson('search.one') },
    });
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: work({
        kind: 'find',
        creator: null,
        since: null,
        known: ['known.one'],
        niche: { id: CREATOR, name: 'Home organizing', searches: ['Home organizing'] },
      }),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    expect(tab.opened[0]).toBe(`${IG}/explore/search/keyword/?q=Home%20organizing`);
    const found = world.calls.find((c) => c.name === 'found')!.args[2] as { handle: string }[];
    expect(found.map((f) => f.handle)).toEqual(['tag.author', 'search.one']);
  });
});

describe('finding creators when hashtags’ pages are gone', () => {
  const findWork = (searches: string[]) =>
    work({
      kind: 'find',
      creator: null,
      since: null,
      known: [],
      niche: { id: CREATOR, name: 'Home services', searches },
    });

  it('reads who posted what the search page shows, and searches accounts without the #', async () => {
    const tab = tabWith({
      '/api/v1/fbsearch/web/top_serp/?enable_metadata=true&query=%23hvacbusiness': {
        json: {
          media_grid: {
            sections: [
              {
                layout_content: {
                  medias: [{ media: { code: 'B1', user: { username: 'serp.author' } } }],
                },
              },
            ],
          },
        },
      },
      '/api/v1/tags/web_info/': { json: { data: {} } },
      '/api/v1/web/search/topsearch/?context=blended&query=hvacbusiness&': {
        json: { users: [{ user: { username: 'named.one' } }] },
      },
      '/api/v1/users/web_profile_info/?username=serp.author': { json: profileJson('serp.author') },
      '/api/v1/users/web_profile_info/?username=named.one': { json: profileJson('named.one') },
    });
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: findWork(['#hvacbusiness']),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    expect(tab.opened[0]).toBe(`${IG}/explore/search/keyword/?q=%23hvacbusiness`);
    const found = world.calls.find((c) => c.name === 'found')!.args[2] as { handle: string }[];
    expect(found.map((f) => f.handle)).toEqual(['serp.author', 'named.one']);
  });

  /** Instagram's own answers, each showing nobody. */
  const nobody: Answers = {
    '/api/v1/fbsearch/web/top_serp/': { json: { media_grid: { sections: [] } } },
    '/api/v1/tags/web_info/': { json: { data: {} } },
    '/api/v1/web/search/topsearch/': { json: { users: [] } },
  };
  const gridPost: Answers = {
    [`/api/v1/media/${ig.mediaIdOf('C0DE1')}/info/`]: {
      json: { items: [{ code: 'C0DE1', user: { username: 'grid.author' } }] },
    },
    '/api/v1/users/web_profile_info/?username=grid.author': { json: profileJson('grid.author') },
  };
  const foundHandles = () =>
    (world.calls.find((c) => c.name === 'found')!.args[2] as { handle: string }[]).map(
      (f) => f.handle,
    );

  it('falls back to who posted the page’s own posts when no answer had anyone', async () => {
    const tab = tabWith({ ...nobody, ...gridPost }, [], { posts: ['C0DE1'] });
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: findWork(['#plumbingbusiness']),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    expect(foundHandles()).toEqual(['grid.author']);
    // Its links were there already: no need for the window in front.
    expect(tab.fronted).toBe(0);
  });

  it('takes the accounts in the data the search page came with', async () => {
    const tab = tabWith(
      {
        ...nobody,
        '/api/v1/users/web_profile_info/?username=held.author': {
          json: profileJson('held.author'),
        },
      },
      [],
      { accounts: [{ username: 'held.author', private: null }] },
    );
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: findWork(['crm software']),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    expect(foundHandles()).toEqual(['held.author']);
  });

  it('asks again for a search answer the page loaded itself, and only search answers', async () => {
    const keyword = '/api/v1/fbsearch/web/keyword_serp/?query=crm%20software&count=30';
    const tab = tabWith(
      {
        ...nobody,
        [keyword]: {
          json: {
            media_grid: {
              sections: [{ medias: [{ media: { user: { username: 'loaded.one' } } }] }],
            },
          },
        },
        '/api/v1/users/web_profile_info/?username=loaded.one': { json: profileJson('loaded.one') },
      },
      [],
      { loaded: ['/api/graphql', '/api/v1/feed/timeline/?x=1', keyword] },
    );
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: findWork(['crm software']),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    expect(foundHandles()).toEqual(['loaded.one']);
    expect(tab.asked).toContain(keyword);
    expect(tab.asked.some((p) => p.startsWith('/api/v1/feed/timeline'))).toBe(false);
    expect(tab.asked).not.toContain('/api/graphql');
  });

  it('brings the search page in front for its grid to draw, when its links aren’t there yet', async () => {
    const tab = tabWith({ ...nobody, ...gridPost }, [], { inFront: ['C0DE1'] });
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: findWork(['#automation']),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    expect(tab.fronted).toBe(1);
    expect(foundHandles()).toEqual(['grid.author']);
  });

  it('says to step away when the grid needed the screen and the person wasn’t away', async () => {
    const tab = tabWith(nobody, [], {
      notAway: true,
      loaded: ['/api/v1/fbsearch/web/top_serp/?enable_metadata=true&query=x', '/api/graphql'],
    });
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: findWork(['#automation']),
      tab: tab as never,
    });
    expect(end.failure).toContain('away');
    const sent = world.calls.find((c) => c.name === 'report')!.args[1] as {
      found: Record<string, unknown>;
    };
    expect(sent.found).toMatchObject({
      notAway: true,
      loaded: ['/api/v1/fbsearch/web/top_serp/?enable_metadata&query', '/api/graphql'],
    });
  });

  it('says what it’s doing as it goes: the searches, the accounts it looked at, the profiles it read', async () => {
    const tab = tabWith({ ...nobody, ...gridPost }, [], { posts: ['C0DE1'] });
    await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: findWork(['#crm', '#automation']),
      tab: tab as never,
    });
    const said = world.calls
      .filter((c) => c.name === 'progress')
      .map((c) => c.args[2] as Record<string, unknown>);
    expect(said[0]).toMatchObject({ now: 'Searching Instagram for “#crm”', searches: 2 });
    expect(said.some((p) => p.now === 'Searching Instagram for “#automation”')).toBe(true);
    expect(said.some((p) => String(p.now).startsWith('Reading profiles: 1 of 1'))).toBe(true);
    expect(said.at(-1)).toMatchObject({
      now: 'Done',
      searched: ['#crm', '#automation'],
      searches: 2,
      accounts: 1,
      profiles: 1,
    });
  });

  it('reads a profile from its page when Instagram’s answer says it isn’t there', async () => {
    const tab = tabWith(
      {
        ...nobody,
        '/api/v1/web/search/topsearch/': { json: { users: [{ user: { username: 'page.only' } }] } },
      },
      [],
      {
        profiles: {
          'page.only': {
            creator: {
              id: null,
              username: 'page.only',
              name: 'Page Only',
              bio: 'CRM tips',
              followers: 12_000,
              private: false,
              lastPostAt: new Date(day(3) * 1000).toISOString(),
              posts: 200,
            },
            posts: [],
          },
        },
      },
    );
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: findWork(['crm']),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    expect(world.calls.find((c) => c.name === 'found')!.args[2]).toEqual([
      {
        handle: 'page.only',
        name: 'Page Only',
        bio: 'CRM tips',
        followers: 12_000,
        lastPostAt: new Date(day(3) * 1000).toISOString(),
      },
    ]);
  });

  it('reads when they last posted from their grid in front, while you’re away, when the page didn’t say', async () => {
    const pageOnly = {
      id: null,
      username: 'page.only',
      name: 'Page Only',
      bio: null,
      followers: 12_000,
      private: false,
      lastPostAt: null,
      posts: 200,
    };
    const tab = tabWith(
      {
        ...nobody,
        '/api/v1/web/search/topsearch/': { json: { users: [{ user: { username: 'page.only' } }] } },
      },
      [],
      {
        profiles: { 'page.only': { creator: pageOnly, posts: [] } },
        profilesInFront: {
          'page.only': {
            creator: { ...pageOnly, lastPostAt: new Date(day(2) * 1000).toISOString() },
            posts: [],
          },
        },
      },
    );
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: findWork(['crm']),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    expect(tab.fronted).toBe(1);
    expect(world.calls.find((c) => c.name === 'found')!.args[2]).toEqual([
      expect.objectContaining({
        handle: 'page.only',
        lastPostAt: new Date(day(2) * 1000).toISOString(),
      }),
    ]);
    expect(world.calls.some((c) => c.name === 'report')).toBe(false);
  });

  it('reports when no profile read said when they last posted, as nobody can be suggested', async () => {
    const tab = tabWith(
      {
        ...nobody,
        '/api/v1/web/search/topsearch/': { json: { users: [{ user: { username: 'page.only' } }] } },
      },
      [],
      {
        notAway: true,
        profiles: {
          'page.only': {
            creator: {
              id: null,
              username: 'page.only',
              name: null,
              bio: null,
              followers: 29_000,
              private: false,
              lastPostAt: null,
              posts: 80,
            },
            posts: [],
          },
        },
      },
    );
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: findWork(['crm']),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    expect(tab.fronted).toBe(0);
    expect(world.calls.find((c) => c.name === 'found')!.args[2]).toEqual([
      expect.objectContaining({ handle: 'page.only', followers: 29_000, lastPostAt: null }),
    ]);
    const sent = world.calls.find((c) => c.name === 'report')!.args[1] as {
      note: string;
      found: Record<string, unknown>;
    };
    expect(sent.note).toContain('none of the 1 profiles read said when they last posted');
    expect(sent.found).toMatchObject({ profilesRead: 1, undated: 1, fromPage: 1 });
  });

  it('says so and reports when Instagram wouldn’t open any profile, rather than finishing with nobody', async () => {
    const tab = tabWith({
      ...nobody,
      '/api/v1/web/search/topsearch/': {
        json: { users: [{ user: { username: 'one.gone' } }, { user: { username: 'two.gone' } }] },
      },
      '/api/v1/users/web_profile_info/': {
        status: 404,
        json: { message: 'User not found', status: 'fail' },
      },
    });
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: findWork(['crm']),
      tab: tab as never,
    });
    expect(end.failure).toContain('wouldn’t open any of the 2 profiles');
    expect(world.calls.some((c) => c.name === 'found')).toBe(false);
    const sent = world.calls.find((c) => c.name === 'report')!.args[1] as {
      note: string;
      found: Record<string, unknown>;
    };
    expect(sent.note).toContain('404 · User not found');
    expect(sent.found).toMatchObject({ accounts: 2, notOpened: 2, profilesRead: 0 });
    const said = world.calls
      .filter((c) => c.name === 'progress')
      .map((c) => c.args[2] as Record<string, unknown>);
    expect(said.at(-1)).toMatchObject({ accounts: 2, profiles: 0, notOpened: 2 });
  });

  it('reports, and says so, when not one search showed anyone', async () => {
    const tab = tabWith(nobody);
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: findWork(['#homeservicebusiness', '#hvacbusiness']),
      tab: tab as never,
    });
    expect(end.failure).toContain('showed nobody');
    expect(world.calls.some((c) => c.name === 'found')).toBe(false);
    const sent = world.calls.find((c) => c.name === 'report')!.args[1] as Record<string, unknown>;
    expect(sent).toMatchObject({
      addonId: 'socialcontent',
      area: 'instagram',
      job: 'read.find',
      found: expect.objectContaining({ searched: 2, posts: 0, accounts: 0, grid: 0 }),
    });
  });
});

describe('when a read goes wrong', () => {
  it('has the helper look, then reports without naming anyone, and rests Instagram while signed out', async () => {
    world.helper = {
      verdict: 'refused',
      said: 'Instagram asks to log in.',
      move: { do: 'none', ref: null, dir: null },
      asked: true,
    };
    const tab = tabWith({
      '/api/v1/users/web_profile_info/': { status: 401, json: { message: 'login_required' } },
    });
    const end = await INSTAGRAM_READS_BY_KIND.profile({
      businessId: BUSINESS,
      work: work({ kind: 'profile' }),
      tab: tab as never,
    });
    expect(end).toMatchObject({ halt: 'while' });
    expect(end.failure).toContain('sign in');
    const look = world.calls.find((c) => c.name === 'helperLook')!.args[1] as Record<
      string,
      unknown
    >;
    expect(look).toMatchObject({ network: 'instagram', read: 'profile' });
    const sent = world.calls.find((c) => c.name === 'report')!.args[1] as Record<string, unknown>;
    expect(sent).toMatchObject({
      addonId: 'socialcontent',
      area: 'instagram',
      job: 'read.profile',
      ref: WORK,
      path: '/{1}/',
      helper: { verdict: 'refused', looks: 1 },
    });
    expect(JSON.stringify(sent)).not.toContain('tidy.home.tips');
  });

  it('tries once more when the helper cleared something in the way', async () => {
    const said = 'A box about notifications covers the page.';
    world.helperQueue = [
      { verdict: 'in_the_way', said, move: { do: 'click', ref: 2, dir: null }, asked: true },
      { verdict: 'in_the_way', said, move: { do: 'none', ref: null, dir: null }, asked: true },
    ];
    let tries = 0;
    const tab = tabWith({});
    const hands = tab.hands;
    tab.hands = async (name: string, ...args: unknown[]) => {
      if (name !== 'get') return hands(name, ...args);
      tries++;
      return tries === 1
        ? { ok: false, status: 500, json: null }
        : { ok: true, status: 200, json: profileJson('tidy.home.tips') };
    };
    const end = await INSTAGRAM_READS_BY_KIND.profile({
      businessId: BUSINESS,
      work: work({ kind: 'profile' }),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    expect(tries).toBe(2);
    expect(tab.moves).toEqual([{ do: 'click', ref: 2, dir: null }]);
    expect(world.calls.some((c) => c.name === 'report')).toBe(false);
  });

  it('stops Instagram for the day on a warning, for both social add-ons', async () => {
    const tab = tabWith({
      '/api/v1/users/web_profile_info/': {
        status: 429,
        json: { message: 'Please wait a few minutes before you try again.' },
      },
    });
    const end = await INSTAGRAM_READS_BY_KIND.profile({
      businessId: BUSINESS,
      work: work({ kind: 'profile' }),
      tab: tab as never,
    });
    expect(end).toMatchObject({ halt: 'day' });
    expect(world.stored['hfos.warned']).toMatchObject({
      instagram: { words: ['Please wait a few minutes before you try again.'] },
    });
    expect(world.calls.some((c) => c.name === 'helperLook')).toBe(false);
  });
});

describe('the day’s room', () => {
  const usedToday = (steps: number) => {
    world.stored['hfos-research-day'] = {
      day: new Date().toLocaleDateString('en-CA'),
      steps: { instagram: steps },
    };
  };
  const theirPosts = () =>
    tabWith({
      '/api/v1/users/web_profile_info/': { json: profileJson('tidy.home.tips') },
      '/api/v1/feed/user/5550001/': {
        json: { items: [item('NEW0001', 2)], more_available: false },
      },
    });

  it('keeps the rest of the day for ticked creators once searches used their share', async () => {
    usedToday(RESEARCH_SEARCH_STEPS_A_DAY);
    expect(await searchRoomOn('instagram')).toBe(false);
    expect(await roomOn('instagram')).toBe(true);
    const tab = tabWith({});
    const end = await INSTAGRAM_READS_BY_KIND.find({
      businessId: BUSINESS,
      work: work({
        kind: 'find',
        creator: null,
        since: null,
        niche: { id: CREATOR, name: 'Home organizing', searches: ['Home organizing'] },
      }),
      tab: tab as never,
    });
    expect(end.failure).toMatch(/^Searching Instagram for new creators stopped for today/);
    // Instagram isn't stopped for the day: a ticked creator's posts are still read.
    expect(end.halt).toBeUndefined();
    expect(tab.opened).toEqual([]);
    const read = await INSTAGRAM_READS_BY_KIND.posts({
      businessId: BUSINESS,
      work: work({}),
      tab: theirPosts() as never,
    });
    expect(read).toEqual({ failure: null });
    expect(world.calls.some((c) => c.name === 'postsSave')).toBe(true);
  });

  it('stops all reading on a network once the whole day is used', async () => {
    usedToday(RESEARCH_STEPS_A_DAY);
    expect(await roomOn('instagram')).toBe(false);
    const end = await INSTAGRAM_READS_BY_KIND.posts({
      businessId: BUSINESS,
      work: work({}),
      tab: theirPosts() as never,
    });
    expect(end).toMatchObject({ halt: 'day' });
    expect(end.failure).toMatch(/^Reading on Instagram stopped for today/);
  });
});

describe('watching a standout video', () => {
  const POST = '4d5e6f70-8192-43a4-b5c6-d7e8f90a1b2c';

  it('turns a post’s code into its number, picks a small enough file, and spreads its frames', () => {
    // Instagram's own example: the code B and the number 1, and a real-shaped one.
    expect(ig.mediaIdOf('B')).toBe('1');
    expect(ig.mediaIdOf('BA')).toBe('64');
    expect(ig.mediaIdOf('C1a_b-2')).toMatch(/^\d+$/);
    expect(ig.mediaIdOf('C1a_b-2LONGERPRIVATEPART')).toBe(ig.mediaIdOf('C1a_b-2LONG'));
    expect(ig.mediaIdOf('no spaces')).toBeNull();
    const video = ig.videoOf({
      items: [
        {
          video_duration: 31.4,
          has_audio: true,
          video_versions: [
            { width: 1080, url: 'https://scontent-lax3-1.cdninstagram.com/v/big.mp4' },
            { width: 640, url: 'https://scontent-lax3-1.cdninstagram.com/v/mid.mp4' },
            { width: 360, url: 'https://scontent-lax3-1.cdninstagram.com/v/small.mp4' },
            { width: 480, url: 'https://elsewhere.example.com/v/not-instagram.mp4' },
          ],
        },
      ],
    });
    expect(video).toEqual({
      url: 'https://scontent-lax3-1.cdninstagram.com/v/mid.mp4',
      seconds: 31.4,
      sound: true,
    });
    expect(ig.videoOf({ items: [{ video_versions: [] }] })).toBeNull();
    const times = ig.frameTimes(31.4, 12);
    expect(times).toHaveLength(12);
    expect(times.slice(0, 3)).toEqual([0.3, 1.2, 2.5]);
    expect(Math.max(...times)).toBeLessThan(31.4);
    expect(ig.frameTimes(2, 12)).toEqual([0.3, 1.2, 1.8]);
    expect(ig.frameTimes(Number.NaN, 12)).toEqual([0]);
    expect(ig.INSTAGRAM_READS.test(ig.mediaInfoPath('123'))).toBe(true);
    expect(ig.INSTAGRAM_READS.test('/api/v1/media/123/comments/')).toBe(false);
  });

  it('opens the post, asks for its video, and sends what the tab took from it', async () => {
    const tab = tabWith({
      '/api/v1/media/': {
        json: {
          items: [
            {
              video_duration: 20,
              has_audio: false,
              video_versions: [{ width: 720, url: 'https://scontent.cdninstagram.com/v/a.mp4' }],
            },
          ],
        },
      },
    });
    const watched: unknown[] = [];
    const hands = tab.hands;
    tab.hands = async (name: string, ...args: unknown[]) => {
      if (name !== 'watch') return hands(name, ...args);
      watched.push(args[0]);
      return { ok: true, seconds: 20, frames: [{ at: 0.3, jpeg: 'AAAA' }], sound: 'UklGRg==' };
    };
    const end = await INSTAGRAM_READS_BY_KIND.watch({
      businessId: BUSINESS,
      work: work({
        kind: 'watch',
        post: { id: POST, postKey: 'BA', link: `${IG}/reel/BA/`, seconds: 20 },
      }),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: null });
    expect(tab.opened).toEqual([`${IG}/reel/BA/`]);
    expect(tab.asked).toEqual(['/api/v1/media/64/info/']);
    expect(watched).toEqual([
      expect.objectContaining({ url: 'https://scontent.cdninstagram.com/v/a.mp4', most: 12 }),
    ]);
    const sent = world.calls.find((c) => c.name === 'watchSend');
    // A video Instagram says has no sound sends none.
    expect(sent?.args).toEqual([
      BUSINESS,
      { workId: WORK, postId: POST, seconds: 20, frames: [{ at: 0.3, jpeg: 'AAAA' }], sound: null },
    ]);
  });

  it('says why when the video couldn’t be watched', async () => {
    const tab = tabWith({
      '/api/v1/media/': {
        json: {
          items: [
            { video_versions: [{ width: 720, url: 'https://scontent.cdninstagram.com/v/a.mp4' }] },
          ],
        },
      },
    });
    const hands = tab.hands;
    tab.hands = async (name: string, ...args: unknown[]) =>
      name === 'watch'
        ? { ok: false, failure: 'The video couldn’t play on the reading computer.' }
        : hands(name, ...args);
    const end = await INSTAGRAM_READS_BY_KIND.watch({
      businessId: BUSINESS,
      work: work({
        kind: 'watch',
        post: { id: POST, postKey: 'BA', link: `${IG}/p/BA/`, seconds: null },
      }),
      tab: tab as never,
    });
    expect(end).toEqual({ failure: 'The video couldn’t play on the reading computer.' });
    expect(world.calls.some((c) => c.name === 'watchSend')).toBe(false);
  });
});
