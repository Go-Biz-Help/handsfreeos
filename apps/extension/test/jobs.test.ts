/**
 * The jobs the extension does on Facebook for the person, by a button in the panel or once a day on its own
 * (src/jobs/, src/auto/daily.ts; docs/outreach.md decision 32): what each opens, scrolls and saves, on made-up 2026
 * pages, and that any warning from Facebook stops it.
 */
import { describe, expect, it, vi } from 'vitest';
import { DAILY_JOBS, freshState, nextDaily } from '../src/auto/plan';
import { readPage } from '../src/facebook/page';
import type { ChatSummary } from '../src/facebook/types';
import type { HfosAsk } from '../src/hfos/messages';
import type { ChatMemory } from '../src/jobs/chats';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import type { BrowseAsk } from '../src/messages';
import { load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { readChats } = await import('../src/jobs/chats');
const { checkRequests, saveMembers, ADMIN_SCROLLS, FRIEND_REQUESTS } =
  await import('../src/jobs/people');
const { findPosts, groupsToWork } = await import('../src/jobs/posts');
const { runDaily } = await import('../src/auto/daily');

const FB = 'https://www.facebook.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/** A tab that opens made-up pages by address, and scrolls as told: each scroll's answer in turn, then no more. */
function fakeTab(
  pages: (url: string) => string,
  scrolls: Partial<Record<BrowseAsk['type'], boolean[]>> = {},
) {
  let at = '';
  const opened: string[] = [];
  const asked: string[] = [];
  const tab = {
    async open(url: string) {
      at = url;
      opened.push(url);
    },
    async ask(message: { readonly type: string }) {
      asked.push(message.type);
      if (message.type === 'hfos-read')
        return { ok: true, result: readPage(load(pages(at), at), at) };
      return { ok: scrolls[message.type as BrowseAsk['type']]?.shift() ?? false };
    },
  } as unknown as JobTab;
  return { tab, opened, asked, goTo: (url: string) => (at = url) };
}

/** HandsFreeOS, answering as a save would, and keeping what it was sent. */
function fakeHfos(groups: unknown[] = []) {
  const sent: HfosAsk[] = [];
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    switch (ask.type) {
      case 'hfos-save-friends':
        return {
          ok: true,
          value: { saved: ask.input.people.length, added: ask.input.people.length, changed: 0 },
        };
      case 'hfos-save-group':
        return { ok: true, value: { people: ask.input.people?.length ?? 0, runsGroup: 0 } };
      case 'hfos-collect-chats':
        return { ok: true, value: { saved: 1, waiting: 1 } };
      case 'hfos-save-posts':
        return {
          ok: true,
          value: { posts: ask.input.posts.map(() => ({})), checking: ask.input.posts.length },
        };
      case 'hfos-groups':
        return { ok: true, value: { groups: ask.input.view === 'work' ? groups : [] } };
      default:
        throw new Error(`Not expected: ${ask.type}`);
    }
  }) as unknown as Hfos;
  return { hfos, sent };
}

function jobWith(tab: JobTab, hfos: Hfos, stopped = () => false) {
  const warned: string[][] = [];
  const lines: string[] = [];
  const job: Job = {
    tab,
    hfos,
    businessId: BUSINESS,
    stopped,
    progress: (line) => lines.push(line),
    warn: async (words) => void warned.push([...words]),
  };
  return { job, warned, lines };
}

const group = (id: string, more: Record<string, unknown> = {}) => ({
  groupId: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
  name: `Group ${id}`,
  url: `${FB}/groups/${id}/`,
  joined: true,
  people: 0,
  adminsRead: false,
  replies: 0,
  demos: 0,
  ...more,
});

describe('the once-a-day jobs, in order', () => {
  it('checks requests, then members, then posts, then chats, each once a day', () => {
    expect(DAILY_JOBS).toEqual(['requests', 'members', 'posts', 'chats']);
    const fresh = freshState('2026-10-10');
    expect(nextDaily(fresh)).toBe('requests');
    expect(nextDaily({ daily: { requests: 'Saved 2.', members: 'Saved 9.' } })).toBe('posts');
    expect(nextDaily({ daily: { requests: '', members: '', posts: '', chats: '' } })).toBeNull();
    // A state kept by 0.11 has none: it starts from the first.
    expect(nextDaily({})).toBe('requests');
  });
});

describe('checking friend requests', () => {
  it('loads the list a screen at a time and saves the requests they’ve got', async () => {
    const { tab, opened, asked } = fakeTab(() => 'friend-requests-2026.html', {
      'hfos-scroll-list': [true],
    });
    const { hfos, sent } = fakeHfos();
    const { job } = jobWith(tab, hfos);
    const end = await checkRequests(job);
    expect(opened).toEqual([FRIEND_REQUESTS]);
    expect(asked.filter((a) => a === 'hfos-scroll-list')).toHaveLength(2);
    const saves = sent.filter((a) => a.type === 'hfos-save-friends');
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ input: { list: 'requests', workspaceId: BUSINESS } });
    // Each once, however many screens showed them; one answered already is left out.
    expect(
      (saves[0] as Extract<HfosAsk, { type: 'hfos-save-friends' }>).input.people.map((p) => p.name),
    ).toEqual(['Avery Lane', 'Quinn Harper', 'Rowan Blake']);
    expect(end).toEqual({ line: 'Saved 3 friend requests, 3 new.', warned: false });
  });

  it('stops on a warning from Facebook, noting it, and saves nothing', async () => {
    const { tab } = fakeTab(() => 'warning.html');
    const { hfos, sent } = fakeHfos();
    const { job, warned } = jobWith(tab, hfos);
    const end = await checkRequests(job);
    expect(end.warned).toBe(true);
    expect(end.line).toContain('You’re Temporarily Blocked');
    expect(warned[0]).toContain('You’re Temporarily Blocked');
    expect(sent).toEqual([]);
  });
});

describe('saving group members', () => {
  const members = () => 'group-members-2026.html';

  it('saves a group’s admins first, read to the end, then its members', async () => {
    const { tab, opened } = fakeTab(members);
    const { hfos, sent } = fakeHfos();
    const { job } = jobWith(tab, hfos);
    const end = await saveMembers(job, [group('4455667788')]);
    expect(opened).toEqual([
      `${FB}/groups/4455667788/members/admins`,
      `${FB}/groups/4455667788/members/`,
    ]);
    const saves = sent.filter((a) => a.type === 'hfos-save-group') as Extract<
      HfosAsk,
      { type: 'hfos-save-group' }
    >[];
    expect(saves.map((s) => s.input.adminsPage)).toEqual([true, false]);
    expect(end.line).toBe('Saved 14 people from 1 group. Today suggests the ones who fit.');
  });

  it('leaves a group’s members for another day when its admins don’t load to the end', async () => {
    const { tab, opened } = fakeTab(members, {
      'hfos-scroll-list': Array<boolean>(ADMIN_SCROLLS + 1).fill(true),
    });
    const { hfos, sent } = fakeHfos();
    const { job } = jobWith(tab, hfos);
    await saveMembers(job, [group('4455667788')]);
    expect(opened).toEqual([`${FB}/groups/4455667788/members/admins`]);
    expect(sent).toEqual([]);
  });

  it('goes to the groups with the fewest saved first, a few a day, and only members once admins are read', async () => {
    const { tab, opened } = fakeTab(members);
    const { hfos } = fakeHfos();
    const { job } = jobWith(tab, hfos);
    await saveMembers(job, [
      group('111', { people: 90, adminsRead: true }),
      group('222', { people: 5, adminsRead: true }),
      group('333', { people: 400, adminsRead: true }),
      group('444', { people: 20, adminsRead: true }),
    ]);
    expect(opened).toEqual([
      `${FB}/groups/222/members/`,
      `${FB}/groups/444/members/`,
      `${FB}/groups/111/members/`,
    ]);
  });
});

describe('which groups it works', () => {
  it('works the groups whose people wrote back and booked demos most, and tries others too', async () => {
    const work = [
      group('fresh1'),
      group('replied', { replies: 3 }),
      group('fresh2'),
      group('booked', { replies: 1, demos: 1 }),
      group('notin', { joined: false, demos: 4 }),
    ];
    const maybe = [group('maybebooked', { demos: 2 }), group('maybefresh')];
    const hfos = (async (ask: HfosAsk) => ({
      ok: true,
      value: { groups: ask.type === 'hfos-groups' && ask.input.view === 'maybe' ? maybe : work },
    })) as unknown as Hfos;
    const { job } = jobWith(fakeTab(() => 'group-feed.html').tab, hfos);
    const picked = await groupsToWork(job, 5);
    expect(typeof picked === 'string' ? picked : picked.map((g) => g.name)).toEqual([
      'Group maybebooked',
      'Group booked',
      'Group replied',
      'Group fresh1',
      'Group fresh2',
    ]);
  });
});

describe('finding posts', () => {
  it('reads each group’s feed a screen at a time, till it ends', async () => {
    const { tab, opened, asked } = fakeTab(() => 'group-feed.html', {
      'hfos-scroll-feed': [true, false, true],
    });
    const { hfos } = fakeHfos();
    const { job } = jobWith(tab, hfos);
    const screens: number[] = [];
    const end = await findPosts(
      job,
      [group('texascontractors'), group('austinsmallbiz')],
      async (page) => {
        screens.push(page.posts?.length ?? 0);
        return 1;
      },
    );
    expect(opened).toEqual([`${FB}/groups/texascontractors/`, `${FB}/groups/austinsmallbiz/`]);
    expect(screens).toEqual([2, 2, 2, 2]);
    expect(asked.filter((a) => a === 'hfos-scroll-feed')).toHaveLength(4);
    expect(end.line).toBe(
      'Looked through 2 groups: 4 posts sent for the AI to check. The good ones go on your list for today.',
    );
  });

  it('sends each post once a day when it runs on its own', async () => {
    const { tab } = fakeTab(() => 'group-feed.html', { 'hfos-scroll-feed': [true] });
    const { hfos, sent } = fakeHfos([group('texascontractors')]);
    const { job } = jobWith(tab, hfos);
    const end = await runDaily('posts', job);
    const saves = sent.filter((a) => a.type === 'hfos-save-posts') as Extract<
      HfosAsk,
      { type: 'hfos-save-posts' }
    >[];
    expect(saves).toHaveLength(1);
    expect(saves[0]!.input.found).toBe('find');
    expect(end.line).toContain('2 posts sent for the AI to check');
  });

  it('says so when they’re in no good group', async () => {
    const { tab } = fakeTab(() => 'group-feed.html');
    const { hfos } = fakeHfos([]);
    const { job } = jobWith(tab, hfos);
    expect(await runDaily('members', job)).toEqual({
      line: 'You’re not in any group marked Work these or Maybe yet.',
      warned: false,
    });
  });
});

describe('reading chats', () => {
  it('opens the chats not read lately, one at a time, and sends each for the AI', async () => {
    const { tab, opened, goTo } = fakeTab(() => 'chat-2026.html');
    goTo(`${FB}/messages/t/100012345678901`);
    const { hfos, sent } = fakeHfos();
    const { job } = jobWith(tab, hfos);
    const remembered: string[] = [];
    const memory: ChatMemory = {
      lately: async (chat: ChatSummary) => chat.name === 'Ben Ortiz',
      remember: async (id) => void remembered.push(id),
    };
    const said: string[] = [];
    const end = await readChats(job, {
      most: 60,
      memory,
      said: (line) => said.push(line),
      again: 'The rest wait for tomorrow.',
    });
    expect(opened).toEqual([`${FB}/messages/t/100009000000002/`]);
    const collected = sent.filter((a) => a.type === 'hfos-collect-chats') as Extract<
      HfosAsk,
      { type: 'hfos-collect-chats' }
    >[];
    expect(collected.map((c) => c.input.chats[0]!.thread.id)).toEqual(['100009000000002']);
    expect(remembered).toEqual(['100009000000002']);
    expect(said).toEqual(['Sent the chat with Dana Reyes for the AI to read.']);
    expect(end).toEqual({
      line: 'Done: 1 chat sent for the AI to read. Chats read in the last day were left as they were.',
      warned: false,
    });
  });

  it('stops when told', async () => {
    const { tab, goTo } = fakeTab(() => 'chat-2026.html');
    goTo(`${FB}/messages/t/100012345678901`);
    const { hfos, sent } = fakeHfos();
    const { job } = jobWith(tab, hfos, () => true);
    const end = await readChats(job, {
      most: 60,
      memory: { lately: async () => false, remember: async () => undefined },
      again: '',
    });
    expect(sent).toEqual([]);
    expect(end.line).toBe('Stopped. 0 chats sent for the AI to read.');
  });
});
