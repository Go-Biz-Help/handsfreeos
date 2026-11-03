/**
 * Each post's own link on LinkedIn's post search, where its newer layout shows none
 * (src/networks/linkedin/post-links.ts, docs/outreach.md decision 123), on a page rebuilt from the owner's Check
 * LinkedIn of 29 Oct 2026 with made-up people: a person's post's menu opened and its Copy link to post pressed, the
 * link it copies caught on the page before it reaches the clipboard (src/networks/copies.ts), and a company's post left
 * alone. Nothing is pressed on a page that doesn't catch copies, and a menu with no Copy link to post is noted with the
 * page's outline after two.
 */
import { describe, expect, it, vi } from 'vitest';
import { catchCopiesIn, CATCH, COPIED } from '../src/networks/copies';
import { readPage } from '../src/networks/linkedin/page';
import { postKey, postLinkIn, postLinksOn } from '../src/networks/linkedin/post-links';
import { shortLinkFrom } from '../src/networks/linkedin/urls';
import { postUrlIn, postUrlOfShort } from '../src/jobs/linkedin/short-links';
import { load } from './load';

vi.setConfig({ testTimeout: 20_000 });

const SEARCH =
  'https://www.linkedin.com/search/results/content/?keywords=missed%20calls&sortBy=%22date_posted%22';
/** What LinkedIn copies for each made-up post: its public /posts/ link, with its tracking. */
const COPIES: Record<string, string> = {
  'Nora Vance':
    'https://www.linkedin.com/posts/nora-vance-hvac_missed-calls-activity-7390000000000000101-AbCd?utm_source=share&utm_medium=member_desktop',
  'Eli Brooks':
    'https://www.linkedin.com/posts/eli-brooks-plumbing_follow-ups-activity-7390000000000000102-EfGh?utm_source=share&utm_medium=member_desktop',
  'Maya Ortiz':
    'https://www.linkedin.com/posts/maya-ortiz-cleaning_texts-activity-7390000000000000103-IjKl?utm_source=share&utm_medium=member_desktop',
};

/** The page, its clipboard a stand-in, and its menus drawn as LinkedIn's: Save, Copy link to post (or not), Embed. */
function page({
  copyLink = true,
  catching = true,
  toast = false,
  copies = COPIES,
}: {
  copyLink?: boolean;
  catching?: boolean;
  toast?: boolean;
  copies?: Record<string, string>;
} = {}) {
  const doc = load('linkedin-search-posts-2026-10.html', SEARCH);
  const view = doc.defaultView!;
  const written: string[] = [];
  Object.defineProperty(view.navigator, 'clipboard', {
    value: { writeText: async (text: string) => void written.push(text) },
    configurable: true,
  });
  if (catching) catchCopiesIn(view);
  const opened: string[] = [];
  for (const button of doc.querySelectorAll('button[aria-label^="Open control menu for post by"]'))
    button.addEventListener('click', () => {
      const by = button.getAttribute('aria-label')!.replace('Open control menu for post by ', '');
      opened.push(by);
      const menu = doc.createElement('div');
      menu.setAttribute('role', 'menu');
      for (const words of ['Save', ...(copyLink ? ['Copy link to post'] : []), 'Embed this post']) {
        const item = doc.createElement('div');
        item.setAttribute('role', 'menuitem');
        item.textContent = words;
        item.addEventListener('click', () => {
          if (words === 'Copy link to post' && toast) {
            // A copy that goes past the page, and LinkedIn's toast with the post's link through its redirect.
            const alert = doc.createElement('div');
            alert.setAttribute('role', 'alert');
            const link = doc.createElement('a');
            link.href = `/redir/redirect/?url=${encodeURIComponent(COPIES[by]!)}&urlhash=AbCd&isSdui=true`;
            link.textContent = 'View post';
            alert.append('Link copied to clipboard. ', link);
            doc.body.append(alert);
          } else if (words === 'Copy link to post')
            void view.navigator.clipboard.writeText(copies[by]!);
          menu.remove();
        });
        menu.append(item);
      }
      doc.body.append(menu);
    });
  return { doc, view, written, opened };
}

const keyOf = (doc: Document, name: string) =>
  postKey(
    readPage(doc, SEARCH, new Date(), { sideOf: () => null }).posts!.find(
      (p) => p.author?.name === name,
    )!,
  );

describe('a page catching what it copies', () => {
  it('keeps what it copies while asked, and copies as ever otherwise', async () => {
    const { doc, view, written } = page();
    const root = doc.documentElement;
    expect(root.hasAttribute('data-hfos-copies')).toBe(true);
    root.setAttribute(CATCH, '');
    await view.navigator.clipboard.writeText('https://www.linkedin.com/posts/x-activity-1-a');
    expect(root.getAttribute(COPIED)).toBe('https://www.linkedin.com/posts/x-activity-1-a');
    expect(written).toEqual([]);
    root.removeAttribute(CATCH);
    await view.navigator.clipboard.writeText('the person’s own copy');
    expect(written).toEqual(['the person’s own copy']);
    // Run again (the next screen): nothing changes.
    expect(catchCopiesIn(view)).toBe(true);
    await view.navigator.clipboard.writeText('again');
    expect(written).toEqual(['the person’s own copy', 'again']);
  });
});

describe('each post’s own link on the post search (decision 123)', () => {
  it('reads none on the newer page', () => {
    const { doc } = page();
    const posts = readPage(doc, SEARCH, new Date(), { sideOf: () => null }).posts!;
    expect(posts.map((p) => [p.author?.name, p.url])).toEqual([
      ['Nora Vance', null],
      ['Brightline Roofing', null],
      ['Eli Brooks', null],
      ['Maya Ortiz', null],
    ]);
  });

  it('gets each person’s from its menu’s Copy link to post, never the clipboard, not a company’s', async () => {
    const { doc, written, opened } = page();
    const answer = await postLinksOn(doc, SEARCH, 8);
    expect(answer).toMatchObject({
      ok: true,
      links: [
        {
          key: keyOf(doc, 'Nora Vance'),
          url: 'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000101/',
        },
        {
          key: keyOf(doc, 'Eli Brooks'),
          url: 'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000102/',
        },
        {
          key: keyOf(doc, 'Maya Ortiz'),
          url: 'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000103/',
        },
      ],
      tried: [keyOf(doc, 'Nora Vance'), keyOf(doc, 'Eli Brooks'), keyOf(doc, 'Maya Ortiz')],
      found: { posts: 3, menus: 3, items: 3, copied: 3 },
    });
    expect(answer.ok && answer.outline).toBeFalsy();
    expect(opened).toEqual(['Nora Vance', 'Eli Brooks', 'Maya Ortiz']);
    expect(written).toEqual([]);
    expect(doc.documentElement.hasAttribute(CATCH)).toBe(false);
  });

  it('takes the link from the toast a copy brings up when the copy went past the page (decision 138)', async () => {
    const { doc, written } = page({ toast: true });
    // A toast left from before is never taken for the next post's.
    const old = doc.createElement('div');
    old.setAttribute('role', 'alert');
    old.innerHTML =
      '<a href="https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000999/">View post</a>';
    doc.body.append(old);
    const answer = await postLinksOn(doc, SEARCH, 2);
    expect(answer.ok && answer.links.map((l) => l.url)).toEqual([
      'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000101/',
      'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000102/',
    ]);
    expect(written).toEqual([]);
  });

  it('passes over the posts it has already, and stops at most', async () => {
    const { doc, opened } = page();
    const answer = await postLinksOn(doc, SEARCH, 1, [keyOf(doc, 'Nora Vance')]);
    expect(answer.ok && answer.links.map((l) => l.url)).toEqual([
      'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000102/',
    ]);
    expect(opened).toEqual(['Eli Brooks']);
  });

  it('presses nothing on a page that doesn’t catch copies', async () => {
    const { doc, opened } = page({ catching: false });
    expect(await postLinksOn(doc, SEARCH, 8)).toEqual({
      ok: false,
      error: 'The page can’t catch a copied link, so nothing was pressed.',
    });
    expect(opened).toEqual([]);
  });

  it('stops after two menus with no Copy link to post, with the page’s outline while one was open', async () => {
    const { doc, opened } = page({ copyLink: false });
    const answer = await postLinksOn(doc, SEARCH, 8);
    expect(answer).toMatchObject({
      ok: true,
      links: [],
      tried: [keyOf(doc, 'Nora Vance'), keyOf(doc, 'Eli Brooks')],
      found: { posts: 2, menus: 2, items: 0, copied: 0 },
    });
    expect(opened).toEqual(['Nora Vance', 'Eli Brooks']);
    const outline = answer.ok ? answer.outline : '';
    expect(outline).toContain('/search/results/content/');
    expect(outline).toContain('div role="menu"');
    expect(outline).toContain('div role="menuitem" "Save"');
  });
});

describe('LinkedIn’s short links from Copy link to post (decision 138)', () => {
  const SHORT = 'https://lnkd.in/p/eyaZJXmK';
  /** Where the short link goes: the post's public page, with LinkedIn's tracking. */
  const PUBLIC =
    'https://www.linkedin.com/posts/sam-reed-roofing_new-roof-share-7522062222513266688-0quw/?utm_source=share&utm_medium=member_desktop&rcm=ACoAABDV3f4BIQ';
  const POST = 'https://www.linkedin.com/feed/update/urn:li:share:7522062222513266688/';

  it('takes a short link copied, or the one in the toast’s View post through /safety/go/', () => {
    expect(shortLinkFrom(SHORT)).toBe(SHORT);
    expect(shortLinkFrom(`${SHORT}?trk=x`)).toBe(SHORT);
    expect(shortLinkFrom('https://lnkd.in/')).toBeNull();
    expect(shortLinkFrom('http://lnkd.in/p/eyaZJXmK')).toBeNull();
    expect(shortLinkFrom('https://lnkd.in.example.com/p/eyaZJXmK')).toBeNull();
    expect(postLinkIn(SHORT, SEARCH)).toBe(SHORT);
    expect(
      postLinkIn(
        `https://www.linkedin.com/safety/go/?url=${encodeURIComponent(SHORT)}&trk=toast`,
        SEARCH,
      ),
    ).toBe(SHORT);
    expect(postLinkIn('https://example.com/p/eyaZJXmK', SEARCH)).toBeNull();
  });

  it('follows one to its post, without the person’s cookies, past a sign-in wall too', async () => {
    expect(postUrlIn(PUBLIC)).toBe(POST);
    expect(
      postUrlIn(
        `https://www.linkedin.com/authwall?trk=bf&sessionRedirect=${encodeURIComponent(PUBLIC)}`,
      ),
    ).toBe(POST);
    expect(postUrlIn('https://www.linkedin.com/feed/')).toBeNull();
    const get = vi.fn(async () => ({ url: PUBLIC }) as Response);
    expect(await postUrlOfShort(SHORT, get as unknown as typeof fetch)).toBe(POST);
    expect(get).toHaveBeenCalledWith(
      SHORT,
      expect.objectContaining({ method: 'HEAD', credentials: 'omit', redirect: 'follow' }),
    );
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await postUrlOfShort(SHORT, down as unknown as typeof fetch)).toBeNull();
  });

  it('keeps a short link copied on the page, for the job to follow', async () => {
    const { doc, written } = page({ copies: { 'Nora Vance': SHORT } });
    const answer = await postLinksOn(doc, SEARCH, 1);
    expect(answer.ok && answer.links.map((l) => l.url)).toEqual([SHORT]);
    expect(written).toEqual([]);
  });
});
