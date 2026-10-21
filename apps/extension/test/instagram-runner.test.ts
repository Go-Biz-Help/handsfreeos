/**
 * Instagram's runner (src/auto/instagram.ts; the Instagram and Alignable plan's part 14), with the extension's storage,
 * HandsFreeOS and Instagram's tab stood in for, on pages written here by hand as the owner's Check Instagram found
 * them, of made-up accounts. Its tab presses by Instagram's own kit (src/networks/instagram/auto.ts). It works only
 * while Instagram's day is started and its Sending isn't Off; before Instagram's first day it saves the followers
 * first; a warm-up looks at their account and likes one or two of their recent posts on each one's own page, never one
 * about grief, or counts the look alone when there's none; Follow is pressed only on their own account; a message goes
 * only once OK'd, typed only into their chat's own box, and one to their Requests as one text; Find partners searches
 * Instagram; and an Instagram warning stops it for the day. Each step is noted as the extension's own, as Instagram's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { TodayListItem } from '../src/hfos/messages';
import type { Hfos, Job } from '../src/jobs/job';

const IG = 'https://www.instagram.com';
const DANA = `${IG}/dana.reyes/`;
const DANA_CHAT = `${IG}/direct/t/111/`;
const ME = { userId: 'u-casey', businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
const PROFILE_ID = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';

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
      getManifest: () => ({ version: '0.82.0' }),
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
    // The newest followers first, then the checks, the chats and Find partners.
    expect(nextInstagramDaily({ daily: {} })).toBe('requests');
    expect(nextInstagramDaily({ daily: { requests: 'x', checks: 'y' } })).toBe('chats');
    expect(nextInstagramDaily({ daily: { requests: 'x', checks: 'y', chats: 'z' } })).toBe(
      'partners',
    );
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

  it('searches Instagram: whoever posted what it shows for creators, the accounts it shows for businesses', async () => {
    world.pages = (url) =>
      url === `${IG}/explore/search/keyword/?q=austin%20homes`
        ? { html: searchHtml }
        : url === `${IG}/p/C6ggggggg/`
          ? { html: postHtml('C6ggggggg', 'kai.builds') }
          : null;
    const creators = await searchInstagram(job(), 'creator', 'austin homes');
    expect((creators as readonly { name: string }[]).map((f) => f.name)).toEqual([
      'ivy.designs',
      'jo.paints',
      'kai.builds',
    ]);
    // The one post whose link didn't say, opened to see who posted it.
    expect(world.opened).toEqual([
      `${IG}/explore/search/keyword/?q=austin%20homes`,
      `${IG}/p/C6ggggggg/`,
    ]);
    expect(await searchInstagram(job(), 'business', 'austin homes')).toEqual([
      {
        name: 'hana.hill',
        profile: { id: null, username: 'hana.hill', url: `${IG}/hana.hill/` },
        lines: [],
        followers: null,
      },
    ]);
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
