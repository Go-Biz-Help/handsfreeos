/**
 * Waiting for you on this computer (src/hfos/waiting.ts): the pop-ups follow the person's pushes setting as their
 * phone does, it looks again on their own changes only, and a step the runner couldn't do is handed to them
 * (src/auto/plan.ts).
 */
import { describe, expect, it } from 'vitest';
import { badgeText, NO_KINDS, type WaitingKinds } from '@hfos/core/addons/outreach/waiting-words';
import { needOf } from '../src/auto/plan';
import type { Waiting, WaitingItem } from '../src/hfos/messages';
import { popUpsFor, POPUP_ID, waitingEventFor } from '../src/hfos/waiting';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Friday 9 October 2026, 10 AM in Chicago.
const friday10 = Date.UTC(2026, 9, 9, 15);
const saturday = Date.UTC(2026, 9, 10, 15);
const hours = { start: 9, end: 17, days: [1, 2, 3, 4, 5] };
const ME = 'a1b2c3d4-0000-4000-8000-000000000001';
const BUSINESS = 'b1b2c3d4-0000-4000-8000-000000000002';

let n = 0;
const uuid = () => `c0c0c0c0-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function send(
  kind: 'reply' | 'message',
  name: string,
  needsYou: string | null = null,
): WaitingItem {
  return {
    kind,
    at: new Date(friday10).toISOString(),
    send: {
      sendId: uuid(),
      kind: kind === 'reply' ? 'reply' : 'opener',
      profileId: uuid(),
      name,
      profileUrl: null,
      chatId: null,
      threadKey: null,
      postId: null,
      postUrl: null,
      post: null,
      postWhole: null,
      text: `Hi ${name}`,
      recent: [],
      state: 'waiting',
      why: null,
      opener: null,
      handedOver: kind === 'reply',
      needsYou,
      createdAt: new Date(friday10).toISOString(),
    },
  };
}

function need(name: string, why: string): WaitingItem {
  return {
    kind: 'need',
    at: new Date(friday10).toISOString(),
    need: {
      needId: uuid(),
      step: 'friend_request',
      profileId: uuid(),
      postId: null,
      sendId: null,
      platform: 'facebook',
      name,
      url: null,
      why,
      text: null,
      threadKey: null,
      seenAt: new Date(friday10).toISOString(),
    },
  };
}

function request(name: string): WaitingItem {
  return {
    kind: 'request',
    at: new Date(friday10).toISOString(),
    request: {
      profileId: uuid(),
      name,
      url: `https://www.facebook.com/${name.toLowerCase().replace(' ', '.')}`,
      fit: 'unknown',
      why: ['Nothing on their profile fits a playbook'],
      held: null,
      since: new Date(friday10).toISOString(),
      mutualFriends: null,
      said: null,
    },
  };
}

function listOf(
  items: WaitingItem[],
  pushes: 'bundled' | 'each' = 'bundled',
): Pick<Waiting, 'items' | 'kinds' | 'pushes' | 'hours' | 'timezone'> {
  const kinds: WaitingKinds = { ...NO_KINDS };
  for (const kind of ['reply', 'message', 'need', 'request'] as const) {
    const count = items.filter((i) => i.kind === kind).length;
    kinds[kind] = { count, newestAt: count ? new Date(friday10).toISOString() : null };
  }
  return { items, kinds, pushes, hours, timezone: 'America/Chicago' };
}

const idOf = (item: WaitingItem) =>
  item.kind === 'need'
    ? item.need.needId
    : item.kind === 'request'
      ? item.request.profileId
      : item.kind === 'ask'
        ? item.ask.askId
        : item.send.sendId;

describe('the pop-ups', () => {
  it('bundle what’s new in one, when it’s due, and remember it as told', () => {
    const items = [send('message', 'Dana Reyes'), send('message', 'Sam Lee'), request('Ana Moss')];
    const shown = popUpsFor({ list: listOf(items), told: [], lastAt: null, now: friday10 });
    expect(shown.show).toEqual([
      {
        id: POPUP_ID,
        title: '2 messages wait for your OK',
        message: 'Open Today to OK, change or skip them.',
      },
    ]);
    expect(shown.told).toEqual(items.slice(0, 2).map(idOf));
    expect(shown.lastAt).toBe(friday10);
    // Nothing new: nothing.
    expect(
      popUpsFor({ list: listOf(items), told: shown.told, lastAt: friday10, now: friday10 + HOUR })
        .show,
    ).toEqual([]);
  });

  it('wait while it isn’t due: under 2 hours since the last, or outside working hours', () => {
    const items = [send('message', 'Dana Reyes')];
    const soon = popUpsFor({
      list: listOf(items),
      told: [],
      lastAt: friday10 - HOUR,
      now: friday10,
    });
    expect(soon).toEqual({ show: [], told: [], lastAt: friday10 - HOUR });
    expect(popUpsFor({ list: listOf(items), told: [], lastAt: null, now: saturday }).show).toEqual(
      [],
    );
    // Once due, it shows.
    expect(
      popUpsFor({ list: listOf(items), told: [], lastAt: friday10 - HOUR, now: friday10 + HOUR })
        .show,
    ).toHaveLength(1);
  });

  it('show a reply handed over at once, whatever the setting', () => {
    const reply = send('reply', 'Ana Moss', 'they sound upset');
    const shown = popUpsFor({
      list: listOf([reply, send('message', 'Dana Reyes')]),
      told: [],
      lastAt: friday10 - HOUR,
      now: saturday,
    });
    expect(shown.show).toEqual([
      {
        id: `${POPUP_ID}-${idOf(reply)}`,
        title: 'Ana Moss needs you',
        message: 'Their reply waits for your OK on Today: they sound upset.',
      },
    ]);
    expect(shown.told).toEqual([idOf(reply)]);
  });

  it('show one for each, up to 3, then one for them all; never for friend requests', () => {
    const three = [
      send('message', 'Dana Reyes'),
      need('Eli Brook', 'couldn’t find “Add friend”'),
      send('message', 'Sam Lee'),
      request('Ana Moss'),
    ];
    const each = popUpsFor({ list: listOf(three, 'each'), told: [], lastAt: null, now: saturday });
    expect(each.show.map((p) => p.title)).toEqual([
      'Dana Reyes: a message waits for your OK',
      'Eli Brook: the extension needs you on Facebook',
      'Sam Lee: a message waits for your OK',
    ]);
    expect(each.show[1]!.message).toBe(
      'Couldn’t find “Add friend”. Do it yourself, or let it go, on Today.',
    );
    const four = [...three, send('message', 'Kim Lee')];
    expect(
      popUpsFor({ list: listOf(four, 'each'), told: [], lastAt: null, now: saturday }).show,
    ).toEqual([
      {
        id: POPUP_ID,
        title: '3 messages wait for your OK',
        message: 'And 1 step the extension couldn’t do. Open Today.',
      },
    ]);
    expect(
      popUpsFor({
        list: listOf([request('Ana Moss')], 'each'),
        told: [],
        lastAt: null,
        now: friday10,
      }).show,
    ).toEqual([]);
  });

  it('tell of what was there in one pop-up at most on the first look', () => {
    const items = [
      send('reply', 'Ana Moss'),
      send('message', 'Dana Reyes'),
      send('message', 'Sam Lee'),
    ];
    const first = popUpsFor({
      list: listOf(items, 'each'),
      told: null,
      lastAt: null,
      now: friday10,
    });
    expect(first.show).toEqual([
      {
        id: POPUP_ID,
        title: '3 messages wait for your OK',
        message: 'Open Today to OK, change or skip them.',
      },
    ]);
    expect(first.told).toEqual(items.map(idOf));
    // Bundled, outside working hours: nothing shows, and it's all told.
    const weekend = popUpsFor({ list: listOf(items), told: null, lastAt: null, now: saturday });
    expect(weekend).toEqual({ show: [], told: items.map(idOf), lastAt: null });
  });
});

describe('what it listens for', () => {
  it('looks again on the person’s own changes to what waits', () => {
    expect(waitingEventFor({ type: 'outreach.send.queued', actorId: ME }, ME)).toBe(true);
    expect(waitingEventFor({ type: 'outreach.need.noted', actorId: ME }, ME)).toBe(true);
    expect(waitingEventFor({ type: 'outreach.send.queued', actorId: 'someone-else' }, ME)).toBe(
      false,
    );
    expect(waitingEventFor({ type: 'outreach.playbook.saved', actorId: ME }, ME)).toBe(false);
    expect(waitingEventFor({ type: 'outreach.send.queued', actorId: ME }, null)).toBe(false);
    // An owner changed the person's pushes, hours or training wheels; HandsFreeOS brought friends in itself.
    expect(waitingEventFor({ type: 'outreach.automation.saved', actorId: 'an-owner' }, ME)).toBe(
      true,
    );
    expect(waitingEventFor({ type: 'outreach.wheels.ended', actorId: 'an-owner' }, ME)).toBe(true);
    expect(waitingEventFor({ type: 'outreach.friends.saved', actorId: null }, ME)).toBe(true);
  });

  it('shows the number on the icon', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(7)).toBe('7');
    expect(badgeText(120)).toBe('99+');
  });
});

describe('steps it needs you for', () => {
  const item = {
    kind: 'friend_request' as const,
    name: 'Eli Brook',
    profileId: 'd0d0d0d0-0000-4000-8000-000000000001',
    postId: null,
    postUrl: null,
    profileUrl: 'https://www.facebook.com/eli.brook.2',
  };

  it('hands a step over with why, less the name it starts with', () => {
    expect(needOf(item, 'Eli Brook: couldn’t find “Add friend”', BUSINESS)).toEqual({
      workspaceId: BUSINESS,
      step: 'friend_request',
      profileId: item.profileId,
      postId: null,
      name: 'Eli Brook',
      url: 'https://www.facebook.com/eli.brook.2',
      why: 'couldn’t find “Add friend”',
    });
    expect(
      needOf(
        {
          ...item,
          kind: 'comment',
          postId: 'e0e0e0e0-0000-4000-8000-000000000001',
          postUrl: 'https://www.facebook.com/groups/1/posts/2/',
        },
        'Eli Brook’s post: Facebook didn’t take the comment',
        BUSINESS,
      ),
    ).toMatchObject({
      step: 'comment',
      postId: 'e0e0e0e0-0000-4000-8000-000000000001',
      url: 'https://www.facebook.com/groups/1/posts/2/',
      why: 'Facebook didn’t take the comment',
    });
  });

  it('hands over no message, and nothing for someone not kept', () => {
    expect(needOf({ ...item, kind: 'opener' }, 'Eli Brook: couldn’t find the box', BUSINESS)).toBe(
      null,
    );
    expect(needOf({ ...item, profileId: null }, 'Eli Brook: couldn’t find it', BUSINESS)).toBe(
      null,
    );
  });
});
