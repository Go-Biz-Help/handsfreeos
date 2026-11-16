/**
 * The comment research's reading on Instagram (docs/outreach.md, decision 166: src/jobs/instagram/comment-research.ts),
 * with Instagram and HandsFreeOS stood in for: nothing when HandsFreeOS says there's none (anyone who didn't start
 * one), or today's share is read; a batch's hashtags opened in turn, a few posts on each, View more comments pressed
 * once and nothing else; only the comments' words sent, sorted first, never who wrote them, the post or its address,
 * never the post writer's comments nor the person's own; the next batch later today; a warning stopping the day; and
 * the end once it's read all it set out to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HfosAsk } from '../src/hfos/messages';
import type { Hfos, Job, JobTab } from '../src/jobs/job';

// A person's pace between posts and hashtags is seconds; here, none.
const paused: number[] = [];
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: (ms: number) => {
    paused.push(ms);
    return Promise.resolve();
  },
}));

const { readCommentsForResearch } = await import('../src/jobs/instagram/comment-research');
const { forgetSeenPosts } = await import('../src/jobs/comment-research');
beforeEach(forgetSeenPosts);

const IG = 'https://www.instagram.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const RESEARCH = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
const OWN = `${IG}/casey.owner/`;
const tagPage = (tag: string) => `${IG}/explore/tags/${tag}/`;
const post = (code: string) => `${IG}/p/${code}/`;

interface Said {
  readonly username: string;
  readonly text: string;
}
/** A page as the extension reads it: Instagram's, with what its own readers found. */
const page = (url: string, found: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  platform: 'instagram',
  kind: 'page',
  url,
  readAt: '2026-11-14T12:00:00.000Z',
  people: [],
  posts: [],
  places: [],
  links: [],
  own: OWN,
  edits: [],
  warnings: [],
  signedOut: false,
  boxes: 0,
  notes: [],
  found,
  ...more,
});
const tagOf = (tag: string, posts: string[]) =>
  page(tagPage(tag), { tag: { url: tagPage(tag), name: tag, posts } });
const postOf = (
  url: string,
  author: string,
  comments: Said[],
  more: Record<string, unknown> = {},
) =>
  page(
    url,
    {
      post: {
        url,
        author: { username: author, url: `${IG}/${author}/` },
        caption: 'Sunday at the lake with the whole crew',
        likes: 12,
        comments: comments.map((c) => ({ ...c, url: `${IG}/${c.username}/` })),
        place: null,
      },
    },
    more,
  );
const said = (username: string, text: string): Said => ({ username, text });

/** The job's window: each address shows its page, and every ask of the page is kept. */
function fakeTab(pages: Record<string, ReturnType<typeof page>>, moreComments = true) {
  const opened: string[] = [];
  const asked: string[] = [];
  let front = 0;
  const tab = {
    async open(url: string) {
      opened.push(url);
    },
    async inFront<T>(work: () => Promise<T>) {
      front++;
      return work();
    },
    async ask(message: { readonly type: string }) {
      asked.push(message.type);
      if (message.type === 'hfos-read') {
        const shown = pages[opened.at(-1)!];
        return shown ? { ok: true, result: shown } : { ok: false, error: 'Nothing there.' };
      }
      // The hashtag's grid has no more to scroll to; a post's View more comments is there to press.
      if (message.type === 'hfos-more-comments') return { ok: moreComments };
      return { ok: false };
    },
  } as unknown as JobTab;
  return { tab, opened, asked, inFront: () => front };
}

interface Next {
  readonly id: string;
  readonly tags: string[];
  readonly postsEach: number;
  readonly kept: number;
  readonly target: number;
}
/** HandsFreeOS: what's next to read, and each save answered as kept in full. */
function fakeHfos(next: Next | null, full: number | null = null) {
  const sent: HfosAsk[] = [];
  let total = next?.kept ?? 0;
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    if (ask.type === 'hfos-comment-research-next') return { ok: true, value: { research: next } };
    if (ask.type === 'hfos-comment-research-save') {
      const kept = ask.input.posts.reduce((n, p) => n + p.comments.length, 0);
      const dropped = ask.input.posts.reduce((n, p) => n + (p.dropped ?? 0), 0);
      total += kept;
      return {
        ok: true,
        value: { kept, dropped, total, reading: full === null || total < full },
      };
    }
    throw new Error(`Not asked for here: ${ask.type}`);
  }) as unknown as Hfos;
  return { hfos, sent };
}

function jobWith(tab: JobTab, hfos: Hfos, stopAfter = Infinity) {
  const lines: string[] = [];
  const warned: string[][] = [];
  let asked = 0;
  const job: Job = {
    tab,
    hfos,
    businessId: BUSINESS,
    stopped: () => asked++ >= stopAfter,
    progress: (line) => void lines.push(line),
    warn: async (words) => void warned.push([...words]),
  };
  return { job, lines, warned };
}

const saves = (sent: HfosAsk[]) =>
  sent.flatMap((ask) => (ask.type === 'hfos-comment-research-save' ? [ask.input] : []));

const NEXT: Next = {
  id: RESEARCH,
  tags: ['foodie', 'dogsofinstagram'],
  postsEach: 2,
  kept: 40,
  target: 2_000,
};

const PAGES = {
  [tagPage('foodie')]: tagOf('foodie', [post('AAA'), post('BBB'), post('CCC')]),
  [post('AAA')]: postOf(post('AAA'), 'the.baker', [
    said('the.baker', 'thank you all!'),
    said('jane.doe', 'Looks so good 😍 @sam.lee'),
    said('casey.owner', 'my own comment here'),
    said('promo_page', 'DM me to get featured, link in bio'),
    said('mike_r', 'need this recipe https://example.com/r'),
  ]),
  [post('BBB')]: postOf(post('BBB'), 'cafe.corner', [said('lou', 'yum'), said('pat', 'Yum')]),
  [post('CCC')]: postOf(post('CCC'), 'never.opened', [said('zed', 'not read')]),
  [tagPage('dogsofinstagram')]: tagOf('dogsofinstagram', [post('DDD')]),
  [post('DDD')]: postOf(post('DDD'), 'dog.mom', [said('ana', 'what a good boy')]),
};

describe('the comment research’s reading on Instagram', () => {
  it('does nothing when HandsFreeOS says there’s none to read for', async () => {
    const { tab, opened, asked } = fakeTab({});
    const { hfos, sent } = fakeHfos(null);
    const end = await readCommentsForResearch(jobWith(tab, hfos).job);
    expect(end).toEqual({ line: 'No comment research is running.', warned: false });
    expect(sent).toEqual([
      {
        type: 'hfos-comment-research-next',
        input: { workspaceId: BUSINESS, platform: 'instagram' },
      },
    ]);
    expect(opened).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('reads no more once today’s share is read', async () => {
    const { tab, opened } = fakeTab({});
    const { hfos, sent } = fakeHfos({ ...NEXT, tags: [], kept: 700 });
    const end = await readCommentsForResearch(jobWith(tab, hfos).job);
    expect(end).toEqual({
      line: 'Today’s share of the comment research is read: 700 of about 2,000 comments kept so far. It carries on tomorrow.',
      warned: false,
    });
    expect(opened).toEqual([]);
    expect(saves(sent)).toEqual([]);
  });

  it('reads a batch’s hashtags in turn and sends only the comments’ words', async () => {
    paused.length = 0;
    const { tab, opened, asked, inFront } = fakeTab(PAGES);
    const { hfos, sent } = fakeHfos(NEXT);
    const { job, lines } = jobWith(tab, hfos);
    const end = await readCommentsForResearch(job);

    // Each hashtag's page, then no more of its posts than HandsFreeOS said.
    expect(opened).toEqual([
      tagPage('foodie'),
      post('AAA'),
      post('BBB'),
      tagPage('dogsofinstagram'),
      post('DDD'),
    ]);
    // Its window is in front once a hashtag: Instagram draws a grid only on screen.
    expect(inFront()).toBe(2);
    // Nothing is pressed but View more comments, once a post: the page is only read and scrolled.
    expect(new Set(asked)).toEqual(
      new Set(['hfos-read', 'hfos-scroll-list', 'hfos-more-comments']),
    );
    expect(asked.filter((type) => type === 'hfos-more-comments')).toHaveLength(3);

    expect(saves(sent)).toEqual([
      {
        workspaceId: BUSINESS,
        id: RESEARCH,
        tag: 'foodie',
        posts: [
          // Never the post writer's own, nor the person's; the advert is left out, and counted.
          { comments: ['Looks so good 😍', 'need this recipe'], dropped: 1 },
          // The same words twice under a post are one comment.
          { comments: ['yum'], dropped: 0 },
        ],
      },
      {
        workspaceId: BUSINESS,
        id: RESEARCH,
        tag: 'dogsofinstagram',
        posts: [{ comments: ['what a good boy'], dropped: 0 }],
      },
    ]);
    // Never who wrote a comment, the post, its caption or its address.
    const left = JSON.stringify(saves(sent));
    for (const never of [
      'jane.doe',
      'sam.lee',
      'mike_r',
      'the.baker',
      'dog.mom',
      'casey.owner',
      'instagram.com',
      'example.com',
      'Sunday at the lake',
      '/p/',
    ])
      expect(left).not.toContain(never);

    expect(end).toEqual({
      line: 'Read the comments under 3 posts for the comment research and kept 4 comments’ words: 44 of about 2,000 comments kept so far. The next batch goes later today.',
      warned: false,
      again: true,
    });
    expect(lines).toContain(
      'Comment research: reading the comments under #foodie posts on Instagram… 40 of about 2,000 comments kept so far.',
    );
    expect(lines).toContain(
      'Comment research: reading the comments under #dogsofinstagram posts on Instagram… 43 of about 2,000 comments kept so far.',
    );
    // A person's pace: between the posts, after a press, and between one hashtag and the next.
    expect(paused.length).toBeGreaterThanOrEqual(7);
    expect(paused.filter((ms) => ms >= 20_000 && ms <= 40_000)).toHaveLength(1);
  });

  it('reads a post whose View more comments isn’t there as it stands', async () => {
    const { tab, asked } = fakeTab(PAGES, false);
    const { hfos, sent } = fakeHfos({ ...NEXT, tags: ['dogsofinstagram'] });
    const end = await readCommentsForResearch(jobWith(tab, hfos).job);
    expect(asked.filter((type) => type === 'hfos-read')).toHaveLength(2);
    expect(saves(sent)[0]!.posts).toEqual([{ comments: ['what a good boy'], dropped: 0 }]);
    expect(end.again).toBe(true);
  });

  it('ends once it’s read all it set out to, with no next batch', async () => {
    const { tab, opened } = fakeTab(PAGES);
    const { hfos, sent } = fakeHfos({ ...NEXT, kept: 1_997 }, 2_000);
    const end = await readCommentsForResearch(jobWith(tab, hfos).job);
    // The first hashtag filled it: the second is never opened.
    expect(opened).toEqual([tagPage('foodie'), post('AAA'), post('BBB')]);
    expect(saves(sent)).toHaveLength(1);
    expect(end).toEqual({
      line: 'Read the comments under 2 posts for the comment research and kept 3 comments’ words: 2,000 of about 2,000 comments kept so far. That’s all it set out to read, so the AI sums it up now: see it in Social Outreach → Settings.',
      warned: false,
    });
  });

  it('stops for the day on an Instagram warning, sending nothing from that hashtag', async () => {
    const pages = {
      ...PAGES,
      [post('BBB')]: postOf(post('BBB'), 'cafe.corner', [said('lou', 'yum')], {
        warnings: ['Try again later'],
      }),
    };
    const { tab, opened } = fakeTab(pages);
    const { hfos, sent } = fakeHfos(NEXT);
    const { job, warned } = jobWith(tab, hfos);
    const end = await readCommentsForResearch(job);
    expect(warned).toEqual([['Try again later']]);
    expect(opened).toEqual([tagPage('foodie'), post('AAA'), post('BBB')]);
    expect(saves(sent)).toEqual([]);
    expect(end.warned).toBe(true);
    expect(end.again).toBeUndefined();
    expect(end.line).toContain('Stopped: Instagram says “Try again later”.');
    expect(end.line).toContain('Read the comments under 0 posts for the comment research');
  });

  it('ends when Instagram asks them to sign in', async () => {
    const pages = {
      [tagPage('foodie')]: page(tagPage('foodie'), {}, { signedOut: true }),
    };
    const { tab } = fakeTab(pages);
    const { hfos, sent } = fakeHfos(NEXT);
    const end = await readCommentsForResearch(jobWith(tab, hfos).job);
    expect(end.failed).toBe(true);
    expect(end.line).toContain('Instagram asked you to sign in.');
    expect(saves(sent)).toEqual([]);
  });

  it('stops when the person stops it, saying what it read', async () => {
    const { tab, opened } = fakeTab(PAGES);
    const { hfos } = fakeHfos(NEXT);
    // Stopped before the first hashtag.
    const end = await readCommentsForResearch(jobWith(tab, hfos, 0).job);
    expect(opened).toEqual([]);
    expect(end).toEqual({
      line: 'Stopped. Read the comments under 0 posts for the comment research and kept 0 comments’ words: 40 of about 2,000 comments kept so far.',
      warned: false,
    });
  });
});
