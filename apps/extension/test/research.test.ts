/**
 * AI Social Media Content Creator's reading on Instagram (src/research/; docs/socialcontent.md, part 2): Instagram's
 * answers written here by hand in the shapes its pages load, of made-up accounts, with HandsFreeOS, the extension's
 * storage and the reading tab stood in for. It reads a profile and posts back to `since`, saving as it goes; finds
 * creators by a hashtag's top posts and a search, passing over those known and private; and when an answer doesn't
 * come, has the AI helper look and sends a report that never names anyone. A warning stops Instagram for the day,
 * for both social add-ons.
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
    helperLook: call('helperLook', () => world.helperQueue.shift() ?? world.helper),
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
const { RESEARCH_PACE } = await import('../src/research/read');
const ig = await import('../src/research/instagram');
RESEARCH_PACE.openMs = [0, 0];
RESEARCH_PACE.answerMs = [0, 0];
RESEARCH_PACE.settleMs = 0;

/** Instagram's answers by what's asked: a status and a body. */
type Answers = Record<string, { status?: number; json: unknown }>;

function tabWith(answers: Answers, warnings: string[] = []) {
  const opened: string[] = [];
  const asked: string[] = [];
  const moves: unknown[] = [];
  return {
    opened,
    asked,
    moves,
    tabId: 7,
    open: async (url: string) => void opened.push(url),
    close: async () => undefined,
    hands: async (name: string, ...args: unknown[]): Promise<unknown> => {
      if (name === 'warnings') return warnings;
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
    expect(ig.INSTAGRAM_READS.test('/api/v1/friendships/create/1/?x')).toBe(false);
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
