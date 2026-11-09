/**
 * What Instagram's search page holds whether or not it's drawn (src/research/held.ts; docs/socialcontent.md,
 * "Finding creators"): the accounts in the data it came with, never the person's own; the posts it links; and the
 * answers it loaded from its own site. Made-up accounts on a page written here by hand.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { HELD_MOST, heldOn, profileHeldOn } from '../src/research/held';
import { descriptionFacts } from '../src/research/instagram';

const IG = 'https://www.instagram.com';
const HREF = `${IG}/explore/search/keyword/?q=crm`;

const pageWith = (body: string) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: HREF }).window.document;

const data = (json: unknown) =>
  `<script type="application/json">${JSON.stringify(json).replace(/</g, '\\u003c')}</script>`;

describe('what the search page holds', () => {
  it('takes the accounts in its own data, never the person’s own, each once', () => {
    const doc = pageWith(
      `<nav><a href="/my.own.account/">Profile</a></nav>` +
        data({
          require: [
            [
              'ScheduledServerJS',
              {
                result: {
                  data: {
                    viewer: { user: { username: 'my.own.account' } },
                    medias: [
                      { media: { code: 'X1', user: { username: 'CRM.Coach', is_private: false } } },
                      { media: { code: 'X2', owner: { username: 'crm.coach' } } },
                      { media: { code: 'X3', user: { username: 'locked.one', is_private: true } } },
                    ],
                  },
                },
              },
            ],
          ],
        }) +
        `<script type="application/json">not json "username"</script>`,
    );
    expect(heldOn(doc, HREF, []).accounts).toEqual([
      { username: 'crm.coach', private: false },
      { username: 'locked.one', private: true },
    ]);
  });

  it('lists the posts it links by their codes, and only its own site’s', () => {
    const doc = pageWith(
      `<main>
        <a href="/p/C0DE1/">a post</a>
        <a href="/reel/R33L2/?utm=1">a reel</a>
        <a href="/someone/p/C0DE3/">a named post</a>
        <a href="/p/C0DE1/">the same post</a>
        <a href="https://example.com/p/ELSEWHERE/">elsewhere</a>
        <a href="/explore/">explore</a>
      </main>`,
    );
    expect(heldOn(doc, HREF, []).posts).toEqual(['C0DE1', 'R33L2', 'C0DE3']);
  });

  it('lists the answers it loaded from its own site, as asked for, newest last', () => {
    const doc = pageWith('');
    const loaded = heldOn(doc, HREF, [
      { name: `${IG}/api/v1/fbsearch/web/top_serp/?query=crm` },
      { name: `${IG}/static/app.js` },
      { name: `${IG}/api/graphql` },
      { name: 'https://scontent.cdninstagram.com/v/photo.jpg' },
      { name: `${IG}/api/v1/fbsearch/web/top_serp/?query=crm` },
      { name: 'not a link' },
    ]).loaded;
    expect(loaded).toEqual(['/api/v1/fbsearch/web/top_serp/?query=crm', '/api/graphql']);
    const many = Array.from({ length: HELD_MOST.loaded + 5 }, (_, i) => ({
      name: `${IG}/api/v1/thing/${i}/`,
    }));
    const kept = heldOn(doc, HREF, many).loaded;
    expect(kept).toHaveLength(HELD_MOST.loaded);
    expect(kept.at(-1)).toBe(`/api/v1/thing/${HELD_MOST.loaded + 4}/`);
  });
});

describe('what a profile page holds', () => {
  const NOW = Math.round(Date.UTC(2026, 10, 8, 12) / 1000);
  /** Deeper than an answer is looked through, as a page's data nests. */
  const nested = (inner: unknown, levels: number): unknown =>
    levels ? { require: [['ScheduledServerJS', { __bbox: nested(inner, levels - 1) }]] } : inner;

  it('reads its description: followers, posts and name', () => {
    expect(
      descriptionFacts(
        '12.5K Followers, 300 Following, 1,234 Posts - See Instagram photos and videos from Jane Doe (@jane.doe)',
      ),
    ).toEqual({ followers: 12_500, posts: 1_234, name: 'Jane Doe' });
    expect(descriptionFacts('2M Followers, 1 Following, 87 Posts')).toMatchObject({
      followers: 2_000_000,
      posts: 87,
    });
    expect(descriptionFacts(null)).toEqual({ followers: null, posts: null, name: null });
  });

  it('finds them and their posts deep in the data the page came with', () => {
    const doc = pageWith(
      `<meta name="description" content="9,100 Followers, 10 Following, 40 Posts - See Instagram photos and videos from Crm Coach (@crm.coach)">` +
        data(
          nested(
            {
              user: {
                pk: '777',
                username: 'crm.coach',
                full_name: 'CRM Coach',
                biography: 'Sales systems',
                follower_count: 9_123,
                is_private: false,
              },
              edges: [
                {
                  node: {
                    code: 'NEWER01',
                    taken_at: NOW - 2 * 86_400,
                    media_type: 1,
                    like_count: 50,
                    user: { username: 'crm.coach' },
                  },
                },
                {
                  node: {
                    code: 'PINNED1',
                    taken_at: NOW - 1 * 86_400,
                    media_type: 1,
                    timeline_pinned_user_ids: [1],
                    user: { username: 'crm.coach' },
                  },
                },
                {
                  node: {
                    code: 'OTHER01',
                    taken_at: NOW,
                    media_type: 1,
                    user: { username: 'someone.else' },
                  },
                },
              ],
            },
            9,
          ),
        ),
    );
    const held = profileHeldOn(doc, 'crm.coach');
    expect(held.creator).toEqual({
      id: '777',
      username: 'crm.coach',
      name: 'CRM Coach',
      bio: 'Sales systems',
      followers: 9_123,
      private: false,
      lastPostAt: new Date((NOW - 2 * 86_400) * 1000).toISOString(),
      posts: 40,
    });
    expect(held.posts.map((p) => p.postKey)).toEqual(['PINNED1', 'NEWER01']);
  });

  it('falls back to its description when its data doesn’t hold them, and to nothing at all', () => {
    const doc = pageWith(
      `<meta property="og:description" content="15K Followers, 2 Following, 300 Posts - See Instagram photos and videos from Big One (@big.one)">`,
    );
    expect(profileHeldOn(doc, 'big.one').creator).toEqual({
      id: null,
      username: 'big.one',
      name: 'Big One',
      bio: null,
      followers: 15_000,
      private: false,
      lastPostAt: null,
      posts: 300,
    });
    expect(profileHeldOn(pageWith(''), 'nobody.here')).toEqual({ creator: null, posts: [] });
  });
});
