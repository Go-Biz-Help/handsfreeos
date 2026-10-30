/**
 * People's views and Find people's cards (docs/outreach.md, decision 128): one list of everyone with a view for each
 * kind, each one of the lists HandsFreeOS keeps, and a card for each way new people are found, with the week's line.
 */
import { describe, expect, it } from 'vitest';
import {
  FIND_WAY_KEYS,
  FIND_WAYS,
  findWayCounts,
  findWayLine,
} from '../../src/addons/outreach/find-page';
import { activityStepsOf } from '../../src/addons/outreach/activity';
import { FRIEND_VIEW_KEYS, friendSinceWords } from '../../src/addons/outreach/friends';
import {
  LEFT_ALONE_KEYS,
  PEOPLE_VIEW_KEYS,
  peopleCountsOf,
  peopleListOf,
  peopleViewOf,
} from '../../src/addons/outreach/people-views';
import { STAGE_VIEW_KEYS } from '../../src/addons/outreach/stages';

describe('People’s views', () => {
  it('are in the plan’s order, with Left alone last', () => {
    expect(PEOPLE_VIEW_KEYS).toEqual([
      'in_play',
      'fits',
      'talking',
      'friends',
      'requests',
      'sent',
      'chats',
      'partners',
      'clients',
      'left_alone',
    ]);
    expect(LEFT_ALONE_KEYS).toEqual(['dont_pitch', 'never_contact', 'lost', 'keep', 'country']);
  });

  it('each open a list, and each list shows under one view', () => {
    for (const view of PEOPLE_VIEW_KEYS) {
      const at = peopleViewOf(peopleListOf(view));
      expect(at.view).toBe(view);
    }
    for (const alone of LEFT_ALONE_KEYS)
      expect(peopleViewOf(peopleListOf(alone))).toEqual({ view: 'left_alone', alone });
    // Every friends list and every stage has a home: a stage of its own is in play, as the board's columns are.
    for (const show of FRIEND_VIEW_KEYS)
      expect(PEOPLE_VIEW_KEYS).toContain(peopleViewOf({ list: 'friends', show }).view);
    for (const show of STAGE_VIEW_KEYS)
      expect(PEOPLE_VIEW_KEYS).toContain(peopleViewOf({ list: 'stages', show }).view);
    expect(peopleViewOf({ list: 'stages', show: 'pitched' })).toEqual({
      view: 'in_play',
      alone: null,
    });
  });
});

describe('Find people’s cards', () => {
  const week = {
    since: '2026-10-23T00:00:00.000Z',
    ways: [
      { platform: 'instagram' as const, how: 'searched' as const, found: 118, good: 31, maybe: 9 },
      { platform: 'linkedin' as const, how: 'searched' as const, found: 4, good: 1, maybe: 0 },
      { platform: 'instagram' as const, how: 'liked' as const, found: 10, good: 2, maybe: 1 },
      { platform: 'alignable' as const, how: 'member' as const, found: 3, good: 0, maybe: 1 },
    ],
    followers: { found: 9, good: 4, maybe: 2 },
    members: { found: 20, good: 5, maybe: 3 },
    partners: 2,
    download: null,
  };

  it('add up each way, a group’s members checked with those found in groups', () => {
    const counts = findWayCounts(week);
    expect(counts.searches).toEqual({ found: 122, good: 32, maybe: 9 });
    expect(counts.posts).toEqual({ found: 10, good: 2, maybe: 1 });
    expect(counts.groups).toEqual({ found: 23, good: 5, maybe: 4 });
    expect(counts.followers).toEqual(week.followers);
    expect(counts.events).toEqual({ found: 0, good: 0, maybe: 0 });
    expect(counts.partners.found).toBe(2);
  });

  it('say what came this week in plain words', () => {
    const counts = findWayCounts(week);
    expect(findWayLine('searches', counts.searches)).toBe('122 found this week · 32 good fits');
    expect(findWayLine('events', counts.events)).toBe('Nothing found this week');
    expect(findWayLine('partners', counts.partners)).toBe('2 found this week');
    expect(findWayLine('posts', { found: 1, good: 1, maybe: 0 })).toBe(
      '1 found this week · 1 good fit',
    );
    for (const way of FIND_WAY_KEYS) {
      expect(FIND_WAYS[way].about).not.toMatch(/'/);
      expect(FIND_WAYS[way].on.length).toBeGreaterThan(0);
    }
  });
});

describe('The views’ counts', () => {
  it('come from the list shown: a friends list knows the friends lists’, the stages theirs', () => {
    expect(
      peopleCountsOf({
        friends: {
          friends: 120,
          fits: 14,
          requests: 2,
          sent: 9,
          keep: 3,
          dontPitch: 5,
          neverContact: 1,
        },
      }),
    ).toEqual({
      fits: 14,
      friends: 120,
      requests: 2,
      sent: 9,
      keep: 3,
      dont_pitch: 5,
      never_contact: 1,
    });
    const stages = {
      all: 40,
      found: 10,
      warming: 10,
      friends: 5,
      talking: 6,
      ready: 4,
      pitched: 3,
      booked: 2,
      client: 7,
      lost: 8,
    };
    expect(peopleCountsOf({ stages })).toEqual({ in_play: 40, talking: 6, clients: 7, lost: 8 });
    expect(peopleCountsOf(null)).toEqual({});
  });
});

describe('A row’s words, the same on the web and the phone', () => {
  const NOW = Date.parse('2026-10-10T15:00:00.000Z');
  const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

  it('says since when, and the latest message', () => {
    const row = { state: null, since: null, friendsSince: null, lastMessage: null };
    expect(friendSinceWords({ ...row, state: 'request_received', since: ago(2) }, NOW)).toBe(
      'Asked · 2 d ago',
    );
    expect(
      friendSinceWords(
        {
          ...row,
          state: 'friends',
          friendsSince: '2019-03-02T12:00:00.000Z',
          lastMessage: { at: ago(30), fromMe: false },
        },
        NOW,
      ),
    ).toBe('Friends since Mar 2019 · Last message Sep 10, from them');
    expect(friendSinceWords(row, NOW)).toBeNull();
  });

  it('names each step someone has come, the request in their network’s words', () => {
    const person = {
      profileId: '00000000-0000-4000-8000-000000000001',
      personId: null,
      name: 'Jo Baker',
      url: 'https://www.linkedin.com/in/jo-baker',
      platform: 'linkedin' as const,
      group: null,
      requestedAt: ago(3),
      likedAt: null,
      commentedAt: null,
      messagedAt: ago(2),
      repliedAt: ago(1),
      lastAt: ago(1),
    };
    expect(activityStepsOf(person).map((s) => [s.key, s.label])).toEqual([
      ['requestedAt', 'Invitation to connect'],
      ['messagedAt', 'Messaged'],
      ['repliedAt', 'Wrote back'],
    ]);
    expect(activityStepsOf({ ...person, platform: 'facebook' })[0]!.label).toBe('Friend request');
  });
});
