/**
 * AI Social Media Content Creator's reading on Threads and X (src/research/follow-read.ts; decision 41, part 17): pages
 * written here by hand in the shape Threads' and X's kits give (`found`, src/networks/follows), of made-up people, with
 * HandsFreeOS, the extension's storage and the reading tab stood in for. It reads someone's own posts back to `since`
 * (never a repost or a reply to someone else, and a pinned post never stops it); finds creators by a niche's top posts,
 * then X's people search, passing over those known and the person; and says to sign in when sent to sign in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResearchWork } from '../src/research/hfos';

const X = 'https://x.com';
const TH = 'https://www.threads.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const WORK = '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901';
const CREATOR = '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b';
const NOW = Date.UTC(2026, 10, 13, 12);
const daysAgo = (n: number) => NOW - n * 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

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
  runtime: { getManifest: () => ({ version: '0.139.0' }) },
});

const follow = await import('../src/research/follow-read');
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
          outline: 'Page: profile /{1}\n  h2 "[2 words]"',
          shown: false,
        };
      if (name === 'view') return 'Page: profile\nOn top:\n  nothing';
      return null;
    },
  };
}

const work = (over: Partial<ResearchWork>): ResearchWork => ({
  id: WORK,
  kind: 'posts',
  network: 'x',
  niche: null,
  creator: { id: CREATOR, handle: 'jane_maker', link: `${X}/jane_maker`, name: null },
  since: iso(daysAgo(30)),
  known: [],
  most: 30,
  post: null,
  ...over,
});

const ctxOf = (w: ResearchWork, screens: Screens) => {
  const tab = tabWith(screens);
  return { tab, ctx: { businessId: BUSINESS, work: w, tab: tab as never } };
};

/** A post on X as its kit reads it. */
const xPost = (who: string, id: string, ms: number, over: Record<string, unknown> = {}) => ({
  url: `${X}/${who}/status/${id}`,
  author: { username: who, url: `${X}/${who}` },
  name: null,
  text: 'A tip   about\nhomes',
  at: iso(ms),
  when: '2d',
  likes: 40,
  replies: 3,
  liked: false,
  replyingTo: [],
  ...over,
});
const thPost = (who: string, code: string, ms: number) => ({
  ...xPost(who, '1', ms),
  url: `${TH}/@${who}/post/${code}`,
  author: { username: who, url: `${TH}/@${who}` },
});

const page = (
  url: string,
  found: Record<string, unknown>,
  kind = 'profile',
  platform = 'x',
): Record<string, unknown> => ({
  platform,
  kind,
  url,
  people: [],
  posts: [],
  found: { profile: null, posts: [], post: null, replies: [], people: [], me: 'myself', ...found },
});

const janeProfile = (posts: unknown[]) => ({
  username: 'jane_maker',
  url: `${X}/jane_maker`,
  name: 'Jane Maker',
  bio: 'I teach small shops to post',
  links: ['Link: janemaker.example'],
  followers: 12_400,
  following: 'no',
  followsYou: null,
  posts,
});

beforeEach(() => {
  world.stored = {};
  world.calls = [];
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

describe('what a page shows', () => {
  it('keeps a post by its number on X and its code on Threads, with its likes and replies', () => {
    const now = new Date(NOW);
    expect(follow.followPostIn('x', xPost('jane_maker', '185', daysAgo(1)) as never, now)).toEqual({
      postKey: 'status/185',
      link: `${X}/jane_maker/status/185`,
      postedAt: iso(daysAgo(1)),
      kind: 'other',
      caption: 'A tip about homes',
      views: null,
      likes: 40,
      comments: 3,
      shares: null,
      seconds: null,
      pinned: false,
    });
    expect(
      follow.followPostIn('threads', thPost('jane', 'DAbc123xyz', daysAgo(1)) as never, now)
        ?.postKey,
    ).toBe('post/DAbc123xyz');
    expect(follow.followPostIn('x', xPost('jane', '9', NOW + 3_600_000) as never, now)).toBeNull();
  });

  it('marks a profile’s first post pinned when it went up before the one under it', () => {
    const now = new Date(NOW);
    const posts = [
      xPost('jane_maker', '1', daysAgo(300)),
      xPost('jane_maker', '2', daysAgo(1)),
      xPost('jane_maker', '3', daysAgo(2)),
    ] as never[];
    expect(follow.ownPostsOn('x', posts, 'jane_maker', now, true).map((p) => p.pinned)).toEqual([
      true,
      false,
      false,
    ]);
    expect(follow.ownPostsOn('x', posts, 'jane_maker', now, false)[0]!.pinned).toBe(false);
  });
});

describe('reading someone’s posts', () => {
  it('reads their own X posts back to since, past a pinned one, never a repost or a reply to others', async () => {
    const at = `${X}/jane_maker`;
    const first = [
      xPost('jane_maker', '100', daysAgo(400)),
      xPost('jane_maker', '101', daysAgo(2), { likes: 90, replies: 12 }),
      xPost('someone_else', '102', daysAgo(3)),
      xPost('jane_maker', '103', daysAgo(4), { replyingTo: ['someone_else'] }),
      xPost('jane_maker', '104', daysAgo(10)),
    ];
    const { ctx, tab } = ctxOf(work({}), {
      [at]: [
        page(at, { profile: janeProfile(first), posts: first }),
        page(at, {
          profile: janeProfile([]),
          posts: [xPost('jane_maker', '105', daysAgo(25)), xPost('jane_maker', '106', daysAgo(40))],
        }),
        page(at, { posts: [xPost('jane_maker', '107', daysAgo(50))] }),
      ],
    });
    expect(await follow.FOLLOW_READS_BY_KIND.posts(ctx)).toEqual({ failure: null });
    expect(tab.opened).toEqual([at]);
    const read = world.calls.find((c) => c.name === 'creatorRead')!;
    expect(read.args[2]).toEqual({
      name: 'Jane Maker',
      bio: 'I teach small shops to post · Link: janemaker.example',
      followers: 12_400,
      lastPostAt: iso(daysAgo(2)),
      recent: [
        { likes: 90, comments: 12, views: null, caption: 'A tip about homes' },
        { likes: 40, comments: 3, views: null, caption: 'A tip about homes' },
      ],
    });
    const saved = world.calls
      .filter((c) => c.name === 'postsSave')
      .flatMap((c) => c.args[2] as { postKey: string }[]);
    expect(saved.map((p) => p.postKey)).toEqual(['status/101', 'status/104', 'status/105']);
    expect(world.calls.some((c) => c.name === 'report')).toBe(false);
  });

  it('reads a Threads profile the same way', async () => {
    const at = `${TH}/@tidyhomes`;
    const posts = [thPost('tidyhomes', 'DAbc123xyz', daysAgo(1))];
    const { ctx } = ctxOf(
      work({
        network: 'threads',
        creator: { id: CREATOR, handle: 'tidyhomes', link: at, name: null },
      }),
      {
        [at]: [
          page(
            at,
            {
              profile: { ...janeProfile(posts), username: 'tidyhomes', name: null, links: [] },
              posts,
            },
            'profile',
            'threads',
          ),
        ],
      },
    );
    expect(await follow.FOLLOW_READS_BY_KIND.posts(ctx)).toEqual({ failure: null });
    const saved = world.calls.find((c) => c.name === 'postsSave')!.args[2];
    expect(saved).toMatchObject([{ postKey: 'post/DAbc123xyz', likes: 40, comments: 3 }]);
    expect(world.calls.find((c) => c.name === 'creatorRead')!.args[2]).toMatchObject({
      name: null,
      bio: 'I teach small shops to post',
    });
  });
});

describe('finding creators', () => {
  it('gathers X’s top posts’ writers, then its people search, passing over those known and the person', async () => {
    const top = `${X}/search?q=home%20tips&src=typed_query`;
    const people = `${X}/search?q=home%20tips&src=typed_query&f=user`;
    const samAt = `${X}/sam_tidy`;
    const janeAt = `${X}/jane_maker`;
    const { ctx, tab } = ctxOf(
      work({
        kind: 'find',
        creator: null,
        known: ['known_one'],
        most: 5,
        niche: { id: 'n1', name: 'Home tips', searches: ['home tips'] } as never,
      }),
      {
        [top]: [
          page(
            top,
            {
              posts: [
                xPost('Jane_Maker', '1', daysAgo(2)),
                xPost('known_one', '2', daysAgo(1)),
                xPost('myself', '3', daysAgo(1)),
              ],
            },
            'search',
          ),
        ],
        [people]: [
          page(
            people,
            {
              people: [
                { username: 'sam_tidy', url: samAt, name: 'Sam Tidy', following: 'no' },
                { username: 'jane_maker', url: janeAt, name: 'Jane Maker', following: 'no' },
              ],
            },
            'search',
          ),
        ],
        [janeAt]: [page(janeAt, { profile: janeProfile([]) })],
        [samAt]: [
          page(samAt, {
            profile: { ...janeProfile([]), username: 'sam_tidy', name: 'Sam Tidy', followers: 300 },
            posts: [xPost('sam_tidy', '9', daysAgo(6))],
          }),
        ],
      },
    );
    expect(await follow.FOLLOW_READS_BY_KIND.find(ctx)).toEqual({ failure: null });
    expect(tab.opened).toEqual([top, people, janeAt, samAt]);
    const found = world.calls.find((c) => c.name === 'found')!.args[2];
    expect(found).toEqual([
      {
        handle: 'jane_maker',
        name: 'Jane Maker',
        bio: 'I teach small shops to post · Link: janemaker.example',
        followers: 12_400,
        lastPostAt: iso(daysAgo(2)),
        recent: null,
      },
      {
        handle: 'sam_tidy',
        name: 'Sam Tidy',
        bio: 'I teach small shops to post · Link: janemaker.example',
        followers: 300,
        lastPostAt: iso(daysAgo(6)),
        recent: [{ likes: 40, comments: 3, views: null, caption: 'A tip about homes' }],
      },
    ]);
    const said = world.calls
      .filter((c) => c.name === 'progress')
      .map((c) => c.args[2] as Record<string, unknown>);
    expect(said[0]).toMatchObject({ now: 'Searching X for “home tips”', searches: 1 });
    expect(said.at(-1)).toMatchObject({ now: 'Done', accounts: 3, profiles: 2 });
  });

  it('searches Threads’ top posts alone', async () => {
    const top = `${TH}/search?q=home%20tips&serp_type=default`;
    const at = `${TH}/@tidyhomes`;
    const { ctx, tab } = ctxOf(
      work({
        network: 'threads',
        kind: 'find',
        creator: null,
        most: 5,
        niche: { id: 'n1', name: 'Home tips', searches: ['home tips'] } as never,
      }),
      {
        [top]: [page(top, { posts: [thPost('tidyhomes', 'DAbc123xyz', daysAgo(1))] }, 'search')],
        [at]: [page(at, { profile: { ...janeProfile([]), username: 'tidyhomes' } }, 'profile')],
      },
    );
    expect(await follow.FOLLOW_READS_BY_KIND.find(ctx)).toEqual({ failure: null });
    expect(tab.opened).toEqual([top, at]);
    expect(world.calls.find((c) => c.name === 'found')!.args[2]).toMatchObject([
      { handle: 'tidyhomes', lastPostAt: iso(daysAgo(1)) },
    ]);
  });
});

describe('when a page doesn’t show what it reads', () => {
  it('has the helper look, then reports it without a name and rests the network', async () => {
    const at = `${X}/jane_maker`;
    const { ctx } = ctxOf(work({}), { [at]: [page(at, {})] });
    const end = await follow.FOLLOW_READS_BY_KIND.posts(ctx);
    expect(end).toMatchObject({ halt: 'while' });
    expect(end.failure).toMatch(/X’s page didn’t show/);
    expect(world.calls.filter((c) => c.name === 'helperLook')).toHaveLength(1);
    const report = world.calls.find((c) => c.name === 'report')!.args[1] as Record<string, unknown>;
    expect(report).toMatchObject({ addonId: 'socialcontent', area: 'x', job: 'read.posts' });
    expect(JSON.stringify(report)).not.toMatch(/jane/i);
  });

  it('says to sign in when the network sent it to its sign-in', async () => {
    const at = `${X}/jane_maker`;
    const { ctx } = ctxOf(work({}), {
      [at]: [page(`${X}/i/flow/login`, {}, 'login')],
    });
    const end = await follow.FOLLOW_READS_BY_KIND.posts(ctx);
    expect(end).toMatchObject({ halt: 'while' });
    expect(end.failure).toMatch(/X asked to sign in/);
    expect(world.calls.some((c) => c.name === 'report')).toBe(false);
  });

  it('leaves watching to Instagram', async () => {
    expect((await follow.FOLLOW_READS_BY_KIND.watch()).failure).toMatch(/Instagram/);
  });
});
