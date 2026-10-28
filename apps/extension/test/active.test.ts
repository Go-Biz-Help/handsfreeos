/**
 * Staying active in the person's Facebook groups (src/jobs/active.ts; docs/outreach.md decision 114): once a day, after
 * finding posts, it likes a few recent posts in the groups HandsFreeOS names, never the person's own, one liked
 * already, an old one or one about sad news, and offers the questions there for the day's reply. On a made-up group's
 * newest posts (test/fixtures/group-feed-2026-10.html) and another with nothing to like (test/fixtures/group-feed.html).
 */
import { describe, expect, it, vi } from 'vitest';
import { groupFeedPosts, likeGroupPost } from '../src/networks/facebook/auto';
import { readPage } from '../src/networks/facebook/page';
import type { ActiveNext, HfosAsk } from '../src/hfos/messages';
import type { Step } from '../src/networks/facebook/actions';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { stayActive } = await import('../src/jobs/active');
const { DAILY_JOBS } = await import('../src/auto/plan');

const FB = 'https://www.facebook.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const AUSTIN = `${FB}/groups/austinsmallbiz/`;
const TEXAS = `${FB}/groups/texascontractors/`;

/** A tab on the group it was sent to: each group's own page, its posts read and liked as the page's own presses do. */
function fakeTab(warnings: Record<string, string[]> = {}) {
  const opened: string[] = [];
  const pages = new Map<string, Document>();
  let at = '';
  const pageOf = (url: string) => {
    const name = url.includes('austinsmallbiz') ? 'group-feed-2026-10.html' : 'group-feed.html';
    if (!pages.has(url)) pages.set(url, load(name, url));
    return pages.get(url)!;
  };
  const tab = {
    async open(url: string) {
      opened.push(url);
      at = url;
    },
    async ask(
      message: { readonly type: string; readonly most?: number } & Record<string, unknown>,
    ) {
      const doc = pageOf(at);
      if (message.type === 'hfos-read') {
        const read = readPage(doc, at);
        const said = Object.entries(warnings).find(([slug]) => at.includes(slug))?.[1];
        return { ok: true, result: said ? { ...read, warnings: said } : read };
      }
      if (message.type === 'hfos-group-feed')
        return {
          ok: true,
          posts: groupFeedPosts(doc, at)
            .slice(0, message.most)
            .map((f) => f.post),
        };
      if (message.type === 'hfos-like-group-post')
        return {
          ok: true,
          ...likeGroupPost(doc, at, {
            index: message.index as number,
            url: message.url as string | null,
          }),
        };
      throw new Error(`Not expected: ${message.type}`);
    },
  } as unknown as JobTab;
  return { tab, opened };
}

function fakeHfos(next: Partial<ActiveNext> = {}) {
  const sent: HfosAsk[] = [];
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    if (ask.type === 'hfos-active-next')
      return {
        ok: true,
        value: {
          likes: 3,
          reply: true,
          groups: [
            {
              groupId: '1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b',
              name: 'Austin Small Business Owners',
              url: AUSTIN,
            },
            {
              groupId: '2c2c2c2c-2c2c-4c2c-8c2c-2c2c2c2c2c2c',
              name: 'Texas Contractors Network',
              url: TEXAS,
            },
          ],
          own: { url: `${FB}/casey.owner.7`, username: 'casey.owner.7' },
          ...next,
        },
      };
    if (ask.type === 'hfos-active-reply')
      return {
        ok: true,
        value: {
          postId: '3d3d3d3d-3d3d-4d3d-8d3d-3d3d3d3d3d3d',
          url: ask.input.posts[0]!.url,
          why: null,
        },
      };
    throw new Error(`Not expected: ${ask.type}`);
  }) as unknown as Hfos;
  return { hfos, sent };
}

function jobWith(tab: JobTab, hfos: Hfos) {
  const warned: string[][] = [];
  const job: Job = {
    tab,
    hfos,
    businessId: BUSINESS,
    stopped: () => false,
    progress: () => {},
    warn: async (words) => void warned.push([...words]),
    report: async () => {},
  };
  return { job, warned };
}

const replies = (sent: HfosAsk[]) =>
  sent.flatMap((a) => (a.type === 'hfos-active-reply' ? [a.input] : []));

describe('staying active in your groups (decision 114)', () => {
  it('runs once a day, after finding posts', () => {
    expect(DAILY_JOBS.indexOf('active')).toBe(DAILY_JOBS.indexOf('posts') + 1);
  });

  it('likes a few recent posts there and offers the questions for the day’s reply', async () => {
    const { tab, opened } = fakeTab();
    const { hfos, sent } = fakeHfos();
    const liked: Step[] = [];
    const end = await stayActive(jobWith(tab, hfos).job, async (step) => void liked.push(step));
    expect(opened).toEqual([
      `${AUSTIN}?sorting_setting=CHRONOLOGICAL`,
      `${TEXAS}?sorting_setting=CHRONOLOGICAL`,
    ]);
    // Their share of three, spread over two groups: never Casey's own, Milo's sad news, Lee's liked already or Kate's
    // from October.
    expect(liked.map((s) => [s.kind, s.to?.name, s.postUrl])).toEqual([
      ['like', 'Dana Reyes', `${FB}/groups/austinsmallbiz/posts/9100000000000001/`],
      ['like', 'Nina Brooks', `${FB}/groups/austinsmallbiz/posts/9100000000000006/`],
    ]);
    expect(liked[0]).toMatchObject({
      auto: true,
      group: expect.objectContaining({ url: AUSTIN, name: 'Austin Small Business Owners' }),
      postText: 'Anyone going to the chamber mixer Thursday night?',
    });
    // The questions there, in the order they were read: never Casey's own.
    expect(replies(sent)).toEqual([
      {
        workspaceId: BUSINESS,
        platform: 'facebook',
        posts: [
          expect.objectContaining({
            name: 'Dana Reyes',
            url: `${FB}/groups/austinsmallbiz/posts/9100000000000001/`,
            text: 'Anyone going to the chamber mixer Thursday night?',
            group: expect.objectContaining({ url: AUSTIN }),
          }),
          expect.objectContaining({ name: 'Lee Hart', when: '1h', comments: 2 }),
          expect.objectContaining({
            name: 'Rob Hayes',
            group: expect.objectContaining({ url: TEXAS }),
          }),
        ],
      },
    ]);
    expect(end).toEqual({
      line: 'Liked 2 recent posts in 2 groups. A question there is on Today for a reply the AI writes.',
      warned: false,
    });
  });

  it('keeps no question when today’s reply is kept already, or its build doesn’t post one', async () => {
    const { tab } = fakeTab();
    const { hfos, sent } = fakeHfos({ reply: false, likes: 1 });
    const liked: Step[] = [];
    const end = await stayActive(jobWith(tab, hfos).job, async (step) => void liked.push(step));
    expect(liked.map((s) => s.to?.name)).toEqual(['Dana Reyes']);
    expect(replies(sent)).toEqual([]);
    expect(end.line).toBe('Liked 1 recent post in 2 groups.');
  });

  it('opens nothing when there’s nothing to do today', async () => {
    const { tab, opened } = fakeTab();
    const { hfos } = fakeHfos({ likes: 0, reply: false });
    const end = await stayActive(jobWith(tab, hfos).job, async () => {});
    expect(opened).toEqual([]);
    expect(end).toEqual({ line: 'Nothing to like or answer in your groups today.', warned: false });
  });

  it('stops on a Facebook warning, with nothing liked there', async () => {
    const { tab } = fakeTab({ austinsmallbiz: ['You’re temporarily blocked'] });
    const { hfos, sent } = fakeHfos();
    const liked: Step[] = [];
    const { job, warned } = jobWith(tab, hfos);
    const end = await stayActive(job, async (step) => void liked.push(step));
    expect(warned).toEqual([['You’re temporarily blocked']]);
    expect(liked).toEqual([]);
    expect(replies(sent)).toEqual([]);
    expect(end.warned).toBe(true);
  });
});
