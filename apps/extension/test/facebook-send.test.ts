/**
 * Facebook's runner sending a message OK'd (src/auto/run.ts, docs/outreach.md decision 26), with the extension's
 * storage, HandsFreeOS and Facebook's tab stood in for, on the made-up pages in test/fixtures. Its tab types by
 * Facebook's own kit (src/networks/facebook/auto.ts). It sends in their chat in Messenger only when the chat links to
 * them the way HandsFreeOS keeps them; by its name alone, someone else's could pass for theirs, so their profile's
 * Message opens their chat instead. It types only into their chat's window, never one left open from the person
 * before, and says so when there's none.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayListItem } from '../src/hfos/messages';
import { load } from './load';

const FB = 'https://www.facebook.com';
const DANA = `${FB}/dana.reyes.12`;
const THREAD_KEY = '100009000000002';
const CHAT = `${FB}/messages/t/${THREAD_KEY}/`;
const ME = { userId: 'u-jordan', businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
const SEND_DONE = '/v1/commands/outreach.send.done';

const world = vi.hoisted(() => ({
  /** The page each address opens, and what its buttons do. */
  pages: (_url: string): Document | null => null,
  opened: [] as string[],
  noted: [] as unknown[],
  posted: [] as { path: string; body: Record<string, unknown> }[],
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
    answer: async () => ({ ok: true, value: {} }),
    answerWith: async (_t: string, fn: () => Promise<unknown>) => ({ ok: true, value: await fn() }),
    api: () => ({
      POST: async (path: string, options: { body: Record<string, unknown> }) => {
        world.posted.push({ path, body: options.body });
        return { data: { ok: true }, response: { ok: true, status: 200 } };
      },
    }),
    call: async (request: Promise<{ data?: unknown }>) => (await request).data,
  };
});
vi.mock('../src/hfos/noting', async (original) => ({
  ...(await original<object>()),
  isNoting: async () => true,
  takeNote: async (note: unknown) => void world.noted.push(note),
  noteNeed: async () => undefined,
}));
vi.mock('../src/hfos/live', async (original) => ({
  ...(await original<object>()),
  beatSoon: () => undefined,
}));
// Facebook's tab: each address opens its page, which its kit reads and types on as the tab's script does.
vi.mock('../src/tab', async () => {
  const { KITS } = await import('../src/networks');
  const kit = KITS.facebook;
  return {
    WorkTab: class {
      private doc: Document | null = null;
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
        this.doc = world.pages(url);
        if (!this.doc) throw new Error(`No page for ${url}`);
        return 9;
      }
      async ask(message: { readonly type: string }) {
        const doc = this.doc;
        if (!doc) return { ok: false, error: 'The Facebook tab was closed.' };
        const at = doc.location.href;
        if (message.type === 'hfos-read') return { ok: true, result: kit.readPage(doc, at) };
        // The tab's script reads its own page and address.
        const here = globalThis as { location?: unknown; document?: unknown };
        here.location = new URL(at);
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

const { doWork } = await import('../src/auto/run');

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
    alarms: { clear: async () => true, create: async () => undefined },
  });
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  store.clear();
  world.opened = [];
  world.noted = [];
  world.posted = [];
});

/** Dana's follow-up, OK'd, to go in her chat. */
const approved = (more: Partial<TodayListItem> = {}): TodayListItem =>
  ({
    kind: 'follow_up',
    name: 'Dana Reyes',
    profileId: '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9',
    profileUrl: DANA,
    chatId: null,
    threadKey: THREAD_KEY,
    send: {
      sendId: '5e6f7081-92a3-4b4c-8d5e-6f708192a3b4',
      state: 'approved',
      text: 'Glad to help, Dana.',
      handedOver: false,
      needsYou: null,
    },
    ...more,
  }) as TodayListItem;

type Sent = { readonly to: string; readonly text: string };

/** Typing goes into the box with the focus, as Chrome's does; each chat's button, or Enter, sends its own box's. */
function sends(doc: Document, sent: Sent[]): void {
  doc.execCommand = (command: string, _ui?: boolean, text?: string) => {
    const box = doc.activeElement?.closest('[role="textbox"]');
    if (box) box.textContent = command === 'insertText' ? (text ?? '') : '';
    return !!box;
  };
  for (const box of doc.querySelectorAll<HTMLElement>('[role="textbox"]:not([data-sends])')) {
    box.setAttribute('data-sends', '');
    const take = () => {
      sent.push({ to: box.getAttribute('aria-label')!, text: box.textContent ?? '' });
      box.textContent = '';
    };
    box.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') take();
    });
    box
      .closest('[role="region"]')
      ?.querySelector('[aria-label="Press enter to send"]')
      ?.addEventListener('click', take);
  }
}

/** A small chat window with someone, as Facebook draws one over a page: the test page's, with Riley, made theirs. */
function chatWindow(doc: Document, name: string, href: string): Element {
  const window = load('chat-window-2026.html', `${FB}/friends/requests/`)
    .querySelector('[aria-label="Close chat"]')!
    .closest('[role="none"]')!;
  const chat = doc.importNode(window, true);
  chat.innerHTML = chat.innerHTML
    .replaceAll('Riley Quinn', name)
    .replaceAll('Riley', name.split(' ')[0]!)
    .replaceAll('/riley.quinn.7/', href);
  return chat;
}

/** Dana's profile, whose Message opens her chat window (or nothing), with Riley's left open over it (or not). */
function danaProfile(sent: Sent[], o: { opens: boolean; rileyOpen: boolean }): Document {
  const doc = load('profile-2026.html', DANA);
  const layer = doc.createElement('div');
  doc.body.append(layer);
  if (o.rileyOpen) layer.append(chatWindow(doc, 'Riley Quinn', '/riley.quinn.7/'));
  sends(doc, sent);
  doc.querySelector('[role="button"][aria-label="Message"]')!.addEventListener('click', () => {
    if (!o.opens) return;
    layer.append(chatWindow(doc, 'Dana Reyes', '/dana.reyes.12/'));
    sends(doc, sent);
  });
  return doc;
}

/** Sends it, with time passed for Facebook's waits. */
async function send(item: TodayListItem) {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    const going = doWork({ do: 'send', item }, ME.businessId, false);
    await vi.advanceTimersByTimeAsync(60_000);
    return await going;
  } finally {
    vi.useRealTimers();
  }
}

describe('sending a message on Facebook', () => {
  it('sends in their chat in Messenger when it links to them as HandsFreeOS keeps them', async () => {
    const sent: Sent[] = [];
    world.pages = (url) => {
      const doc = url === CHAT ? load('chat-2026.html', CHAT) : null;
      if (doc) sends(doc, sent);
      return doc;
    };
    // Kept by number, as her chat links to her.
    const outcome = await send(approved({ profileUrl: `${FB}/profile.php?id=${THREAD_KEY}` }));
    expect(outcome).toEqual({ done: true, line: 'Sent Dana Reyes a message' });
    expect(world.opened).toEqual([CHAT]);
    expect(sent).toEqual([{ to: 'Message Dana Reyes', text: 'Glad to help, Dana.' }]);
  });

  it('goes through their profile’s Message when their chat in Messenger links to them another way', async () => {
    // Kept by username; her chat links to her by number, and someone else could have her name.
    const sent: Sent[] = [];
    world.pages = (url) =>
      url === CHAT
        ? load('chat-2026.html', CHAT)
        : url === DANA
          ? danaProfile(sent, { opens: true, rileyOpen: true })
          : null;
    const outcome = await send(approved());
    expect(outcome).toEqual({ done: true, line: 'Sent Dana Reyes a message' });
    expect(world.opened).toEqual([CHAT, DANA]);
    expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Glad to help, Dana.' }]);
  });

  it('sends nothing into the last person’s chat window when theirs doesn’t open, and says so', async () => {
    const sent: Sent[] = [];
    let page: Document | null = null;
    world.pages = (url) =>
      url === DANA ? (page = danaProfile(sent, { opens: false, rileyOpen: true })) : null;
    const outcome = await send(approved({ kind: 'opener', threadKey: null }));
    expect(outcome).toEqual({
      done: false,
      line: 'Dana Reyes: couldn’t find a chat open with them, so nothing was sent',
    });
    expect(sent).toEqual([]);
    expect(page!.querySelector('[aria-label="Write to Riley Quinn"]')!.textContent?.trim()).toBe(
      '',
    );
    expect(world.posted.find((p) => p.path === SEND_DONE)?.body).toMatchObject({
      sent: false,
      why: 'couldn’t find a chat open with them, so nothing was sent',
    });
    expect(world.noted).toEqual([]);
  });
});
