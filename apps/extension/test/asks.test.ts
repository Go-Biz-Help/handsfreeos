/**
 * What the person asks of their computer from HandsFreeOS (src/asks/run.ts, src/hfos/asks.ts, docs/outreach.md
 * decision 43): which changes heard on the live channel it acts on, how often it tells HandsFreeOS how it's going,
 * where each ask works, the turns it takes with the runner, and the jobs moved out of the side panel, on made-up 2026
 * pages: reading chats from a tab not opened yet, tidying the people ticked with a step handed over, getting the file
 * with Stop pressed, looking someone up for drafts, and saving the person's groups and friends.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { groupsListPage, scrollPage } from '../src/facebook/browse';
import { readPage } from '../src/facebook/page';
import { askEventFor, lineDue, withEnd, type WaitingEnd } from '../src/hfos/asks';
import type { HfosAsk } from '../src/hfos/messages';
import type { HandOverReply, Hfos, Job, JobTab } from '../src/jobs/job';
import { load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { runAsk, placeFor } = await import('../src/asks/run');
const { inTurn, askInLine, turnHeldBy } = await import('../src/auto/turns');
const { MESSENGER } = await import('../src/jobs/chats');
const { YOUR_GROUPS, groupSearch } = await import('../src/jobs/groups');
const { YOUR_FRIENDS } = await import('../src/jobs/people');

// The extension's own storage: the chats read lately are kept there.
const store = new Map<string, unknown>();
beforeAll(() =>
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (values: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(values)) store.set(k, v);
        },
      },
    },
  }),
);
afterAll(() => vi.unstubAllGlobals());

const FB = 'https://www.facebook.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ME = 'u-dana';
const ASK = '4c3b2a1d-0e9f-4a8b-8c7d-6e5f4a3b2c1d';

/**
 * A tab that opens made-up pages by address. It starts unopened, as a new WorkTab does: until something is opened, it
 * can't be read. Scrolls answer in turn, then no more; the file's and tidying's steps answer as `steps` says.
 */
function fakeTab(
  pages: (url: string) => string,
  more: {
    scrolls?: Record<string, boolean[]>;
    steps?: (message: Record<string, unknown>) => unknown;
  } = {},
) {
  let at: string | null = null;
  const opened: string[] = [];
  const asked: string[] = [];
  const tab = {
    async open(url: string) {
      at = url;
      opened.push(url);
      return 1;
    },
    async loaded() {
      return 1;
    },
    async ask(message: Record<string, unknown> & { readonly type: string }) {
      asked.push(message.type);
      if (at === null) return { ok: false, error: 'The Facebook tab was closed.' };
      if (message.type === 'hfos-read')
        return { ok: true, result: readPage(load(pages(at), at), at) };
      if (message.type === 'hfos-fetch-step' || message.type === 'hfos-fetch-path')
        return more.steps?.(message) ?? { ok: true, result: 'done', at: 0 };
      return { ok: more.scrolls?.[message.type]?.shift() ?? false };
    },
  } as unknown as JobTab;
  return { tab, opened, asked };
}

/** HandsFreeOS, answering as it would, and keeping what it was sent. */
function fakeHfos(answers: Partial<Record<HfosAsk['type'], (ask: HfosAsk) => unknown>> = {}) {
  const sent: HfosAsk[] = [];
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    const answer = answers[ask.type];
    if (answer) return { ok: true, value: answer(ask) };
    switch (ask.type) {
      case 'hfos-collect-chats':
        return { ok: true, value: { saved: 1, waiting: 1 } };
      case 'hfos-save-groups':
        return { ok: true, value: { saved: ask.input.groups.length } };
      case 'hfos-save-friends':
        return {
          ok: true,
          value: { saved: ask.input.people.length, added: ask.input.people.length, changed: 0 },
        };
      case 'hfos-friend-end':
        return { ok: true, value: {} };
      default:
        throw new Error(`Not expected: ${ask.type}`);
    }
  }) as unknown as Hfos;
  return { hfos, sent };
}

function jobWith(tab: JobTab, hfos: Hfos, more: Partial<Job> = {}) {
  const lines: string[] = [];
  const handedOver: string[] = [];
  const job: Job = {
    tab,
    hfos,
    businessId: BUSINESS,
    stopped: () => false,
    progress: (line) => lines.push(line),
    warn: async () => undefined,
    ...more,
  };
  return { job, lines, handedOver };
}

describe('hearing about asks', () => {
  const made = { type: 'outreach.ask.made', actorId: ME, entityId: ASK };
  it('takes a new one of the person’s own, and hears a stop or an answer only for the one under way', () => {
    expect(askEventFor(made, ME, null)).toBe('take');
    expect(askEventFor({ ...made, actorId: 'u-other' }, ME, null)).toBeNull();
    expect(askEventFor(made, null, null)).toBeNull();
    const cancelled = { type: 'outreach.ask.cancelled', actorId: ME, entityId: ASK };
    expect(askEventFor(cancelled, ME, ASK)).toBe('under_way');
    expect(askEventFor({ ...cancelled, type: 'outreach.ask.replied' }, ME, ASK)).toBe('under_way');
    expect(askEventFor(cancelled, ME, null)).toBeNull();
    expect(askEventFor({ ...cancelled, entityId: 'another' }, ME, ASK)).toBeNull();
    expect(askEventFor({ type: 'outreach.ask.progressed', actorId: ME }, ME, ASK)).toBeNull();
  });

  it('tells a new state at once, and a new line alone at most every 20 seconds', () => {
    expect(lineDue(null, 0, false)).toBe(true);
    expect(lineDue(1_000, 15_000, false)).toBe(false);
    expect(lineDue(1_000, 15_000, true)).toBe(true);
    expect(lineDue(1_000, 21_000, false)).toBe(true);
  });

  it('keeps an end that couldn’t go, one an ask, the oldest let go past twenty', () => {
    const end = (askId: string, line = 'Done.'): WaitingEnd => ({
      userId: ME,
      businessId: BUSINESS,
      askId,
      commandId: `c-${askId}-${line}`,
      occurredAt: '2026-10-27T15:00:00.000Z',
      state: 'done',
      line,
      result: null,
    });
    let ends: WaitingEnd[] = [];
    for (let i = 0; i < 25; i++) ends = withEnd(ends, end(`a${i}`));
    expect(ends).toHaveLength(20);
    expect(ends[0]!.askId).toBe('a5');
    ends = withEnd(ends, end('a10', 'Stopped.'));
    expect(ends.filter((e) => e.askId === 'a10').map((e) => e.line)).toEqual(['Stopped.']);
  });
});

describe('where an ask works', () => {
  it('in a tab the person can see for the file and for tidying; else in a window of its own', () => {
    expect(placeFor('file_download')).toBe('view');
    expect(placeFor('cancel')).toBe('view');
    expect(placeFor('unfriend')).toBe('view');
    expect(placeFor('chats')).toBe('window');
    expect(placeFor('lookup')).toBe('window');
    expect(placeFor('file_in')).toBe('window');
  });
});

describe('taking turns with the runner', () => {
  it('goes one at a time, in order, and has the runner give way while an ask waits', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = inTurn('runner', async () => {
      order.push('runner starts');
      await new Promise<void>((done) => (release = done));
      order.push('runner ends');
    });
    const second = inTurn('ask', async () => {
      order.push(`ask, held by ${turnHeldBy()}`);
    });
    await Promise.resolve();
    expect(askInLine()).toBe(true);
    expect(turnHeldBy()).toBe('runner');
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['runner starts', 'runner ends', 'ask, held by ask']);
    expect(askInLine()).toBe(false);
    expect(turnHeldBy()).toBeNull();
  });

  it('lets the next go after one that failed', async () => {
    const failed = inTurn('ask', () =>
      Promise.reject(new Error('Facebook took the tab elsewhere')),
    );
    const next = inTurn('runner', async () => 'went');
    await expect(failed).rejects.toThrow('Facebook took the tab elsewhere');
    await expect(next).resolves.toBe('went');
  });
});

describe('the jobs an ask does', () => {
  it('reads chats from a tab not opened yet: Messenger first', async () => {
    const { tab, opened } = fakeTab(() => 'chat-2026.html');
    const { hfos, sent } = fakeHfos();
    const { job } = jobWith(tab, hfos);
    const end = await runAsk({ kind: 'chats' }, job);
    expect(opened[0]).toBe(MESSENGER);
    expect(sent.some((a) => a.type === 'hfos-collect-chats')).toBe(true);
    expect(end.warned).toBe(false);
    expect(end.line).toMatch(/sent for the AI to read/);
  });

  it('tidies only the people ticked who are still on the list, and skips one the person skips', async () => {
    const profile = 'https://www.facebook.com/dana.reyes.12';
    const { tab, opened } = fakeTab(() => 'profile-2026.html', {
      // Facebook never shows the button: the step is handed to the person.
      steps: () => ({ ok: true, result: 'missing' }),
    });
    const listed = {
      profileId: '7b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
      platformId: null,
      username: 'dana.reyes.12',
      url: profile,
      name: 'Dana Reyes',
      since: '2026-08-01T15:00:00.000Z',
      lastContact: null,
      fit: 'unknown',
    };
    const { hfos, sent } = fakeHfos({
      'hfos-tidy': () => ({
        cancel: [listed],
        unfriend: [],
        limits: { cancel_request: { most: 20, done: 0 }, unfriend: { most: 10, done: 0 } },
      }),
    });
    const said: string[] = [];
    const { job } = jobWith(tab, hfos, {
      handOver: async (says): Promise<HandOverReply> => {
        said.push(says);
        return 'skip';
      },
    });
    const end = await runAsk(
      { kind: 'cancel', profileIds: [listed.profileId, '00000000-0000-4000-8000-000000000009'] },
      job,
    );
    // Dana's profile shows something other than a request sent, or the step is handed over and skipped.
    expect(opened).toEqual([profile]);
    expect(sent.some((a) => a.type === 'hfos-friend-end')).toBe(false);
    expect(end.line).toMatch(/^Done\. Requests cancelled: 0 people\./);
    expect(end.line).toContain('No longer on the list: 1.');
  });

  it('gets the file until the person presses Stop on a step handed to them', async () => {
    const { tab, opened } = fakeTab(() => 'profile-2026.html', {
      steps: () => ({ ok: true, result: 'missing' }),
    });
    const { hfos } = fakeHfos();
    const said: string[] = [];
    const { job } = jobWith(tab, hfos, {
      handOver: async (says) => {
        said.push(says);
        return 'stop';
      },
    });
    const end = await runAsk({ kind: 'file_backup' }, job);
    expect(opened).toHaveLength(1);
    expect(said[0]).toMatch(/^Couldn’t find that step on the page\. .* Then press Carry on\.$/);
    expect(end).toEqual({ line: 'Stopped.', warned: false });
  });

  it('looks someone up, and has the AI write drafts with what it read', async () => {
    const { tab, opened } = fakeTab(() => 'profile-2026.html');
    const { hfos, sent } = fakeHfos({
      'hfos-draft': () => ({
        drafts: ['Hi Dana, saw your post about missed calls.', 'Hey Dana!'],
        opener: null,
        simple: false,
      }),
    });
    const { job } = jobWith(tab, hfos);
    const end = await runAsk(
      {
        kind: 'lookup',
        draft: { kind: 'opener', profileId: ASK, chatId: null, postId: null },
        profileUrl: 'https://www.facebook.com/dana.reyes.12',
        name: 'Dana Reyes',
      },
      job,
    );
    expect(opened[0]).toBe('https://www.facebook.com/dana.reyes.12');
    const draft = sent.find((a) => a.type === 'hfos-draft') as Extract<
      HfosAsk,
      { type: 'hfos-draft' }
    >;
    expect(draft.input.profileId).toBe(ASK);
    expect(draft.input.lookup?.length).toBeGreaterThan(0);
    expect(end.result?.drafts).toHaveLength(2);
    expect(end.result?.lookedUp).toBe(true);
    expect(end.line).toBe('Wrote 2 drafts after looking Dana Reyes up.');
  });

  it('drafts from what HandsFreeOS knows when there’s no profile to open', async () => {
    const { tab, opened } = fakeTab(() => 'profile-2026.html');
    const { hfos } = fakeHfos({
      'hfos-draft': () => ({ drafts: ['Hi Dana!'], opener: null, simple: false }),
    });
    const { job } = jobWith(tab, hfos);
    const end = await runAsk(
      {
        kind: 'lookup',
        draft: { kind: 'reply', profileId: null, chatId: ASK, postId: null },
        profileUrl: null,
        name: 'Dana Reyes',
      },
      job,
    );
    expect(opened).toEqual([]);
    expect(end.result?.lookedUp).toBe(false);
    expect(end.line).toBe(
      'Wrote a draft from what HandsFreeOS knows: Facebook didn’t show their profile.',
    );
  });

  it('saves the person’s groups, a screen at a time, and searches for groups by words', async () => {
    const { tab, opened, asked } = fakeTab(() => 'groups-joined.html', {
      scrolls: { 'hfos-scroll-page': [true] },
    });
    const { hfos, sent } = fakeHfos();
    const { job } = jobWith(tab, hfos);
    const end = await runAsk({ kind: 'groups' }, job);
    expect(opened).toEqual([YOUR_GROUPS]);
    expect(asked.filter((a) => a === 'hfos-scroll-page')).toHaveLength(2);
    const saved = sent.filter((a) => a.type === 'hfos-save-groups') as Extract<
      HfosAsk,
      { type: 'hfos-save-groups' }
    >[];
    expect(saved.length).toBeGreaterThan(0);
    // From the person's own list, each is saved as one they're in: the setup's groups step lists those.
    expect(saved.every((s) => s.input.groups.every((g) => g.joined === true))).toBe(true);
    expect(end.line).toMatch(
      /^Saved \d+ groups?\. The Groups tab says which fit your playbooks\.$/,
    );

    const search = fakeTab(() => 'groups-joined.html');
    const before = sent.length;
    await runAsk(
      { kind: 'group_search', words: 'dog groomers austin' },
      jobWith(search.tab, hfos).job,
    );
    // A search's groups may be any: whether they're in each is left unsaid.
    const found = sent.slice(before).filter((a) => a.type === 'hfos-save-groups') as Extract<
      HfosAsk,
      { type: 'hfos-save-groups' }
    >[];
    expect(found.flatMap((s) => s.input.groups).some((g) => 'joined' in g)).toBe(false);
    expect(search.opened).toEqual([groupSearch('dog groomers austin')]);
    expect(search.opened[0]).toBe(
      'https://www.facebook.com/search/groups/?q=dog%20groomers%20austin',
    );
  });

  it('saves the person’s friends list from their friends page', async () => {
    const { tab, opened } = fakeTab(() => 'friends-list.html');
    const { hfos, sent } = fakeHfos();
    const { job } = jobWith(tab, hfos);
    const end = await runAsk({ kind: 'friends' }, job);
    expect(opened).toEqual([YOUR_FRIENDS]);
    const saves = sent.filter((a) => a.type === 'hfos-save-friends') as Extract<
      HfosAsk,
      { type: 'hfos-save-friends' }
    >[];
    expect(saves.every((s) => s.input.list === 'friends')).toBe(true);
    expect(end.line).toMatch(/^Saved \d+ friends?/);
  });
});

describe('scrolling a list of groups', () => {
  const view = { scrollY: 0, innerHeight: 800, scrollBy: vi.fn() };
  const root = {
    defaultView: view,
    documentElement: { scrollHeight: 4_000 },
  } as unknown as Document;
  it('scrolls only the person’s groups and a search, while there’s more below', () => {
    expect(groupsListPage(`${FB}/groups/joins/`)).toBe(true);
    expect(groupsListPage(`${FB}/search/groups/?q=dog`)).toBe(true);
    expect(groupsListPage(`${FB}/groups/123456/`)).toBe(false);
    expect(scrollPage(root, `${FB}/groups/joins/`)).toBe(true);
    expect(view.scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollPage(root, `${FB}/dana.reyes.12`)).toBe(false);
    expect(view.scrollBy).toHaveBeenCalledTimes(1);
    const end = { ...root, documentElement: { scrollHeight: 800 } } as unknown as Document;
    expect(scrollPage(end, `${FB}/groups/joins/`)).toBe(false);
  });
});
