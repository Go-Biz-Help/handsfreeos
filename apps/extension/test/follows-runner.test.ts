/**
 * Threads' and X's runners (src/auto/follows.ts, decision 163), with the extension's storage, HandsFreeOS and the
 * network's tab stood in for, on pages written here by hand in the shape X draws, of made-up accounts. Its tab presses
 * by X's own kit (src/networks/follows/). What it does on its list: the warm-up (the post someone was found by liked
 * first on its own page, or their reply to a good post, found under it and liked on its own page), the follow on their
 * own profile, and a comment posted only once OK'd, only in the post's own box; never a message. Every hour: its search,
 * only the posts under 2 days old sent for the AI's check, and the replies to the person's comments from their
 * mentions. Each step is noted as the extension's own, as the network's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayListItem } from '../src/hfos/messages';

const X = 'https://x.com';
const DANA = `${X}/dana_reyes`;
const POST = `${DANA}/status/1111`;
const ME = { userId: 'u-casey', businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
const PROFILE_ID = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';
const POST_ID = '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b';

vi.setConfig({ testTimeout: 30_000 });

const world = vi.hoisted(() => ({
  pages: (_url: string): string | null => null,
  behave: (_doc: Document, _url: string): void => undefined,
  opened: [] as string[],
  noted: [] as { note: unknown; platform: unknown }[],
  asked: [] as { type: string; input?: unknown }[],
  posted: [] as { path: string; body: Record<string, unknown> }[],
  hfos: {} as Record<string, (ask: Record<string, unknown>) => unknown>,
}));

vi.mock('../src/hfos/session', () => {
  class Refused extends Error {
    constructor(readonly problem: { readonly message: string; readonly status?: number | null }) {
      super(problem.message);
    }
  }
  return {
    Refused,
    savingTo: async () => ME,
    answer: async (ask: { type: string; input?: unknown }) => {
      world.asked.push(ask);
      const found = world.hfos[ask.type];
      return { ok: true, value: found ? found(ask as Record<string, unknown>) : {} };
    },
    answerWith: async (_t: string, fn: () => Promise<unknown>) => ({ ok: true, value: await fn() }),
    api: () => ({
      POST: async (path: string, options: { body: Record<string, unknown> }) => {
        world.posted.push({ path, body: options.body });
        return { data: {}, response: { ok: true, status: 200 } };
      },
    }),
    call: async (request: Promise<{ data?: unknown }>) => (await request).data,
  };
});
vi.mock('../src/hfos/follow', () => ({
  SETTINGS_KEY: 'hfos.settings',
  follow: async () => undefined,
  loadSettings: async () => null,
}));
vi.mock('../src/hfos/noting', async (original) => ({
  ...(await original<object>()),
  isNoting: async () => true,
  takeNote: async (note: unknown, platform: unknown) => void world.noted.push({ note, platform }),
  noteNeed: async () => undefined,
}));
vi.mock('../src/hfos/waiting', () => ({
  POPUP_ID: 'hfos-waiting',
  popUp: async () => undefined,
  waitingSoon: () => undefined,
}));
vi.mock('../src/hfos/looked', () => ({ noteWarnings: async () => undefined }));
vi.mock('../src/auto/run', () => ({ tick: async () => undefined }));
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));
// The network's tab: each address opens its page, which its kit reads and presses on as the tab's script does.
vi.mock('../src/tab', async () => {
  const { JSDOM: Dom } = await import('jsdom');
  const { kitOf } = await import('../src/networks');
  return {
    WorkTab: class {
      private doc: Document | null = null;
      private at = '';
      get tabId() {
        return this.doc ? 9 : null;
      }
      async adopt() {}
      async focus() {}
      async loaded() {}
      async keepInFront() {}
      async close() {
        this.doc = null;
      }
      async inFront<T>(work: () => Promise<T>) {
        return work();
      }
      async open(url: string) {
        world.opened.push(url);
        const html = world.pages(url);
        if (html === null) throw new Error(`No page for ${url}`);
        this.at = url;
        this.doc = new Dom(`<!doctype html><html><body>${html}</body></html>`, {
          url,
        }).window.document;
        world.behave(this.doc, url);
        return 9;
      }
      async ask(message: { readonly type: string }) {
        const doc = this.doc;
        if (!doc) return { ok: false, error: 'The tab was closed.' };
        const kit = kitOf(this.at)!;
        if (message.type === 'hfos-read') return { ok: true, result: kit.readPage(doc, this.at) };
        const here = globalThis as { location?: unknown; document?: unknown };
        here.location = new URL(this.at);
        here.document = doc;
        try {
          return (
            (await kit.work!(message)) ?? { ok: false, error: `Not expected: ${message.type}` }
          );
        } finally {
          delete here.location;
          delete here.document;
        }
      }
    },
  };
});

const store = new Map<string, unknown>();
beforeAll(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter((k) => store.has(k))
              .map((k) => [k, store.get(k)]),
          ),
        set: async (values: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(values)) store.set(k, JSON.parse(JSON.stringify(v)));
        },
        remove: async (keys: string | string[]) => {
          for (const k of [keys].flat()) store.delete(k);
        },
      },
      onChanged: { addListener: () => undefined },
    },
    runtime: { getManifest: () => ({ version: '0.137.0' }) },
    alarms: { get: async () => undefined, create: async () => undefined, clear: async () => true },
    notifications: { clear: async () => true },
  });
});
afterAll(() => vi.unstubAllGlobals());

const { FOLLOW_RUNNERS, followWorkLeft, nextFollowDaily, nextSearch, searchDue } =
  await import('../src/auto/follows');
const runner = FOLLOW_RUNNERS.x;

// ------------------------------------------------------------------------------------------------- X's pages

const MENU = `<nav><a data-testid="AppTabBar_Profile_Link" href="/casey_owner">Profile</a></nav>`;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const tweet = (
  handle: string,
  id: string,
  text: string,
  { at = hoursAgo(2), liked = false, replying = '' } = {},
) => `<article data-testid="tweet">
  <div data-testid="User-Name"><a href="/${handle}"><span>${handle.replace('_', ' ')}</span></a>
    <a href="/${handle}/status/${id}"><time datetime="${at}">2h</time></a></div>
  ${replying ? `<div>Replying to <a href="/${replying}">@${replying}</a></div>` : ''}
  <div data-testid="tweetText">${text}</div>
  <div role="group"><button data-testid="reply" aria-label="Reply"></button>
    <button data-testid="${liked ? 'unlike' : 'like'}" aria-label="Like"></button></div></article>`;
const column = (inner: string) => `${MENU}<div data-testid="primaryColumn">${inner}</div>`;
const FOLLOW = '<button data-testid="77-follow">Follow</button>';
const FOLLOWING = '<button data-testid="77-unfollow">Following</button>';
const profile = (button: string) =>
  column(`<div><div>${button}</div>
    <div data-testid="UserName"><div><span>Dana Reyes</span></div><div><span>@dana_reyes</span></div></div>
    <div data-testid="UserDescription">Realtor in Austin.</div>
    <div><a href="/dana_reyes/followers"><span>320</span> Followers</a></div></div>
    ${tweet('dana_reyes', '2222', 'Just listed in Hyde Park')}
    ${tweet('dana_reyes', '3333', 'Market update for November')}`);
const BOX = `<div><div data-testid="tweetTextarea_0"><div contenteditable="true" role="textbox"></div></div>
  <button data-testid="tweetButtonInline">Reply</button></div>`;

/** Like buttons say Liked once pressed; Follow says Following; the reply box sends what's typed in it. */
function pressesWork(doc: Document): void {
  for (const like of doc.querySelectorAll('[data-testid="like"]'))
    like.addEventListener('click', () => like.setAttribute('data-testid', 'unlike'));
  const follow = doc.querySelector('[data-testid="77-follow"]');
  follow?.addEventListener('click', () => (follow.outerHTML = FOLLOWING));
  const box = doc.querySelector<HTMLElement>('[contenteditable="true"]');
  if (box) {
    doc.execCommand = (_c: string, _u?: boolean, words?: string) => {
      box.textContent = words ?? '';
      return true;
    };
    doc.querySelector('[data-testid="tweetButtonInline"]')!.addEventListener('click', () => {
      world.asked.push({ type: 'sent-on-x', input: box.textContent });
      box.textContent = '';
    });
  }
}

const item = (more: Partial<TodayListItem>): TodayListItem =>
  ({
    kind: 'warm_up',
    name: 'Dana Reyes',
    profileId: PROFILE_ID,
    profileUrl: DANA,
    chatId: null,
    threadKey: null,
    postId: null,
    postUrl: null,
    posted: null,
    post: null,
    asking: false,
    why: [],
    summary: null,
    nextStep: null,
    playbookName: null,
    demoLink: null,
    videoLink: null,
    personId: null,
    demoBooked: false,
    send: null,
    recent: [],
    ...more,
  }) as TodayListItem;

const noted = () =>
  world.noted.map(({ note, platform }) => {
    const step = (note as { step: { kind: string; auto: boolean; postUrl: string | null } }).step;
    return { kind: step.kind, auto: step.auto, postUrl: step.postUrl, platform };
  });

beforeEach(() => {
  store.clear();
  world.opened.length = 0;
  world.noted.length = 0;
  world.asked.length = 0;
  world.posted.length = 0;
  world.hfos = {};
  world.pages = () => null;
  world.behave = pressesWork;
});

// ------------------------------------------------------------------------------------------------- the list

describe('what it does on X’s list', () => {
  it('warms up and follows on its own, drafts and sends comments, and never a message', () => {
    const send = {
      sendId: 's1',
      state: 'approved' as const,
      text: 'Nice',
      handedOver: false,
      needsYou: null,
    };
    const list = {
      items: [
        item({ kind: 'friend_request' }),
        item({ kind: 'warm_up', name: 'Sam Lee', profileId: 'p-sam' }),
        item({
          kind: 'comment',
          name: 'Avery Lane',
          profileId: 'p-avery',
          postId: POST_ID,
          postUrl: POST,
        }),
        item({
          kind: 'comment',
          name: 'Lee Park',
          profileId: 'p-lee',
          postId: 'p2',
          postUrl: POST,
          send,
        }),
        item({ kind: 'opener', name: 'Jo Day', profileId: 'p-jo' }),
      ],
      auto: ['warm_up', 'friend_request', 'confirm'],
      messages: ['comment', 'opener'],
      sending: 'steps',
    } as never;
    // What's OK'd goes first, as on every network.
    expect(followWorkLeft(list, []).map((w) => [w.do, w.item.kind, w.item.name])).toEqual([
      ['send', 'comment', 'Lee Park'],
      ['step', 'friend_request', 'Dana Reyes'],
      ['step', 'warm_up', 'Sam Lee'],
      ['draft', 'comment', 'Avery Lane'],
    ]);
  });

  it('does its once-a-day jobs in order, and searches every hour', () => {
    expect(nextFollowDaily({ daily: {} })).toBe('requests');
    expect(nextFollowDaily({ daily: { requests: 'a' } })).toBe('follow_backs');
    expect(nextFollowDaily({ daily: { requests: 'a', follow_backs: 'b' } })).toBe('tidy');
    const read = { requests: 'a', follow_backs: 'b', tidy: 'c' };
    expect(nextFollowDaily({ daily: read })).toBe('post_people');
    expect(nextFollowDaily({ daily: { ...read, post_people: 'd' } })).toBe('found_checks');
    expect(nextFollowDaily({ daily: { ...read, post_people: 'd', found_checks: 'e' } })).toBe(
      'profile',
    );
    expect(
      nextFollowDaily({ daily: { ...read, post_people: 'd', found_checks: 'e', profile: 'f' } }),
    ).toBeNull();
    const at = Date.parse('2026-11-13T15:00:00Z');
    expect(searchDue({ watchAt: null }, at)).toBe(true);
    expect(searchDue({ watchAt: at + 1 }, at)).toBe(false);
    for (const random of [0, 0.5, 1]) {
      const next = nextSearch('x', at, random) - at;
      expect(next).toBeGreaterThanOrEqual(54 * 60_000);
      expect(next).toBeLessThanOrEqual(66 * 60_000);
    }
  });

  it('likes the post someone was found by first, on its own page, then follows the next day', async () => {
    world.pages = (url) =>
      url === POST
        ? column(tweet('dana_reyes', '1111', 'Who do you use for a CRM?'))
        : url === DANA
          ? profile(FOLLOW)
          : null;
    const warm = await runner.doWork(
      { do: 'step', item: item({ postUrl: POST, post: 'Who do you use for a CRM?' }) },
      ME.businessId,
      0,
    );
    expect(warm).toEqual({
      done: true,
      line: 'Liked Dana Reyes’s post it found: the follow comes tomorrow',
    });
    expect(world.opened).toEqual([POST]);
    const follow = await runner.doWork(
      { do: 'step', item: item({ kind: 'friend_request' }) },
      ME.businessId,
    );
    expect(follow).toMatchObject({ done: true, line: 'Followed Dana Reyes' });
    expect(noted()).toEqual([
      { kind: 'like', auto: true, postUrl: POST, platform: 'x' },
      { kind: 'friend_request', auto: true, postUrl: null, platform: 'x' },
    ]);
  });

  it('likes their reply to a good post on the reply’s own page, then one of their latest while likes have room', async () => {
    const REPLY = `${DANA}/status/4444`;
    const GOOD = `${X}/sam_lee/status/9999`;
    world.pages = (url) =>
      url === GOOD
        ? column(
            `${tweet('sam_lee', '9999', 'Best CRM for a small team?')}${tweet('dana_reyes', '4444', 'Following this', { replying: 'sam_lee' })}`,
          )
        : url === REPLY
          ? column(tweet('dana_reyes', '4444', 'Following this', { replying: 'sam_lee' }))
          : url === DANA
            ? profile(FOLLOW)
            : url === `${DANA}/status/2222`
              ? column(tweet('dana_reyes', '2222', 'Just listed in Hyde Park'))
              : null;
    const warm = await runner.doWork(
      {
        do: 'step',
        item: item({ postUrl: GOOD, likeComment: true, post: 'Best CRM for a small team?' }),
      },
      ME.businessId,
      5,
    );
    expect(warm).toEqual({
      done: true,
      line: 'Liked Dana Reyes’s reply it found and a post of theirs: the follow comes tomorrow',
    });
    expect(noted().map((n) => n.postUrl)).toEqual([REPLY, `${DANA}/status/2222`]);
  });

  it('posts a comment once it’s OK’d, only in the post’s own box, and says it went', async () => {
    world.pages = (url) =>
      url === POST ? column(`${tweet('dana_reyes', '1111', 'Who do you use?')}${BOX}`) : null;
    const text = 'We text your leads for you. Happy to show you how.';
    const went = await runner.doWork(
      {
        do: 'send',
        item: item({
          kind: 'comment',
          postId: POST_ID,
          postUrl: POST,
          send: { sendId: 'send-1', state: 'approved', text, handedOver: false, needsYou: null },
        } as Partial<TodayListItem>),
      },
      ME.businessId,
    );
    expect(went).toEqual({ done: true, line: 'Commented on Dana Reyes’s post' });
    expect(world.asked.filter((a) => a.type === 'sent-on-x').map((a) => a.input)).toEqual([text]);
    expect(
      world.posted.find((p) => p.path === '/v1/commands/outreach.send.done')?.body,
    ).toMatchObject({
      sendId: 'send-1',
      sent: true,
    });
    expect(noted()).toEqual([{ kind: 'comment', auto: true, postUrl: POST, platform: 'x' }]);
  });
});

describe('X’s hourly search', () => {
  it('sends only the posts under 2 days old, never the person’s own, then reads replies to their comments', async () => {
    const SEARCH = `${X}/search?q=${encodeURIComponent('crm for realtors')}&src=typed_query&f=live`;
    world.pages = (url) =>
      url === SEARCH
        ? column(
            `${tweet('dana_reyes', '1111', 'Which CRM texts leads for realtors?')}${tweet('casey_owner', '1212', 'Our CRM texts leads')}${tweet('sam_lee', '1313', 'Old question', { at: hoursAgo(60) })}`,
          )
        : url === `${X}/notifications/mentions`
          ? column(tweet('avery_lane', '1414', 'Yes, I’d love a demo', { replying: 'casey_owner' }))
          : null;
    world.hfos = {
      'hfos-post-words': () => ({ words: ['crm for realtors'] }),
      'hfos-save-posts': () => ({ checking: 1 }),
      'hfos-comment-replies': () => ({ kept: 1 }),
    };
    const end = await runner.searchHour(ME.businessId);
    expect(end.warned).toBe(false);
    const saved = world.asked.find((a) => a.type === 'hfos-save-posts')?.input as {
      posts: { url: string }[];
      words: string | null;
    };
    expect(saved.posts.map((p) => p.url)).toEqual([`${X}/dana_reyes/status/1111`]);
    const replies = world.asked.find((a) => a.type === 'hfos-comment-replies')?.input as {
      replies: { url: string; toComment: boolean }[];
    };
    expect(replies.replies).toEqual([
      expect.objectContaining({ url: `${X}/avery_lane/status/1414`, toComment: true }),
    ]);
    expect(end.line).toContain('1 post sent for the AI to check');
    expect(end.line).toContain('1 new reply to your comments on X');
    // Its next look is an hour on.
    const state = store.get('hfos.auto.x') as { watchAt: number };
    expect(state.watchAt - Date.now()).toBeGreaterThan(50 * 60_000);
  });
});
