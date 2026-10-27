/**
 * Alignable's runner (src/auto/alignable.ts; partners stage 6c, part 5), with the extension's storage, HandsFreeOS and
 * Alignable's tab stood in for, on pages written here by hand as the owner's Check Alignable found them (0.66.0 to
 * 0.68.0), of made-up businesses. Its tab presses by Alignable's own kit (src/networks/alignable/auto.ts). It works
 * only while Alignable's day is started and its Sending isn't Off; before Alignable's first day it saves the
 * connections first; a warm-up looks at their business page and likes a recent post of theirs, or counts the look
 * alone when there's none; Connect is pressed only on their own page, by Alignable's id for their business; a message
 * goes only once OK'd, typed only into their conversation's own box; Find partners searches Alignable's businesses;
 * and an Alignable warning stops it for the day. Each step is noted as the extension's own, as Alignable's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { TodayListItem } from '../src/hfos/messages';
import type { Hfos, Job } from '../src/jobs/job';

const AL = 'https://www.alignable.com';
/** Dana Reyes's business, Acme Plumbing, by Alignable's id (42) and at its address in its town. */
const DANA = `${AL}/biz/businesses/42`;
const DANA_PAGE = `${AL}/austin-tx/acme-plumbing`;
const DANA_CHAT = `${AL}/biz/conversations?with_business_id=42`;
const ME = { userId: 'u-casey', businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
const PROFILE_ID = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';

// The runner waits for Alignable to draw what a press opened, as it does live: a couple of seconds a step.
vi.setConfig({ testTimeout: 30_000 });

const world = vi.hoisted(() => ({
  /** The page each address opens, where Alignable leaves it, and what its buttons do. */
  pages: (_url: string): { html: string; at?: string } | null => null,
  behave: (_doc: Document, _url: string): void => undefined,
  opened: [] as string[],
  noted: [] as { note: unknown; platform: unknown }[],
  needs: [] as unknown[],
  asked: [] as { type: string; input?: unknown }[],
  posted: [] as { path: string; body: Record<string, unknown> }[],
  answers: {} as Record<string, (body: Record<string, unknown>) => unknown>,
  hfos: {} as Record<string, (ask: Record<string, unknown>) => unknown>,
  /** The person's Alignable choices. */
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
    settings: { voice: { split: false }, networks: { alignable: world.choices } },
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
// Alignable's tab: each address opens its page, which its kit reads and presses on as the tab's script does.
vi.mock('../src/tab', async () => {
  const { JSDOM: Dom } = await import('jsdom');
  const { KITS } = await import('../src/networks');
  const kit = KITS.alignable;
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
        if (!doc) return { ok: false, error: 'The Alignable tab was closed.' };
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

const { alignableTick, alignableWorkLeft, doWork, nextAlignableDaily, runAlignableDaily, longAgo } =
  await import('../src/auto/alignable');
const { searchAlignable } = await import('../src/jobs/alignable/partner-search');
const { NO_TOWN } = await import('../src/jobs/alignable/customer-search');
const { ALIGNABLE: SITE } = await import('../src/networks/alignable/site');
const { WorkTab } = await import('../src/tab');
const { LIVE_KEY } = await import('../src/hfos/live');
const { NETWORKS_KEY } = await import('../src/networks/on');
const { ALIGNABLE_STATE_KEY } = await import('../src/auto/plan');
const { WARNED_KEY } = await import('../src/hfos/warned');

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
      getManifest: () => ({ version: '0.77.0' }),
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

/** A post on a business's page: its author's link, when, its words, its count of likes and its own Like. */
const post = (o: { id: number; by?: string; name?: string; when?: string; words?: string }) => `
  <div><div><a href="${o.by ?? '/austin-tx/acme-plumbing'}?user=5"><span>${o.name ?? 'Dana Reyes'}</span><span>at</span>
      <span>Acme Plumbing</span></a><span>${o.when ?? '3d'}</span></div>
    <div><div title="An update">${o.words ?? 'Spring is here: book your water heater check.'}</div></div>
    <div><div><a href="/biz/likes?resource=${o.id}"><span>2</span><span>Like</span></a></div>
      <div><a href="/biz/discussions/${o.id}">Comment</a>
        <a data-like="${o.id}" href="/biz/likes"><svg></svg><div>Like</div></a></div></div></div>`;

/**
 * A business's own page, as the owner's Check read one (0.67.0): its Recommend and Refer by Alignable's id for it, its
 * names, its town, its own Connect (or Request Sent once asked; or once you're connected, as the owner's report of
 * 26 Oct 2026 showed, its Remove Connection and Alignable's newer Message), its posts, and another business it
 * suggests, with a Connect of its own.
 */
const businessHtml = (
  o: { id?: string; asked?: boolean; connected?: boolean; posts?: string; extra?: string } = {},
) => {
  const id = o.id ?? '42';
  return `<main><section>
    <div><a href="/biz/recommendations/new?id=${id}">Recommend</a><a href="/forward_referral_card/${id}">Refer</a></div>
    <h1 title="Dana Reyes">Dana Reyes</h1><h2 title="Acme Plumbing">Acme Plumbing</h2>
    <div><a href="/austin-tx">Austin, TX</a></div>
    ${o.extra ?? ''}
    <div>${
      o.connected
        ? `<a href="/biz/messages/new?_faid=7&recipient_ids=9001&to_user=9001"><svg></svg>Message</a>
          <button data-testid="introduce-button">Introduce</button>
          <a id="remove" href="/biz/connections/${id}"><svg></svg>Remove Connection</a>`
        : o.asked
          ? '<button disabled>Request Sent</button>'
          : `<a id="connect" href="/biz/connection_requests/make_connection?business_id=${id}&request_source=profile"><div>Connect</div></a>`
    }</div>
    <div><div><div>About Us</div></div><div><p>Family plumbers in Austin since 1990.</p></div></div>
    ${o.posts ?? ''}
    <aside><h3>Businesses like this</h3><div><a href="/austin-tx/best-bakery?user=6">Sam Lee</a>
      <a id="other-connect" href="/biz/connection_requests/make_connection?business_id=43&request_source=profile"><div>Connect</div></a></div></aside>
  </section></main>`;
};

/** A conversation in Alignable's messages, its header linking to the business it's with, its box and its Send. */
const chatHtml = (withId = '42') => `<div data-testid="inbox">
    <div data-testid="conversationInSidebar"><div><div>Sam Lee</div><div>See you Tuesday</div></div></div>
    <div data-testid="channel-header-loaded"><a href="/biz/businesses/${withId}?user=5"><div>Dana Reyes</div></a></div>
    <div data-testid="full-view-write-message"><div contenteditable="true" id="box"></div>
      <button aria-label="Send" data-testid="messaging-send-external"><svg></svg></button></div>
    <form id="elsewhere"><div contenteditable="true" id="other-box"></div><button>Send</button></form>
  </div>`;

/** Alignable's search for businesses, as Check Alignable read it (0.66.0): two results, each by Alignable's id. */
const searchHtml = `<section><div role="contentinfo"><ul>
  <div><a href="/austin-tx/hill-homes?user=8&page_num=1&result_id=4242"><img alt="Hana Hill" /></a>
    <div><div><div><a title="Hana Hill" href="/austin-tx/hill-homes?user=8&result_id=4242">Hana Hill</a></div>
      <div><div><a title="Hill Homes" href="/austin-tx/hill-homes?user=8&result_id=4242">Hill Homes</a>
        <span>Real Estate Agent</span></div><div>Austin, TX</div></div></div>
    <a data-testid="react-connect-button" href="/biz/connection_requests/quick?business_id=4242&result_id=4242">Connect</a></div></div>
  <div><a href="/round-rock-tx/ivy-inspections?user=9&result_id=4343"><img alt="Ivy Inspector" /></a>
    <div><div><div><a title="Ivy Inspector" href="/round-rock-tx/ivy-inspections?user=9&result_id=4343">Ivy Inspector</a></div>
      <div><div><a title="Ivy Inspections" href="/round-rock-tx/ivy-inspections?user=9&result_id=4343">Ivy Inspections</a>
        <span>Home Inspector</span></div><div>Round Rock, TX</div></div></div></div></div>
</ul></div></section>`;

// ------------------------------------------------------------------------------------------------- the day

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const day = (state: 'none' | 'started' | 'stopped') => ({
  date: today(),
  state,
  why: state === 'stopped' ? 'person' : null,
  via: state === 'none' ? null : 'web',
  at: null,
});
function keep(alignableDay: ReturnType<typeof day>) {
  store.set(LIVE_KEY, {
    ...ME,
    at: Date.now(),
    computerId: '00000000-0000-4000-8000-000000000001',
    name: 'Chrome on Mac',
    working: true,
    workingName: null,
    day: day('none'),
    days: { alignable: alignableDay },
    stepsKept: [],
    asks: 0,
  });
}
/** Lists saved and checked: the day can go. */
const saved = () => {
  const at = new Date().toISOString();
  return {
    friendsAt: at,
    requestsAt: at,
    sentAt: null,
    groupsAt: null,
    groupChecksAt: null,
    tidyAt: null,
    checksAt: at,
  };
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
          to: { profile: { id: string | null } };
        };
      }
    ).step;
    return {
      kind: step.kind,
      auto: step.auto,
      postUrl: step.postUrl,
      id: step.to.profile.id,
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
    alignable: { on: true, allowed: true },
  });
});

// ------------------------------------------------------------------------------------------------- the list

describe('what it does on Alignable’s list', () => {
  it('warms up and connects on its own; comments, answers and requests they got stay theirs', () => {
    const list = {
      items: [
        item({ kind: 'confirm', name: 'Avery Lane' }),
        item({
          kind: 'comment',
          name: 'Lee Park',
          postId: 'p1',
          postUrl: `${AL}/biz/discussions/7`,
        }),
        item({ kind: 'friend_request' }),
        item({ kind: 'warm_up', name: 'Sam Lee', profileId: 'p-sam' }),
      ],
      auto: ['confirm', 'warm_up', 'friend_request', 'comment'],
      messages: [],
      sending: 'steps',
    } as never;
    expect(alignableWorkLeft(list, []).map((w) => w.item.kind)).toEqual([
      'warm_up',
      'friend_request',
    ]);
    // Their own groups first, before any search or join (decision 92), then the requests.
    expect(nextAlignableDaily({ daily: {} })).toBe('my_groups');
    expect(nextAlignableDaily({ daily: { my_groups: 'g' } })).toBe('requests');
    // Their chats right after the connections are checked (0.84.0), as on Instagram; then Find partners, then the
    // town's posts.
    const done = { my_groups: 'g', requests: 'x', checks: 'y' };
    expect(nextAlignableDaily({ daily: done })).toBe('chats');
    expect(nextAlignableDaily({ daily: { ...done, chats: 'c' } })).toBe('partners');
    expect(nextAlignableDaily({ daily: { ...done, chats: 'c', partners: 'z' } })).toBe('posts');
    // Then the search for businesses like their clients, and the groups: found and checked, joined, their members,
    // their posts (decision 92).
    const town = { ...done, chats: 'c', partners: 'z', posts: 'w' };
    const groups = ['search', 'group_checks', 'join', 'members', 'group_posts'] as const;
    let daily: Record<string, string> = town;
    for (const job of groups) {
      expect(nextAlignableDaily({ daily })).toBe(job);
      daily = { ...daily, [job]: 'd' };
    }
    // Then who engaged with them, from their notifications.
    expect(nextAlignableDaily({ daily })).toBe('helpful');
    // Last, the businesses found by topic checked for good fits (decision 92).
    const all = { ...daily, helpful: 'v' };
    expect(nextAlignableDaily({ daily: all })).toBe('found_checks');
    expect(nextAlignableDaily({ daily: { ...all, found_checks: 'u' } })).toBeNull();
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
    expect(alignableWorkLeft(list('waiting'), [])).toEqual([]);
    expect(alignableWorkLeft(list('approved'), []).map((w) => w.do)).toEqual(['send']);
  });

  it('takes a post of weeks or more ago as old, never one of days', () => {
    expect(['3d', '2 weeks ago', 'Yesterday', '4h', null].map(longAgo)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(['2mo', '5w', 'about 1 year ago', '3 months ago'].map(longAgo)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

describe('a warm-up on Alignable', () => {
  /** Their page opens by Alignable's id at its address in its town; its Like says Liked once pressed. */
  const pageWith = (posts: string) => {
    world.pages = (url) => (url === DANA ? { html: businessHtml({ posts }), at: DANA_PAGE } : null);
    world.behave = (doc) => {
      for (const like of doc.querySelectorAll('[data-like]'))
        like.addEventListener('click', (event) => {
          event.preventDefault();
          like.querySelector('div')!.textContent = 'Liked';
        });
    };
  };

  it('looks at their business page and likes a recent post of theirs, noting it as Alignable’s own', async () => {
    pageWith(
      `${post({ id: 90, by: '/austin-tx/best-bakery', name: 'Sam Lee' })}${post({ id: 91 })}`,
    );
    let pressed = '';
    const behave = world.behave;
    world.behave = (doc, url) => {
      behave(doc, url);
      for (const like of doc.querySelectorAll('[data-like]'))
        like.addEventListener('click', () => (pressed = like.getAttribute('data-like')!));
    };
    const outcome = await doWork(
      { do: 'step', item: item({ kind: 'warm_up' }) },
      ME.businessId,
      false,
    );
    expect(outcome).toEqual({
      done: true,
      line: 'Looked at Dana Reyes’s business page and liked a post of theirs: the connection request comes tomorrow',
    });
    expect(world.opened).toEqual([DANA]);
    // Their own post, never the one by the business beside it.
    expect(pressed).toBe('91');
    expect(notedAs()).toEqual([
      {
        kind: 'like',
        auto: true,
        postUrl: `${AL}/biz/discussions/91`,
        id: '42',
        platform: 'alignable',
      },
    ]);
    expect(missedPosted()).toEqual([]);
  });

  it('counts the look alone when their page shows no recent post of theirs, and the request needn’t wait', async () => {
    pageWith(post({ id: 92, when: '3 months ago' }));
    const outcome = await doWork(
      { do: 'step', item: item({ kind: 'warm_up' }) },
      ME.businessId,
      false,
    );
    expect(outcome).toEqual({
      done: true,
      line: 'Looked at Dana Reyes’s business page, with no recent post of theirs to like: the look is the warm-up, so the connection request can go next',
    });
    expect(world.noted).toEqual([]);
    expect(missedPosted().map((p) => p.body)).toEqual([
      { workspaceId: ME.businessId, profileId: PROFILE_ID },
    ]);
  });

  it('hands the step to them when Alignable shows another business’s page', async () => {
    world.pages = () => ({ html: businessHtml({ id: '77' }), at: DANA_PAGE });
    const outcome = await doWork(
      { do: 'step', item: item({ kind: 'warm_up' }) },
      ME.businessId,
      false,
    );
    expect(outcome).toEqual({
      done: false,
      line: 'Dana Reyes: Alignable showed a different page',
      need: true,
    });
    expect(world.noted).toEqual([]);
  });
});

describe('a connection request on Alignable', () => {
  it('presses their own Connect, by their business’s id, and notes the request once their page shows it went', async () => {
    let asked = false;
    let pressed = '';
    world.pages = (url) => (url === DANA ? { html: businessHtml({ asked }), at: DANA_PAGE } : null);
    world.behave = (doc) => {
      for (const link of doc.querySelectorAll('a[href*="connection_requests"]'))
        link.addEventListener('click', (event) => {
          event.preventDefault();
          pressed = link.id;
          asked = true;
        });
    };
    const outcome = await doWork({ do: 'step', item: item({}) }, ME.businessId, false);
    expect(outcome).toEqual({ done: true, line: 'Sent Dana Reyes a connection request' });
    // Their page, then their page again to see the request went.
    expect(world.opened).toEqual([DANA, DANA]);
    expect(pressed).toBe('connect');
    expect(notedAs()).toEqual([
      { kind: 'friend_request', auto: true, postUrl: null, id: '42', platform: 'alignable' },
    ]);
  });

  it('presses nothing on another business’s page, nor another business’s Connect', async () => {
    let pressed = '';
    world.behave = (doc) => {
      for (const link of doc.querySelectorAll('a[href*="connection_requests"]'))
        link.addEventListener('click', (event) => {
          event.preventDefault();
          pressed = link.id;
        });
    };
    // Alignable showed another business: by its id, it isn't theirs.
    world.pages = () => ({ html: businessHtml({ id: '77' }), at: DANA_PAGE });
    expect(await doWork({ do: 'step', item: item({}) }, ME.businessId, false)).toEqual({
      done: false,
      line: 'Dana Reyes: Alignable showed a different page',
      need: true,
    });
    // Their own page, asked already: only the Connect of the business it suggests is there.
    world.pages = () => ({
      html: businessHtml({
        asked: true,
        extra: '<a href="/biz/conversations?with_business_id=42">Message</a>',
      }),
      at: DANA_PAGE,
    });
    expect(await doWork({ do: 'step', item: item({}) }, ME.businessId, false)).toEqual({
      done: false,
      line: 'Dana Reyes: no Connect on their page: you’re connected already, or asked',
    });
    expect(pressed).toBe('');
    expect(world.noted).toEqual([]);
  });

  it('hands it to them when Alignable didn’t take the request', async () => {
    world.pages = () => ({ html: businessHtml(), at: DANA_PAGE });
    world.behave = (doc) =>
      doc.querySelector('#connect')!.addEventListener('click', (event) => event.preventDefault());
    expect(await doWork({ do: 'step', item: item({}) }, ME.businessId, false)).toEqual({
      done: false,
      line: 'Dana Reyes: Alignable didn’t take the request',
      need: true,
    });
    expect(world.noted).toEqual([]);
  });

  /** Every link that would change a connection, noting which was pressed. */
  const pressedOn = (pressed: string[]) => (doc: Document) => {
    for (const link of doc.querySelectorAll(
      'a[href*="connection_requests"], a[href*="/biz/connections/"]',
    ))
      link.addEventListener('click', (event) => {
        event.preventDefault();
        pressed.push(link.id);
      });
  };

  it('passes over a business their page shows you’re connected with, keeps them as a connection, and hands nothing to you', async () => {
    // The owner's report of 26 Oct 2026: their Remove Connection and Alignable's newer Message, no Connect of theirs,
    // and the Connect of a business their page suggests.
    world.pages = (url) =>
      url === DANA ? { html: businessHtml({ connected: true }), at: DANA_PAGE } : null;
    const pressed: string[] = [];
    world.behave = pressedOn(pressed);
    world.hfos['hfos-save-friends'] = () => ({ saved: 1, added: 0, changed: 1 });
    expect(await doWork({ do: 'step', item: item({}) }, ME.businessId, false)).toEqual({
      done: false,
      line: 'Dana Reyes: you’re connected already',
    });
    expect(world.opened).toEqual([DANA]);
    expect(pressed).toEqual([]);
    expect(world.noted).toEqual([]);
    // Kept as one of their Alignable connections, as Save my connections keeps them: Today won't offer it again.
    expect(world.asked.filter((a) => a.type === 'hfos-save-friends').map((a) => a.input)).toEqual([
      {
        workspaceId: ME.businessId,
        platform: 'alignable',
        list: 'friends',
        people: [
          {
            name: 'Dana Reyes',
            profile: { id: '42', username: 'austin-tx-acme-plumbing', url: DANA },
            mutualFriends: null,
          },
        ],
      },
    ]);
    // Its tab presses nothing there either, by Alignable's id for their business.
    const { JSDOM } = await import('jsdom');
    const { connectOnPage } = await import('../src/networks/alignable/auto');
    const doc = new JSDOM(`<!doctype html><body>${businessHtml({ connected: true })}</body>`, {
      url: DANA_PAGE,
    }).window.document;
    pressedOn(pressed)(doc);
    expect(connectOnPage(doc, DANA_PAGE, { id: '42', username: null, url: DANA })).toBe('already');
    expect(pressed).toEqual([]);
  });

  it('passes over a page with only Alignable’s newer Message of theirs, without keeping them as a connection', async () => {
    // No Connect of theirs and no Remove Connection: their newer Message, among their own buttons, says only that
    // they're connected already or asked. It's passed over, never handed to you, and only Remove Connection keeps them.
    world.pages = (url) =>
      url === DANA
        ? {
            html: businessHtml({
              asked: true,
              extra: `<div><a href="/biz/messages/new?_faid=7&recipient_ids=9001&to_user=9001"><svg></svg>Message</a>
                <a href="/forward_referral_card/42">Refer</a></div>`,
            }),
            at: DANA_PAGE,
          }
        : null;
    const pressed: string[] = [];
    world.behave = pressedOn(pressed);
    expect(await doWork({ do: 'step', item: item({}) }, ME.businessId, false)).toEqual({
      done: false,
      line: 'Dana Reyes: no Connect on their page: you’re connected already, or asked',
    });
    expect(pressed).toEqual([]);
    expect(world.noted).toEqual([]);
    expect(world.asked.filter((a) => a.type === 'hfos-save-friends')).toEqual([]);
  });

  it('notes the request when their page shows you’re connected once Connect is pressed', async () => {
    let connected = false;
    world.pages = (url) =>
      url === DANA ? { html: businessHtml({ connected }), at: DANA_PAGE } : null;
    world.behave = (doc) =>
      doc.querySelector('#connect')?.addEventListener('click', (event) => {
        event.preventDefault();
        connected = true;
      });
    expect(await doWork({ do: 'step', item: item({}) }, ME.businessId, false)).toEqual({
      done: true,
      line: 'Sent Dana Reyes a connection request',
    });
    expect(notedAs()).toEqual([
      { kind: 'friend_request', auto: true, postUrl: null, id: '42', platform: 'alignable' },
    ]);
  });
});

describe('a message on Alignable', () => {
  const approved = (more: Partial<TodayListItem> = {}) =>
    item({
      kind: 'follow_up',
      send: {
        sendId: '5e6f7081-92a3-4b4c-8d5e-6f708192a3b4',
        state: 'approved',
        text: 'Glad to help, Dana.',
        handedOver: false,
        needsYou: null,
      },
      ...more,
    });

  /** Typing goes into the box clicked; Send takes what's in the conversation's box and empties it. */
  const sentOn = (sent: string[]) => (doc: Document) => {
    let typed: Element | null = null;
    for (const box of doc.querySelectorAll('[contenteditable="true"]'))
      box.addEventListener('click', () => (typed = box));
    doc.execCommand = (_c: string, _u?: boolean, text?: string) => {
      if (typed) typed.textContent = text ?? '';
      return true;
    };
    doc.querySelector('[data-testid="messaging-send-external"]')!.addEventListener('click', () => {
      const box = doc.querySelector('#box')!;
      sent.push(box.textContent ?? '');
      box.textContent = '';
    });
  };

  it('sends one OK’d in their conversation, typing only into its own box, and says it went', async () => {
    world.pages = (url) => (url === DANA_CHAT ? { html: chatHtml() } : null);
    const sent: string[] = [];
    let other = '';
    world.behave = (doc) => {
      sentOn(sent)(doc);
      other = doc.querySelector('#other-box')!.textContent ?? '';
    };
    world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
    const outcome = await doWork({ do: 'send', item: approved() }, ME.businessId, false);
    expect(outcome).toEqual({ done: true, line: 'Sent Dana Reyes a message' });
    // Its kit's chatUrl, by their business's id.
    expect(world.opened).toEqual([DANA_CHAT]);
    expect(sent).toEqual(['Glad to help, Dana.']);
    expect(other).toBe('');
    expect(notedAs()).toEqual([
      { kind: 'message', auto: true, postUrl: null, id: '42', platform: 'alignable' },
    ]);
    const note = world.noted[0]!.note as { step: { thread: unknown } };
    expect(note.step.thread).toEqual({ id: '42', encrypted: false, url: DANA_CHAT });
    expect(
      world.posted.find((p) => p.path === '/v1/commands/outreach.send.done')?.body,
    ).toMatchObject({ sent: true });
  });

  it('types nothing when Alignable opens a conversation with another business, and says it wasn’t sent', async () => {
    world.pages = () => ({ html: chatHtml('77'), at: DANA_CHAT });
    const sent: string[] = [];
    world.behave = sentOn(sent);
    world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
    const outcome = await doWork({ do: 'send', item: approved() }, ME.businessId, false);
    expect(outcome).toEqual({
      done: false,
      line: 'Dana Reyes: Alignable showed a different conversation',
    });
    expect(sent).toEqual([]);
    expect(world.noted).toEqual([]);
    expect(
      world.posted.find((p) => p.path === '/v1/commands/outreach.send.done')?.body,
    ).toMatchObject({ sent: false, why: 'Alignable showed a different conversation' });
  });

  it('sends one when the header links to their business by its address in its town alone, and never to another business’s so', async () => {
    for (const [header, goes] of [
      ['/austin-tx/acme-plumbing', true],
      ['/austin-tx/kim-bakes', false],
    ] as const) {
      // Kept by its address in its town, with its conversation's key; the header shows the same name either way.
      world.pages = (url) =>
        url === DANA_CHAT
          ? { html: chatHtml().replace('/biz/businesses/42?user=5', header) }
          : null;
      const sent: string[] = [];
      world.behave = sentOn(sent);
      world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
      const outcome = await doWork(
        { do: 'send', item: approved({ profileUrl: DANA_PAGE, threadKey: '42' }) },
        ME.businessId,
        false,
      );
      expect(outcome).toEqual(
        goes
          ? { done: true, line: 'Sent Dana Reyes a message' }
          : { done: false, line: 'Dana Reyes: couldn’t find the box to write in' },
      );
      expect(sent).toEqual(goes ? ['Glad to help, Dana.'] : []);
    }
  });

  it('sends nothing, and takes the writing out, when the focus isn’t in its box or the conversation changes as it’s typed', async () => {
    for (const trouble of ['focus', 'header'] as const) {
      world.pages = (url) => (url === DANA_CHAT ? { html: chatHtml() } : null);
      const sent: string[] = [];
      let box: HTMLElement | null = null;
      world.behave = (doc) => {
        sentOn(sent)(doc);
        box = doc.querySelector<HTMLElement>('#box');
        const type = doc.execCommand;
        if (trouble === 'focus') box!.focus = () => undefined;
        else
          doc.execCommand = (command: string, ui?: boolean, text?: string) => {
            const typed = type.call(doc, command, ui, text);
            // Alignable opens another business's conversation in the same box as it's typed.
            if (command === 'insertText')
              doc
                .querySelector('[data-testid="channel-header-loaded"] a')!
                .setAttribute('href', '/biz/businesses/77?user=9');
            return typed;
          };
      };
      world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
      const outcome = await doWork({ do: 'send', item: approved() }, ME.businessId, false);
      expect(outcome).toEqual({
        done: false,
        line: 'Dana Reyes: its typing didn’t stay in their conversation, so it took it out and sent nothing',
      });
      expect(sent).toEqual([]);
      expect(box!.textContent).toBe('');
    }
  });

  it('types nothing in a conversation whose header isn’t drawn, on its address alone', async () => {
    const { writeMessage } = await import('../src/networks/alignable/auto');
    const { JSDOM } = await import('jsdom');
    const doc = new JSDOM(`<!doctype html><html><body>${chatHtml()}</body></html>`, {
      url: DANA_CHAT,
    }).window.document;
    doc.querySelector('[data-testid="channel-header-loaded"]')!.remove();
    const sent: string[] = [];
    sentOn(sent)(doc);
    const dana = { id: '42', username: null, url: DANA };
    expect(await writeMessage(doc, DANA_CHAT, 'Glad to help, Dana.', dana)).toBe('none');
    expect(sent).toEqual([]);
    expect(doc.querySelector('#box')!.textContent).toBe('');
  });

  it('drafts one after looking their business page up, and leaves it to wait for their OK', async () => {
    world.pages = (url) => (url === DANA ? { html: businessHtml(), at: DANA_PAGE } : null);
    world.hfos['hfos-draft'] = () => ({
      drafts: ['Hi Dana, how did spring tune-ups go?'],
      kind: 'follow_up',
      opener: null,
      simple: false,
    });
    world.answers['/v1/commands/outreach.send.queue'] = () => ({ state: 'waiting' });
    const outcome = await doWork(
      { do: 'draft', item: item({ kind: 'follow_up' }) },
      ME.businessId,
      false,
    );
    expect(outcome).toEqual({
      done: true,
      line: 'Wrote a message to Dana Reyes: it waits for your OK',
    });
    const drafted = world.asked.find((a) => a.type === 'hfos-draft') as {
      input?: { lookup: string[] };
    };
    expect(drafted.input?.lookup).toContain('About Us: Family plumbers in Austin since 1990.');
    expect(world.noted).toEqual([]);
  });
});

describe('Find partners on Alignable', () => {
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

  it('searches Alignable’s businesses, keeps each by Alignable’s id, and finds no creators', async () => {
    world.pages = (url) =>
      url === `${AL}/biz/search?q=Austin%20realtors` ? { html: searchHtml } : null;
    expect(await searchAlignable(job(), 'creator', 'Austin realtors')).toEqual([]);
    expect(world.opened).toEqual([]);
    expect(await searchAlignable(job(), 'business', 'Austin realtors')).toEqual([
      {
        name: 'Hana Hill',
        profile: {
          id: '4242',
          username: 'austin-tx-hill-homes',
          url: `${AL}/austin-tx/hill-homes`,
        },
        lines: ['Hill Homes', 'Real Estate Agent', 'Austin, TX'],
        followers: null,
      },
      {
        name: 'Ivy Inspector',
        profile: {
          id: '4343',
          username: 'round-rock-tx-ivy-inspections',
          url: `${AL}/round-rock-tx/ivy-inspections`,
        },
        lines: ['Ivy Inspections', 'Home Inspector', 'Round Rock, TX'],
        followers: null,
      },
    ]);
  });

  it('once a day: today’s searches, who they found sent to keep, then each read for the AI’s partner check', async () => {
    world.pages = (url) =>
      url === `${AL}/biz/search?q=Austin%20realtors`
        ? { html: searchHtml }
        : url === `${AL}/austin-tx/hill-homes`
          ? { html: businessHtml({ id: '4242' }).replace(/Dana Reyes/g, 'Hana Hill') }
          : null;
    world.hfos['hfos-partner-searches'] = () => ({
      searches: [{ kind: 'business', words: 'Austin realtors' }],
      today: 0,
      perDay: 2,
      waiting: 0,
    });
    world.hfos['hfos-partner-leads'] = () => ({ kept: 2 });
    world.hfos['hfos-partners-next'] = () => ({
      people: [
        {
          profileId: PROFILE_ID,
          name: 'Hana Hill',
          url: `${AL}/austin-tx/hill-homes`,
          kind: 'business',
        },
      ],
      today: 0,
      perDay: 15,
    });
    world.hfos['hfos-partner-look'] = () => ({ partnerId: PROFILE_ID, fit: 'waiting' });
    const end = await runAlignableDaily('partners', job());
    expect(world.asked.find((a) => a.type === 'hfos-partner-searches')?.input).toMatchObject({
      platform: 'alignable',
    });
    expect(world.asked.find((a) => a.type === 'hfos-partner-leads')?.input).toMatchObject({
      platform: 'alignable',
      kind: 'business',
      words: 'Austin realtors',
      people: [
        { name: 'Hana Hill', profile: { id: '4242' } },
        { name: 'Ivy Inspector', profile: { id: '4343' } },
      ],
    });
    expect(world.asked.find((a) => a.type === 'hfos-partners-next')?.input).toMatchObject({
      platform: 'alignable',
    });
    expect(world.asked.find((a) => a.type === 'hfos-partner-look')?.input).toMatchObject({
      kind: 'business',
      missing: false,
      lines: expect.arrayContaining(['About Us: Family plumbers in Austin since 1990.']),
    });
    expect(end).toEqual({
      line: 'Done. Searched Alignable 1 time and found 2 new people who could partner. Read 1 possible partner for the AI. Good partners show on the Partners list once it has read them.',
      warned: false,
    });
  });
});

// ------------------------------------------------------------------------------------------ finding by topic (92)

/** Their own profile, which Alignable opens at their business's address in their town (Austin, TX). */
const MINE = `${AL}/biz/businesses/my_profile`;
const myProfile = (town = true) => ({
  html: '<main><h1 title="Casey Owner">Casey Owner</h1></main>',
  ...(town ? { at: `${AL}/austin-tx/acme-roofing?user=7` } : {}),
});

/** A once-a-day job's window, asking HandsFreeOS as `world.hfos` answers. */
const dailyJob = (): Job => ({
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
  report: async () => undefined,
});

const inputsOf = (type: string) =>
  world.asked.filter((a) => a.type === type).map((a) => a.input as Record<string, unknown>);
const peopleIn = (ask: Record<string, unknown>) =>
  (ask['input'] as { people: unknown[] }).people.length;

/** Their own business, as a search or a group's members show it: never someone to find. */
const OWN_ROW = `<div><a href="/austin-tx/acme-roofing?user=7&result_id=4141"><img alt="Casey Owner" /></a>
    <div><div><div><a title="Casey Owner" href="/austin-tx/acme-roofing?user=7&result_id=4141">Casey Owner</a></div>
      <div><div><a title="Acme Roofing" href="/austin-tx/acme-roofing?user=7&result_id=4141">Acme Roofing</a>
        <span>Roofing Contractor</span></div><div>Austin, TX</div></div></div></div></div>`;

describe('the search for businesses like their clients on Alignable', () => {
  beforeEach(() => {
    world.hfos['hfos-finds-save'] = (ask) => ({ added: peopleIn(ask) });
  });

  it('keeps only their town’s businesses on a local search, and every one on a search that works online', async () => {
    // Their own business shows in both: never kept.
    world.pages = (url) =>
      url === MINE
        ? myProfile()
        : url === `${AL}/biz/search?q=real%20estate%20agent%20Austin%20TX` ||
            url === `${AL}/biz/search?q=home%20inspector`
          ? { html: searchHtml.replace('<ul>', `<ul>${OWN_ROW}`) }
          : null;
    world.hfos['hfos-finds-searches'] = () => ({
      searches: [
        { words: 'real estate agent', anywhere: false },
        { words: 'home inspector', anywhere: true },
      ],
    });
    const end = await runAlignableDaily('search', dailyJob());
    expect(world.opened).toEqual([
      MINE,
      `${AL}/biz/search?q=real%20estate%20agent%20Austin%20TX`,
      `${AL}/biz/search?q=home%20inspector`,
    ]);
    expect(inputsOf('hfos-finds-searches')).toEqual([
      { workspaceId: ME.businessId, platform: 'alignable' },
    ]);
    const saves = inputsOf('hfos-finds-save');
    expect(saves).toMatchObject([
      {
        platform: 'alignable',
        how: 'searched',
        words: 'real estate agent',
        place: 'Austin, TX',
        group: null,
        postId: null,
        people: [{ name: 'Hana Hill', profile: { id: '4242' }, place: 'Austin, TX' }],
      },
      {
        how: 'searched',
        words: 'home inspector',
        place: null,
        people: [
          { name: 'Hana Hill', place: 'Austin, TX' },
          { name: 'Ivy Inspector', profile: { id: '4343' }, place: 'Round Rock, TX' },
        ],
      },
    ]);
    // The town's businesses only: never the one in Round Rock on the local search.
    expect((saves[0]!['people'] as unknown[]).length).toBe(1);
    expect(end).toEqual({
      line: 'Searched Alignable for 2 kinds of business: 3 businesses found, 3 new to check. The good fits come onto Today once the AI has read their pages.',
      warned: false,
    });
  });

  it('ends with what to do when Alignable didn’t show their town, after any search that works online', async () => {
    world.pages = (url) =>
      url === MINE
        ? myProfile(false)
        : url === `${AL}/biz/search?q=home%20inspector`
          ? { html: searchHtml }
          : null;
    world.hfos['hfos-finds-searches'] = () => ({
      searches: [{ words: 'real estate agent', anywhere: false }],
    });
    expect(await runAlignableDaily('search', dailyJob())).toEqual({
      line: NO_TOWN,
      warned: false,
      failed: true,
    });
    expect(world.opened).toEqual([MINE]);
    expect(inputsOf('hfos-finds-save')).toEqual([]);

    world.opened.length = 0;
    world.hfos['hfos-finds-searches'] = () => ({
      searches: [
        { words: 'real estate agent', anywhere: false },
        { words: 'home inspector', anywhere: true },
      ],
    });
    const end = await runAlignableDaily('search', dailyJob());
    expect(world.opened).toEqual([MINE, `${AL}/biz/search?q=home%20inspector`]);
    expect(end.line).toBe(
      `Searched Alignable for 1 kind of business: 2 businesses found, 2 new to check. The good fits come onto Today once the AI has read their pages. ${NO_TOWN}`,
    );
    expect(NO_TOWN).toBe(
      'Alignable didn’t show your town. Check your business page’s address in Alignable, then start your day again.',
    );
  });
});

/** Made-up groups on Alignable, by HandsFreeOS's ids for them. */
const GROUPS = [
  {
    groupId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c51',
    slug: 'home-pros-network',
    name: 'Home Pros Network',
  },
  {
    groupId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c52',
    slug: 'maple-valley-trades',
    name: 'Maple Valley Trades',
  },
  {
    groupId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c53',
    slug: 'cedar-creek-builders',
    name: 'Cedar Creek Builders',
  },
].map((g) => ({ groupId: g.groupId, name: g.name, url: `${AL}/groups/${g.slug}` }));
const TOWN_GROUP = {
  groupId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c50',
  name: 'Austin Business Owners',
  url: `${AL}/groups/austin-tx`,
};

/**
 * A group's own page: its name, members and where the person stands (its own Join, Joined or Requested), its About, a
 * post, and another group it suggests with a Join of its own.
 */
const groupHtml = (
  standing: 'join' | 'joined' | 'requested' = 'join',
  name = 'Home Pros Network',
) =>
  `<main><h1>${name}</h1>
    <div><span>1,204 members</span>${
      standing === 'joined'
        ? '<button>Joined</button>'
        : standing === 'requested'
          ? '<button>Requested</button>'
          : '<button data-join="own">Join</button>'
    }</div>
    <section><h2>About</h2><p>For people who fix and build homes.</p></section>
    <section>${post({ id: 93, by: '/denver-co/stone-gutters', name: 'Riley Stone', words: 'Who else is busy with gutters this fall?' })}</section>
    <aside><h3>Groups you may like</h3>
      <div><a href="/groups/riverbend-roofers">Riverbend Roofers</a><button data-join="other">Join</button></div></aside>
  </main>`;

/** HandsFreeOS's list of a group to work, as `outreach.groups` gives it. */
const workGroup = (g: { groupId: string; name: string; url: string }) => ({
  ...g,
  privacy: null,
  members: 1204,
  detail: null,
  joined: true,
  verdict: 'work',
  reasons: [],
  playbookName: null,
  people: 0,
  runsGroup: 0,
  replies: 0,
  demos: 0,
});

/** What HandsFreeOS says of joining today. */
const joinsNext = (more: Record<string, unknown> = {}) => ({
  groups: [],
  today: 0,
  perDay: 3,
  prospects: { left: 40, days: 2, low: true },
  words: 'home services',
  anywhere: false,
  onItsOwn: true,
  ...more,
});

describe('Alignable’s groups', () => {
  it('reads their own groups first, each saved as one they’re in, never one it only suggests', async () => {
    world.pages = (url) =>
      url === `${AL}/biz/groups`
        ? {
            html: `<main><h1>My Groups</h1>
              <div><a href="/groups/austin-tx">Austin Business Owners</a><span>2,310 members</span><button>Leave</button></div>
              <div><a href="/groups/riverbend-roofers">Riverbend Roofers</a><span>86 members</span><button>Joined</button></div>
              <div><a href="/groups/home-pros-network">Home Pros Network</a><button>Join</button></div>
              <div><a href="/groups/maple-street-makers">Maple Street Makers</a><span>40 members</span></div></main>`,
          }
        : null;
    world.hfos['hfos-save-groups'] = (ask) => ({
      saved: (ask['input'] as { groups: unknown[] }).groups.length,
    });
    expect(nextAlignableDaily({ daily: {} })).toBe('my_groups');
    const end = await runAlignableDaily('my_groups', dailyJob());
    expect(world.opened).toEqual([`${AL}/biz/groups`]);
    expect(inputsOf('hfos-save-groups')).toMatchObject([
      {
        platform: 'alignable',
        groups: [
          { group: { url: `${AL}/groups/austin-tx` }, members: 2310, joined: true },
          { group: { url: `${AL}/groups/riverbend-roofers` }, members: 86, joined: true },
        ],
      },
    ]);
    expect(end).toEqual({ line: 'Saved 2 groups of yours on Alignable.', warned: false });
  });

  it('takes every card of their own groups page as theirs when none offers a Join', async () => {
    world.pages = (url) =>
      url === `${AL}/biz/groups`
        ? {
            html: `<main><h1>My Groups</h1>
              <div><a href="/groups/austin-tx">Austin Business Owners</a><span>2,310 members</span></div>
              <div><a href="/groups/maple-street-makers">Maple Street Makers</a><span>40 members</span></div></main>`,
          }
        : null;
    world.hfos['hfos-save-groups'] = (ask) => ({
      saved: (ask['input'] as { groups: unknown[] }).groups.length,
    });
    const end = await runAlignableDaily('my_groups', dailyJob());
    expect(inputsOf('hfos-save-groups')).toMatchObject([
      {
        groups: [
          { group: { url: `${AL}/groups/austin-tx` }, joined: true },
          { group: { url: `${AL}/groups/maple-street-makers` }, joined: true },
        ],
      },
    ]);
    expect(end).toEqual({ line: 'Saved 2 groups of yours on Alignable.', warned: false });
  });

  it('keeps the plain cards of their own groups page beside one asked and waiting, leaving that one out', async () => {
    // A group it asked to join, whose leaders haven't said yet: the page still offers no Join.
    world.pages = (url) =>
      url === `${AL}/biz/groups`
        ? {
            html: `<main><h1>My Groups</h1>
              <div><a href="/groups/austin-tx">Austin Business Owners</a><span>2,310 members</span></div>
              <div><a href="/groups/maple-street-makers">Maple Street Makers</a><span>40 members</span></div>
              <div><a href="/groups/home-pros-network">Home Pros Network</a><span>1,204 members</span>
                <button>Cancel Request</button></div></main>`,
          }
        : null;
    world.hfos['hfos-save-groups'] = (ask) => ({
      saved: (ask['input'] as { groups: unknown[] }).groups.length,
    });
    const end = await runAlignableDaily('my_groups', dailyJob());
    expect(world.opened).toEqual([`${AL}/biz/groups`]);
    expect(inputsOf('hfos-save-groups')).toMatchObject([
      {
        groups: [
          { group: { url: `${AL}/groups/austin-tx` }, joined: true },
          { group: { url: `${AL}/groups/maple-street-makers` }, joined: true },
        ],
      },
    ]);
    expect(end).toEqual({ line: 'Saved 2 groups of yours on Alignable.', warned: false });
  });

  it('finds groups with today’s words in their town when none wait, then sends each for the AI’s check', async () => {
    let asked = 0;
    world.hfos['hfos-groups-to-check'] = () =>
      asked++ === 0
        ? { groups: [], saved: 2 }
        : { groups: [{ ...GROUPS[0]!, joined: false }], saved: 3 };
    world.hfos['hfos-joins-next'] = () => joinsNext();
    world.hfos['hfos-save-groups'] = (ask) => ({
      saved: (ask['input'] as { groups: unknown[] }).groups.length,
    });
    world.hfos['hfos-group-look'] = () => ({});
    const search = `${AL}/groups/search?q=home%20services%20Austin%20TX`;
    world.pages = (url) =>
      url === MINE
        ? myProfile()
        : url === search
          ? {
              html: `<main><div><a href="/groups/home-pros-network">Home Pros Network</a>
                <span>For people who fix and build homes</span><span>1,204 members</span><button>Join</button></div></main>`,
            }
          : url === GROUPS[0]!.url
            ? { html: groupHtml() }
            : null;
    const end = await runAlignableDaily('group_checks', dailyJob());
    expect(world.opened).toEqual([MINE, search, GROUPS[0]!.url]);
    expect(inputsOf('hfos-groups-to-check')[0]).toMatchObject({ platform: 'alignable', most: 4 });
    expect(inputsOf('hfos-save-groups')).toMatchObject([
      { platform: 'alignable', groups: [{ group: { url: GROUPS[0]!.url }, joined: false }] },
    ]);
    expect(inputsOf('hfos-group-look')).toEqual([
      {
        workspaceId: ME.businessId,
        groupId: GROUPS[0]!.groupId,
        about: ['For people who fix and build homes.'],
        posts: ['Who else is busy with gutters this fall?'],
        joined: false,
      },
    ]);
    expect(end).toEqual({
      line: 'Found 1 group on Alignable for your niche and area. Checked 1 group. The good ones are joined as your groups run low on people to reach.',
      warned: false,
    });
  });

  it('joins only the good groups HandsFreeOS lists, at most today’s 3, each with its own Join', async () => {
    const standing = new Map<string, 'join' | 'joined' | 'requested'>();
    const pressed: string[] = [];
    world.pages = (url) => {
      const group = GROUPS.find((g) => g.url === url);
      return group ? { html: groupHtml(standing.get(url) ?? 'join', group.name) } : null;
    };
    world.behave = (doc, url) => {
      for (const join of doc.querySelectorAll<HTMLElement>('[data-join]'))
        join.addEventListener('click', () => {
          if (join.dataset['join'] !== 'own') return void pressed.push(`another group, on ${url}`);
          pressed.push(url);
          // The first lets them straight in; the others wait for their leaders.
          const now = url === GROUPS[0]!.url ? 'joined' : 'requested';
          standing.set(url, now);
          join.textContent = now === 'joined' ? 'Joined' : 'Requested';
        });
    };
    world.hfos['hfos-joins-next'] = () => joinsNext({ groups: GROUPS });
    world.hfos['hfos-join-note'] = () => ({});
    const end = await runAlignableDaily('join', dailyJob());
    // Each group's page, then again to see how its Join went.
    expect(world.opened).toEqual(GROUPS.flatMap((g) => [g.url, g.url]));
    expect(pressed).toEqual(GROUPS.map((g) => g.url));
    expect(inputsOf('hfos-joins-next')[0]).toMatchObject({ platform: 'alignable' });
    expect(inputsOf('hfos-join-note')).toEqual(
      GROUPS.map((g, i) => ({
        workspaceId: ME.businessId,
        groupId: g.groupId,
        state: i === 0 ? 'joined' : 'pending',
        answers: [],
        why: null,
      })),
    );
    expect(end).toEqual({
      line: 'Joined 1 group on Alignable. Asked to join 2 groups: their leaders say yes or no.',
      warned: false,
      failed: false,
    });
  });

  it('joins nothing once today’s are joined, while their groups have people left, or while they’ve said not to', async () => {
    const cases = [
      [{ today: 3 }, 'That’s today’s 3 groups joined on Alignable. It carries on tomorrow.'],
      [
        { prospects: { left: 400, days: 20, low: false } },
        'Your Alignable groups have 400 people left to reach: no need to join more yet.',
      ],
      [{ onItsOwn: false }, 'Joining groups on its own is off in your Alignable settings.'],
    ] as const;
    for (const [more, line] of cases) {
      world.hfos['hfos-joins-next'] = () => joinsNext({ groups: GROUPS, ...more });
      expect((await runAlignableDaily('join', dailyJob())).line).toBe(line);
    }
    expect(world.opened).toEqual([]);
  });

  it('answers that there were no questions to a join: Alignable asks none, so nothing waits on the AI', async () => {
    expect(typeof SITE.auto?.join).toBe('function');
    expect(typeof SITE.auto?.comment).toBe('function');
    world.pages = (url) => (url === GROUPS[0]!.url ? { html: groupHtml() } : null);
    const tab = new WorkTab('window');
    await tab.open(GROUPS[0]!.url);
    expect(await tab.ask({ type: 'hfos-join-answer', answers: [] })).toEqual({
      ok: true,
      result: 'none',
    });
  });

  it('reads a group’s members, its leaders first and kept as running it; everyone else is sent as found', async () => {
    world.hfos['hfos-groups'] = (ask) =>
      (ask['input'] as { view: string }).view === 'work'
        ? { groups: [workGroup(GROUPS[0]!)] }
        : { groups: [] };
    world.hfos['hfos-save-group'] = (ask) => ({ people: peopleIn(ask) });
    world.hfos['hfos-finds-save'] = (ask) => ({ added: peopleIn(ask) });
    // Their own business is a member too: never saved, as a member or as found.
    world.pages = (url) =>
      url === MINE
        ? myProfile()
        : url === `${GROUPS[0]!.url}/members`
          ? {
              html: `<main><h1>Home Pros Network</h1><span>1,204 members</span>
              <h2>Group Leaders</h2>
              <div><a href="/denver-co/stone-gutters/riley-stone">Riley Stone</a><a href="/denver-co/stone-gutters">Stone Gutters</a></div>
              <h2>Members (1,204)</h2>
              <div><a href="/boise-id/pine-painting/jamie-pine">Jamie Pine</a><a href="/boise-id/pine-painting">Pine Painting</a>
                <span>Painter in Boise</span></div>
              <div><a href="/austin-tx/acme-roofing/casey-owner">Casey Owner</a><a href="/austin-tx/acme-roofing">Acme Roofing</a>
                <span>Roofer in Austin</span></div>
              <div><a href="/biz/businesses/5150?user=3">Morgan Vale</a><span>Vale Bookkeeping</span></div></main>`,
            }
          : null;
    const end = await runAlignableDaily('members', dailyJob());
    expect(world.opened).toEqual([MINE, `${GROUPS[0]!.url}/members`]);
    const [saved] = inputsOf('hfos-save-group');
    expect(saved).toMatchObject({
      platform: 'alignable',
      group: { url: GROUPS[0]!.url },
      joined: true,
      adminsPage: true,
    });
    expect(
      (saved!['people'] as { name: string; runsGroup: boolean }[]).map((p) => [
        p.name,
        p.runsGroup,
      ]),
    ).toEqual([
      ['Riley Stone', true],
      ['Jamie Pine', false],
      ['Morgan Vale', false],
    ]);
    // Its leaders are never sent as found: they stay partner leads.
    const [found] = inputsOf('hfos-finds-save');
    expect(found).toMatchObject({
      platform: 'alignable',
      how: 'member',
      group: { url: GROUPS[0]!.url },
      people: [
        { name: 'Jamie Pine', place: 'Boise, ID' },
        { name: 'Morgan Vale', place: null },
      ],
    });
    expect((found!['people'] as unknown[]).length).toBe(2);
    expect(end).toEqual({
      line: 'Saved 3 businesses from 1 Alignable group, 2 new to check. Group leaders are kept as partner leads, never reached.',
      warned: false,
    });
  });

  it('reads the posts of their groups other than their town’s, each saved with its group', async () => {
    world.hfos['hfos-groups'] = (ask) =>
      (ask['input'] as { view: string }).view === 'work'
        ? { groups: [workGroup(TOWN_GROUP), workGroup(GROUPS[0]!)] }
        : { groups: [] };
    world.hfos['hfos-save-posts'] = (ask) => ({
      checking: (ask['input'] as { posts: unknown[] }).posts.length,
    });
    // A post of their own in the group: never sent.
    const own = post({
      id: 94,
      by: '/austin-tx/acme-roofing',
      name: 'Casey Owner',
      words: 'We’re booking roof checks before the storms.',
    });
    world.pages = (url) =>
      url === MINE
        ? myProfile()
        : url === GROUPS[0]!.url
          ? { html: groupHtml('joined').replace('<aside>', `<section>${own}</section><aside>`) }
          : null;
    const end = await runAlignableDaily('group_posts', dailyJob());
    // Never their town's group: its posts are Find posts in your town's.
    expect(world.opened).toEqual([MINE, GROUPS[0]!.url]);
    expect(inputsOf('hfos-save-posts')).toMatchObject([
      {
        platform: 'alignable',
        group: { url: GROUPS[0]!.url },
        posts: [
          { url: `${AL}/biz/discussions/93`, text: 'Who else is busy with gutters this fall?' },
        ],
      },
    ]);
    expect(end).toEqual({
      line: 'Read 2 posts in 1 Alignable group: 1 post sent for the AI to check. The good ones go on your list for today.',
      warned: false,
    });
  });
});

/** A post's own page, wherever Alignable opens it: their post, its own reply form at the top, and an answer's own. */
const DISCUSSION = `${AL}/biz/discussions/93`;
const discussionHtml = (o: { by?: string; name?: string; top?: boolean } = {}) => `<main><section>
  ${post({ id: 93, by: o.by, name: o.name, when: '4h', words: 'Who has tips for a water heater that keeps tripping?' })}
  ${o.top === false ? '' : '<form data-testid="discussion-comment-reply-form" id="top"><textarea placeholder="Write a comment"></textarea><button>Send</button></form>'}
  <div data-testid="discussion-comment"><a href="/salem-or/park-florist?user=4">Lee Park</a><span>1h</span>
    <div data-testid="discussion-comment-body">Check the breaker first.</div><button>Reply</button>
    <form data-testid="discussion-comment-reply-form" id="under"><textarea placeholder="Write a reply"></textarea>
      <button>Send</button></form></div>
</section></main>`;
const discussionAt = (html: string) => ({ html, at: `${AL}/groups/austin-tx/water-heater-tips` });

describe('a business found by topic on Alignable', () => {
  const HANA = `${AL}/austin-tx/hill-homes`;
  const hanaHtml = (asked = false) =>
    businessHtml({ id: '4242', asked }).replace(/Dana Reyes/g, 'Hana Hill');

  it('with no posts, is looked at for the AI’s check, warmed up by the look alone, then connected', async () => {
    let asked = false;
    world.pages = (url) => (url === HANA ? { html: hanaHtml(asked) } : null);
    world.behave = (doc) =>
      doc.querySelector('#connect')?.addEventListener('click', (event) => {
        event.preventDefault();
        asked = true;
      });
    world.hfos['hfos-finds-next'] = () => ({
      people: [
        {
          profileId: PROFILE_ID,
          name: 'Hana Hill',
          url: HANA,
          how: 'searched',
          words: 'real estate agent',
          postUrl: null,
        },
      ],
      today: 0,
      perDay: 30,
    });
    world.hfos['hfos-check-look'] = () => ({});
    expect(await runAlignableDaily('found_checks', dailyJob())).toEqual({
      line: 'Done. Checked 1 person found by topic for the AI. The good fits come onto Today once it has read them.',
      warned: false,
    });
    expect(inputsOf('hfos-check-look')).toMatchObject([
      {
        profileId: PROFILE_ID,
        missing: false,
        lines: expect.arrayContaining(['About Us: Family plumbers in Austin since 1990.']),
      },
    ]);
    const hana = { name: 'Hana Hill', profileUrl: HANA };
    expect(
      await doWork({ do: 'step', item: item({ kind: 'warm_up', ...hana }) }, ME.businessId, false),
    ).toEqual({
      done: true,
      line: 'Looked at Hana Hill’s business page, with no recent post of theirs to like: the look is the warm-up, so the connection request can go next',
    });
    expect(
      await doWork(
        { do: 'step', item: item({ kind: 'friend_request', ...hana }) },
        ME.businessId,
        false,
      ),
    ).toEqual({ done: true, line: 'Sent Hana Hill a connection request' });
    expect(world.opened).toEqual([HANA, HANA, HANA, HANA]);
    expect(notedAs()).toEqual([
      { kind: 'friend_request', auto: true, postUrl: null, id: '4242', platform: 'alignable' },
    ]);
  });
});

describe('a warm-up for the writer of a post found on Alignable', () => {
  // Found by their post, by their business's address in its town.
  const found = item({ kind: 'warm_up', profileUrl: DANA_PAGE, postUrl: DISCUSSION });
  const liking = (pressed: string[]) => (doc: Document) => {
    for (const like of doc.querySelectorAll('[data-like]'))
      like.addEventListener('click', (event) => {
        event.preventDefault();
        pressed.push(like.getAttribute('data-like')!);
        like.querySelector('div')!.textContent = 'Liked';
      });
  };

  it('likes the post they were found by, on its own page', async () => {
    world.pages = (url) => (url === DISCUSSION ? discussionAt(discussionHtml()) : null);
    const pressed: string[] = [];
    world.behave = liking(pressed);
    expect(await doWork({ do: 'step', item: found }, ME.businessId, false)).toEqual({
      done: true,
      line: 'Liked Dana Reyes’s post that was found for you: the connection request comes tomorrow',
    });
    expect(world.opened).toEqual([DISCUSSION]);
    expect(pressed).toEqual(['93']);
    expect(notedAs()).toEqual([
      { kind: 'like', auto: true, postUrl: DISCUSSION, id: null, platform: 'alignable' },
    ]);
    expect(missedPosted()).toEqual([]);
  });

  it('falls back to their business page’s warm-up when the post there isn’t theirs', async () => {
    world.pages = (url) =>
      url === DISCUSSION
        ? discussionAt(discussionHtml({ by: '/austin-tx/best-bakery', name: 'Sam Lee' }))
        : url === DANA_PAGE
          ? { html: businessHtml({ posts: post({ id: 91 }) }) }
          : null;
    const pressed: string[] = [];
    world.behave = liking(pressed);
    expect(await doWork({ do: 'step', item: found }, ME.businessId, false)).toEqual({
      done: true,
      line: 'Looked at Dana Reyes’s business page and liked a post of theirs: the connection request comes tomorrow',
    });
    expect(world.opened).toEqual([DISCUSSION, DANA_PAGE]);
    // Never the other business's post.
    expect(pressed).toEqual(['91']);
  });
});

describe('a comment on a good post on Alignable', () => {
  const SEND_ID = '6f708192-a3b4-4c5d-8e6f-708192a3b4c5';
  const comment = (state: 'waiting' | 'approved' | null) =>
    item({
      kind: 'comment',
      profileUrl: DANA_PAGE,
      postId: 'post-93',
      postUrl: DISCUSSION,
      post: 'Who has tips for a water heater that keeps tripping?',
      send: state
        ? {
            sendId: SEND_ID,
            state,
            text: 'Check the reset button on the thermostat first.',
            handedOver: false,
            needsYou: null,
          }
        : null,
    } as Partial<TodayListItem>);
  const list = (state: 'waiting' | 'approved' | null) =>
    ({
      items: [comment(state)],
      auto: ['warm_up', 'friend_request'],
      messages: ['comment'],
      sending: 'steps',
    }) as never;
  /** Each form's Send empties its box, as Alignable's does once a comment went. */
  const sending = (sent: string[]) => (doc: Document) => {
    for (const form of doc.querySelectorAll('form'))
      form.querySelector('button')!.addEventListener('click', () => {
        const box = form.querySelector('textarea')!;
        sent.push(`${form.id}: ${box.value}`);
        box.value = '';
      });
  };

  it('is drafted, waits for the person’s OK, then goes in the post’s own reply form', async () => {
    expect(alignableWorkLeft(list(null), []).map((w) => w.do)).toEqual(['draft']);
    world.hfos['hfos-draft'] = () => ({
      drafts: ['Check the reset button on the thermostat first.'],
    });
    world.answers['/v1/commands/outreach.send.queue'] = () => ({
      sendId: SEND_ID,
      state: 'waiting',
    });
    expect(await doWork({ do: 'draft', item: comment(null) }, ME.businessId, false)).toEqual({
      done: true,
      line: 'Wrote a comment on Dana Reyes’s post: it waits for your OK',
    });
    // Waiting for their OK: nothing to do.
    expect(alignableWorkLeft(list('waiting'), [])).toEqual([]);
    // Once OK'd, it goes.
    expect(alignableWorkLeft(list('approved'), []).map((w) => w.do)).toEqual(['send']);
    world.answers['/v1/commands/outreach.send.done'] = () => ({});
    world.pages = (url) => (url === DISCUSSION ? discussionAt(discussionHtml()) : null);
    const sent: string[] = [];
    world.behave = sending(sent);
    expect(await doWork({ do: 'send', item: comment('approved') }, ME.businessId, false)).toEqual({
      done: true,
      line: 'Commented on Dana Reyes’s post',
    });
    expect(sent).toEqual(['top: Check the reset button on the thermostat first.']);
    expect(notedAs()).toEqual([
      { kind: 'comment', auto: true, postUrl: DISCUSSION, id: null, platform: 'alignable' },
    ]);
    expect(
      world.posted.filter((p) => p.path === '/v1/commands/outreach.send.done').map((p) => p.body),
    ).toEqual([{ workspaceId: ME.businessId, sendId: SEND_ID, sent: true, why: null }]);
  });

  it('is never written in a reply box under an answer, and HandsFreeOS hears it didn’t go', async () => {
    world.answers['/v1/commands/outreach.send.done'] = () => ({});
    world.pages = (url) =>
      url === DISCUSSION ? discussionAt(discussionHtml({ top: false })) : null;
    const sent: string[] = [];
    world.behave = sending(sent);
    expect(await doWork({ do: 'send', item: comment('approved') }, ME.businessId, false)).toEqual({
      done: false,
      line: 'Dana Reyes’s post: couldn’t find the post’s own box to comment in',
    });
    expect(sent).toEqual([]);
    expect(world.noted).toEqual([]);
    expect(
      world.posted.filter((p) => p.path === '/v1/commands/outreach.send.done').map((p) => p.body),
    ).toEqual([
      {
        workspaceId: ME.businessId,
        sendId: SEND_ID,
        sent: false,
        why: 'couldn’t find the post’s own box to comment in',
      },
    ]);
  });
});

describe('its day', () => {
  it('stops for the day on an Alignable warning, and notes it as Alignable’s', async () => {
    world.pages = () => ({
      html: `<div role="alert">You’ve reached your daily limit for connection requests.</div>${businessHtml()}`,
      at: DANA_PAGE,
    });
    const outcome = await doWork({ do: 'step', item: item({}) }, ME.businessId, false);
    expect(outcome).toMatchObject({
      stop: expect.stringContaining('The extension stops on Alignable for today'),
    });
    expect(world.asked.find((a) => a.type === 'hfos-warning')?.input).toMatchObject({
      platform: 'alignable',
    });
    expect(store.get(WARNED_KEY)).toMatchObject({ alignable: { day: expect.any(String) } });
  });

  it('waits, and sets no alarm, while Alignable’s day isn’t started', async () => {
    keep(day('none'));
    await alignableTick();
    expect(world.opened).toEqual([]);
    expect(alarms.has('hfos-auto-alignable')).toBe(false);
    expect((store.get(ALIGNABLE_STATE_KEY) as { line: string }).line).toBe(
      'Waiting for you to start your day on Alignable: press Start my day for Alignable on Today in HandsFreeOS.',
    );
  });

  it('does nothing while their Alignable Sending is Off, though the day is started', async () => {
    keep(day('started'));
    world.choices = { on: true, sending: 'off', collect: true, warmUp: true };
    await alignableTick();
    expect(world.opened).toEqual([]);
    expect(world.asked.find((a) => a.type === 'hfos-lists')).toBeUndefined();
    expect(alarms.has('hfos-auto-alignable')).toBe(false);
  });

  it('saves the connections first on Alignable’s first day, noting them as Alignable’s', async () => {
    keep(day('started'));
    world.pages = (url) =>
      url === `${AL}/biz/my_network`
        ? {
            html: `<main><div data-testid="connection-row">
              <a aria-label="Dana Reyes" data-testid="connection-row-profile-link" href="/biz/businesses/42"></a>
              <div data-testid="connection-row-summary"><div><span>Dana Reyes</span><span>Acme Plumbing</span></div></div>
              <a data-testid="connection-row-cta" href="/biz/conversations?with_business_id=42">Message</a></div></main>`,
          }
        : null;
    const lists = {
      friendsAt: null,
      requestsAt: null,
      sentAt: null,
      groupsAt: null,
      groupChecksAt: null,
      tidyAt: null,
      checksAt: null,
    };
    world.hfos['hfos-lists'] = () => lists;
    world.hfos['hfos-lists-saved'] = () => ({ ...lists, friendsAt: new Date().toISOString() });
    world.hfos['hfos-save-friends'] = () => ({ added: 1 });
    await alignableTick();
    expect(world.opened).toEqual([`${AL}/biz/my_network`]);
    expect(world.asked.find((a) => a.type === 'hfos-lists')).toMatchObject({
      platform: 'alignable',
    });
    expect(world.asked.find((a) => a.type === 'hfos-save-friends')?.input).toMatchObject({
      platform: 'alignable',
      list: 'friends',
      people: [{ name: 'Dana Reyes', profile: { id: '42' } }],
    });
    expect(world.asked.find((a) => a.type === 'hfos-lists-saved')).toMatchObject({
      list: 'friends',
      platform: 'alignable',
    });
    expect(alarms.has('hfos-auto-alignable')).toBe(true);
  });

  it('works its list once its day is started and its lists are saved, a step a go', async () => {
    keep(day('started'));
    world.hfos['hfos-lists'] = saved;
    world.answers['/v1/queries/outreach.today'] = (body) => {
      expect(body).toMatchObject({ platform: 'alignable' });
      return {
        items: [item({})],
        auto: ['warm_up', 'friend_request'],
        messages: [],
        sending: 'steps',
        partners: [],
      };
    };
    let asked = false;
    world.pages = (url) => (url === DANA ? { html: businessHtml({ asked }), at: DANA_PAGE } : null);
    world.behave = (doc) =>
      doc.querySelector('#connect')?.addEventListener('click', (event) => {
        event.preventDefault();
        asked = true;
      });
    await alignableTick();
    expect(notedAs()).toEqual([
      { kind: 'friend_request', auto: true, postUrl: null, id: '42', platform: 'alignable' },
    ]);
    expect(store.get(ALIGNABLE_STATE_KEY)).toMatchObject({
      line: 'Sent Dana Reyes a connection request',
      done: { friend_request: 1 },
    });
    expect(alarms.has('hfos-auto-alignable')).toBe(true);
  });

  it('hands you nothing for a business you’re connected with already: it says so, and goes on', async () => {
    keep(day('started'));
    world.hfos['hfos-lists'] = saved;
    world.answers['/v1/queries/outreach.today'] = () => ({
      items: [item({})],
      auto: ['warm_up', 'friend_request'],
      messages: [],
      sending: 'steps',
      partners: [],
    });
    world.pages = (url) =>
      url === DANA ? { html: businessHtml({ connected: true }), at: DANA_PAGE } : null;
    await alignableTick();
    expect(world.needs).toEqual([]);
    expect(world.noted).toEqual([]);
    expect(world.asked.find((a) => a.type === 'hfos-save-friends')?.input).toMatchObject({
      platform: 'alignable',
      list: 'friends',
      people: [{ name: 'Dana Reyes', profile: { id: '42' } }],
    });
    expect(store.get(ALIGNABLE_STATE_KEY)).toMatchObject({
      line: 'Dana Reyes: you’re connected already',
      needs: false,
    });
    expect(alarms.has('hfos-auto-alignable')).toBe(true);
  });

  it('does nothing on a day Alignable warned them', async () => {
    keep(day('started'));
    store.set(WARNED_KEY, {
      alignable: { day: new Date().toLocaleDateString('en-CA'), words: ['Slow down'] },
    });
    await alignableTick();
    expect(world.opened).toEqual([]);
    expect((store.get(ALIGNABLE_STATE_KEY) as { line: string }).line).toContain(
      'Alignable warned you today (“Slow down”)',
    );
  });
});
