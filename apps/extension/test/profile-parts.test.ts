/**
 * The rest of the person's own profile (docs/outreach.md, decision 84): whether anyone's at a username's address, as
 * each network's page says it; the name, username and links handed to the person where a job didn't put them in, with
 * the page where each is changed opened where core says it's theirs (Instagram's links only in its app); and usernames
 * checked in turn, what was found kept on their check.
 */
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkUsernames, putInByHand } from '../src/jobs/profile-parts';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { pageThere } from '../src/networks/there';

const doc = (body: string) => new JSDOM(`<body>${body}</body>`).window.document;

describe('whether anyone’s at an address', () => {
  it('reads each network’s words for a page that isn’t there, and a profile’s name for one that is', () => {
    expect(
      pageThere(doc('<main><h2>Sorry, this page isn’t available.</h2></main>'), 'instagram'),
    ).toBe(false);
    expect(
      pageThere(
        doc('<div role="main"><span>This content isn\'t available right now</span></div>'),
        'facebook',
      ),
    ).toBe(false);
    expect(pageThere(doc('<main><h1>This page doesn’t exist</h1></main>'), 'linkedin')).toBe(false);
    expect(pageThere(doc('<main><header><h2>casey.roofs</h2></header></main>'), 'instagram')).toBe(
      true,
    );
    expect(pageThere(doc('<main><p>Loading…</p></main>'), 'instagram')).toBeNull();
  });
});

type Found = { value: string; free: boolean | null };

function fakeJob(there: Readonly<Record<string, boolean | null>> = {}) {
  const opened: string[] = [];
  const said: string[] = [];
  const saved: Found[][] = [];
  let at = '';
  const tab = {
    async open(url: string) {
      opened.push(url);
      at = url;
      return 1;
    },
    async ask(message: { readonly type: string }) {
      if (message.type !== 'hfos-page-there') return { ok: false, error: 'Not expected' };
      return { ok: true, there: there[at] ?? null };
    },
  } as unknown as JobTab;
  const job: Job = {
    tab,
    hfos: (async (ask: { readonly type: string; readonly input?: { found: Found[] } }) => {
      if (ask.type === 'hfos-usernames') saved.push(ask.input!.found);
      return { ok: true, value: {} };
    }) as unknown as Hfos,
    businessId: 'b',
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
    handOver: async (says: string) => {
      said.push(says);
      return 'carry_on';
    },
  };
  return { job, opened, said, saved };
}

const task = (more: Partial<{ name: string; username: string; links: string[] }>) => ({
  kind: 'profile_edit' as const,
  bio: null,
  about: null,
  name: more.name ?? null,
  username: more.username ?? null,
  links: more.links ?? [],
});

describe('the name, username and links, put in by the person', () => {
  it('says the links are in Instagram’s app, and its name and username in words where they weren’t put in', async () => {
    const { job, opened, said } = fakeJob();
    const end = await putInByHand(
      job,
      'instagram',
      task({ name: 'Casey | Roofs', username: 'casey.roofs', links: ['https://cal.com/c'] }),
    );
    expect(end).toBeNull();
    // From 0.94.0 they go in by themselves (decision 89): no page opened for one that didn't.
    expect(opened).toEqual([]);
    expect(said).toHaveLength(3);
    expect(said[0]).toContain('Name. Put in “Casey | Roofs”');
    expect(said[1]).toContain('Username. Put in “casey.roofs”');
    expect(said[2]).toContain('In the Instagram app');
    expect(said.every((s) => s.endsWith('Then press Carry on.'))).toBe(true);
  });

  it('passes over a part put in already, and stops when the person does', async () => {
    const { job, said } = fakeJob();
    await putInByHand(
      job,
      'linkedin',
      task({ name: 'Casey Lee', username: 'casey-lee' }),
      new Set(['name']),
    );
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('Edit public profile & URL');
    const stopped = await putInByHand(
      { ...job, handOver: async () => 'stop' },
      'facebook',
      task({ username: 'casey.lee' }),
    );
    expect(stopped).toMatchObject({ line: 'Stopped.', failed: true });
  });
});

describe('a part core says goes in by itself, not put in', () => {
  it('is still handed over in words, with no page opened: Facebook’s username, from 0.93.0', async () => {
    const { job, opened, said } = fakeJob();
    const end = await putInByHand(job, 'facebook', task({ username: 'casey.roofs' }));
    expect(end).toBeNull();
    expect(opened).toEqual([]);
    expect(said).toEqual([
      'In Accounts Center, press Profiles, then your Facebook profile, then Username. Put in “casey.roofs”, then Done. Then press Carry on.',
    ]);
  });

  it('passes over the parts the job put in itself, and says the name’s boxes for one it didn’t', async () => {
    const { job, opened, said } = fakeJob();
    await putInByHand(
      job,
      'facebook',
      task({ name: 'Casey Lee', username: 'casey.lee', links: ['https://cal.com/c'] }),
      new Set(['username', 'links']),
    );
    expect(opened).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(
      'Put “Casey” in First name and “Lee” in Last name, leave Middle name empty',
    );
  });

  it('passes over every part Facebook’s and Instagram’s jobs put in themselves', async () => {
    const { job, opened, said } = fakeJob();
    const all = task({ name: 'Casey Lee', username: 'casey.lee', links: ['https://cal.com/c'] });
    await putInByHand(job, 'facebook', all, new Set(['name', 'username', 'links']));
    await putInByHand(job, 'instagram', all, new Set(['name', 'username']));
    expect(opened).toEqual([]);
    // Only Instagram's links, which are its app's.
    expect(said).toEqual([expect.stringContaining('In the Instagram app')]);
  });
});

describe('usernames checked', () => {
  afterEach(() => vi.useRealTimers());

  it('opens each one’s address, and keeps whether it’s free on the person’s check', async () => {
    vi.useFakeTimers();
    const { job, opened, saved } = fakeJob({
      'https://www.instagram.com/casey.roofs/': false,
      'https://www.instagram.com/casey/': true,
    });
    const going = checkUsernames(job, 'instagram', ['casey.roofs', 'casey', 'casey_lee']);
    await vi.runAllTimersAsync();
    const end = await going;
    expect(opened).toEqual([
      'https://www.instagram.com/casey.roofs/',
      'https://www.instagram.com/casey/',
      'https://www.instagram.com/casey_lee/',
    ]);
    expect(saved).toEqual([
      [
        { value: 'casey.roofs', free: true },
        { value: 'casey', free: false },
        { value: 'casey_lee', free: null },
      ],
    ]);
    expect(end).toEqual({ line: '1 of 3 is free.', warned: false });
  });
});
