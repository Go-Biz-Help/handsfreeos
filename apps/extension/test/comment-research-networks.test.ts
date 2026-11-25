/**
 * The comment research on every network but Instagram (docs/outreach.md, decision 172): each network's reader
 * (src/jobs/facebook-research.ts, src/jobs/linkedin/comment-research.ts, src/jobs/alignable/comment-research.ts and
 * src/jobs/follows/comment-research.ts) through the shared day (src/jobs/comment-research.ts), with the network and
 * HandsFreeOS stood in for: each search's busiest posts with comments opened in turn; only the comments' words sent,
 * never the post writer's nor the person's; Facebook's and LinkedIn's box of who reacted never opened; a post read
 * before for the research passed over in a later batch; and a warning stopping the day. On made-up people and posts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HfosAsk } from '../src/hfos/messages';
import type { Hfos, Job, JobTab } from '../src/jobs/job';

// A person's pace is seconds; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { readFacebookComments } = await import('../src/jobs/facebook-research');
const { topPostSearchUrl, readLinkedInComments } =
  await import('../src/jobs/linkedin/comment-research');
const { readAlignableComments } = await import('../src/jobs/alignable/comment-research');
const { readFollowComments } = await import('../src/jobs/follows/comment-research');
const { forgetSeenPosts, lookForResearch, NO_RESEARCH, postKey, researchNext, researchRuns } =
  await import('../src/jobs/comment-research');
const { freshState } = await import('../src/auto/plan');
const { facebookPostSearch } = await import('../src/jobs/partner-search');
const { FOLLOW_SPECS } = await import('../src/networks/follows/specs');
const { MINE } = await import('../src/jobs/alignable/read');
beforeEach(forgetSeenPosts);

const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const RESEARCH = '2a3b4c5d-6e7f-4081-9a2b-3c4d5e6f7a8b';

type Page = Record<string, unknown>;
interface Engaged {
  readonly name: string;
  readonly profile: { readonly id: string | null; readonly username: string | null; url: string };
  readonly comment: string | null;
}

/** The job's window: each address shows its page; a post's comments come from `engaged`; every ask is kept. */
function fakeTab(pages: Record<string, Page>, engaged: Record<string, Engaged[]> = {}) {
  const opened: string[] = [];
  const asked: { readonly type: string; readonly reactions?: boolean }[] = [];
  const tab = {
    async open(url: string) {
      opened.push(url);
    },
    async ask(message: { readonly type: string; readonly reactions?: boolean }) {
      asked.push(message);
      const at = opened.at(-1)!;
      if (message.type === 'hfos-read') {
        const shown = pages[at];
        return shown ? { ok: true, result: shown } : { ok: false, error: 'Nothing there.' };
      }
      if (message.type === 'hfos-point-times') return { ok: true };
      if (message.type === 'hfos-engaged')
        return engaged[at]
          ? { ok: true, comments: engaged[at], reactions: [] }
          : { ok: false, error: 'Not a post.' };
      // Nothing more to scroll to.
      return { ok: false };
    },
  } as unknown as JobTab;
  return { tab, opened, asked };
}

interface Next {
  readonly id: string;
  readonly tags: string[];
  readonly postsEach: number;
  readonly kept: number;
  readonly target: number;
}
function fakeHfos(next: Next, groups: Record<string, unknown[]> = {}) {
  const sent: HfosAsk[] = [];
  let total = next.kept;
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    if (ask.type === 'hfos-comment-research-next') return { ok: true, value: { research: next } };
    if (ask.type === 'hfos-comment-research-save') {
      const kept = ask.input.posts.reduce((n, p) => n + p.comments.length, 0);
      total += kept;
      return { ok: true, value: { kept, dropped: 0, total, reading: true } };
    }
    if (ask.type === 'hfos-groups')
      return { ok: true, value: { groups: groups[ask.input.view as string] ?? [] } };
    throw new Error(`Not asked for here: ${ask.type}`);
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
    progress: () => undefined,
    warn: async (words) => void warned.push([...words]),
  };
  return { job, warned };
}

const saves = (sent: HfosAsk[]) =>
  sent.flatMap((ask) => (ask.type === 'hfos-comment-research-save' ? [ask.input] : []));

// ------------------------------------------------------------------------------------------------ Facebook

const FB = 'https://www.facebook.com';
const fbWho = (username: string) => ({ id: null, username, url: `${FB}/${username}` });
const fbPage = (url: string, more: Page = {}): Page => ({
  kind: 'search',
  url,
  readAt: '2026-11-16T12:00:00.000Z',
  warnings: [],
  notes: [],
  ...more,
});
const fbPost = (url: string, author: string, comments: number | null) => ({
  author: { name: author, profile: fbWho(author) },
  url,
  when: '2h',
  text: 'Taco night at our place',
  comments,
  reactions: 4,
});

describe('the comment research on Facebook', () => {
  const A = `${FB}/sam.cook/posts/pfbid0aaa/`;
  const B = `${FB}/jo.lane/posts/pfbid0bbb/`;
  const NONE = `${FB}/kit.k/posts/pfbid0ccc/`;
  const C = `${FB}/max.m/posts/pfbid0ddd/`;
  const next: Next = { id: RESEARCH, tags: ['dinner'], postsEach: 2, kept: 0, target: 2_000 };
  const pages = (): Record<string, Page> => ({
    [facebookPostSearch('dinner')]: fbPage(facebookPostSearch('dinner'), {
      posts: [
        fbPost(NONE, 'kit.k', 0),
        fbPost(A, 'sam.cook', 12),
        fbPost(B, 'jo.lane', null),
        fbPost(C, 'max.m', 3),
      ],
    }),
    [A]: fbPage(A, { kind: 'post', posts: [fbPost(A, 'sam.cook', 12)] }),
    [B]: fbPage(B, { kind: 'post', posts: [fbPost(B, 'jo.lane', null)] }),
    [C]: fbPage(C, { kind: 'post', posts: [fbPost(C, 'max.m', 3)] }),
  });
  const engaged = {
    [A]: [
      { name: 'Sam Cook', profile: fbWho('sam.cook'), comment: 'thanks everyone!' },
      { name: 'Lee Park', profile: fbWho('lee.park'), comment: 'Looks amazing 🌮' },
      { name: 'Ana Ruiz', profile: fbWho('ana.ruiz'), comment: null },
    ],
    [B]: [{ name: 'Ty Vo', profile: fbWho('ty.vo'), comment: 'what time is dinner lol' }],
    [C]: [{ name: 'Bo Li', profile: fbWho('bo.li'), comment: 'yum' }],
  };

  it('searches the words, opens the posts with comments, and reads only the comments', async () => {
    const { tab, opened, asked } = fakeTab(pages(), engaged);
    const { hfos, sent } = fakeHfos(next);
    const end = await readFacebookComments(jobWith(tab, hfos).job);
    // A post showing no comments is passed over; one showing no count may have some.
    expect(opened).toEqual([facebookPostSearch('dinner'), A, B]);
    // The comments as the page shows them: the box of who reacted is never opened.
    for (const ask of asked.filter((a) => a.type === 'hfos-engaged'))
      expect(ask.reactions).toBe(false);
    expect(saves(sent)).toEqual([
      {
        workspaceId: BUSINESS,
        id: RESEARCH,
        tag: 'dinner',
        // Never the post writer's own comment; one with no words is no comment.
        posts: [
          { comments: ['Looks amazing 🌮'], dropped: 0 },
          { comments: ['what time is dinner lol'], dropped: 0 },
        ],
      },
    ]);
    expect(end.again).toBe(true);
  });

  it('passes over the posts read before for the same research, in the next batch', async () => {
    const first = fakeTab(pages(), engaged);
    await readFacebookComments(jobWith(first.tab, fakeHfos(next).hfos).job);
    const second = fakeTab(pages(), engaged);
    const { hfos, sent } = fakeHfos(next);
    await readFacebookComments(jobWith(second.tab, hfos).job);
    expect(second.opened).toEqual([facebookPostSearch('dinner'), C]);
    expect(saves(sent)[0]!.posts).toEqual([{ comments: ['yum'], dropped: 0 }]);
  });

  it('stops for the day on a Facebook warning', async () => {
    const warnedPages = {
      ...pages(),
      [A]: fbPage(A, { kind: 'post', warnings: ['You’re temporarily blocked'] }),
    };
    const { tab, opened } = fakeTab(warnedPages, engaged);
    const { hfos, sent } = fakeHfos(next);
    const { job, warned } = jobWith(tab, hfos);
    const end = await readFacebookComments(job);
    expect(warned).toEqual([['You’re temporarily blocked']]);
    expect(opened).toEqual([facebookPostSearch('dinner'), A]);
    expect(saves(sent)).toEqual([]);
    expect(end.warned).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ LinkedIn

const LI = 'https://www.linkedin.com';
const liWho = (username: string) => ({ id: null, username, url: `${LI}/in/${username}/` });
const liPage = (url: string, kind: string, posts: unknown[], more: Page = {}): Page => ({
  platform: 'linkedin',
  kind,
  url,
  readAt: '2026-11-16T12:00:00.000Z',
  posts,
  warnings: [],
  notes: [],
  ...more,
});
const liPost = (id: string, author: string, comments: number | null) => ({
  author: { name: author, profile: liWho(author) },
  url: `${LI}/feed/update/urn:li:activity:${id}/`,
  text: 'Excited to share I’ve started a new role',
  comments,
});

describe('the comment research on LinkedIn', () => {
  const A = liPost('7390000000000000001', 'dana-reyes', 30);
  const B = liPost('7390000000000000002', 'sam-lee', 0);
  const next: Next = { id: RESEARCH, tags: ['new job'], postsEach: 3, kept: 0, target: 2_000 };

  it('searches work words as LinkedIn ranks them and reads each post’s comments, never its writer’s', async () => {
    const search = topPostSearchUrl('new job');
    const { tab, opened, asked } = fakeTab(
      {
        [search]: liPage(search, 'search-posts', [A, B]),
        [A.url]: liPage(A.url, 'post', [A]),
      },
      {
        [A.url]: [
          { name: 'Dana Reyes', profile: liWho('dana-reyes'), comment: 'Thank you all so much!' },
          { name: 'Pat Kim', profile: liWho('pat-kim'), comment: 'Congrats Dana, well deserved!' },
        ],
      },
    );
    const { hfos, sent } = fakeHfos(next);
    await readLinkedInComments(jobWith(tab, hfos).job);
    expect(search).toBe(`${LI}/search/results/content/?keywords=new%20job`);
    expect(opened).toEqual([search, A.url]);
    expect(asked.find((a) => a.type === 'hfos-engaged')?.reactions).toBe(false);
    expect(saves(sent)[0]).toEqual({
      workspaceId: BUSINESS,
      id: RESEARCH,
      tag: 'new job',
      posts: [{ comments: ['Congrats Dana, well deserved!'], dropped: 0 }],
    });
  });
});

// ------------------------------------------------------------------------------------------------ Threads and X

describe('the comment research on Threads and X', () => {
  const X = 'https://x.com';
  const xPage = (url: string, found: Page, more: Page = {}): Page => ({
    platform: 'x',
    kind: 'page',
    url,
    readAt: '2026-11-16T12:00:00.000Z',
    people: [],
    posts: [],
    places: [],
    links: [],
    own: `${X}/casey_owner`,
    edits: [],
    warnings: [],
    signedOut: false,
    boxes: 0,
    notes: [],
    found,
    ...more,
  });
  const tweet = (user: string, id: string, replies: number | null) => ({
    url: `${X}/${user}/status/${id}`,
    author: { username: user, name: user },
    text: 'Road trip day 3',
    replies,
  });
  const next: Next = { id: RESEARCH, tags: ['road trip'], postsEach: 3, kept: 0, target: 2_000 };

  it('searches the busiest posts, passes over the person’s own, and keeps only others’ replies', async () => {
    const search = FOLLOW_SPECS.x.pages.topSearch('road trip');
    const mine = tweet('casey_owner', '1', 40);
    const a = tweet('ana_r', '2', 9);
    const quiet = tweet('bo_l', '3', 0);
    const { tab, opened } = fakeTab({
      [search]: xPage(search, { posts: [mine, a, quiet], me: 'casey_owner' }),
      [a.url]: xPage(a.url, {
        post: a,
        me: 'casey_owner',
        replies: [
          { author: { username: 'ana_r' }, text: 'day 4 tomorrow!' },
          { author: { username: 'casey_owner' }, text: 'safe travels' },
          { author: { username: 'tim_w' }, text: 'where are you headed??' },
        ],
      }),
    });
    const { hfos, sent } = fakeHfos(next);
    await readFollowComments(jobWith(tab, hfos).job, 'x');
    expect(search).toContain('road%20trip');
    expect(opened).toEqual([search, a.url]);
    expect(saves(sent)[0]!.posts).toEqual([{ comments: ['where are you headed??'], dropped: 0 }]);
    expect(JSON.stringify(saves(sent))).not.toContain('x.com');
  });
});

// ------------------------------------------------------------------------------------------------ Alignable

describe('the comment research on Alignable', () => {
  const AL = 'https://www.alignable.com';
  const alPage = (url: string, found: Page, more: Page = {}): Page => ({
    platform: 'alignable',
    kind: 'page',
    url,
    readAt: '2026-11-16T12:00:00.000Z',
    people: [],
    posts: [],
    places: [],
    links: [],
    own: `${AL}/austin-tx/acme-plumbing`,
    edits: [],
    warnings: [],
    signedOut: false,
    boxes: 0,
    notes: [],
    found,
    ...more,
  });
  const biz = (path: string) => ({ name: path, profile: { url: `${AL}/austin-tx/${path}` } });
  const thread = (id: string, by: string) => ({
    url: `${AL}/biz/discussions/${id}`,
    author: biz(by),
    text: 'Who do you use for bookkeeping?',
  });
  const TOWN = `${AL}/austin-tx`;
  const next: Next = { id: RESEARCH, tags: ['town'], postsEach: 3, kept: 0, target: 2_000 };

  it('reads the posts in the person’s town, never their own post or answer, nor the writer’s', async () => {
    const own = thread('101', 'acme-plumbing');
    const other = thread('102', 'lone-star-bakery');
    const { tab, opened } = fakeTab({
      [MINE]: alPage(`${AL}/austin-tx/acme-plumbing`, {}),
      [TOWN]: alPage(TOWN, { threads: [own, other] }),
      [other.url]: alPage(other.url, {
        threads: [other],
        answers: [
          { author: biz('lone-star-bakery'), text: 'Thanks for the ideas!' },
          { author: biz('acme-plumbing'), text: 'We use a local CPA' },
          { author: biz('hill-country-cpa'), text: 'Happy to help, send me a message' },
          { author: biz('river-yoga'), text: 'We love Wave, it’s free' },
        ],
      }),
    });
    const { hfos, sent } = fakeHfos(next);
    await readAlignableComments(jobWith(tab, hfos).job);
    expect(opened).toEqual([MINE, TOWN, other.url]);
    const kept = saves(sent)[0]!.posts[0]!.comments;
    expect(kept).toContain('We love Wave, it’s free');
    expect(kept).not.toContain('Thanks for the ideas!');
    expect(kept).not.toContain('We use a local CPA');
  });

  it('reads the groups the person’s in, not their town’s own, with their profile opened once a batch', async () => {
    const group = (slug: string) => ({
      groupId: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
      name: slug,
      url: `${AL}/groups/${slug}`,
      joined: true,
      people: 0,
      adminsRead: false,
      replies: 0,
      demos: 0,
    });
    const post = thread('201', 'river-yoga');
    const GROUP = `${AL}/groups/austin-small-biz`;
    const { tab, opened } = fakeTab({
      [MINE]: alPage(`${AL}/austin-tx/acme-plumbing`, {}),
      [TOWN]: alPage(TOWN, { threads: [] }),
      [GROUP]: alPage(GROUP, { threads: [post] }),
      [post.url]: alPage(post.url, {
        threads: [post],
        answers: [{ author: biz('hill-country-cpa'), text: 'Following this one' }],
      }),
    });
    const { hfos, sent } = fakeHfos(
      { ...next, tags: ['town', 'groups'] },
      { work: [group('austin-tx'), group('austin-small-biz')] },
    );
    await readAlignableComments(jobWith(tab, hfos).job);
    expect(opened.filter((url) => url === MINE)).toHaveLength(1);
    expect(opened).toContain(GROUP);
    expect(opened).not.toContain(`${AL}/groups/austin-tx`);
    expect(saves(sent).find((s) => s.tag === 'groups')?.posts).toEqual([
      { comments: ['Following this one'], dropped: 0 },
    ]);
  });
});

describe('which posts were read', () => {
  it('is kept as short numbers, the same for an address however it was written', () => {
    const key = postKey('https://www.facebook.com/sam.cook/posts/pfbid0aaa/');
    expect(key).toMatch(/^[0-9a-z]{1,8}$/);
    expect(postKey('https://www.facebook.com/Sam.Cook/posts/pfbid0aaa?ref=search')).toBe(key);
    expect(postKey('https://www.facebook.com/jo.lane/posts/pfbid0bbb/')).not.toBe(key);
  });
});

describe('whether a runner reads for the research at all', () => {
  it('is yes only when HandsFreeOS says this person started one on that network', async () => {
    const asked: unknown[] = [];
    const says = (answer: unknown) =>
      (async (ask: unknown) => {
        asked.push(ask);
        if (answer instanceof Error) throw answer;
        return answer;
      }) as unknown as Hfos;
    const research = { id: RESEARCH, tags: ['dinner'], postsEach: 5, kept: 0, target: 2_000 };
    expect(await researchRuns(says({ ok: true, value: { research } }), BUSINESS, 'facebook')).toBe(
      true,
    );
    expect(asked[0]).toEqual({
      type: 'hfos-comment-research-next',
      input: { workspaceId: BUSINESS, platform: 'facebook' },
    });
    // None, a refusal, or a HandsFreeOS that doesn't answer: no, and nothing is shown.
    expect(await researchRuns(says({ ok: true, value: { research: null } }), BUSINESS, 'x')).toBe(
      false,
    );
    expect(
      await researchRuns(says({ ok: false, problem: { message: 'No.' } }), BUSINESS, 'linkedin'),
    ).toBe(false);
    expect(await researchRuns(says(new Error('offline')), BUSINESS, 'alignable')).toBe(false);
  });
});

describe('the research’s turn (decision 194)', () => {
  const HOUR = 60 * 60_000;
  const now = Date.UTC(2026, 10, 25, 9);
  const running = (async () => ({
    ok: true,
    value: { research: { id: RESEARCH, tags: ['dinner'], postsEach: 5, kept: 0, target: 2_000 } },
  })) as unknown as Hfos;
  const none = (async () => ({ ok: true, value: { research: null } })) as unknown as Hfos;

  it('reads whenever its batch is due and one this person started runs; for anyone else, none is kept once', async () => {
    const changes: unknown[] = [];
    const setState = async (change: object) => {
      changes.push(change);
      return { ...freshState('2026-11-25'), ...change } as never;
    };
    const ask = { businessId: BUSINESS, platform: 'facebook', now, setState } as const;
    const fresh = freshState('2026-11-25');
    expect(await researchNext({ ...ask, hfos: running, state: fresh })).toEqual({
      reads: true,
      state: fresh,
    });
    // Its next batch still to come, put off till they're away, or done today: not now, and nothing is asked.
    const waiting = { ...fresh, againAt: { comment_research: now + HOUR } };
    expect((await researchNext({ ...ask, hfos: running, state: waiting })).reads).toBe(false);
    const putOff = ['comment_research'];
    expect(
      (await researchNext({ ...ask, hfos: running, state: fresh, passOver: putOff })).reads,
    ).toBe(false);
    expect(changes).toEqual([]);
    const gone = await researchNext({ ...ask, hfos: none, state: fresh });
    expect(gone.reads).toBe(false);
    expect(gone.state.daily?.comment_research).toBe(NO_RESEARCH);
    expect(changes).toEqual([{ daily: { comment_research: NO_RESEARCH } }]);
  });

  it('looks again outside the hours for its next batch, or in an hour once today’s share is read', () => {
    const look = now + 10 * HOUR;
    expect(
      lookForResearch(look, { daily: {}, againAt: { comment_research: now + HOUR } }, now),
    ).toBe(now + HOUR);
    expect(lookForResearch(look, { daily: { comment_research: 'Read.' } }, now)).toBe(now + HOUR);
    expect(lookForResearch(null, { daily: { comment_research: 'Read.' } }, now)).toBe(now + HOUR);
    expect(lookForResearch(look, { daily: {} }, now, ['comment_research'])).toBe(now + 10 * 60_000);
    // Nobody's research, or one not asked about: as it was.
    expect(lookForResearch(look, { daily: { comment_research: NO_RESEARCH } }, now)).toBe(look);
    expect(lookForResearch(null, { daily: {} }, now)).toBeNull();
    expect(lookForResearch(now + 5 * 60_000, { daily: { comment_research: 'Read.' } }, now)).toBe(
      now + 5 * 60_000,
    );
  });
});
