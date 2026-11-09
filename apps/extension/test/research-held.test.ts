/**
 * What Instagram's search page holds whether or not it's drawn (src/research/held.ts; docs/socialcontent.md,
 * "Finding creators"): the accounts in the data it came with, never the person's own; the posts it links; and the
 * answers it loaded from its own site. Made-up accounts on a page written here by hand.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { HELD_MOST, heldOn } from '../src/research/held';

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
