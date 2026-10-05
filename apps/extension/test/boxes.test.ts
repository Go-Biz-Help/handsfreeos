/**
 * A page outline leaves out the bare boxes Facebook wraps around everything (a box with no role, label or words of its
 * own, and one thing in it), so the test pages written from outlines have fewer of them than Facebook's. The readers
 * must read a page the same however many there are: these read every test page as written and again with a bare box
 * around each element, and expect the same.
 */
import { describe, expect, it } from 'vitest';
import { readPage } from '../src/facebook/page';
import { load } from './load';

const NOW = new Date('2026-10-05T12:00:00Z');

const PAGES: readonly (readonly [fixture: string, url: string])[] = [
  ['group-members.html', 'https://www.facebook.com/groups/austinsmallbiz/members'],
  ['group-members-2026.html', 'https://www.facebook.com/groups/4455667788/members'],
  ['profile.html', 'https://www.facebook.com/jane.doe.5'],
  ['profile-2026.html', 'https://www.facebook.com/dana.reyes.12'],
  ['feed-2026.html', 'https://www.facebook.com/'],
  ['group-feed.html', 'https://www.facebook.com/groups/texascontractors/'],
  ['chat.html', 'https://www.facebook.com/messages/t/1234567890/'],
  ['chat-2026.html', 'https://www.facebook.com/messages/t/100009000000002/'],
  ['notifications.html', 'https://www.facebook.com/notifications'],
  ['friends-list.html', 'https://www.facebook.com/friends/list'],
  ['groups-joined.html', 'https://www.facebook.com/groups/joins/'],
  ['warning.html', 'https://www.facebook.com/groups/texascontractors/'],
];

/** Pieces of a line of text get a `span` around them, not a `div`, so no line breaks where the page's doesn't. */
const IN_A_LINE = new Set('A ABBR B EM I IMG LABEL SMALL SPAN STRONG svg'.split(' '));

function boxEverything(doc: Document): Document {
  for (const element of [...doc.body.querySelectorAll('*')]) {
    if (element.parentElement?.closest('svg')) continue;
    const box = doc.createElement(IN_A_LINE.has(element.tagName) ? 'span' : 'div');
    element.replaceWith(box);
    box.append(element);
  }
  return doc;
}

describe('pages with more boxes than their outline shows', () => {
  it.each(PAGES)('reads %s the same with a bare box around every element', (fixture, url) => {
    const asWritten = readPage(load(fixture, url), url, NOW);
    expect(readPage(boxEverything(load(fixture, url)), url, NOW)).toEqual(asWritten);
  });
});
