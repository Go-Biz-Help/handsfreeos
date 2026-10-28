/**
 * The person's own followers on Facebook (src/jobs/followers.ts; docs/outreach.md decision 113): read once a week
 * before the day's checks, a screen at a time, and saved to HandsFreeOS for the AI to check those who aren't friends
 * like friends. On a made-up page of followers (test/fixtures/followers-2026-10.html).
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { readPage } from '../src/networks/facebook/page';
import type { HfosAsk } from '../src/hfos/messages';
import { followersSave } from '../src/hfos/saves';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { readFollowers, YOUR_FOLLOWERS } = await import('../src/jobs/followers');
const { DAILY_JOBS } = await import('../src/auto/plan');

const FB = 'https://www.facebook.com';
const OWN = `${FB}/casey.owner.7`;
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/** Their followers tab, where Facebook sends /me/followers; scrolled as told, then no more. */
function fakeTab(
  scrolls: boolean[] = [],
  doc: Document = load('followers-2026-10.html', `${OWN}/followers`),
) {
  const opened: string[] = [];
  const tab = {
    async open(url: string) {
      opened.push(url);
    },
    async ask(message: { readonly type: string }) {
      if (message.type === 'hfos-read')
        return { ok: true, result: readPage(doc, `${OWN}/followers`) };
      return { ok: scrolls.shift() ?? false };
    },
  } as unknown as JobTab;
  return { tab, opened };
}

function fakeHfos(due = true) {
  const sent: HfosAsk[] = [];
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    if (ask.type === 'hfos-followers-next') return { ok: true, value: { due } };
    if (ask.type === 'hfos-followers-save') {
      const people = ask.input.people ?? [];
      return {
        ok: true,
        value: {
          saved: people.length,
          // Kate Nguyen is their friend already.
          added: people.filter((p) => p.name !== 'Kate Nguyen').length,
          readAt: ask.input.done ? '2026-10-28T15:00:00.000Z' : null,
        },
      };
    }
    throw new Error(`Not expected: ${ask.type}`);
  }) as unknown as Hfos;
  return { hfos, sent };
}

function jobWith(tab: JobTab, hfos: Hfos, stopped = () => false) {
  const notes: unknown[] = [];
  const job: Job = {
    tab,
    hfos,
    businessId: BUSINESS,
    stopped,
    progress: () => {},
    warn: async () => {},
    report: async (note) => void notes.push(note),
  };
  return { job, notes };
}

const saves = (sent: HfosAsk[]) =>
  sent.flatMap((a) => (a.type === 'hfos-followers-save' ? [a.input] : []));

describe('your followers on Facebook (decision 113)', () => {
  it('are read once a week, before the day’s checks', () => {
    expect(DAILY_JOBS.indexOf('followers')).toBe(DAILY_JOBS.indexOf('checks') - 1);
  });

  it('opens their own list, reads it to its end and saves each follower once, the week’s read done', async () => {
    const { tab, opened } = fakeTab([true]);
    const { hfos, sent } = fakeHfos();
    const { job } = jobWith(tab, hfos);
    const end = await readFollowers(job);
    expect(opened).toEqual([YOUR_FOLLOWERS]);
    expect(saves(sent)).toEqual([
      {
        workspaceId: BUSINESS,
        platform: 'facebook',
        done: true,
        people: [
          {
            name: 'Dana Reyes',
            profile: { id: null, username: 'dana.reyes.31', url: `${FB}/dana.reyes.31` },
          },
          {
            name: 'Milo Park',
            profile: expect.objectContaining({ id: '100007777777777', username: null }),
          },
          {
            name: 'Kate Nguyen',
            profile: expect.objectContaining({ username: 'kate.nguyen.9' }),
          },
        ],
      },
    ]);
    expect(end).toEqual({
      line: 'Read 3 followers: 2 new who aren’t your friends. The AI checks them like friends, and the good fits come onto Today for a friend request.',
      warned: false,
    });
  });

  it('reads nothing when this week’s read is done', async () => {
    const { tab, opened } = fakeTab();
    const { hfos, sent } = fakeHfos(false);
    const end = await readFollowers(jobWith(tab, hfos).job);
    expect(opened).toEqual([]);
    expect(saves(sent)).toEqual([]);
    expect(end.line).toBe(
      'Your followers were read this week. They’re read again a week after the last time.',
    );
  });

  it('keeps what it read when stopped part-way, and reads the list again next time', async () => {
    const { tab } = fakeTab([true]);
    const { hfos, sent } = fakeHfos();
    let reads = 0;
    const end = await readFollowers(jobWith(tab, hfos, () => ++reads > 1).job);
    expect(saves(sent)).toHaveLength(1);
    expect(saves(sent)[0]).toMatchObject({ done: false });
    expect(end.line).toMatch(/^Stopped\. Read 3 followers: .* The rest are read next time\.$/);
  });

  it('notes the page’s outline when Facebook showed nobody, and the week’s read is still done', async () => {
    const empty = new JSDOM(
      '<!doctype html><html><body><div role="main"><h2>Followers</h2><span>No followers to show</span></div></body></html>',
      { url: `${OWN}/followers` },
    ).window.document;
    const { tab } = fakeTab([], empty);
    const { hfos, sent } = fakeHfos();
    const { job, notes } = jobWith(tab, hfos);
    const end = await readFollowers(job);
    expect(notes).toEqual([{ note: 'Facebook showed no followers.', outline: true }]);
    expect(saves(sent)).toEqual([
      { workspaceId: BUSINESS, platform: 'facebook', people: [], done: true },
    ]);
    expect(end.line).toBe('Facebook showed no followers. They’re read again next week.');
  });

  it('saves a longer list in parts, the week’s read done with the last', () => {
    const people = Array.from({ length: 150 }, (_, i) => ({
      name: `Follower ${i + 1}`,
      profile: { id: null, username: `follower.${i + 1}`, url: `${FB}/follower.${i + 1}` },
      details: [],
    }));
    const parts = followersSave(people as never, BUSINESS, true);
    expect(parts.map((p) => [p.people?.length, p.done])).toEqual([
      [100, false],
      [50, true],
    ]);
  });
});
