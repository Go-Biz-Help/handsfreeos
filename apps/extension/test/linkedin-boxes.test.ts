/**
 * LinkedIn's pages, as ./boxes.test.ts does Facebook's: a page outline leaves out the bare boxes LinkedIn wraps
 * around everything, so the test pages written by hand have fewer of them than LinkedIn's. The readers must read a
 * page the same however many there are: these read every LinkedIn test page as written and again with a bare box
 * around each element, and expect the same.
 */
import { describe, expect, it } from 'vitest';
import { readPage } from '../src/linkedin/page';
import { boxEverything, load } from './load';

const NOW = new Date('2026-10-15T12:00:00Z');

const PAGES: readonly (readonly [fixture: string, url: string])[] = [
  ['linkedin-profile.html', 'https://www.linkedin.com/in/dana-reyes-4b2a1c/'],
  ['linkedin-profile-follow.html', 'https://www.linkedin.com/in/sam-lee-77/'],
  ['linkedin-own-profile.html', 'https://www.linkedin.com/in/me/'],
  ['linkedin-connections.html', 'https://www.linkedin.com/mynetwork/invite-connect/connections/'],
  ['linkedin-invitations.html', 'https://www.linkedin.com/mynetwork/invitation-manager/received/'],
  ['linkedin-invitations-sent.html', 'https://www.linkedin.com/mynetwork/invitation-manager/sent/'],
  [
    'linkedin-search-people.html',
    'https://www.linkedin.com/search/results/people/?keywords=plumber',
  ],
  ['linkedin-feed.html', 'https://www.linkedin.com/feed/'],
  [
    'linkedin-search-posts.html',
    'https://www.linkedin.com/search/results/content/?keywords=recommend%20a%20plumber&sortBy=%22date_posted%22',
  ],
  [
    'linkedin-post.html',
    'https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000101/',
  ],
  ['linkedin-chat.html', 'https://www.linkedin.com/messaging/thread/2-MadeUpThreadDana0001==/'],
  ['linkedin-chat.html', 'https://www.linkedin.com/messaging/'],
  ['linkedin-notifications.html', 'https://www.linkedin.com/notifications/'],
  ['linkedin-group.html', 'https://www.linkedin.com/groups/9876543/'],
  ['linkedin-warning.html', 'https://www.linkedin.com/feed/'],
  ['linkedin-checkpoint.html', 'https://www.linkedin.com/checkpoint/challenge/AgMadeUp'],
  ['linkedin-restricted.html', 'https://www.linkedin.com/feed/'],
  [
    'linkedin-search-limit.html',
    'https://www.linkedin.com/search/results/people/?keywords=plumber',
  ],
  ['linkedin-loading.html', 'https://www.linkedin.com/search/results/people/?keywords=roofing'],
];

describe('LinkedIn pages with more boxes than their outline shows', () => {
  // A chat's side is measured on screen; jsdom draws nothing, so it says none either way.
  const options = { sideOf: () => null };
  it.each(PAGES)('reads %s the same with a bare box around every element', (fixture, url) => {
    const asWritten = readPage(load(fixture, url), url, NOW, options);
    expect(readPage(boxEverything(load(fixture, url)), url, NOW, options)).toEqual(asWritten);
  });
});
