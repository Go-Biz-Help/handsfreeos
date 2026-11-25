/**
 * The business's link as the first comment under its own post (src/research/posting.ts `firstComment`,
 * src/research/post-comment.ts; docs/socialcontent.md, "Your link"; the owner, 24 Nov 2026): once the post is up on
 * Facebook, LinkedIn or Instagram, the link is written under it from the person's own account, once and never again,
 * and HandsFreeOS hears whether it went. On Facebook, where a new post's link often isn't shown, it's opened from the
 * page that lists it, by its words.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type { DuePost } from '@hfos/core/addons/socialcontent/content-shapes';

const world = {
  went: [] as unknown[],
  reports: [] as { job: string; note: string; found: Record<string, unknown> }[],
};

vi.mock('../src/research/hfos', () => {
  class ResearchRefused extends Error {}
  return {
    ResearchRefused,
    postNext: async () => ({ post: null }),
    postWent: async (_ws: string, _id: string, said: { went: unknown[] }) => {
      world.went.push(...said.went);
      return {};
    },
    reportProblem: async (
      _ws: string,
      r: { job: string; note: string; found: Record<string, unknown> },
    ) => {
      world.reports.push(r);
      return { reportId: 'r1' };
    },
  };
});
// Its waits pass at once in a test.
vi.mock('../src/research/read', async (actual) => ({
  ...(await actual<object>()),
  pause: async () => undefined,
  paced: () => 0,
}));
vi.stubGlobal('chrome', {
  storage: {
    local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
  },
  runtime: { getManifest: () => ({ version: '0.153.0' }) },
});

const { putUp } = await import('../src/research/posting');
const { startsLike } = await import('../src/research/post-comment');

const TEXT = 'Most leads are gone three minutes after a missed call. Here’s what we do instead.';
const COMMENT = 'https://gobiz.example/book';

const due = (over: Partial<DuePost>): DuePost => ({
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Missed calls',
  network: 'linkedin',
  format: 'text',
  text: TEXT,
  chain: [],
  comment: COMMENT,
  files: [],
  places: ['feed'],
  facebookPage: null,
  postAt: null,
  ...over,
});

/**
 * A reading window that puts the post up (its note's link, `url`, when the network shows one), finds it on the page
 * that lists it (`listed`: its link there, or none), and writes the comment as `commented` says.
 */
function tabFor(opts: {
  url?: string | null;
  listed?: { url: string | null } | null;
  commented?: 'done' | 'none' | 'not_sent';
  me?: string | null;
}) {
  const opened: string[] = [];
  const asked: { name: string; args: unknown[]; at: string | undefined }[] = [];
  const tab = {
    opened,
    asked,
    open: async (url: string) => {
      opened.push(url);
      return 1;
    },
    holdPicker: async () => true,
    inFront: async <T>(work: () => Promise<T>) => work(),
    hands: async (name: string, ...args: unknown[]) => {
      asked.push({ name, args, at: opened.at(-1) });
      if (name === 'warnings') return [];
      if (name === 'post')
        return { result: 'done', pressed: true, url: opts.url ?? null, steps: [] };
      if (name === 'read')
        return opts.listed
          ? { kind: 'profile', posts: [{ text: TEXT, url: opts.listed.url }] }
          : { posts: [] };
      if (name === 'drawPosts') return { drawn: 1, loading: false, shown: true };
      if (name === 'me') return opts.me ?? null;
      if (name === 'get') return { ok: false, status: 0, json: null };
      if (name === 'comment') return opts.commented ?? 'done';
      if (name === 'outline') return null;
      return null;
    },
  };
  return tab;
}

const comments = (tab: ReturnType<typeof tabFor>) => tab.asked.filter((a) => a.name === 'comment');

async function run(post: DuePost, tab: ReturnType<typeof tabFor>) {
  world.went.length = 0;
  world.reports.length = 0;
  await putUp('ws', tab as never, post);
  return world.went as {
    place: string;
    posted: boolean;
    link: string | null;
    comment: boolean | null;
  }[];
}

describe('the link as the first comment', () => {
  it('opens a LinkedIn post by the link LinkedIn showed and writes the link under it, once', async () => {
    const link = 'https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000000/';
    const tab = tabFor({ url: link });
    const went = await run(due({}), tab);
    expect(went).toEqual([{ place: 'feed', posted: true, link, failure: null, comment: true }]);
    expect(comments(tab)).toEqual([
      { name: 'comment', args: [{ where: 'linkedin', text: COMMENT, words: TEXT }], at: link },
    ]);
    expect(world.reports).toEqual([]);
  });

  it('writes it on Facebook from the page that lists the post, found by its words, when Facebook shows no link', async () => {
    const tab = tabFor({ listed: { url: null } });
    const went = await run(due({ network: 'facebook', places: ['profile'] }), tab);
    expect(went[0]).toMatchObject({ place: 'profile', posted: true, link: null, comment: true });
    expect(comments(tab).map((c) => c.at)).toEqual(['https://www.facebook.com/me']);
  });

  it('says it didn’t go, and reports it, when the comment wasn’t taken: never tried twice', async () => {
    const link = 'https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000001/';
    const tab = tabFor({ url: link, commented: 'not_sent' });
    const went = await run(due({}), tab);
    expect(went[0]).toMatchObject({ posted: true, comment: false });
    expect(comments(tab)).toHaveLength(1);
    expect(world.reports).toMatchObject([
      {
        job: 'comment.feed',
        found: { result: ['not_sent'], steps: ['opened', 'comment:not_sent'] },
      },
    ]);
  });

  it('says it didn’t go when the Instagram post’s link couldn’t be found, without writing anywhere else', async () => {
    const tab = tabFor({ me: null });
    const went = await run(due({ network: 'instagram', format: 'photo' }), tab);
    expect(went[0]).toMatchObject({ posted: true, link: null, comment: false });
    expect(comments(tab)).toEqual([]);
    expect(world.reports).toMatchObject([{ job: 'comment.feed', found: { result: ['no_post'] } }]);
  });

  it('writes nothing when the post carries no first comment, or on Threads and X, where it went in the chain', async () => {
    for (const post of [due({ comment: null }), due({ network: 'x', comment: COMMENT })]) {
      const tab = tabFor({ url: 'https://x.com/gobiz/status/1' });
      const went = await run(post, tab);
      expect(went[0]).toMatchObject({ posted: true, comment: null });
      expect(comments(tab)).toEqual([]);
    }
  });
});

describe('finding the post by its words', () => {
  it('matches what the page shows cut short, with its paragraphs run together or apart', () => {
    expect(startsLike('Most leads are gone three minutes after a missed call. Here’s…', TEXT)).toBe(
      true,
    );
    expect(startsLike('Most leads are gone threeminutes after a missed call.', TEXT)).toBe(true);
    expect(startsLike('A different post about something else entirely', TEXT)).toBe(false);
    expect(startsLike('', TEXT)).toBe(false);
  });

  it('never writes on Facebook when no post opened over the page', async () => {
    const { commentHere } = await import('../src/research/post-comment');
    const dom = new JSDOM(
      '<main role="main"><div role="feed"><div>Something else entirely, not the post</div></div></main>',
      {
        url: 'https://www.facebook.com/me',
      },
    );
    vi.useFakeTimers();
    const writing = commentHere(dom.window.document, 'https://www.facebook.com/me', {
      where: 'facebook',
      text: COMMENT,
      words: TEXT,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    expect(await writing).toBe('none');
  });
});
