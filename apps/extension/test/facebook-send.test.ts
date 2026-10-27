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
  /** The page in the tab: a press may take it elsewhere, as Message may to Messenger. */
  doc: null as Document | null,
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
      get tabId() {
        return world.doc ? 9 : null;
      }
      async adopt() {}
      async focus() {}
      async loaded() {}
      async close() {
        world.doc = null;
      }
      async open(url: string) {
        world.opened.push(url);
        world.doc = world.pages(url);
        if (!world.doc) throw new Error(`No page for ${url}`);
        return 9;
      }
      async ask(message: { readonly type: string }) {
        const doc = world.doc;
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
  world.doc = null;
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

/** The step noted for the message sent. */
const noted = () => (world.noted[0] as { step: Record<string, unknown> } | undefined)?.step;

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
      const to = box.getAttribute('data-who') ?? box.getAttribute('aria-label')!;
      sent.push({ to, text: box.textContent ?? '' });
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

/**
 * A small chat window with someone, as Facebook draws one over a page: the test page's, with Riley, made theirs, its
 * header linking to `href`, or to nobody.
 */
function chatWindow(doc: Document, name: string, href: string | null): Element {
  const window = load('chat-window-2026.html', `${FB}/friends/requests/`)
    .querySelector('[aria-label="Close chat"]')!
    .closest('[role="none"]')!;
  const chat = doc.importNode(window, true);
  chat.innerHTML = chat.innerHTML
    .replaceAll('Riley Quinn', name)
    .replaceAll('Riley', name.split(' ')[0]!)
    .replaceAll('/riley.quinn.7/', href ?? '');
  if (!href) chat.querySelector('a[href=""]')!.remove();
  return chat;
}

/** Messenger's chat with Dana, which links to her by number, or the same with someone else's name on it. */
function messenger(sent: Sent[], name = 'Dana Reyes'): Document {
  const doc = load('chat-2026.html', CHAT);
  if (name !== 'Dana Reyes')
    doc.body.innerHTML = doc.body.innerHTML
      .replaceAll('Dana Reyes', name)
      .replaceAll('Dana', name.split(' ')[0]!);
  sends(doc, sent);
  return doc;
}

/**
 * Dana's profile (at her username, unless `at` says otherwise), whose Message opens her chat window with the cursor in
 * its box, as Facebook's does (or nothing, or takes the tab to her chat in Messenger), with Riley's left open over it
 * (or not), and another Dana Reyes's, linking to nobody (or not).
 */
function danaProfile(
  sent: Sent[],
  o: {
    opens: boolean | 'messenger';
    rileyOpen: boolean;
    namesakeOpen?: boolean;
    at?: string;
  },
): Document {
  const doc = load('profile-2026.html', o.at ?? DANA);
  const layer = doc.createElement('div');
  doc.body.append(layer);
  if (o.rileyOpen) layer.append(chatWindow(doc, 'Riley Quinn', '/riley.quinn.7/'));
  if (o.namesakeOpen) {
    const other = chatWindow(doc, 'Dana Reyes', null);
    other.querySelector('[role="textbox"]')!.setAttribute('data-who', 'the other Dana Reyes');
    layer.append(other);
  }
  sends(doc, sent);
  doc.querySelector('[role="button"][aria-label="Message"]')!.addEventListener('click', () => {
    if (o.opens === 'messenger') world.doc = messenger(sent);
    if (o.opens !== true) return;
    const hers = chatWindow(doc, 'Dana Reyes', '/dana.reyes.12/');
    layer.append(hers);
    sends(doc, sent);
    hers.querySelector<HTMLElement>('[role="textbox"]')!.focus();
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
    // Noted with the chat HandsFreeOS keeps, which showed her name, as her replies there are matched by it.
    expect(noted()).toMatchObject({ thread: { id: THREAD_KEY } });
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

  it('sends nothing into another Dana Reyes’s chat window left open, linking to nobody, when hers doesn’t open', async () => {
    const sent: Sent[] = [];
    world.pages = (url) =>
      url === DANA
        ? danaProfile(sent, { opens: false, rileyOpen: true, namesakeOpen: true })
        : null;
    const outcome = await send(approved({ kind: 'opener', threadKey: null }));
    expect(outcome).toEqual({
      done: false,
      line: 'Dana Reyes: couldn’t find a chat open with them, so nothing was sent',
    });
    expect(sent).toEqual([]);
    expect(world.posted.find((p) => p.path === SEND_DONE)?.body).toMatchObject({ sent: false });
    expect(world.noted).toEqual([]);
  });

  it('sends in Messenger when their profile’s Message takes the tab there, by the key their chat shows', async () => {
    // Kept by username; Messenger's chat links to her by number. An opener, and a reply in the chat kept.
    for (const item of [
      approved({ kind: 'opener', threadKey: null }),
      approved({ kind: 'reply' }),
    ]) {
      const sent: Sent[] = [];
      world.noted = [];
      world.opened = [];
      world.pages = (url) =>
        url === CHAT
          ? messenger(sent)
          : url === DANA
            ? danaProfile(sent, { opens: 'messenger', rileyOpen: true })
            : null;
      expect(await send(item)).toEqual({ done: true, line: 'Sent Dana Reyes a message' });
      expect(world.opened).toEqual(item.threadKey ? [CHAT, DANA] : [DANA]);
      expect(sent).toEqual([{ to: 'Message Dana Reyes', text: 'Glad to help, Dana.' }]);
      expect(noted()).toMatchObject({
        to: { profile: { id: THREAD_KEY, username: 'dana.reyes.12' } },
        thread: { id: THREAD_KEY },
      });
    }
  });

  it('sends in Messenger when their profile’s Message takes the tab there and the chat draws a while after', async () => {
    // Kept by username; Messenger shows its address at once, and draws the chat, linking to her by number, 3 seconds on.
    const sent: Sent[] = [];
    world.pages = (url) => {
      if (url !== DANA) return null;
      const doc = danaProfile(sent, { opens: false, rileyOpen: true });
      doc.querySelector('[role="button"][aria-label="Message"]')!.addEventListener('click', () => {
        const chat = messenger(sent);
        const main = chat.querySelector('[role="main"]')!;
        const drawn = [...main.childNodes];
        main.replaceChildren();
        setTimeout(() => main.append(...drawn), 3_000);
        world.doc = chat;
      });
      return doc;
    };
    expect(await send(approved({ kind: 'opener', threadKey: null }))).toEqual({
      done: true,
      line: 'Sent Dana Reyes a message',
    });
    expect(sent).toEqual([{ to: 'Message Dana Reyes', text: 'Glad to help, Dana.' }]);
    expect(noted()).toMatchObject({
      to: { profile: { id: THREAD_KEY, username: 'dana.reyes.12' } },
      thread: { id: THREAD_KEY },
    });
  });

  it('sends nothing when their profile’s Message takes the tab to a chat with someone else’s name', async () => {
    const sent: Sent[] = [];
    world.pages = (url) => {
      if (url !== DANA) return null;
      const doc = danaProfile(sent, { opens: false, rileyOpen: false });
      doc
        .querySelector('[role="button"][aria-label="Message"]')!
        .addEventListener('click', () => (world.doc = messenger(sent, 'Sam Lee')));
      return doc;
    };
    const outcome = await send(approved({ kind: 'opener', threadKey: null }));
    expect(outcome).toEqual({
      done: false,
      line: 'Dana Reyes: couldn’t find a chat open with them, so nothing was sent',
    });
    expect(sent).toEqual([]);
  });

  it('sends in the window their Message opened for someone kept by number, though it links to their username', async () => {
    // Saved from a group by number, and Facebook leaves her profile at its number.
    const KEPT = `${FB}/profile.php?id=100009000000077`;
    const sent: Sent[] = [];
    world.pages = (url) =>
      url === KEPT ? danaProfile(sent, { opens: true, rileyOpen: true, at: KEPT }) : null;
    const outcome = await send(approved({ kind: 'opener', threadKey: null, profileUrl: KEPT }));
    expect(outcome).toEqual({ done: true, line: 'Sent Dana Reyes a message' });
    expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Glad to help, Dana.' }]);
    // Not while another Dana Reyes's window, linking to nobody, was open before: her name proves nothing then.
    const none: Sent[] = [];
    world.pages = (url) =>
      url === KEPT
        ? danaProfile(none, { opens: true, rileyOpen: false, namesakeOpen: true, at: KEPT })
        : null;
    expect(await send(approved({ kind: 'opener', threadKey: null, profileUrl: KEPT }))).toEqual({
      done: false,
      line: 'Dana Reyes: couldn’t find a chat open with them, so nothing was sent',
    });
    expect(none).toEqual([]);
  });

  it('sends a reply through their profile when the chat kept shows another name, noting no chat for it', async () => {
    // Saved as Dana Ruiz; she's Dana Reyes now. Her chat in Messenger links to her by number, not her username.
    const sent: Sent[] = [];
    world.pages = (url) =>
      url === CHAT
        ? messenger(sent)
        : url === DANA
          ? danaProfile(sent, { opens: true, rileyOpen: true })
          : null;
    const outcome = await send(approved({ kind: 'reply', name: 'Dana Ruiz' }));
    expect(outcome).toEqual({ done: true, line: 'Sent Dana Ruiz a message' });
    expect(world.opened).toEqual([CHAT, DANA]);
    expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Glad to help, Dana.' }]);
    expect(noted()).toMatchObject({ thread: null });
  });

  it('says where its typing stayed when it couldn’t take it out of another chat’s box', async () => {
    const sent: Sent[] = [];
    let page: Document | null = null;
    world.pages = (url) => {
      if (url !== DANA) return null;
      page = danaProfile(sent, { opens: true, rileyOpen: true });
      const doc = page;
      const riley = doc.querySelector<HTMLElement>('[aria-label="Write to Riley Quinn"]')!;
      riley.textContent = 'See you Tuesday';
      // Once her window is open, the typing goes over the person's own writing in Riley's box too.
      doc.querySelector('[role="button"][aria-label="Message"]')!.addEventListener('click', () => {
        const type = doc.execCommand.bind(doc);
        doc.execCommand = (command: string, ui?: boolean, text?: string) => {
          if (command === 'insertText') riley.textContent = text ?? '';
          return type(command, ui, text);
        };
      });
      return doc;
    };
    const outcome = await send(approved({ kind: 'opener', threadKey: null }));
    expect(outcome).toEqual({
      done: false,
      line: 'Dana Reyes: its typing went into the chat box with Riley Quinn too and couldn’t be taken out, so delete it there before you send that chat; nothing was sent',
    });
    expect(sent).toEqual([]);
  });
});
