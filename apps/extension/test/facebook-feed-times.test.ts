/**
 * A post's address in a group's feed (src/networks/facebook/browse.ts, docs/outreach.md decision 138): since 2026 each
 * post's time link holds only Facebook's tracking ("?__cft__[0]=…") until it's pointed at, when Facebook fills in
 * /groups/<group>/posts/<number>/ (the owner's outline of 31 Oct 2026). On the made-up feed of
 * test/fixtures/group-feed-2026-10.html, its time links emptied the same way.
 */
import { describe, expect, it } from 'vitest';
import { pointAtTimes } from '../src/networks/facebook/browse';
import { readPosts } from '../src/networks/facebook/posts';
import { load } from './load';

const GROUP = 'https://www.facebook.com/groups/austinsmallbiz/';

/** The feed with each post's time link empty till a mouse passes over it, as Facebook draws it now. */
function emptied() {
  const doc = load('group-feed-2026-10.html', GROUP);
  const feed = doc.querySelector('[role="feed"]')!;
  let emptiedLinks = 0;
  for (const link of feed.querySelectorAll<HTMLAnchorElement>('a[href*="/posts/"]')) {
    const real = link.getAttribute('href')!;
    link.setAttribute('role', 'link');
    link.setAttribute('href', '?__cft__[0]=AZW1x&__tn__=%2CO%2CP-R');
    link.addEventListener('mouseover', () => link.setAttribute('href', real));
    emptiedLinks++;
  }
  return { doc, feed, emptiedLinks };
}

describe('each post’s address in a group’s feed (decision 138)', () => {
  it('is filled in once its time is pointed at, so a post without comments is kept', () => {
    const { doc, feed, emptiedLinks } = emptied();
    expect(emptiedLinks).toBeGreaterThan(0);
    const before = readPosts(feed, GROUP).filter((p) => p.url);
    expect(pointAtTimes(doc, GROUP)).toBe(emptiedLinks);
    const after = readPosts(feed, GROUP);
    expect(after.filter((p) => p.url).length).toBeGreaterThan(before.length);
    expect(after.every((p) => p.url?.startsWith(`${GROUP}posts/`))).toBe(true);
  });

  it('points at nothing off a group’s feed', () => {
    const { doc } = emptied();
    expect(pointAtTimes(doc, `${GROUP}members/`)).toBe(0);
  });
});
