/**
 * Instagram's runner (src/auto/instagram.ts; the Instagram and Alignable plan's part 14), with the extension's storage,
 * HandsFreeOS and Instagram's tab stood in for, on pages written here by hand as the owner's Check Instagram found
 * them, of made-up accounts. Its tab presses by Instagram's own kit (src/networks/instagram/auto.ts). It works only
 * while Instagram's day is started and its Sending isn't Off; before Instagram's first day it saves the followers
 * first; a warm-up looks at their account and likes one or two of their recent posts on each one's own page, never one
 * about grief, or counts the look alone when there's none; Follow is pressed only on their own account; a message goes
 * only once OK'd, typed only into their chat's own box, and one to their Requests as one text; Find partners searches
 * Instagram, the hashtag of its words and the accounts Instagram suggests; once a day it looks at the day's hashtags
 * and the places in the area their posts were tagged at, and reads the notifications for warm leads (part 15); and an
 * Instagram warning stops it for the day. Each step is noted as the extension's own, as Instagram's. From 0.95.0
 * (decision 92): about 10 posts a hashtag, each hashtag's saved with it; who liked and commented on the good ones,
 * never the person, the writer or anyone they follow; the post someone was found by liked first; and a comment drafted
 * for its OK, then posted only in the post's own box.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { TodayListItem } from '../src/hfos/messages';
import type { Hfos, Job } from '../src/jobs/job';
import type { ReportNote } from '../src/jobs/report';

const IG = 'https://www.instagram.com';
const DANA = `${IG}/dana.reyes/`;
const DANA_CHAT = `${IG}/direct/t/111/`;
const ME = { userId: 'u-casey', businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
const PROFILE_ID = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';
/** A good post HandsFreeOS keeps (decision 92). */
const POST_ID = '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b';

// The runner waits for Instagram to draw what a press opened, as it does live: a couple of seconds a step.
vi.setConfig({ testTimeout: 30_000 });

const world = vi.hoisted(() => ({
  /** The page each address opens, and what its buttons do. */
  pages: (_url: string): { html: string; at?: string } | null => null,
  behave: (_doc: Document, _url: string): void => undefined,
  opened: [] as string[],
  noted: [] as { note: unknown; platform: unknown }[],
  needs: [] as unknown[],
  asked: [] as { type: string; input?: unknown }[],
  posted: [] as { path: string; body: Record<string, unknown> }[],
  answers: {} as Record<string, (body: Record<string, unknown>) => unknown>,
  hfos: {} as Record<string, (ask: Record<string, unknown>) => unknown>,
  /** The person's Instagram choices. */
  choices: {} as Record<string, unknown>,
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
      return found
        ? { ok: true, value: found(ask as Record<string, unknown>) }
        : { ok: true, value: {} };
    },
    answerWith: async (_t: string, fn: () => Promise<unknown>) => ({ ok: true, value: await fn() }),
    api: () => ({
      POST: async (path: string, options: { body: Record<string, unknown> }) => {
        world.posted.push({ path, body: options.body });
        const found = world.answers[path];
        return found
          ? { data: found(options.body), response: { ok: true, status: 200 } }
          : { error: {}, response: { ok: false, status: 503 } };
      },
    }),
    call: async (request: Promise<{ data?: unknown; response: { ok: boolean } }>) => {
      const result = await request;
      if (result.response.ok) return result.data;
      throw new Refused({ message: 'Couldn’t reach HandsFreeOS.' });
    },
  };
});
vi.mock('../src/hfos/follow', () => ({
  SETTINGS_KEY: 'hfos.settings',
  follow: async () => undefined,
  loadSettings: async () => ({
    timezone: 'America/Chicago',
    settings: { voice: { split: true }, networks: { instagram: world.choices } },
  }),
}));
vi.mock('../src/hfos/noting', async (original) => ({
  ...(await original<object>()),
  isNoting: async () => true,
  takeNote: async (note: unknown, platform: unknown) => void world.noted.push({ note, platform }),
  noteNeed: async (need: unknown) => void world.needs.push(need),
}));
vi.mock('../src/hfos/waiting', () => ({
  POPUP_ID: 'hfos-waiting',
  popUp: async () => undefined,
  waitingSoon: () => undefined,
}));
vi.mock('../src/hfos/looked', () => ({ noteWarnings: async () => undefined }));
vi.mock('../src/auto/run', () => ({ tick: async () => undefined }));
// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));
// Instagram's tab: each address opens its page, which its kit reads and presses on as the tab's script does.
vi.mock('../src/tab', async () => {
  const { JSDOM: Dom } = await import('jsdom');
  const { KITS } = await import('../src/networks');
  const kit = KITS.instagram;
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
      async close() {
        this.doc = null;
      }
      async open(url: string) {
        world.opened.push(url);
        const page = world.pages(url);
        if (!page) throw new Error(`No page for ${url}`);
        this.at = page.at ?? url;
        this.doc = new Dom(`<!doctype html><html><body>${page.html}</body></html>`, {
          url: this.at,
        }).window.document;
        world.behave(this.doc, url);
        return 9;
      }
      async ask(message: { readonly type: string }) {
        const doc = this.doc;
        if (!doc) return { ok: false, error: 'The Instagram tab was closed.' };
        if (message.type === 'hfos-read') return { ok: true, result: kit.readPage(doc, this.at) };
        // The tab's script reads its own page and address.
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

const {
  doWork,
  instagramTick,
  instagramWorkLeft,
  nextInstagramDaily,
  runInstagramDaily,
  spareLikes,
} = await import('../src/auto/instagram');
const { searchInstagram } = await import('../src/jobs/instagram/partner-search');
const { WorkTab } = await import('../src/tab');
const { LIVE_KEY } = await import('../src/hfos/live');
const { NETWORKS_KEY } = await import('../src/networks/on');
const { INSTAGRAM_STATE_KEY } = await import('../src/auto/plan');
const { WARNED_KEY } = await import('../src/hfos/warned');
const { beforeDayDoing, beforeDayLine } = await import('../src/auto/lists');

const store = new Map<string, unknown>();
const alarms = new Map<string, number>();
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
    runtime: {
      getPlatformInfo: async () => ({ os: 'mac' }),
      getManifest: () => ({ version: '0.83.0' }),
    },
    alarms: {
      get: async (name: string) => (alarms.has(name) ? { name } : undefined),
      create: async (name: string, info: { when: number }) => void alarms.set(name, info.when),
      clear: async (name: string) => alarms.delete(name),
    },
    notifications: { clear: async () => true },
  });
});
afterAll(() => vi.unstubAllGlobals());

// ------------------------------------------------------------------------------------------------- the pages

/** The menu down the side, with the person's own Profile (me.owner). */
const MENU = `<div><a role="link" href="/"><span>Home</span></a>
  <a role="link" href="/me.owner/"><span dir="auto"><span>Profile</span></span></a></div>`;

/** Their latest posts on their grid, each by its own link with what Instagram says it shows. */
const POSTS = [
  ['C1aaaaaaa', 'Sad news: rest in peace, Grandpa'],
  ['C2bbbbbbb', 'A new water heater, fitted'],
  ['C3ccccccc', 'Our team at the county fair'],
] as const;

/**
 * Someone's account, as the owner's Check outlined one: their name in the header, Follow (or Following) and Message
 * under it, and their grid.
 */
const accountHtml = (
  o: {
    username?: string;
    button?: 'Follow' | 'Following';
    posts?: readonly (readonly [string, string])[];
  } = {},
) => {
  const username = o.username ?? 'dana.reyes';
  return `${MENU}<main role="main"><header>
    <section><a href="#"><h2 dir="auto"><span>${username}</span></h2></a><span dir="auto">Dana Reyes</span></section>
    <section><div dir="auto">Plumber in Austin</div></section>
    <section><button id="follow"><div dir="auto">${o.button ?? 'Follow'}</div></button>
      <div role="button" id="message">Message</div></section>
  </header>
  <div>${(o.posts ?? POSTS)
    .map(([code, alt]) => `<a href="/${username}/p/${code}/"><img alt="${alt}"></a>`)
    .join('')}</div></main>`;
};

/** One of their posts on its own page: who posted it by its own link, its caption, and its bar's Like and Comment. */
const postHtml = (
  code: string,
  by = 'dana.reyes',
  liked = false,
) => `${MENU}<main role="main"><article>
    <div><a href="/${by}/"><span>${by}</span></a></div>
    <div><span>A post</span></div>
    <section><div><div role="button" class="like"><svg role="img" aria-label="${liked ? 'Unlike' : 'Like'}"></svg></div>
      <div role="button"><svg role="img" aria-label="Comment"></svg></div></div></section>
    <div><a href="/${by}/p/${code}/"><time>2d</time></a></div>
  </article></main>`;

/** Their chat on its own page: who it's with, a message each way, its box and its Send. */
const chatHtml = (withUsername = 'dana.reyes') => `${MENU}<main><section>
    <div><a role="link" href="/${withUsername}/"><span title="Dana Reyes">Dana Reyes</span></a></div>
    <div aria-label="Messages in conversation with Dana Reyes"><div role="grid">
      <div role="row"><div role="gridcell"><h5><span>You sent</span></h5><div dir="auto">Hi Dana</div></div></div>
    </div></div>
    <div><div><div role="textbox" contenteditable="true" aria-label="Message" id="box"></div>
      <div role="button" id="send">Send</div></div></div>
    <form id="elsewhere"><textarea aria-label="Add a comment…" id="other-box"></textarea></form>
  </section></main>`;

/** Typing goes into the box clicked; Send takes what's in it and empties it. */
const sentOn = (sent: string[]) => (doc: Document) => {
  let typed: Element | null = null;
  for (const box of doc.querySelectorAll('[contenteditable="true"], textarea'))
    box.addEventListener('click', () => (typed = box));
  doc.execCommand = (_c: string, _u?: boolean, text?: string) => {
    if (typed) typed.textContent = text ?? '';
    return true;
  };
  doc.querySelector('#send')?.addEventListener('click', () => {
    const box = doc.querySelector('#box')!;
    sent.push(box.textContent ?? '');
    box.textContent = '';
  });
};

// ------------------------------------------------------------------------------------------------- the day

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const day = (state: 'none' | 'started' | 'stopped') => ({
  date: today(),
  state,
  why: state === 'stopped' ? 'person' : null,
  via: state === 'none' ? null : 'web',
  at: null,
});
function keep(instagramDay: ReturnType<typeof day>) {
  store.set(LIVE_KEY, {
    ...ME,
    at: Date.now(),
    computerId: '00000000-0000-4000-8000-000000000001',
    name: 'Chrome on Mac',
    working: true,
    workingName: null,
    day: day('none'),
    days: { instagram: instagramDay },
    stepsKept: [],
    asks: 0,
  });
}
const NO_LISTS = {
  friendsAt: null,
  requestsAt: null,
  sentAt: null,
  groupsAt: null,
  groupChecksAt: null,
  tidyAt: null,
  checksAt: null,
};
/** Lists saved, worked out and checked: the day can go. */
const saved = () => {
  const at = new Date().toISOString();
  return { ...NO_LISTS, friendsAt: at, tidyAt: at, checksAt: at };
};

const item = (more: Partial<TodayListItem>): TodayListItem =>
  ({
    kind: 'friend_request',
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

const notedAs = () =>
  world.noted.map(({ note, platform }) => {
    const step = (
      note as {
        step: {
          kind: string;
          auto: boolean;
          postUrl: string | null;
          to: { profile: { username: string | null } };
        };
      }
    ).step;
    return {
      kind: step.kind,
      auto: step.auto,
      postUrl: step.postUrl,
      username: step.to.profile.username,
      platform: platform as Platform,
    };
  });

const missedPosted = () =>
  world.posted.filter((p) => p.path === '/v1/commands/outreach.warm_up.missed');

beforeEach(() => {
  store.clear();
  alarms.clear();
  world.opened.length = 0;
  world.noted.length = 0;
  world.needs.length = 0;
  world.asked.length = 0;
  world.posted.length = 0;
  world.answers = { '/v1/commands/outreach.warm_up.missed': () => ({ profileId: PROFILE_ID }) };
  world.hfos = {};
  world.pages = () => null;
  world.behave = () => undefined;
  world.choices = { on: true, sending: 'steps', collect: false, warmUp: true };
  store.set(NETWORKS_KEY, {
    facebook: { on: true, allowed: true },
    instagram: { on: true, allowed: true },
  });
});

// ------------------------------------------------------------------------------------------------- the list

describe('what it does on Instagram’s list', () => {
  it('warms up and follows on its own; comments and follow requests they got stay theirs', () => {
    const list = {
      items: [
        item({ kind: 'confirm', name: 'Avery Lane' }),
        item({ kind: 'comment', name: 'Lee Park', postId: 'p1', postUrl: `${IG}/p/C9ddddddd/` }),
        item({ kind: 'friend_request' }),
        item({ kind: 'warm_up', name: 'Sam Lee', profileId: 'p-sam' }),
      ],
      auto: ['confirm', 'warm_up', 'friend_request', 'comment'],
      messages: [],
      sending: 'steps',
    } as never;
    expect(instagramWorkLeft(list, []).map((w) => w.item.kind)).toEqual([
      'warm_up',
      'friend_request',
    ]);
    // The newest followers first, then who followed back seen on their accounts, the checks, the chats, Find
    // partners, the hashtags and the notifications.
    expect(nextInstagramDaily({ daily: {} })).toBe('requests');
    expect(nextInstagramDaily({ daily: { requests: 'x' } })).toBe('follow_backs');
    expect(nextInstagramDaily({ daily: { requests: 'x', follow_backs: 'u' } })).toBe('checks');
    const done = { requests: 'x', follow_backs: 'u', checks: 'y' };
    expect(nextInstagramDaily({ daily: done })).toBe('chats');
    expect(nextInstagramDaily({ daily: { ...done, chats: 'z' } })).toBe('partners');
    expect(nextInstagramDaily({ daily: { ...done, chats: 'z', partners: 'w' } })).toBe('posts');
    expect(nextInstagramDaily({ daily: { ...done, chats: 'z', partners: 'w', posts: 'v' } })).toBe(
      'helpful',
    );
    // Then who liked and commented on the good posts the hashtags found, and last the people found by topic checked
    // for good fits (decision 92).
    const all = { ...done, chats: 'z', partners: 'w', posts: 'v', helpful: 't' };
    expect(nextInstagramDaily({ daily: all })).toBe('post_people');
    expect(nextInstagramDaily({ daily: { ...all, post_people: 'r' } })).toBe('found_checks');
    expect(
      nextInstagramDaily({ daily: { ...all, post_people: 'r', found_checks: 's' } }),
    ).toBeNull();
  });

  it('drafts a comment on a good post for its OK, and posts one once it’s OK’d (decision 92)', () => {
    const comment = (send: TodayListItem['send']) =>
      item({ kind: 'comment', postId: POST_ID, postUrl: `${IG}/p/C7aaaaaaa/`, send });
    const list = (send: TodayListItem['send']) =>
      ({
        items: [comment(send)],
        auto: ['warm_up', 'friend_request'],
        messages: ['comment'],
        sending: 'steps',
      }) as never;
    expect(instagramWorkLeft(list(null), []).map((w) => w.do)).toEqual(['draft']);
    const send = (state: 'waiting' | 'approved') => ({
      sendId: '5e6f7081-92a3-4b4c-8d5e-6f708192a3b4',
      state,
      text: 'Lovely work.',
      handedOver: false,
      needsYou: null,
    });
    expect(instagramWorkLeft(list(send('waiting')), [])).toEqual([]);
    expect(instagramWorkLeft(list(send('approved')), []).map((w) => w.do)).toEqual(['send']);
  });

  it('sends a message only once it’s OK’d: one waiting for the person isn’t sent', () => {
    const send = (state: 'waiting' | 'approved') => ({
      sendId: '5e6f7081-92a3-4b4c-8d5e-6f708192a3b4',
      state,
      text: 'Glad to help, Dana.',
      handedOver: false,
      needsYou: null,
    });
    const list = (state: 'waiting' | 'approved') =>
      ({
        items: [item({ kind: 'follow_up', send: send(state) })],
        auto: ['warm_up', 'friend_request'],
        messages: ['follow_up'],
        sending: 'steps',
      }) as never;
    expect(instagramWorkLeft(list('waiting'), [])).toEqual([]);
    expect(instagramWorkLeft(list('approved'), []).map((w) => w.do)).toEqual(['send']);
  });

  it('has a second like for a warm-up only while the day’s likes have room past the warm-ups left', () => {
    const left = instagramWorkLeft(
      {
        items: [item({ kind: 'warm_up' }), item({ kind: 'warm_up', profileId: 'p-sam' })],
        auto: ['warm_up', 'friend_request'],
        messages: [],
        sending: 'steps',
      } as never,
      [],
    );
    expect(spareLikes({ limits: { like: { done: 26, most: 30 } } } as never, left)).toBe(2);
    expect(spareLikes({ limits: { like: { done: 28, most: 30 } } } as never, left)).toBe(0);
  });
});

describe('a warm-up on Instagram', () => {
  /** Their account and each post's own page; a post's Like says Unlike once pressed. */
  const likes: string[] = [];
  const pagesFor = (posts?: readonly (readonly [string, string])[]) => {
    likes.length = 0;
    world.pages = (url) =>
      url === DANA
        ? { html: accountHtml({ posts }) }
        : /\/p\/(\w+)\/$/.test(url)
          ? { html: postHtml(/\/p\/(\w+)\/$/.exec(url)![1]!) }
          : null;
    world.behave = (doc, url) => {
      for (const like of doc.querySelectorAll('.like'))
        like.addEventListener('click', () => {
          like.querySelector('svg')!.setAttribute('aria-label', 'Unlike');
          likes.push(url);
        });
    };
  };

  it('looks at their account and likes two recent posts of theirs, never one about grief, noting each as Instagram’s own', async () => {
    pagesFor();
    const outcome = await doWork(
      { do: 'step', item: item({ kind: 'warm_up' }) },
      ME.businessId,
      true,
      3,
    );
    expect(outcome).toEqual({
      done: true,
      line: 'Looked at Dana Reyes’s Instagram and liked 2 posts of theirs: the follow comes tomorrow',
    });
    // Their account, then each post liked on its own page: never the one about grief.
    expect(world.opened).toEqual([DANA, `${IG}/p/C2bbbbbbb/`, `${IG}/p/C3ccccccc/`]);
    expect(likes).toEqual([`${IG}/p/C2bbbbbbb/`, `${IG}/p/C3ccccccc/`]);
    expect(notedAs()).toEqual([
      {
        kind: 'like',
        auto: true,
        postUrl: `${IG}/p/C2bbbbbbb/`,
        username: 'dana.reyes',
        platform: 'instagram',
      },
      {
        kind: 'like',
        auto: true,
        postUrl: `${IG}/p/C3ccccccc/`,
        username: 'dana.reyes',
        platform: 'instagram',
      },
    ]);
    expect(missedPosted()).toEqual([]);
  });

  it('likes one alone when the day’s likes have no room past the warm-ups left', async () => {
    pagesFor();
    await doWork({ do: 'step', item: item({ kind: 'warm_up' }) }, ME.businessId, true, 0);
    expect(likes).toEqual([`${IG}/p/C2bbbbbbb/`]);
  });

  it('counts the look alone when they have no post to see, and the follow needn’t wait', async () => {
    pagesFor([]);
    const outcome = await doWork(
      { do: 'step', item: item({ kind: 'warm_up' }) },
      ME.businessId,
      true,
      3,
    );
    expect(outcome).toEqual({
      done: true,
      line: 'Looked at Dana Reyes’s Instagram, with no post of theirs to see: the look is the warm-up, so the follow can go next',
    });
    expect(world.noted).toEqual([]);
    expect(missedPosted().map((p) => p.body)).toEqual([
      { workspaceId: ME.businessId, profileId: PROFILE_ID },
    ]);
  });

  /** Someone found by a post they wrote (decision 92): its own link, and what it said. */
  const foundBy = (code: string, post: string) =>
    item({ kind: 'warm_up', postId: POST_ID, postUrl: `${IG}/p/${code}/`, post });

  it('likes the post it found them by first, on its own page, then one of their latest while likes have room', async () => {
    pagesFor();
    const outcome = await doWork(
      { do: 'step', item: foundBy('C3ccccccc', 'Our team at the county fair') },
      ME.businessId,
      true,
      3,
    );
    expect(outcome).toEqual({
      done: true,
      line: 'Liked Dana Reyes’s post it found and another of theirs: the follow comes tomorrow',
    });
    // The post it found, then their account, and one of their latest: never that post again, nor the one about grief.
    expect(world.opened).toEqual([`${IG}/p/C3ccccccc/`, DANA, `${IG}/p/C2bbbbbbb/`]);
    expect(likes).toEqual([`${IG}/p/C3ccccccc/`, `${IG}/p/C2bbbbbbb/`]);
    expect(notedAs().map((n) => [n.kind, n.postUrl, n.auto])).toEqual([
      ['like', `${IG}/p/C3ccccccc/`, true],
      ['like', `${IG}/p/C2bbbbbbb/`, true],
    ]);
    // With no room past the warm-ups left, the post it found alone.
    world.opened.length = 0;
    pagesFor();
    expect(
      await doWork(
        { do: 'step', item: foundBy('C3ccccccc', 'Our team at the county fair') },
        ME.businessId,
        true,
        0,
      ),
    ).toEqual({
      done: true,
      line: 'Liked Dana Reyes’s post it found: the follow comes tomorrow',
    });
    expect(world.opened).toEqual([`${IG}/p/C3ccccccc/`]);
    expect(missedPosted()).toEqual([]);
  });

  it('likes their latest in its place when the post it found is gone, or isn’t right to like', async () => {
    pagesFor();
    const pages = world.pages;
    world.pages = (url) =>
      url === `${IG}/p/C9gonepost/`
        ? { html: `${MENU}<main role="main"><h2>Sorry, this page isn’t available.</h2></main>` }
        : pages(url);
    const outcome = await doWork(
      { do: 'step', item: foundBy('C9gonepost', 'Fitted a new boiler') },
      ME.businessId,
      true,
      3,
    );
    expect(outcome).toEqual({
      done: true,
      line: 'Looked at Dana Reyes’s Instagram and liked 2 posts of theirs: the follow comes tomorrow',
    });
    expect(world.opened).toEqual([
      `${IG}/p/C9gonepost/`,
      DANA,
      `${IG}/p/C2bbbbbbb/`,
      `${IG}/p/C3ccccccc/`,
    ]);
    expect(likes).toEqual([`${IG}/p/C2bbbbbbb/`, `${IG}/p/C3ccccccc/`]);
    // One about grief is never opened to like, though it's the post it found.
    world.opened.length = 0;
    pagesFor();
    await doWork(
      { do: 'step', item: foundBy('C1aaaaaaa', 'Sad news: rest in peace, Grandpa') },
      ME.businessId,
      true,
      3,
    );
    expect(world.opened).toEqual([DANA, `${IG}/p/C2bbbbbbb/`, `${IG}/p/C3ccccccc/`]);
    expect(likes).toEqual([`${IG}/p/C2bbbbbbb/`, `${IG}/p/C3ccccccc/`]);
  });

  it('likes nothing on a post that isn’t theirs, and hands the step over when Instagram shows another account', async () => {
    likes.length = 0;
    world.pages = (url) =>
      url === DANA
        ? { html: accountHtml() }
        : { html: postHtml(/\/p\/(\w+)\/$/.exec(url)![1]!, 'kim_bakes') };
    world.behave = (doc) => {
      for (const like of doc.querySelectorAll('.like'))
        like.addEventListener('click', () => likes.push('pressed'));
    };
    expect(
      await doWork({ do: 'step', item: item({ kind: 'warm_up' }) }, ME.businessId, true, 3),
    ).toEqual({ done: false, line: 'Couldn’t like Dana Reyes’s post: the follow goes without' });
    expect(likes).toEqual([]);
    world.pages = () => ({ html: accountHtml({ username: 'sam.lee' }), at: `${IG}/sam.lee/` });
    expect(
      await doWork({ do: 'step', item: item({ kind: 'warm_up' }) }, ME.businessId, true, 3),
    ).toEqual({
      done: false,
      line: 'Dana Reyes: Instagram showed a different account',
      need: true,
    });
    expect(world.noted).toEqual([]);
  });
});

describe('a follow on Instagram', () => {
  it('presses Follow on their own account, and notes the follow once it says Following', async () => {
    let pressed = 0;
    world.pages = (url) => (url === DANA ? { html: accountHtml() } : null);
    world.behave = (doc) =>
      doc.querySelector('#follow')!.addEventListener('click', () => {
        pressed++;
        doc.querySelector('#follow div')!.textContent = 'Following';
      });
    const outcome = await doWork({ do: 'step', item: item({}) }, ME.businessId, true);
    expect(outcome).toEqual({ done: true, line: 'Followed Dana Reyes' });
    expect(pressed).toBe(1);
    expect(notedAs()).toEqual([
      {
        kind: 'friend_request',
        auto: true,
        postUrl: null,
        username: 'dana.reyes',
        platform: 'instagram',
      },
    ]);
  });

  it('passes over someone followed already, and hands it over when Instagram didn’t take the follow', async () => {
    world.pages = () => ({ html: accountHtml({ button: 'Following' }) });
    expect(await doWork({ do: 'step', item: item({}) }, ME.businessId, true)).toEqual({
      done: false,
      line: 'Dana Reyes: you follow them already, or asked to',
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      world.pages = () => ({ html: accountHtml() });
      const going = doWork({ do: 'step', item: item({}) }, ME.businessId, true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await going).toEqual({
        done: false,
        line: 'Dana Reyes: Instagram didn’t take the follow',
        need: true,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(world.noted).toEqual([]);
  });
});

describe('a message on Instagram', () => {
  const approved = (more: Partial<TodayListItem> = {}) =>
    item({
      kind: 'follow_up',
      threadKey: '111',
      send: {
        sendId: '5e6f7081-92a3-4b4c-8d5e-6f708192a3b4',
        state: 'approved',
        text: 'Glad to help, Dana.\n\nWant the details?',
        handedOver: false,
        needsYou: null,
      },
      ...more,
    });

  it('sends one OK’d in their chat as its texts, typing only into its own box, and says it went', async () => {
    world.pages = (url) => (url === DANA_CHAT ? { html: chatHtml() } : null);
    const sent: string[] = [];
    let other = '';
    world.behave = (doc) => {
      sentOn(sent)(doc);
      other = (doc.querySelector('#other-box') as HTMLTextAreaElement).value;
    };
    world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
    const outcome = await doWork({ do: 'send', item: approved() }, ME.businessId, true);
    expect(outcome).toEqual({ done: true, line: 'Sent Dana Reyes a message' });
    expect(world.opened).toEqual([DANA_CHAT]);
    expect(sent).toEqual(['Glad to help, Dana.', 'Want the details?']);
    expect(other).toBe('');
    expect(notedAs()).toEqual([
      { kind: 'message', auto: true, postUrl: null, username: 'dana.reyes', platform: 'instagram' },
    ]);
    const note = world.noted[0]!.note as { step: { thread: unknown } };
    expect(note.step.thread).toEqual({ id: '111', encrypted: false, url: DANA_CHAT });
    expect(
      world.posted.find((p) => p.path === '/v1/commands/outreach.send.done')?.body,
    ).toMatchObject({ sent: true });
  });

  it('sends the one to their Requests as one text, from their account’s Message', async () => {
    world.pages = (url) => (url === DANA ? { html: accountHtml() } : null);
    const sent: string[] = [];
    // Message opens their chat over the page, with its own box and Send.
    world.behave = (doc) => {
      doc.querySelector('#message')!.addEventListener('click', () => {
        doc.body.insertAdjacentHTML(
          'beforeend',
          `<div role="dialog"><a href="/dana.reyes/">Dana Reyes</a>
            <div><div role="textbox" contenteditable="true" aria-label="Message" id="box"></div>
            <div role="button" id="send">Send</div></div></div>`,
        );
        sentOn(sent)(doc);
      });
    };
    world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
    const outcome = await doWork(
      {
        do: 'send',
        item: approved({ kind: 'opener', threadKey: null, requests: true }),
      },
      ME.businessId,
      true,
    );
    expect(outcome).toEqual({ done: true, line: 'Sent Dana Reyes a message' });
    expect(sent).toEqual(['Glad to help, Dana.\n\nWant the details?']);
    expect(notedAs()).toEqual([
      { kind: 'message', auto: true, postUrl: null, username: 'dana.reyes', platform: 'instagram' },
    ]);
  });

  it('types nothing when Instagram opens a chat with someone else, and says it wasn’t sent', async () => {
    world.pages = () => ({ html: chatHtml('kim_bakes'), at: DANA_CHAT });
    const sent: string[] = [];
    world.behave = sentOn(sent);
    world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
    const outcome = await doWork({ do: 'send', item: approved() }, ME.businessId, true);
    expect(outcome).toEqual({ done: false, line: 'Dana Reyes: Instagram showed a different chat' });
    expect(sent).toEqual([]);
    expect(world.noted).toEqual([]);
    expect(
      world.posted.find((p) => p.path === '/v1/commands/outreach.send.done')?.body,
    ).toMatchObject({ sent: false, why: 'Instagram showed a different chat' });
  });

  it('drafts one after looking their account up, and leaves it to wait for their OK', async () => {
    world.pages = (url) => (url === DANA ? { html: accountHtml() } : null);
    world.hfos['hfos-draft'] = () => ({
      drafts: ['Hi Dana, how did the fair go?'],
      kind: 'opener',
      opener: null,
      simple: false,
    });
    world.answers['/v1/commands/outreach.send.queue'] = () => ({ state: 'waiting' });
    const outcome = await doWork(
      { do: 'draft', item: item({ kind: 'opener' }) },
      ME.businessId,
      true,
    );
    expect(outcome).toEqual({
      done: true,
      line: 'Wrote a message to Dana Reyes: it waits for your OK',
    });
    const drafted = world.asked.find((a) => a.type === 'hfos-draft') as {
      input?: { lookup: string[] };
    };
    expect(drafted.input?.lookup).toContain('Plumber in Austin');
    expect(world.noted).toEqual([]);
  });
});

describe('a comment on a good post on Instagram (decision 92)', () => {
  const POST_URL = `${IG}/p/C7aaaaaaa/`;
  const TEXT = 'Those tiles came out lovely. How long did the grout take?';
  const commentOn = (send: TodayListItem['send'] = null) =>
    item({
      kind: 'comment',
      postId: POST_ID,
      postUrl: POST_URL,
      post: 'Retiled a shower in Round Rock today',
      send,
    });
  const approved = () =>
    commentOn({
      sendId: '6f708192-a3b4-4c5d-8e6f-708192a3b4c5',
      state: 'approved',
      text: TEXT,
      handedOver: false,
      needsYou: null,
    });

  /**
   * Their post on its own page: a comment of someone else's with a box drawn under it to reply in, the post's bar, its
   * own link, and (`own`) its own box to comment in, whose form's Post shows once something's written.
   */
  const postWithBoxes = (own = true) => `${MENU}<main role="main"><article>
    <div><a role="link" href="/dana.reyes/"><span dir="auto">dana.reyes</span></a></div>
    <div><div><a role="link" href="/sam.lee/"><span dir="auto">sam.lee</span></a>
      <a role="link" href="/p/C7aaaaaaa/c/17900000000000001/"><time>1d</time></a><span dir="auto">Looks great</span>
      <div role="button"><span>Reply</span></div></div>
      <form id="reply"><textarea aria-label="Add a comment…">@sam.lee </textarea></form></div>
    <section><div role="button"><svg aria-label="Like"></svg></div><div role="button"><svg aria-label="Comment"></svg></div></section>
    <div><a role="link" href="/dana.reyes/p/C7aaaaaaa/"><time>2d</time></a></div>
    ${own ? '<section><form id="own"><textarea aria-label="Add a comment…" placeholder="Add a comment…"></textarea></form></section>' : ''}
  </article></main>`;

  /** As Instagram draws the post's own form: Post once something's written, which takes it and empties the box. */
  const posting = (posted: string[], replyBox: { value: string }) => (doc: Document) => {
    const form = doc.querySelector('#own');
    const box = form?.querySelector('textarea');
    replyBox.value = doc.querySelector<HTMLTextAreaElement>('#reply textarea')!.value;
    if (!form || !box) return;
    box.addEventListener('input', () => {
      form.querySelector('[data-post]')?.remove();
      if (!box.value.trim()) return;
      form.insertAdjacentHTML('beforeend', '<div role="button" data-post>Post</div>');
      form.querySelector('[data-post]')!.addEventListener('click', () => {
        posted.push(box.value);
        box.value = '';
        form.querySelector('[data-post]')?.remove();
      });
    });
  };

  it('drafts one from the post, and leaves it to wait for their OK', async () => {
    world.hfos['hfos-draft'] = () => ({
      drafts: [TEXT],
      kind: 'comment',
      opener: null,
      simple: false,
    });
    world.answers['/v1/commands/outreach.send.queue'] = () => ({ state: 'waiting' });
    const outcome = await doWork({ do: 'draft', item: commentOn() }, ME.businessId, true);
    expect(outcome).toEqual({
      done: true,
      line: 'Wrote a comment on Dana Reyes’s post: it waits for your OK',
    });
    expect(world.asked.find((a) => a.type === 'hfos-draft')?.input).toMatchObject({
      kind: 'comment',
      profileId: PROFILE_ID,
      postId: POST_ID,
    });
    expect(
      world.posted.find((p) => p.path === '/v1/commands/outreach.send.queue')?.body,
    ).toMatchObject({ kind: 'comment', postId: POST_ID, text: TEXT });
    // Nothing opened or written on Instagram for it.
    expect(world.opened).toEqual([]);
    expect(world.noted).toEqual([]);
  });

  it('posts one OK’d only in the post’s own box, never the box under someone’s comment, and notes it', async () => {
    world.pages = (url) => (url === POST_URL ? { html: postWithBoxes() } : null);
    const posted: string[] = [];
    const reply = { value: '' };
    world.behave = posting(posted, reply);
    world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
    const outcome = await doWork({ do: 'send', item: approved() }, ME.businessId, true);
    expect(outcome).toEqual({ done: true, line: 'Commented on Dana Reyes’s post' });
    expect(world.opened).toEqual([POST_URL]);
    expect(posted).toEqual([TEXT]);
    expect(reply.value).toBe('@sam.lee ');
    expect(notedAs()).toEqual([
      {
        kind: 'comment',
        auto: true,
        postUrl: POST_URL,
        username: 'dana.reyes',
        platform: 'instagram',
      },
    ]);
    expect(
      world.posted.find((p) => p.path === '/v1/commands/outreach.send.done')?.body,
    ).toMatchObject({ sent: true });
  });

  it('hands it to the person when the post has no box of its own to write in', async () => {
    world.pages = (url) => (url === POST_URL ? { html: postWithBoxes(false) } : null);
    const posted: string[] = [];
    world.behave = posting(posted, { value: '' });
    world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const going = doWork({ do: 'send', item: approved() }, ME.businessId, true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await going).toEqual({
        done: false,
        line: 'Dana Reyes’s post: couldn’t find the post’s own box to comment in',
      });
    } finally {
      vi.useRealTimers();
    }
    expect(posted).toEqual([]);
    expect(world.noted).toEqual([]);
    expect(
      world.posted.find((p) => p.path === '/v1/commands/outreach.send.done')?.body,
    ).toMatchObject({ sent: false, why: 'couldn’t find the post’s own box to comment in' });
  });
});

describe('Find partners on Instagram', () => {
  const job = (): Job => ({
    tab: new WorkTab('window'),
    hfos: (async (ask: { readonly type: string }) => {
      world.asked.push(ask);
      const found = world.hfos[ask.type];
      return { ok: true, value: found ? found(ask as Record<string, unknown>) : {} };
    }) as unknown as Hfos,
    businessId: ME.businessId,
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
  });

  /** Instagram's search: two posts whose links name who posted them, one that doesn't, and an account it shows. */
  const searchHtml = `${MENU}<main><div>
    <a href="/hana.hill/"><span>hana.hill</span></a>
    <a href="/ivy.designs/p/C4eeeeeee/"><img alt=""></a><a href="/jo.paints/p/C5fffffff/"><img alt=""></a>
    <a href="/p/C6ggggggg/"><img alt=""></a></div></main>`;

  /** The hashtag of the words: a post by someone new, and one by someone the search showed already. */
  const tagHtml = `${MENU}<main><header><h1>#austinhomes</h1></header><div>
    <a href="/lu.homes/p/C9iiiiiii/"><img alt=""></a><a href="/ivy.designs/p/C4eeeeeee/"><img alt=""></a></div></main>`;
  /** The accounts Instagram suggests: one new, and one the search showed already. */
  const suggestedHtml = `${MENU}<main><div>
    <div><a href="/max.realty/"><span>max.realty</span></a><button><div dir="auto">Follow</div></button></div>
    <div><a href="/hana.hill/"><span>hana.hill</span></a><button><div dir="auto">Follow</div></button></div>
  </div></main>`;
  const account = (username: string) => ({
    name: username,
    profile: { id: null, username, url: `${IG}/${username}/` },
    lines: [],
    followers: null,
  });

  it('searches Instagram: whoever posted what it shows for creators, the accounts it shows for businesses', async () => {
    world.pages = (url) =>
      url === `${IG}/explore/search/keyword/?q=austin%20homes`
        ? { html: searchHtml }
        : url === `${IG}/p/C6ggggggg/`
          ? { html: postHtml('C6ggggggg', 'kai.builds') }
          : url === `${IG}/explore/tags/austinhomes/`
            ? { html: tagHtml }
            : url === `${IG}/explore/people/`
              ? { html: suggestedHtml }
              : null;
    const creators = await searchInstagram(job(), 'creator', 'austin homes');
    // Then the hashtag of the words (part 15), each poster once.
    expect((creators as readonly { name: string }[]).map((f) => f.name)).toEqual([
      'ivy.designs',
      'jo.paints',
      'kai.builds',
      'lu.homes',
    ]);
    // The one post whose link didn't say, opened to see who posted it.
    expect(world.opened).toEqual([
      `${IG}/explore/search/keyword/?q=austin%20homes`,
      `${IG}/p/C6ggggggg/`,
      `${IG}/explore/tags/austinhomes/`,
    ]);
    // For businesses, the accounts Instagram suggests too, once a run.
    const run = job();
    expect(await searchInstagram(run, 'business', 'austin homes')).toEqual([
      account('hana.hill'),
      account('max.realty'),
    ]);
    world.opened.length = 0;
    expect(await searchInstagram(run, 'business', 'austin homes')).toEqual([account('hana.hill')]);
    expect(world.opened).toEqual([`${IG}/explore/search/keyword/?q=austin%20homes`]);
  });

  it('once a day: today’s searches, who they found sent to keep, then each read for the AI’s partner check', async () => {
    world.pages = (url) =>
      url === `${IG}/explore/search/keyword/?q=austin%20homes`
        ? { html: searchHtml }
        : url === `${IG}/hana.hill/`
          ? { html: accountHtml({ username: 'hana.hill' }) }
          : null;
    world.hfos['hfos-partner-searches'] = () => ({
      searches: [{ kind: 'business', words: 'austin homes' }],
      today: 0,
      perDay: 2,
      waiting: 0,
    });
    world.hfos['hfos-partner-leads'] = () => ({ kept: 1 });
    world.hfos['hfos-partners-next'] = () => ({
      people: [
        { profileId: PROFILE_ID, name: 'Hana Hill', url: `${IG}/hana.hill/`, kind: 'business' },
      ],
      today: 0,
      perDay: 15,
    });
    world.hfos['hfos-partner-look'] = () => ({ partnerId: PROFILE_ID, fit: 'waiting' });
    const end = await runInstagramDaily('partners', job());
    expect(world.asked.find((a) => a.type === 'hfos-partner-leads')?.input).toMatchObject({
      platform: 'instagram',
      kind: 'business',
      words: 'austin homes',
      people: [{ name: 'hana.hill', profile: { username: 'hana.hill' } }],
    });
    expect(world.asked.find((a) => a.type === 'hfos-partner-look')?.input).toMatchObject({
      kind: 'business',
      missing: false,
      lines: expect.arrayContaining(['Plumber in Austin']),
    });
    expect(end).toMatchObject({ warned: false });
  });
});

describe('its day', () => {
  it('stops for the day on an Instagram warning, and notes it as Instagram’s', async () => {
    world.pages = () => ({
      html: `<div role="dialog"><h3>Action blocked</h3><p>Try again later.</p></div>${accountHtml()}`,
    });
    const outcome = await doWork({ do: 'step', item: item({}) }, ME.businessId, true);
    expect(outcome).toMatchObject({
      stop: expect.stringContaining('The extension stops on Instagram for today'),
    });
    expect(world.asked.find((a) => a.type === 'hfos-warning')?.input).toMatchObject({
      platform: 'instagram',
    });
    expect(store.get(WARNED_KEY)).toMatchObject({ instagram: { day: expect.any(String) } });
  });

  it('waits, and sets no alarm, while Instagram’s day isn’t started', async () => {
    keep(day('none'));
    await instagramTick();
    expect(world.opened).toEqual([]);
    expect(alarms.has('hfos-auto-instagram')).toBe(false);
    expect((store.get(INSTAGRAM_STATE_KEY) as { line: string }).line).toBe(
      'Waiting for you to start your day on Instagram: press Start my day for Instagram on Today in HandsFreeOS.',
    );
  });

  it('does nothing while their Instagram Sending is Off, though the day is started', async () => {
    keep(day('started'));
    world.choices = { on: true, sending: 'off', collect: true, warmUp: true };
    await instagramTick();
    expect(world.opened).toEqual([]);
    expect(world.asked.find((a) => a.type === 'hfos-lists')).toBeUndefined();
    expect(alarms.has('hfos-auto-instagram')).toBe(false);
  });

  it('saves the followers first on Instagram’s first day, then works out who to unfollow', async () => {
    keep(day('started'));
    world.pages = (url) =>
      url === `${IG}/`
        ? { html: `${MENU}<main><article></article></main>` }
        : url === `${IG}/me.owner/followers/`
          ? {
              html: `${MENU}<div role="dialog"><h1>Followers</h1><div>
                <div><a href="/dana.reyes/"><span dir="auto">dana.reyes</span></a><span dir="auto">Dana Reyes</span>
                  <button><div dir="auto">Remove</div></button></div></div></div>`,
            }
          : null;
    let lists = NO_LISTS as Record<string, string | null>;
    world.hfos['hfos-lists'] = () => lists;
    world.hfos['hfos-lists-saved'] = (ask) => {
      lists = { ...lists, [`${ask.list as string}At`]: new Date().toISOString() };
      return lists;
    };
    world.hfos['hfos-save-friends'] = () => ({ added: 1 });
    await instagramTick();
    expect(world.opened).toEqual([`${IG}/`, `${IG}/me.owner/followers/`]);
    expect(world.asked.find((a) => a.type === 'hfos-lists')).toMatchObject({
      platform: 'instagram',
    });
    expect(world.asked.find((a) => a.type === 'hfos-save-friends')?.input).toMatchObject({
      platform: 'instagram',
      list: 'friends',
      people: [{ name: 'Dana Reyes', profile: { username: 'dana.reyes' } }],
    });
    expect(world.asked.find((a) => a.type === 'hfos-lists-saved')).toMatchObject({
      list: 'friends',
      platform: 'instagram',
    });
    expect(alarms.has('hfos-auto-instagram')).toBe(true);
    // Next, who to unfollow, worked out for the person to tick: nothing is unfollowed on its own.
    const tidy = { do: 'tidy' } as const;
    expect(beforeDayDoing(tidy, 'instagram')).toBe('Working out who to unfollow on Instagram…');
    expect(beforeDayLine(tidy, { line: 'x', warned: false }, 'instagram')).toBe('Tidy up: x');
  });

  it('works its list once its day is started and its lists are saved, a step a go', async () => {
    keep(day('started'));
    world.hfos['hfos-lists'] = saved;
    world.answers['/v1/queries/outreach.today'] = (body) => {
      expect(body).toMatchObject({ platform: 'instagram' });
      return {
        items: [item({})],
        auto: ['warm_up', 'friend_request'],
        messages: [],
        sending: 'steps',
        partners: [],
        limits: { like: { done: 0, most: 30 } },
      };
    };
    world.pages = (url) => (url === DANA ? { html: accountHtml() } : null);
    world.behave = (doc) =>
      doc.querySelector('#follow')?.addEventListener('click', () => {
        doc.querySelector('#follow div')!.textContent = 'Following';
      });
    await instagramTick();
    expect(notedAs()).toEqual([
      {
        kind: 'friend_request',
        auto: true,
        postUrl: null,
        username: 'dana.reyes',
        platform: 'instagram',
      },
    ]);
    expect(store.get(INSTAGRAM_STATE_KEY)).toMatchObject({
      line: 'Followed Dana Reyes',
      done: { friend_request: 1 },
    });
    expect(alarms.has('hfos-auto-instagram')).toBe(true);
  });

  it('does nothing on a day Instagram warned them', async () => {
    keep(day('started'));
    store.set(WARNED_KEY, {
      instagram: { day: new Date().toLocaleDateString('en-CA'), words: ['Action blocked'] },
    });
    await instagramTick();
    expect(world.opened).toEqual([]);
    expect((store.get(INSTAGRAM_STATE_KEY) as { line: string }).line).toContain(
      'Instagram warned you today (“Action blocked”)',
    );
  });
});

describe('Instagram’s growing (part 15)', () => {
  const job = (): Job => ({
    tab: new WorkTab('window'),
    hfos: (async (ask: { readonly type: string }) => {
      world.asked.push(ask);
      const found = world.hfos[ask.type];
      return { ok: true, value: found ? found(ask as Record<string, unknown>) : {} };
    }) as unknown as Hfos,
    businessId: ME.businessId,
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
  });

  /** A post on its own page, as a hashtag's leads to it: who posted it, its place, and its caption beside its time. */
  const foundPostHtml = (
    by: string,
    caption: string,
    place: readonly [id: string, slug: string, name: string] | null,
  ) => `${MENU}<section><main role="main"><div><div><div>
      <div><div><div><span dir="auto"><a role="link" href="/${by}/"><span dir="auto">${by}</span></a></span></div>
        ${place ? `<a role="link" href="/explore/locations/${place[0]}/${place[1]}/"><span>${place[2]}</span></a>` : ''}</div>
        <div role="button">Follow</div></div>
        <div role="button" aria-expanded="false"><svg role="img" aria-label="More options"></svg></div></div>
      <hr>
      <div><div><div><a role="link" href="/${by}/"><img alt=""></a>
        <div><span dir="auto"><div><div><a role="link" href="/${by}/"><span dir="auto">${by}</span></a>
          <span>•</span><time>2d</time></div>
          <span>${caption}</span></div></span></div></div></div>
    </div></div></main></section>`;
  const grid = (codes: readonly string[]) =>
    `<div>${codes.map((c) => `<a href="/p/${c}/"><img alt=""></a>`).join('')}</div>`;

  it('looks at the day’s hashtags, then the places in the area their posts were tagged at, and sends the posts to check', async () => {
    world.pages = (url) =>
      ({
        [`${IG}/explore/tags/austinplumbing/`]: {
          html: `${MENU}<main><header><h1>#austinplumbing</h1></header>${grid(['C7aaaaaaa', 'C7bbbbbbb'])}</main>`,
        },
        [`${IG}/p/C7aaaaaaa/`]: {
          html: foundPostHtml(
            'quinn.plumbing',
            'Busy week of plumbing in Austin. Can anyone recommend a CRM?',
            ['212988663', 'austin-texas', 'Austin, Texas'],
          ),
        },
        [`${IG}/p/C7bbbbbbb/`]: {
          html: foundPostHtml('paris.pipes', 'Plumbing in Paris today', [
            '999',
            'paris-france',
            'Paris, France',
          ]),
        },
        [`${IG}/explore/locations/212988663/austin-texas/`]: {
          html: `${MENU}<main><h1>Austin, Texas</h1>${grid(['C8ccccccc', 'C7aaaaaaa'])}</main>`,
        },
        [`${IG}/p/C8ccccccc/`]: { html: foundPostHtml('rory.drains', 'Drain day', null) },
      })[url] ?? null;
    world.hfos['hfos-post-words'] = () => ({
      words: ['plumbing'],
      tags: ['austinplumbing'],
      places: ['Austin', 'Round Rock'],
    });
    world.hfos['hfos-save-posts'] = (ask) => ({
      groupId: null,
      posts: [],
      checking: (ask['input'] as { posts: unknown[] }).posts.length,
    });
    const end = await runInstagramDaily('posts', job());
    // Austin's place, never Paris's; a post opened once.
    expect(world.opened).toEqual([
      `${IG}/explore/tags/austinplumbing/`,
      `${IG}/p/C7aaaaaaa/`,
      `${IG}/p/C7bbbbbbb/`,
      `${IG}/explore/locations/212988663/austin-texas/`,
      `${IG}/p/C8ccccccc/`,
    ]);
    // A save a page: the hashtag's with its hashtag (decision 92), the place's with none.
    const saves = world.asked.filter((a) => a.type === 'hfos-save-posts');
    expect(saves.map((a) => a.input)).toEqual([
      {
        workspaceId: ME.businessId,
        platform: 'instagram',
        group: null,
        found: 'search',
        words: 'austinplumbing',
        posts: [
          {
            url: `${IG}/p/C7aaaaaaa/`,
            author: { id: null, username: 'quinn.plumbing', url: `${IG}/quinn.plumbing/` },
            name: 'quinn.plumbing',
            when: null,
            text: 'Busy week of plumbing in Austin. Can anyone recommend a CRM?',
            comments: null,
            reactions: null,
          },
          expect.objectContaining({ name: 'paris.pipes', text: 'Plumbing in Paris today' }),
        ],
      },
      expect.objectContaining({
        words: null,
        posts: [expect.objectContaining({ name: 'rory.drains', text: 'Drain day' })],
      }),
    ]);
    expect(end).toEqual({
      line: 'Looked at 1 hashtag and 1 place in your area on Instagram and read 3 posts: 3 posts sent for the AI to check. Who posted the good ones is checked next, and a good fit goes on your list: a like on their post first, then a follow.',
      warned: false,
    });
  });

  it('never sends the person’s own post under a hashtag they use (decision 92)', async () => {
    world.pages = (url) =>
      ({
        [`${IG}/explore/tags/austinplumbing/`]: {
          html: `${MENU}<main><header><h1>#austinplumbing</h1></header>${grid(['C7aaaaaaa', 'C7eeeeeee'])}</main>`,
        },
        [`${IG}/p/C7aaaaaaa/`]: {
          html: foundPostHtml(
            'quinn.plumbing',
            'Busy week of plumbing in Austin. Can anyone recommend a CRM?',
            null,
          ),
        },
        // Their own, by the account the menu's Profile links to.
        [`${IG}/p/C7eeeeeee/`]: {
          html: foundPostHtml('me.owner', 'Three water heaters fitted in Austin today', null),
        },
      })[url] ?? null;
    world.hfos['hfos-post-words'] = () => ({
      words: ['plumbing'],
      tags: ['austinplumbing'],
      places: [],
    });
    world.hfos['hfos-save-posts'] = (ask) => ({
      groupId: null,
      posts: [],
      checking: (ask['input'] as { posts: unknown[] }).posts.length,
    });
    await runInstagramDaily('posts', job());
    const saves = world.asked
      .filter((a) => a.type === 'hfos-save-posts')
      .map((a) => (a.input as { posts: { name: string }[] }).posts.map((p) => p.name));
    expect(saves).toEqual([['quinn.plumbing']]);
  });

  it('opens about 10 posts a hashtag, for the day’s 5, and saves each hashtag’s on their own with its hashtag', async () => {
    const tags = ['tilework', 'austinremodel', 'bathroomideas', 'roundrockhomes', 'showerdesign'];
    // Each hashtag's grid shows 12 posts at once, none tagged at a place.
    const code = (t: number, p: number) => `C${t}x${String(p).padStart(2, '0')}abcd`;
    world.pages = (url) => {
      const tag = tags.findIndex((t) => url === `${IG}/explore/tags/${t}/`);
      if (tag >= 0)
        return {
          html: `${MENU}<main><header><h1>#${tags[tag]}</h1></header>${grid(
            Array.from({ length: 12 }, (_, p) => code(tag, p)),
          )}</main>`,
        };
      return /\/p\/(\w+)\/$/.test(url)
        ? { html: foundPostHtml('jo.tiles', `Fresh tile work ${url.slice(-10)}`, null) }
        : null;
    };
    world.hfos['hfos-post-words'] = () => ({ words: ['tile'], tags, places: [] });
    world.hfos['hfos-save-posts'] = (ask) => ({
      groupId: null,
      posts: [],
      checking: (ask['input'] as { posts: unknown[] }).posts.length,
    });
    const end = await runInstagramDaily('posts', job());
    const saves = world.asked
      .filter((a) => a.type === 'hfos-save-posts')
      .map((a) => a.input as { words: string; posts: { url: string }[] });
    expect(saves.map((s) => [s.words, s.posts.length])).toEqual(tags.map((t) => [t, 10]));
    // The first 10 of each grid, each opened once.
    expect(saves[0]!.posts.map((p) => p.url)).toEqual(
      Array.from({ length: 10 }, (_, p) => `${IG}/p/${code(0, p)}/`),
    );
    expect(world.opened).toHaveLength(5 + 50);
    expect(end.line).toContain(
      'Looked at 5 hashtags on Instagram and read 50 posts: 50 posts sent',
    );
  });

  it('reads a hashtag’s posts on the search Instagram sends its page to now (21 Oct 2026)', async () => {
    world.pages = (url) =>
      ({
        [`${IG}/explore/tags/austinplumbing/`]: {
          // Its grid as the owner's Check outlined the search: posts by /p/<code>/, none naming who posted them.
          html: `${MENU}<section><main role="main"><div><div><span dir="auto">#austinplumbing</span></div>
            ${grid(['C7aaaaaaa'])}<div role="progressbar"></div></div></main></section>`,
          at: `${IG}/explore/search/keyword/?q=%23austinplumbing`,
        },
        [`${IG}/p/C7aaaaaaa/`]: {
          html: foundPostHtml('quinn.plumbing', 'Plumbing in Austin all week', null),
        },
      })[url] ?? null;
    world.hfos['hfos-post-words'] = () => ({
      words: ['plumbing'],
      tags: ['austinplumbing'],
      places: ['Austin'],
    });
    world.hfos['hfos-save-posts'] = (ask) => ({
      groupId: null,
      posts: [],
      checking: (ask['input'] as { posts: unknown[] }).posts.length,
    });
    const end = await runInstagramDaily('posts', job());
    expect(world.opened).toEqual([`${IG}/explore/tags/austinplumbing/`, `${IG}/p/C7aaaaaaa/`]);
    expect(
      world.asked
        .filter((a) => a.type === 'hfos-save-posts')
        .map((a) => (a.input as { posts: { name: string }[] }).posts.map((p) => p.name)),
    ).toEqual([['quinn.plumbing']]);
    expect(end.line).toContain('Looked at 1 hashtag on Instagram and read 1 post');
  });

  it('looks at each page with its window in front, and notes a page with no posts and a post it couldn’t read, once each', async () => {
    world.pages = (url) =>
      ({
        [`${IG}/explore/tags/austinplumbing/`]: {
          html: `${MENU}<main><header><h1>#austinplumbing</h1></header>${grid(['C7aaaaaaa', 'C7bbbbbbb'])}</main>`,
        },
        // Neither post drew who posted it.
        [`${IG}/p/C7aaaaaaa/`]: { html: `${MENU}<main role="main"><div></div></main>` },
        [`${IG}/p/C7bbbbbbb/`]: { html: `${MENU}<main role="main"><div></div></main>` },
        [`${IG}/explore/tags/roundrockplumbing/`]: {
          html: `${MENU}<main><header><h1>#roundrockplumbing</h1></header></main>`,
        },
        [`${IG}/explore/tags/plumbing/`]: {
          html: `${MENU}<main><header><h1>#plumbing</h1></header></main>`,
        },
      })[url] ?? null;
    world.hfos['hfos-post-words'] = () => ({
      words: ['plumbing'],
      tags: ['austinplumbing', 'roundrockplumbing', 'plumbing'],
      places: ['Austin', 'Round Rock'],
    });
    const report = vi.fn(async (_note?: ReportNote) => undefined);
    const inFront = vi.fn(<T>(work: () => Promise<T>) => work());
    const base = job();
    const end = await runInstagramDaily('posts', {
      ...base,
      report,
      tab: Object.assign(base.tab, { inFront }),
    });
    // Once a hashtag: theirs comes back between pages.
    expect(inFront).toHaveBeenCalledTimes(3);
    expect(report.mock.calls.map(([note]) => note?.job)).toEqual(['posts.post', 'posts.page']);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'No posts on the page.', outline: true }),
    );
    expect(end.line).toContain('Looked at 3 hashtags on Instagram and read 2 posts: 0 posts sent');
  });

  /** A comment on the good post below: who wrote it, its own link, what it says, and its Reply. */
  const said = (username: string, id: string, text: string) =>
    `<div><a role="link" href="/${username}/"><span dir="auto">${username}</span></a>
      <a role="link" href="/p/C7aaaaaaa/c/1790000000000000${id}/"><time>1d</time></a><span dir="auto">${text}</span>
      <div role="button"><span>Reply</span></div></div>`;

  /** Someone in the good post's Likes box, with whether the person follows them by its own button. */
  const liker = (username: string, name: string, button: string) =>
    `<div><a role="link" href="/${username}/"><span dir="auto">${username}</span></a><span dir="auto">${name}</span>
      ${button ? `<button type="button"><div dir="auto">${button}</div></button>` : ''}</div>`;

  /**
   * A good post on its own page (decision 92): its writer's reply, the person's own comment and someone else's; its
   * View all 4 comments, which shows one more; and its count of likes, which opens its Likes box: the person, the
   * writer, someone they follow, someone they asked to, and two others, closed by its own Close. `warning` draws an
   * Instagram warning over the page as the box opens.
   */
  const goodPost = (warning = false) => ({
    html: `${MENU}<main role="main"><article>
      <div><a role="link" href="/quinn.tiles/"><span dir="auto">quinn.tiles</span></a>
        <div role="button"><svg aria-label="More options"></svg></div></div>
      <div id="comments">${said('sam.lee', '1', 'Who did your grout?')}${said('quinn.tiles', '2', 'Thanks all!')}${said(
        'me.owner',
        '3',
        'Great job',
      )}</div>
      <div role="button" id="view-all"><span dir="auto">View all 4 comments</span></div>
      <section><div role="button"><svg aria-label="Like"></svg></div>
        <div role="button"><svg aria-label="Comment"></svg></div></section>
      <section><span>Liked by <a role="link" href="/rio.tanaka/">rio.tanaka</a> and
        <a role="link" href="/p/C7aaaaaaa/liked_by/" id="likes">12 others</a></span></section>
      <div dir="auto"><a role="link" href="/quinn.tiles/p/C7aaaaaaa/"><time>2d</time></a></div>
      <form><textarea aria-label="Add a comment…"></textarea></form>
    </article></main>`,
    behave: (doc: Document, closed: { box: boolean }) => {
      doc
        .querySelector('#view-all')!
        .addEventListener('click', () =>
          doc
            .querySelector('#comments')!
            .insertAdjacentHTML('beforeend', said('kim_bakes', '4', 'Love the colour')),
        );
      doc.querySelector('#likes')!.addEventListener('click', (e) => {
        e.preventDefault();
        doc.body.insertAdjacentHTML(
          'beforeend',
          `<div role="dialog" id="likers"><h2>Likes</h2><div role="button" aria-label="Close"></div><div>
            ${liker('rio.tanaka', 'Rio Tanaka', 'Follow')}${liker('me.owner', 'Me Owner', '')}
            ${liker('quinn.tiles', 'Quinn Tiles', 'Follow')}${liker('pat.quinn', 'Pat Quinn', 'Following')}
            ${liker('lou.marsh', 'Lou Marsh', 'Requested')}${liker('ada.finch', 'Ada Finch', 'Follow Back')}
          </div></div>${warning ? '<div role="dialog"><h3>Action blocked</h3><p>Try again later.</p></div>' : ''}`,
        );
        const box = doc.querySelector('#likers')!;
        box.querySelector('[aria-label="Close"]')!.addEventListener('click', () => {
          box.remove();
          closed.box = true;
        });
      });
    },
  });

  /** HandsFreeOS's good posts to read, and how many it keeps of each save. */
  const peopleNext = (...codes: string[]) => {
    world.hfos['hfos-posts-people-next'] = () => ({
      posts: codes.map((c) => ({
        postId: POST_ID,
        url: `${IG}/p/${c}/`,
        name: 'quinn.tiles',
        profileUrl: `${IG}/quinn.tiles/`,
        words: 'tilework',
        strong: false,
        comments: 4,
        reactions: 13,
      })),
      today: 0,
      perDay: 5,
    });
    world.hfos['hfos-finds-save'] = (ask) => ({
      added: (ask['input'] as { people: unknown[] }).people.length,
      skipped: 0,
    });
  };

  it('reads who commented and who liked a good post, never you, its writer or anyone you follow, then closes the box', async () => {
    const closed = { box: false };
    const post = goodPost();
    world.pages = (url) => (url === `${IG}/p/C7aaaaaaa/` ? { html: post.html } : null);
    world.behave = (doc) => post.behave(doc, closed);
    peopleNext('C7aaaaaaa');
    const inFront = vi.fn(<T>(work: () => Promise<T>) => work());
    const base = job();
    const end = await runInstagramDaily('post_people', {
      ...base,
      report: async () => undefined,
      tab: Object.assign(base.tab, { inFront }),
    });
    expect(world.asked.find((a) => a.type === 'hfos-posts-people-next')?.input).toEqual({
      workspaceId: ME.businessId,
      platform: 'instagram',
    });
    expect(world.opened).toEqual([`${IG}/p/C7aaaaaaa/`]);
    expect(inFront).toHaveBeenCalledTimes(1);
    const saves = world.asked
      .filter((a) => a.type === 'hfos-finds-save')
      .map((a) => a.input as Record<string, unknown>);
    // Who commented, with what they said (more of them once View all comments was pressed), then who liked it.
    expect(saves).toEqual([
      expect.objectContaining({
        workspaceId: ME.businessId,
        platform: 'instagram',
        how: 'commented',
        postId: POST_ID,
        people: [
          expect.objectContaining({
            name: 'sam.lee',
            profile: { id: null, username: 'sam.lee', url: `${IG}/sam.lee/` },
            said: 'Who did your grout?',
          }),
          expect.objectContaining({ name: 'kim_bakes', said: 'Love the colour' }),
        ],
      }),
      expect.objectContaining({
        how: 'liked',
        postId: POST_ID,
        people: [
          expect.objectContaining({
            name: 'Rio Tanaka',
            profile: { id: null, username: 'rio.tanaka', url: `${IG}/rio.tanaka/` },
            said: null,
          }),
          expect.objectContaining({ name: 'Ada Finch' }),
        ],
      }),
    ]);
    expect(closed.box).toBe(true);
    expect(end).toEqual({
      line: 'Done. Read who liked and commented on 1 good post on Instagram: 4 new people to check for good fits.',
      warned: false,
    });
  });

  it('stops for the day on an Instagram warning in the Likes box, saving nothing of that post', async () => {
    const post = goodPost(true);
    world.pages = (url) => (/\/p\/C7\w+\/$/.test(url) ? { html: post.html } : null);
    world.behave = (doc) => post.behave(doc, { box: false });
    peopleNext('C7aaaaaaa', 'C7bbbbbbb');
    const end = await runInstagramDaily('post_people', { ...job(), report: async () => undefined });
    expect(end).toMatchObject({
      warned: true,
      line: expect.stringContaining(
        'Read who liked and commented on 0 good posts on Instagram: 0 new people',
      ),
    });
    expect(world.opened).toEqual([`${IG}/p/C7aaaaaaa/`]);
    expect(world.asked.filter((a) => a.type === 'hfos-finds-save')).toEqual([]);
  });

  it('says so when no good post waits for who liked and commented on it', async () => {
    world.hfos['hfos-posts-people-next'] = () => ({ posts: [], today: 5, perDay: 5 });
    expect(await runInstagramDaily('post_people', job())).toEqual({
      line: 'That’s today’s 5 good posts on Instagram. It carries on tomorrow.',
      warned: false,
    });
    world.hfos['hfos-posts-people-next'] = () => ({ posts: [], today: 0, perDay: 5 });
    expect((await runInstagramDaily('post_people', job())).line).toBe(
      'No good post on Instagram waits for who liked and commented on it, or the people found wait for their checks first.',
    );
    expect(world.opened).toEqual([]);
  });

  it('says what to add when the playbooks have nothing to make hashtags from', async () => {
    world.hfos['hfos-post-words'] = () => ({ words: [], tags: [], places: [] });
    expect(await runInstagramDaily('posts', job())).toMatchObject({
      line: expect.stringContaining('add your area'),
      failed: true,
    });
    expect(world.opened).toEqual([]);
  });

  it('reads the notifications for warm leads: who followed, liked or commented, never one already followed', async () => {
    world.pages = (url) =>
      url === `${IG}/notifications/`
        ? {
            html: `${MENU}<main><div>
              <div><a href="/dana.reyes/"><img alt=""></a>
                <span><a href="/dana.reyes/">dana.reyes</a> started following you. <time>2d</time></span>
                <button><div dir="auto">Follow Back</div></button></div>
              <div><a href="/sam.lee/"><img alt=""></a>
                <span><a href="/sam.lee/">sam.lee</a> liked your post. <time>3d</time></span>
                <a href="/p/C3xyzabcd/"><img alt=""></a></div>
              <div><a href="/ivy.cole/"><img alt=""></a>
                <span><a href="/ivy.cole/">ivy.cole</a> started following you. <time>5d</time></span>
                <button><div dir="auto">Following</div></button></div>
            </div></main>`,
          }
        : null;
    world.hfos['hfos-engaged-save'] = () => ({ added: 2 });
    const end = await runInstagramDaily('helpful', job());
    expect(world.asked.find((a) => a.type === 'hfos-engaged-save')?.input).toEqual({
      workspaceId: ME.businessId,
      platform: 'instagram',
      engaged: [
        {
          profile: { id: null, username: 'dana.reyes', url: `${IG}/dana.reyes/` },
          name: 'dana.reyes',
          kind: 'follow',
        },
        {
          profile: { id: null, username: 'sam.lee', url: `${IG}/sam.lee/` },
          name: 'sam.lee',
          kind: 'reaction',
        },
      ],
    });
    expect(end).toEqual({
      line: 'Read your Instagram notifications: 2 new warm leads who followed you or liked or commented on your posts, on your list for today.',
      warned: false,
    });
  });

  it('once a day, looks at the accounts they followed for who follows them back, 30 at most (21 Oct 2026)', async () => {
    // Dana's account says she follows them; Sam's doesn't yet.
    const followed = (username: string, followsYou: boolean) =>
      accountHtml({ username, button: 'Following' }).replace(
        '</h2></a>',
        `</h2></a>${followsYou ? '<span dir="auto">Follows you</span>' : ''}`,
      );
    world.pages = (url) =>
      url === `${IG}/dana.reyes/`
        ? { html: followed('dana.reyes', true) }
        : url === `${IG}/sam.lee/`
          ? { html: followed('sam.lee', false) }
          : null;
    const who = (username: string, name: string) => ({
      profileId: PROFILE_ID,
      name,
      url: `${IG}/${username}/`,
      platformId: null,
      username,
      followedAt: '2026-10-10T15:00:00.000Z',
    });
    world.hfos['hfos-follow-backs-next'] = () => ({
      people: [who('dana.reyes', 'Dana Reyes'), who('sam.lee', 'Sam Lee')],
      perDay: 30,
    });
    world.hfos['hfos-save-friends'] = () => ({ saved: 1, added: 0, changed: 1 });
    const end = await runInstagramDaily('follow_backs', job());
    expect(world.asked.find((a) => a.type === 'hfos-follow-backs-next')?.input).toEqual({
      workspaceId: ME.businessId,
      platform: 'instagram',
      most: 30,
    });
    expect(
      world.asked
        .filter((a) => a.type === 'hfos-save-friends')
        .map((a) => {
          const input = a.input as { list: string; people: { profile: { username: string } }[] };
          return [input.list, input.people[0]!.profile.username];
        }),
    ).toEqual([
      ['friends', 'dana.reyes'],
      ['sent', 'sam.lee'],
    ]);
    expect(end).toEqual({
      line: 'Looked at 2 accounts you followed: 1 followed you back.',
      warned: false,
    });
    // Counted on this computer: the day's 30 less those two.
    world.asked.length = 0;
    await runInstagramDaily('follow_backs', job());
    expect(world.asked.find((a) => a.type === 'hfos-follow-backs-next')?.input).toMatchObject({
      most: 28,
    });
  });
});
