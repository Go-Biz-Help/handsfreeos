/**
 * AI Social Media Content Creator reading the business's own posts' numbers (src/research/own.ts; part 11): about 2
 * and 7 days after a post went up it opens it in each place by its link and says what each showed. Instagram from the
 * post's own answer, Facebook and LinkedIn from the post's own page; a place it can't read says why, and a warning
 * stops it there for the day with nothing said.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnCheck } from '@hfos/core/addons/socialcontent/content-shapes';
import type { ResearchTab } from '../src/research/tab';

const said: { postId: string; read: string; reads: unknown[] }[] = [];
const kept: string[][] = [];

vi.mock('../src/research/hfos', async (actual) => ({
  ...(await actual<object>()),
  ownRead: vi.fn(async (_ws: string, postId: string, read: string, reads: unknown[]) => {
    said.push({ postId, read, reads });
    return {};
  }),
}));
vi.mock('../src/hfos/warned', async (actual) => ({
  ...(await actual<object>()),
  keepWarning: vi.fn(async (words: string[]) => {
    kept.push(words);
    return words;
  }),
}));
vi.mock('../src/research/read', async (actual) => ({
  ...(await actual<object>()),
  pause: async () => undefined,
}));

const { instagramCode, ownFailure, ownPostOf, readOwn } = await import('../src/research/own');

const POST_ID = '7a1d0b6e-6a52-4a8e-9d0c-3e5f3c1b2a90';

interface Page {
  warnings?: string[];
  read?: unknown;
  got?: unknown;
}

/** A reading window over made-up pages, by their links: what each shows, and the pages opened. */
function tabOver(pages: Record<string, Page>) {
  let at = '';
  const opened: string[] = [];
  const asked: string[] = [];
  const tab = {
    open: async (url: string) => {
      at = url;
      opened.push(url);
    },
    hands: async (name: string, ...args: unknown[]) => {
      const page = pages[at];
      if (!page) return null;
      if (name === 'warnings') return page.warnings ?? [];
      if (name === 'read') return page.read ?? null;
      if (name === 'get') {
        asked.push(String(args[0]));
        return page.got ?? null;
      }
      return null;
    },
  };
  return { tab: tab as unknown as ResearchTab, opened, asked };
}

const check = (over: Partial<OwnCheck>): OwnCheck => ({
  id: POST_ID,
  network: 'facebook',
  read: 'd2',
  places: [],
  text: 'Three things every new homeowner should check in the first week',
  ...over,
});

beforeEach(() => {
  said.length = 0;
  kept.length = 0;
});

describe('the code in an Instagram link', () => {
  it('reads posts, reels and links with a name first', () => {
    expect(instagramCode('https://www.instagram.com/p/DAbc123xyz_/')).toBe('DAbc123xyz_');
    expect(instagramCode('https://www.instagram.com/reel/C9zz-Yq1AbC/?igsh=x')).toBe('C9zz-Yq1AbC');
    expect(instagramCode('https://www.instagram.com/someone/p/DAbc123xyz_/')).toBe('DAbc123xyz_');
  });

  it('is none for other pages and other sites', () => {
    expect(instagramCode('https://www.instagram.com/someone/')).toBeNull();
    expect(instagramCode('https://example.com/p/DAbc123xyz_/')).toBeNull();
    expect(instagramCode('not a link')).toBeNull();
  });
});

describe('the post on its own page', () => {
  const post = (text: string, reactions: number) => ({
    author: null,
    url: null,
    when: null,
    text,
    comments: 1,
    reactions,
  });

  it('is the one that starts the way its words do, even cut short', () => {
    const found = ownPostOf(
      [post('Someone else’s post shown first', 5), post('Three things every new homeowner…', 41)],
      'Three things every new homeowner should check in the first week',
    );
    expect(found?.reactions).toBe(41);
  });

  it('is the first when none starts that way, and none when the page shows none', () => {
    expect(ownPostOf([post('Edited words now', 9)], 'The words it went up with')?.reactions).toBe(
      9,
    );
    expect(ownPostOf([], 'Anything')).toBeNull();
  });
});

describe('reading how a post did', () => {
  it('reads an Instagram post from its own answer', async () => {
    const link = 'https://www.instagram.com/reel/C9zz-Yq1AbC/';
    const { tab, asked } = tabOver({
      [link]: {
        got: {
          ok: true,
          status: 200,
          json: {
            items: [
              {
                code: 'C9zz-Yq1AbC',
                taken_at: 1_793_000_000,
                media_type: 2,
                product_type: 'clips',
                play_count: 1240,
                like_count: 86,
                comment_count: 9,
                reshare_count: 4,
                video_duration: 31,
              },
            ],
          },
        },
      },
    });
    await readOwn(
      'ws',
      tab,
      check({ network: 'instagram', read: 'd7', places: [{ place: 'feed', link }] }),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^\/api\/v1\/media\/\d+\/info\/$/);
    expect(said).toEqual([
      {
        postId: POST_ID,
        read: 'd7',
        reads: [{ place: 'feed', views: 1240, likes: 86, comments: 9, shares: 4, failure: null }],
      },
    ]);
  });

  it('reads Facebook profile and Page posts from their own pages, reactions as likes', async () => {
    const profile = 'https://www.facebook.com/someone/posts/pfbid0abc';
    const pageLink = 'https://www.facebook.com/thebusiness/posts/pfbid0def';
    const shown = (reactions: number, comments: number) => ({
      kind: 'post',
      url: '',
      posts: [
        {
          text: 'Three things every new homeowner should check in the first week',
          reactions,
          comments,
        },
      ],
    });
    const { tab, opened } = tabOver({
      [profile]: { read: shown(23, 4) },
      [pageLink]: { read: shown(7, 0) },
    });
    await readOwn(
      'ws',
      tab,
      check({
        places: [
          { place: 'profile', link: profile },
          { place: 'page', link: pageLink },
        ],
      }),
    );
    expect(opened).toEqual([profile, pageLink]);
    expect(said[0]!.reads).toEqual([
      { place: 'profile', views: null, likes: 23, comments: 4, shares: null, failure: null },
      { place: 'page', views: null, likes: 7, comments: 0, shares: null, failure: null },
    ]);
  });

  it('says why when the post isn’t at its link', async () => {
    const link = 'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000000/';
    const { tab } = tabOver({ [link]: { read: { kind: 'other', url: link, posts: [] } } });
    await readOwn('ws', tab, check({ network: 'linkedin', places: [{ place: 'feed', link }] }));
    expect(said[0]!.reads).toEqual([
      {
        place: 'feed',
        views: null,
        likes: null,
        comments: null,
        shares: null,
        failure: ownFailure('linkedin', 'not_shown'),
      },
    ]);
    expect(ownFailure('linkedin', 'not_shown')).toMatch(/LinkedIn didn’t show the post/);
  });

  it('stops at a warning, keeps it for the day and says nothing', async () => {
    const link = 'https://www.facebook.com/someone/posts/pfbid0abc';
    const { tab } = tabOver({ [link]: { warnings: ['You’re temporarily blocked'] } });
    await readOwn('ws', tab, check({ places: [{ place: 'profile', link }] }));
    expect(kept).toEqual([['You’re temporarily blocked']]);
    expect(said).toEqual([]);
  });
});
