/**
 * LinkedIn's runner (src/auto/linkedin.ts), with the extension's storage, HandsFreeOS and LinkedIn's tab stood in for,
 * on hand-written pages of made-up people: it works only while LinkedIn's day is started; before LinkedIn's first day
 * it saves the person's connections first, noting it as LinkedIn's; and each step on LinkedIn's list (a look and a like,
 * an invitation without a note, a comment, a message OK'd) is pressed on its own page and noted as the extension's own,
 * as LinkedIn's; for a writer its post search found, the like goes on that post, on its own page, and on their latest
 * when it's gone (decision 92). Invitations they got are left for them, and a LinkedIn warning stops it for the day.
 * A once-a-day job's page that showed nothing is noted with its outline, as LinkedIn's (decision 74).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { TodayListItem } from '../src/hfos/messages';
import { load } from './load';

const LI = 'https://www.linkedin.com';
const DANA = `${LI}/in/dana-reyes-4b2a1c/`;
const POST = `${LI}/feed/update/urn:li:activity:7380000000000000101/`;
const THREAD_KEY = '2-MadeUpThreadDana0001==';
const ME = { userId: 'u-chris', businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };

// A step waits as the runner does for LinkedIn to draw each page it opens: about 4 seconds for a like here, past
// vitest's 5 on a busy CI runner, and a step cut off goes on noting into the next test (16 Oct 2026).
vi.setConfig({ testTimeout: 30_000 });
const PROFILE_ID = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';

const world = vi.hoisted(() => ({
  /** The made-up page each address opens, and what LinkedIn does when it's pressed. */
  pages: (_url: string): { fixture: string; at?: string } | null => null,
  behave: (_doc: Document, _url: string): void => undefined,
  opened: [] as string[],
  noted: [] as { note: unknown; platform: unknown }[],
  needs: [] as unknown[],
  asked: [] as { type: string; input?: unknown }[],
  posted: [] as { path: string; body: Record<string, unknown> }[],
  answers: {} as Record<string, (body: Record<string, unknown>) => unknown>,
  hfos: {} as Record<string, (ask: Record<string, unknown>) => unknown>,
  /** The person's LinkedIn choices. */
  choices: {} as Record<string, unknown>,
  /** The person's working hours (the same on every network). */
  hours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] } as {
    start: number;
    end: number;
    days: number[];
  },
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
    settings: {
      voice: { split: false },
      hours: world.hours,
      networks: { linkedin: world.choices },
    },
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
vi.mock('../src/tab', async () => {
  const { readPage } = await import('../src/networks/linkedin/page');
  const auto = await import('../src/networks/linkedin/auto');
  const compose = await import('../src/networks/linkedin/compose');
  const { outlinePage } = await import('../src/networks/linkedin/outline');
  return {
    WorkTab: class {
      private doc: Document | null = null;
      private at = '';
      get tabId() {
        return this.doc ? 9 : null;
      }
      async adopt() {}
      async focus() {}
      async close() {
        this.doc = null;
      }
      async open(url: string) {
        world.opened.push(url);
        const page = world.pages(url);
        if (!page) throw new Error(`No page for ${url}`);
        this.at = page.at ?? url;
        this.doc = load(page.fixture, this.at);
        world.behave(this.doc, url);
        return 9;
      }
      async ask(message: Record<string, unknown> & { type: string }) {
        const doc = this.doc;
        if (!doc) return { ok: false, error: 'The LinkedIn tab was closed.' };
        switch (message.type) {
          case 'hfos-read':
            return { ok: true, result: readPage(doc, this.at, new Date(), { sideOf: () => null }) };
          case 'hfos-outline': {
            // As the tab's own (src/content.ts): the page's read, and its outline with what was found.
            const result = readPage(doc, this.at, new Date(), { sideOf: () => null });
            return {
              ok: true,
              result,
              outline: outlinePage(doc, this.at, { found: result }),
              shown: true,
            };
          }
          case 'hfos-post-people':
            return {
              ok: true,
              ...(await compose.postPeopleOn(doc, this.at, message.writer as never)),
            };
          case 'hfos-their-posts':
            return {
              ok: true,
              posts: auto.theirPosts(doc, this.at, message.profile as never).map((f) => f.post),
            };
          case 'hfos-like-post':
            return {
              ok: true,
              ...(await auto.likeTheirPost(
                doc,
                this.at,
                message.profile as never,
                message as never,
              )),
            };
          case 'hfos-connect':
            return { ok: true, result: await auto.connect(doc, this.at) };
          case 'hfos-comment':
            return { ok: true, result: await auto.writeComment(doc, message.text as string) };
          case 'hfos-message':
            return {
              ok: true,
              result: await auto.writeMessage(
                doc,
                this.at,
                message.text as string,
                message.profile as never,
              ),
            };
          case 'hfos-open-message':
            return { ok: auto.openMessage(doc) };
          case 'hfos-feed-post':
            return {
              ok: true,
              ...(await compose.writeFeedPost(doc, this.at, message.text as string)),
            };
          default:
            return { ok: false };
        }
      }
    },
  };
});

const { runLinkedInDaily, doWork, linkedInTick, linkedInWorkLeft, nextLinkedInDaily } =
  await import('../src/auto/linkedin');
const { WorkTab } = await import('../src/tab');
const { answer } = await import('../src/hfos/session');
const { LIVE_KEY } = await import('../src/hfos/live');
const { NETWORKS_KEY } = await import('../src/networks/on');
const { LINKEDIN_STATE_KEY } = await import('../src/auto/plan');
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
      getManifest: () => ({ version: '0.41.0' }),
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

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
/** Working hours that leave out today: nothing goes on its own unless a test says. */
const notToday = () => {
  const weekday = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }),
  ).getDay();
  return { start: 9, end: 17, days: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== weekday) };
};
const ALL_DAY = { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] };
const day = (state: 'none' | 'started' | 'stopped') => ({
  date: today(),
  state,
  why: state === 'stopped' ? 'person' : null,
  via: state === 'none' ? null : 'web',
  at: null,
});
function keep(linkedInDay: ReturnType<typeof day>) {
  store.set(LIVE_KEY, {
    ...ME,
    at: Date.now(),
    computerId: '00000000-0000-4000-8000-000000000001',
    name: 'Chrome on Mac',
    working: true,
    workingName: null,
    day: day('none'),
    days: { linkedin: linkedInDay },
    stepsKept: [],
    asks: 0,
  });
}

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
    const step = (note as { step: { kind: string; auto: boolean; postUrl: string | null } }).step;
    return {
      kind: step.kind,
      auto: step.auto,
      postUrl: step.postUrl,
      platform: platform as Platform,
    };
  });

beforeEach(() => {
  store.clear();
  alarms.clear();
  world.opened.length = 0;
  world.noted.length = 0;
  world.needs.length = 0;
  world.asked.length = 0;
  world.posted.length = 0;
  world.answers = {};
  world.hfos = {};
  world.behave = () => undefined;
  world.choices = { on: true, sending: 'steps', collect: false, posting: 'after_ok' };
  world.hours = notToday();
  store.set(NETWORKS_KEY, {
    facebook: { on: true, allowed: true },
    linkedin: { on: true, allowed: true },
  });
});

describe('what it does on LinkedIn’s list', () => {
  it('does only the kinds it does there: invitations they got are theirs to accept', () => {
    const list = {
      items: [
        item({ kind: 'confirm', name: 'Avery Lane' }),
        item({ kind: 'friend_request' }),
        item({ kind: 'warm_up', name: 'Sam Lee', profileId: 'p-sam' }),
      ],
      auto: ['confirm', 'warm_up', 'friend_request', 'comment'],
      messages: [],
      sending: 'steps',
    } as never;
    expect(linkedInWorkLeft(list, []).map((w) => w.item.kind)).toEqual([
      'warm_up',
      'friend_request',
    ]);
    expect(nextLinkedInDaily({ daily: {} })).toBe('requests');
    expect(nextLinkedInDaily({ daily: { requests: 'x', checks: 'y' } })).toBe('chats');
    // People who could partner (decision 81) are read after the posts, before the helpful post.
    expect(
      nextLinkedInDaily({ daily: { requests: 'x', checks: 'y', chats: 'z', posts: 'w' } }),
    ).toBe('partners');
    expect(
      nextLinkedInDaily({
        daily: { requests: 'x', checks: 'y', chats: 'z', posts: 'w', partners: 'v' },
      }),
    ).toBe('helpful');
    // Then who reacted to and commented on the good posts its search found, and last the people found by topic
    // checked for good fits (decision 92).
    const all = { requests: 'x', checks: 'y', chats: 'z', posts: 'w', partners: 'v', helpful: 'u' };
    expect(nextLinkedInDaily({ daily: all })).toBe('post_people');
    expect(nextLinkedInDaily({ daily: { ...all, post_people: 's' } })).toBe('found_checks');
    expect(
      nextLinkedInDaily({ daily: { ...all, post_people: 's', found_checks: 't' } }),
    ).toBeNull();
  });

  it('notes a good post with no reactions count to open, as LinkedIn’s, with the page’s outline', async () => {
    world.pages = (url) => (url === POST ? { fixture: 'linkedin-post.html' } : null);
    // LinkedIn drew its count some other way: the reader finds none, though HandsFreeOS saw 42 reactions.
    world.behave = (doc) => doc.querySelector('[aria-label="42 reactions"]')?.remove();
    world.hfos['hfos-posts-people-next'] = () => ({
      posts: [
        {
          postId: '5e6f7081-92a3-44b5-86c7-d8e9f0a1b2c1',
          url: POST,
          name: 'Dana Reyes',
          profileUrl: DANA,
          words: 'cleaning crew recommendations',
          strong: false,
          comments: 2,
          reactions: 42,
        },
      ],
      today: 0,
      perDay: 5,
    });
    world.hfos['hfos-finds-save'] = (ask) => ({
      added: (ask['input'] as { people: unknown[] }).people.length,
      skipped: 0,
    });
    const end = await runLinkedInDaily('post_people', {
      tab: new WorkTab(),
      hfos: answer as never,
      businessId: ME.businessId,
      stopped: () => false,
      progress: () => undefined,
      warn: async () => undefined,
    });
    expect(world.asked.find((a) => a.type === 'hfos-report')?.input).toMatchObject({
      workspaceId: ME.businessId,
      report: {
        area: 'linkedin',
        job: 'post_people.count',
        page: 'post',
        note: 'No reactions count on the post to open who reacted.',
        outline: expect.stringContaining('Page: post'),
      },
    });
    expect(end.line).toMatch(/^Done\. Read who reacted to and commented on 1 good post/);
  });

  it('sends an invitation without a note from their profile, and notes it as LinkedIn’s', async () => {
    world.pages = () => ({ fixture: 'linkedin-profile.html' });
    world.behave = (doc) => {
      const connect = doc.querySelector('[aria-label="Invite Dana Reyes to connect"]')!;
      connect.addEventListener('click', () => {
        connect.insertAdjacentHTML(
          'beforebegin',
          '<button aria-label="Pending, click to withdraw invitation sent to Dana Reyes"><span>Pending</span></button>',
        );
        connect.remove();
      });
    };
    const outcome = await doWork({ do: 'step', item: item({}) }, ME.businessId, false);
    expect(outcome).toEqual({ done: true, line: 'Sent Dana Reyes an invitation to connect' });
    expect(world.opened).toEqual([DANA]);
    expect(notedAs()).toEqual([
      { kind: 'friend_request', auto: true, postUrl: null, platform: 'linkedin' },
    ]);
  });

  it('looks at their profile, then likes the first post of theirs nothing rules out', async () => {
    world.pages = (url) =>
      url.endsWith('recent-activity/all/')
        ? { fixture: 'linkedin-activity.html' }
        : { fixture: 'linkedin-profile.html' };
    world.behave = (doc) => {
      for (const like of doc.querySelectorAll('[aria-label="React Like"]'))
        like.addEventListener('click', () => like.setAttribute('aria-pressed', 'true'));
    };
    const outcome = await doWork(
      { do: 'step', item: item({ kind: 'warm_up' }) },
      ME.businessId,
      false,
    );
    expect(outcome).toMatchObject({ done: true });
    expect(world.opened).toEqual([DANA, `${DANA}recent-activity/all/`]);
    expect(notedAs()).toEqual([
      {
        kind: 'like',
        auto: true,
        postUrl: `${LI}/feed/update/urn:li:activity:7380000000000000302/`,
        platform: 'linkedin',
      },
    ]);
  });

  describe('for a writer its post search found (decision 92)', () => {
    const FOUND = `${LI}/feed/update/urn:li:activity:7380000000000000777/`;
    const PRIYA = `${LI}/in/priya-dalton-hvac/`;
    const found = (more: Partial<TodayListItem> = {}) =>
      item({
        kind: 'warm_up',
        name: 'Priya Dalton',
        profileUrl: PRIYA,
        postId: '7e8f90a1-b2c3-44d5-86e7-f8091a2b3c4d',
        postUrl: `${FOUND}?utm_source=share`,
        ...more,
      });
    /** The newer layout's reaction button, as LinkedIn shows a like given. */
    const likes = (doc: Document) => {
      const button = doc.querySelector('button[aria-label="Reaction button state: no reaction"]');
      button?.addEventListener('click', () => {
        button.setAttribute('aria-label', 'Reaction button state: like');
        button.querySelector('span span')!.textContent = '56';
      });
      for (const like of doc.querySelectorAll('[aria-label="React Like"]'))
        like.addEventListener('click', () => like.setAttribute('aria-pressed', 'true'));
    };

    it('likes the post it found on that post’s own page, and notes it with the post', async () => {
      world.pages = (url) => (url === FOUND ? { fixture: 'linkedin-post-2026-10.html' } : null);
      world.behave = likes;
      const outcome = await doWork({ do: 'step', item: found() }, ME.businessId, false);
      expect(outcome).toEqual({
        done: true,
        line: 'Liked Priya Dalton’s post that your search found: the invitation comes tomorrow',
      });
      // Straight to the post, at its own address: no look at the profile first.
      expect(world.opened).toEqual([FOUND]);
      expect(notedAs()).toEqual([
        { kind: 'like', auto: true, postUrl: FOUND, platform: 'linkedin' },
      ]);
    });

    it('counts the post as liked when it was already, pressing nothing', async () => {
      world.pages = () => ({ fixture: 'linkedin-post-2026-10.html' });
      world.behave = (doc) =>
        doc
          .querySelector('button[aria-label="Reaction button state: no reaction"]')!
          .setAttribute('aria-label', 'Reaction button state: like');
      const outcome = await doWork({ do: 'step', item: found() }, ME.businessId, false);
      expect(outcome).toEqual({
        done: true,
        line: 'Priya Dalton’s post was liked already: the invitation comes tomorrow',
      });
      expect(notedAs()).toEqual([
        { kind: 'like', auto: true, postUrl: FOUND, platform: 'linkedin' },
      ]);
    });

    it.each([
      ['LinkedIn no longer shows the post', { fixture: 'linkedin-feed.html', at: `${LI}/feed/` }],
      ['the post isn’t theirs', { fixture: 'linkedin-post-2026-10.html' }],
    ])('likes their latest instead when %s', async (_, post) => {
      world.pages = (url) =>
        url === FOUND
          ? post
          : url.endsWith('recent-activity/all/')
            ? { fixture: 'linkedin-activity.html' }
            : { fixture: 'linkedin-profile.html' };
      world.behave = likes;
      // Dana Reyes, by a post that isn't hers.
      const outcome = await doWork(
        { do: 'step', item: found({ name: 'Dana Reyes', profileUrl: DANA }) },
        ME.businessId,
        false,
      );
      expect(outcome).toMatchObject({ done: true });
      expect(world.opened).toEqual([FOUND, DANA, `${DANA}recent-activity/all/`]);
      expect(notedAs()).toEqual([
        {
          kind: 'like',
          auto: true,
          postUrl: `${LI}/feed/update/urn:li:activity:7380000000000000302/`,
          platform: 'linkedin',
        },
      ]);
    });
  });

  it('comments in the post’s own box, with the AI’s draft', async () => {
    world.pages = () => ({ fixture: 'linkedin-post-commenting.html' });
    world.hfos['hfos-draft'] = () => ({ drafts: ['Good reminder. Ours went at 12 years.'] });
    let typed: Element | null = null;
    world.behave = (doc) => {
      for (const box of doc.querySelectorAll('[role="textbox"]'))
        box.addEventListener('click', () => (typed = box));
      doc.execCommand = (_c: string, _u?: boolean, text?: string) => {
        if (typed) typed.textContent = text ?? '';
        return true;
      };
      for (const button of doc.querySelectorAll('button[type="submit"]'))
        button.addEventListener('click', () => {
          button.closest('form')!.querySelector('[role="textbox"]')!.textContent = '';
        });
    };
    const outcome = await doWork(
      {
        do: 'step',
        item: item({
          kind: 'comment',
          postId: '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b',
          postUrl: POST,
        }),
      },
      ME.businessId,
      false,
    );
    expect(outcome).toEqual({ done: true, line: 'Commented on Dana Reyes’s post' });
    expect(notedAs()).toEqual([
      { kind: 'comment', auto: true, postUrl: POST, platform: 'linkedin' },
    ]);
  });

  /** Dana's follow-up, OK'd, to go in her conversation. */
  const approvedSend = (more: Partial<TodayListItem> = {}) =>
    item({
      kind: 'follow_up',
      threadKey: THREAD_KEY,
      send: {
        sendId: '5e6f7081-92a3-4b4c-8d5e-6f708192a3b4',
        state: 'approved',
        text: 'Glad to help, Dana.',
        handedOver: false,
        needsYou: null,
      },
      ...more,
    });

  it('sends a message OK’d in their conversation, and says it went', async () => {
    world.pages = () => ({ fixture: 'linkedin-chat.html' });
    let typed: Element | null = null;
    const sent: string[] = [];
    world.behave = (doc) => {
      for (const box of doc.querySelectorAll('[role="textbox"]'))
        box.addEventListener('click', () => (typed = box));
      doc.execCommand = (_c: string, _u?: boolean, text?: string) => {
        if (typed) typed.textContent = text ?? '';
        return true;
      };
      for (const button of doc.querySelectorAll('button[type="submit"]'))
        button.addEventListener('click', () => {
          const box = button.closest('form')!.querySelector('[role="textbox"]')!;
          sent.push(box.textContent ?? '');
          box.textContent = '';
        });
    };
    world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
    const outcome = await doWork(
      {
        do: 'send',
        // Kept by her member id, as her conversation links to her.
        item: approvedSend({ profileUrl: `${LI}/in/ACoAAFakeDanaReyes123/` }),
      },
      ME.businessId,
      false,
    );
    expect(outcome).toEqual({ done: true, line: 'Sent Dana Reyes a message' });
    expect(world.opened).toEqual([`${LI}/messaging/thread/${encodeURIComponent(THREAD_KEY)}/`]);
    expect(sent).toEqual(['Glad to help, Dana.']);
    expect(notedAs()).toEqual([
      { kind: 'message', auto: true, postUrl: null, platform: 'linkedin' },
    ]);
    expect(
      world.posted.find((p) => p.path === '/v1/commands/outreach.send.done')?.body,
    ).toMatchObject({
      sent: true,
    });
  });

  /** Her conversation's own page as LinkedIn behaves: what's typed in its box goes when its Send is pressed. */
  function chatSends(doc: Document, sent: string[]) {
    const box = doc.querySelector('main [role="textbox"]')!;
    doc.execCommand = (_c: string, _u?: boolean, text?: string) => {
      if (doc.activeElement === box) box.textContent = text ?? '';
      return true;
    };
    doc.querySelector('main button[type="submit"]')!.addEventListener('click', () => {
      sent.push(box.textContent ?? '');
      box.textContent = '';
    });
  }

  it('sends in her kept conversation, kept by the name in her address, once her profile shows the member id it links to her by, with Message on it or not', async () => {
    for (const message of [true, false]) {
      world.opened.length = 0;
      world.noted.length = 0;
      // Her conversation links to her by member id only; her profile's Message and mutual connections show it.
      world.pages = (url) =>
        url === DANA ? { fixture: 'linkedin-profile.html' } : { fixture: 'linkedin-chat.html' };
      const sent: string[] = [];
      world.behave = (doc, url) => {
        if (url === DANA) {
          if (!message) doc.querySelector('[aria-label="Message Dana Reyes"]')!.remove();
        } else chatSends(doc, sent);
      };
      world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
      const outcome = await doWork({ do: 'send', item: approvedSend() }, ME.businessId, false);
      expect(outcome).toEqual({ done: true, line: 'Sent Dana Reyes a message' });
      const thread = `${LI}/messaging/thread/${encodeURIComponent(THREAD_KEY)}/`;
      expect(world.opened).toEqual([thread, DANA, thread]);
      expect(sent).toEqual(['Glad to help, Dana.']);
      expect(
        (world.noted[0]?.note as { step: { thread: { id: string } | null } }).step.thread?.id,
      ).toBe(THREAD_KEY);
    }
  });

  it('sends nothing when her kept conversation, opened again after her profile, links to someone else', async () => {
    world.pages = (url) =>
      url === DANA ? { fixture: 'linkedin-profile.html' } : { fixture: 'linkedin-chat.html' };
    const sent: string[] = [];
    let opens = 0;
    world.behave = (doc, url) => {
      if (url === DANA) return;
      // The second time, LinkedIn shows another Dana Reyes's conversation at that address.
      if (++opens === 2)
        for (const link of doc.querySelectorAll('a[href*="ACoAAFakeDanaReyes123"]'))
          link.setAttribute('href', `${LI}/in/ACoAAFakeOtherDana456`);
      chatSends(doc, sent);
    };
    world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
    const outcome = await doWork({ do: 'send', item: approvedSend() }, ME.businessId, false);
    expect(outcome).toEqual({
      done: false,
      line: 'Dana Reyes: LinkedIn showed a different conversation',
    });
    expect(sent).toEqual([]);
  });

  it('sends one through their profile’s Message when their kept conversation, kept by name, links to a namesake', async () => {
    // Kept by the name in her profile's address; the kept conversation links by member id to another Dana Reyes.
    world.pages = (url) =>
      url === DANA ? { fixture: 'linkedin-profile.html' } : { fixture: 'linkedin-chat.html' };
    const sent: string[] = [];
    const typedInChat: string[] = [];
    world.behave = (doc, url) => {
      if (url !== DANA) {
        for (const link of doc.querySelectorAll('a[href*="ACoAAFakeDanaReyes123"]'))
          link.setAttribute('href', `${LI}/in/ACoAAFakeOtherDana456`);
        chatSends(doc, typedInChat);
        return;
      }
      // Message opens her conversation in a window over her profile.
      const window = load('linkedin-chat-window.html', DANA).querySelector('aside')!;
      doc.querySelector('[aria-label="Message Dana Reyes"]')!.addEventListener('click', (event) => {
        event.preventDefault();
        const aside = doc.importNode(window, true);
        doc.body.append(aside);
        const box = aside.querySelector('[role="textbox"]')!;
        doc.execCommand = (_c: string, _u?: boolean, text?: string) => {
          if (doc.activeElement === box) box.textContent = text ?? '';
          return true;
        };
        aside.querySelector('button[type="submit"]')!.addEventListener('click', () => {
          sent.push(box.textContent ?? '');
          box.textContent = '';
        });
      });
    };
    world.answers['/v1/commands/outreach.send.done'] = () => ({ ok: true });
    const outcome = await doWork({ do: 'send', item: approvedSend() }, ME.businessId, false);
    expect(outcome).toEqual({ done: true, line: 'Sent Dana Reyes a message' });
    expect(world.opened).toEqual([
      `${LI}/messaging/thread/${encodeURIComponent(THREAD_KEY)}/`,
      DANA,
    ]);
    expect(sent).toEqual(['Glad to help, Dana.']);
    expect(typedInChat).toEqual([]);
  });

  it('stops for the day on a LinkedIn warning, and notes it as LinkedIn’s', async () => {
    world.pages = () => ({ fixture: 'linkedin-warning.html', at: DANA });
    const outcome = await doWork({ do: 'step', item: item({}) }, ME.businessId, false);
    expect(outcome).toMatchObject({
      stop: expect.stringContaining('The extension stops on LinkedIn for today'),
    });
    expect(world.asked.find((a) => a.type === 'hfos-warning')?.input).toMatchObject({
      platform: 'linkedin',
    });
    expect(store.get(WARNED_KEY)).toMatchObject({ linkedin: { day: expect.any(String) } });
  });
});

describe('its day', () => {
  it('waits outside the working hours with nothing pressed, waking at their start', async () => {
    keep(day('none'));
    await linkedInTick();
    expect(world.opened).toEqual([]);
    expect(alarms.get('hfos-auto-linkedin')).toBeGreaterThan(Date.now());
    expect((store.get(LINKEDIN_STATE_KEY) as { line: string }).line).toBe(
      'Starts on its own on LinkedIn tomorrow at 9:00 AM. To start now, press Start my day for LinkedIn on Today in HandsFreeOS.',
    );
  });

  it('waits after Stop for today till the working hours of a later day', async () => {
    keep(day('stopped'));
    world.hours = ALL_DAY;
    await linkedInTick();
    expect(world.opened).toEqual([]);
    expect(alarms.get('hfos-auto-linkedin')).toBeGreaterThan(Date.now());
    expect((store.get(LINKEDIN_STATE_KEY) as { line: string }).line).toBe(
      'Stopped on LinkedIn for today. It starts again on its own tomorrow at 12:00 AM.',
    );
  });

  it.each([
    { state: 'started', how: 'once its day is started' },
    { state: 'none', how: 'on its own in the working hours' },
  ] as const)(
    'saves the connections first on LinkedIn’s first day $how, noting them as LinkedIn’s',
    async ({ state }) => {
      keep(day(state));
      world.hours = ALL_DAY;
      world.pages = () => ({ fixture: 'linkedin-connections.html' });
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
      world.hfos['hfos-save-friends'] = (ask) => ({
        saved: (ask.input as { people: unknown[] }).people.length,
        added: 0,
        changed: 0,
      });
      await linkedInTick();
      expect(world.opened).toEqual([`${LI}/mynetwork/invite-connect/connections/`]);
      expect(world.asked.find((a) => a.type === 'hfos-lists')).toMatchObject({
        platform: 'linkedin',
      });
      expect(world.asked.find((a) => a.type === 'hfos-save-friends')?.input).toMatchObject({
        platform: 'linkedin',
        list: 'friends',
      });
      expect(world.asked.find((a) => a.type === 'hfos-lists-saved')).toMatchObject({
        list: 'friends',
        platform: 'linkedin',
      });
      expect(alarms.has('hfos-auto-linkedin')).toBe(true);
    },
  );

  it('puts today’s helpful post up on their own feed when LinkedIn posting is its own', async () => {
    keep(day('started'));
    world.choices = { on: true, sending: 'steps', collect: false, posting: 'own' };
    const saved = new Date().toISOString();
    world.hfos['hfos-lists'] = () => ({
      friendsAt: saved,
      requestsAt: saved,
      sentAt: saved,
      groupsAt: null,
      groupChecksAt: null,
      tidyAt: saved,
      checksAt: saved,
    });
    const post = `${LI}/feed/update/urn:li:activity:7380000000000000500/`;
    world.hfos['hfos-helpful-next'] = () => ({
      post: {
        helpfulId: '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e',
        groupName: null,
        groupUrl: null,
        text: 'Three things to check before you call a plumber.',
      },
      read: [],
    });
    world.hfos['hfos-helpful-posted'] = () => ({ state: 'posted' });
    world.pages = () => ({ fixture: 'linkedin-feed.html' });
    world.behave = (doc) => {
      let into: Element | null = null;
      doc.execCommand = (_c: string, _u?: boolean, text?: string) => {
        if (into) into.textContent = text ?? '';
        doc.getElementById('share-post')?.removeAttribute('disabled');
        return true;
      };
      [...doc.querySelectorAll('main button')]
        .find((b) => b.textContent?.trim() === 'Start a post')!
        .addEventListener('click', () => {
          const box = load('linkedin-share-box.html', doc.location.href);
          const outlet = doc.importNode(box.getElementById('modal-outlet')!, true);
          doc.body.append(outlet);
          const writing = outlet.querySelector('[role="textbox"]')!;
          writing.addEventListener('click', () => (into = writing));
          outlet.querySelector('#share-post')!.addEventListener('click', () => {
            outlet.remove();
            doc.body.insertAdjacentHTML('beforeend', `<a href="${post}">View post</a>`);
          });
        });
    };
    await linkedInTick();
    expect(world.opened).toEqual([`${LI}/feed/`]);
    expect(world.asked.find((a) => a.type === 'hfos-helpful-next')?.input).toMatchObject({
      platform: 'linkedin',
    });
    expect(world.asked.find((a) => a.type === 'hfos-helpful-posted')?.input).toMatchObject({
      posted: true,
      url: post,
    });
    expect(store.get(LINKEDIN_STATE_KEY)).toMatchObject({
      line: 'Helpful post: Put your helpful post up on your LinkedIn feed.',
      helpfulUp: true,
    });
  });

  it('does nothing on a day LinkedIn warned them', async () => {
    keep(day('started'));
    store.set(WARNED_KEY, {
      linkedin: { day: new Date().toLocaleDateString('en-CA'), words: ['Slow down'] },
    });
    await linkedInTick();
    expect(world.opened).toEqual([]);
    expect((store.get(LINKEDIN_STATE_KEY) as { line: string }).line).toContain(
      'LinkedIn warned you today (“Slow down”)',
    );
  });
});
