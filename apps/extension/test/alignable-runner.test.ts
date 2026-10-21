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
 * names, its town, its own Connect (or Request Sent once asked), its posts, and another business it suggests, with a
 * Connect of its own.
 */
const businessHtml = (o: { id?: string; asked?: boolean; posts?: string; extra?: string } = {}) => {
  const id = o.id ?? '42';
  return `<main><section>
    <div><a href="/biz/recommendations/new?id=${id}">Recommend</a><a href="/forward_referral_card/${id}">Refer</a></div>
    <h1 title="Dana Reyes">Dana Reyes</h1><h2 title="Acme Plumbing">Acme Plumbing</h2>
    <div><a href="/austin-tx">Austin, TX</a></div>
    ${o.extra ?? ''}
    <div>${
      o.asked
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
    expect(nextAlignableDaily({ daily: {} })).toBe('requests');
    // Their chats right after the connections are checked (0.84.0), as on Instagram; then Find partners, then the
    // town's posts.
    const done = { requests: 'x', checks: 'y' };
    expect(nextAlignableDaily({ daily: done })).toBe('chats');
    expect(nextAlignableDaily({ daily: { ...done, chats: 'c' } })).toBe('partners');
    expect(nextAlignableDaily({ daily: { ...done, chats: 'c', partners: 'z' } })).toBe('posts');
    // Last, who engaged with them, from their notifications.
    expect(nextAlignableDaily({ daily: { ...done, chats: 'c', partners: 'z', posts: 'w' } })).toBe(
      'helpful',
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
