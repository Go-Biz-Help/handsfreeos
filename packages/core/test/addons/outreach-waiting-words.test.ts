/**
 * Waiting for you's words and rules (docs/outreach.md, decisions 40 and 42), which the web, the phone, the worker and
 * the extension all follow: when the bundled push goes, what it and a push for each say, what a need asks of the
 * person, the icon's number, and which messages wait for an OK of their own.
 */
import { describe, expect, it } from 'vitest';
import {
  approveAllCount,
  approveAllWords,
  badgeText,
  bundleAt,
  bundleDue,
  bundlePushWords,
  eachPushWords,
  messengerChatUrl,
  moreWords,
  needClearedWords,
  needTitle,
  needWhyWords,
  newestNudgeAt,
  NO_KINDS,
  nudgeCount,
  oneByOne,
  oneByOneWords,
  requestWhy,
  waitingCount,
  waitingWords,
  type WaitingKinds,
} from '../../src/addons/outreach/waiting-words';

const MIN = 60_000;
const HOUR = 60 * MIN;
const tz = 'America/Chicago';
const hours = { start: 9, end: 17, days: [1, 2, 3, 4, 5] };
// Friday 9 October 2026, 10 AM in Chicago (15:00 UTC).
const friday10 = Date.UTC(2026, 9, 9, 15);
// Monday 12 October 2026, 9 AM in Chicago.
const monday9 = Date.UTC(2026, 9, 12, 14);

const kinds = (k: Partial<Record<keyof WaitingKinds, number>>): WaitingKinds => ({
  ask: { count: k.ask ?? 0, newestAt: k.ask ? new Date(friday10).toISOString() : null },
  reply: { count: k.reply ?? 0, newestAt: k.reply ? new Date(friday10).toISOString() : null },
  message: {
    count: k.message ?? 0,
    newestAt: k.message ? new Date(friday10 + MIN).toISOString() : null,
  },
  need: {
    count: k.need ?? 0,
    newestAt: k.need ? new Date(friday10 + 2 * MIN).toISOString() : null,
  },
  request: {
    count: k.request ?? 0,
    newestAt: k.request ? new Date(friday10 + 3 * MIN).toISOString() : null,
  },
});

describe('the bundled push’s timing', () => {
  it('gathers 10 minutes after the first new one, at most every 2 hours', () => {
    expect(bundleAt({ now: friday10, lastAt: null, hours, timeZone: tz })).toBe(
      friday10 + 10 * MIN,
    );
    expect(bundleAt({ now: friday10, lastAt: friday10 - 30 * MIN, hours, timeZone: tz })).toBe(
      friday10 + 90 * MIN,
    );
    expect(bundleAt({ now: friday10, lastAt: friday10 - 3 * HOUR, hours, timeZone: tz })).toBe(
      friday10 + 10 * MIN,
    );
  });

  it('waits for the next working hours, over a weekend', () => {
    // Friday 4:55 PM: 10 minutes on is after 5, so Monday at 9.
    const late = Date.UTC(2026, 9, 9, 21, 55);
    expect(bundleAt({ now: late, lastAt: null, hours, timeZone: tz })).toBe(monday9);
    // Saturday.
    expect(bundleAt({ now: Date.UTC(2026, 9, 10, 15), lastAt: null, hours, timeZone: tz })).toBe(
      monday9,
    );
  });

  it('is due in working hours, 2 hours or more after the last', () => {
    expect(bundleDue({ now: friday10, lastAt: null, hours, timeZone: tz })).toBe(true);
    expect(bundleDue({ now: friday10, lastAt: friday10 - HOUR, hours, timeZone: tz })).toBe(false);
    expect(bundleDue({ now: friday10, lastAt: friday10 - 2 * HOUR, hours, timeZone: tz })).toBe(
      true,
    );
    expect(bundleDue({ now: Date.UTC(2026, 9, 10, 15), lastAt: null, hours, timeZone: tz })).toBe(
      false,
    );
  });
});

describe('the words', () => {
  it('bundle messages first, in the owner’s words', () => {
    // Replies handed over pushed on their own: the bundle leaves them out.
    expect(bundlePushWords(kinds({ message: 3, reply: 2 }))).toEqual({
      title: '3 messages wait for your OK',
      body: 'Open Today to OK, change or skip them.',
    });
    expect(bundlePushWords(kinds({ message: 1, need: 2 }))).toEqual({
      title: '1 message waits for your OK',
      body: 'And 2 steps the extension couldn’t do. Open Today.',
    });
    expect(bundlePushWords(kinds({ need: 2, request: 4 }))).toEqual({
      title: '2 steps need you',
      body: 'The extension couldn’t do them. Do them yourself, or let them go, on Today.',
    });
    expect(bundlePushWords(kinds({ reply: 2, request: 1 }))).toBeNull();
    // The extension's first look tells of them too.
    expect(bundlePushWords(kinds({ message: 3, reply: 2 }), true)?.title).toBe(
      '5 messages wait for your OK',
    );
    expect(bundlePushWords(kinds({ request: 4 }))).toBeNull();
    expect(bundlePushWords(NO_KINDS)).toBeNull();
  });

  it('push one at a time with “one for each”, the why as a sentence', () => {
    expect(eachPushWords('message', 'Dana Reyes')).toEqual({
      title: 'Dana Reyes: a message waits for your OK',
      body: 'OK it, change it or skip it on Today.',
    });
    expect(eachPushWords('need', 'Dana Reyes', 'couldn’t find “Add friend”.')).toEqual({
      title: 'Dana Reyes: the extension needs you',
      body: 'Couldn’t find “Add friend”. Do it yourself, or let it go, on Today.',
    });
  });

  it('count Approve all the same everywhere, and say how a list is cut short', () => {
    const send = (handedOver: boolean, needsYou: string | null) => ({
      kind: 'message',
      send: { handedOver, needsYou },
    });
    const items = [send(false, null), send(false, null), send(false, 'they sound upset')];
    // Listed: 2 can go together. 150 wait, 1 of those listed on its own: 149.
    expect(approveAllCount(items, 3)).toBe(2);
    expect(approveAllCount(items, 150)).toBe(149);
    expect(approveAllCount([{ kind: 'need' }], 0)).toBe(0);
    expect(moreWords('message', 3)).toBe('And 3 more: the oldest are listed first.');
    expect(moreWords('request', 1200)).toBe('And 1,200 more: the newest are listed first.');
    expect(needClearedWords('done', 'done')).toBe('Done. It’s off your list.');
    expect(needClearedWords('dismissed', 'dismissed')).toBe(
      'Let go. It won’t be handed to you for a week.',
    );
    expect(needClearedWords('done', 'open')).toMatch(/still waits for you/);
  });

  it('say why a need couldn’t be done, and link its chat, the same everywhere', () => {
    expect(needWhyWords('the Confirm button wasn’t there.')).toBe(
      'The Confirm button wasn’t there.',
    );
    expect(needWhyWords('')).toBe('');
    expect(messengerChatUrl('4001')).toBe('https://www.facebook.com/messages/t/4001');
    expect(messengerChatUrl('a b/c')).toBe('https://www.facebook.com/messages/t/a%20b%2Fc');
    expect(messengerChatUrl(null)).toBeNull();
  });

  it('say what each need asks of the person', () => {
    expect(needTitle('confirm', 'Dana Reyes')).toBe(
      'Confirm or delete Dana Reyes’s friend request yourself',
    );
    expect(needTitle('friend_request', 'Dana Reyes')).toBe(
      'Send Dana Reyes a friend request yourself',
    );
    expect(needTitle('warm_up', 'Dana Reyes')).toBe('Like a post of Dana Reyes’s yourself');
    expect(needTitle('comment', 'Dana Reyes')).toBe('Comment on Dana Reyes’s post yourself');
    expect(needTitle('message', 'Dana Reyes')).toBe('Send Dana Reyes the message yourself');
  });

  it('count what waits, and what pushes tell of', () => {
    const k = kinds({ reply: 1, message: 2, need: 1, request: 3 });
    expect(waitingCount(k)).toBe(7);
    expect(nudgeCount(k)).toBe(3);
    expect(newestNudgeAt(k)).toBe(friday10 + 2 * MIN);
    // A reply handed over alone never makes a bundle go.
    expect(nudgeCount(kinds({ reply: 2 }))).toBe(0);
    expect(newestNudgeAt(kinds({ reply: 2 }))).toBeNull();
    expect(newestNudgeAt(kinds({ request: 2 }))).toBeNull();
    // An ask that needs the person counts, and pushed at once on its own: never in a bundle.
    expect(waitingCount(kinds({ ask: 1, reply: 1 }))).toBe(2);
    expect(nudgeCount(kinds({ ask: 2 }))).toBe(0);
    expect(waitingWords(0)).toBe('Nothing waits for you.');
    expect(waitingWords(1)).toBe('1 thing waits for you.');
    expect(waitingWords(5)).toBe('5 things wait for you.');
    expect(badgeText(0)).toBe('');
    expect(badgeText(7)).toBe('7');
    expect(badgeText(120)).toBe('99+');
  });

  it('say why a request is the person’s', () => {
    expect(requestWhy([], 'unknown')).toEqual(['Nothing on their profile fits a playbook']);
    expect(requestWhy(['“Realtor” on their profile'], 'skip')).toEqual([
      '“Realtor” on their profile',
    ]);
    expect(requestWhy(['14 mutual friends'], 'good', 'no_playbook')).toEqual([
      '14 mutual friends',
      'Fits, but the business has no playbook in use yet',
    ]);
  });

  it('leave a message to one tap when it’s handed over or to someone who needs the person', () => {
    expect(oneByOne({ handedOver: false, needsYou: null })).toBe(false);
    expect(oneByOne({ handedOver: true, needsYou: null })).toBe(true);
    expect(oneByOne({ handedOver: false, needsYou: 'they asked you to stop messaging them' })).toBe(
      true,
    );
    expect(oneByOneWords({ handedOver: true, needsYou: 'they sound upset' })).toBe(
      'Handed over to you: they sound upset.',
    );
    expect(oneByOneWords({ handedOver: false, needsYou: null })).toBeNull();
    expect(approveAllWords(1)).toBe('Approve all 1 message');
    expect(approveAllWords(5)).toBe('Approve all 5 messages');
  });
});
