/**
 * Social Outreach rearranged, part 3 (docs/outreach.md, decision 129): Set up's count in the menu and when it's there,
 * what Today says of Get ready, the jobs in each page's Run now, and which opener works best so far on Results.
 */
import { describe, expect, it } from 'vitest';
import { askableOn } from '../../src/addons/outreach/asks';
import { PLATFORM_KEYS } from '../../src/addons/outreach/networks';
import { bestOpenerOf, type OpenerResult } from '../../src/addons/outreach/openers';
import { RUN_NOW_ALL, RUN_NOW_ON, runNowOn } from '../../src/addons/outreach/run-now';
import { setUpInMenu, setupDoneOf, todayReadyWords } from '../../src/addons/outreach/set-up-page';
import type { SetupLaidOut } from '../../src/addons/outreach/setup';

const step = <S extends string>(
  s: S,
  state: 'done' | 'todo' | 'again' | 'waiting',
  optional = false,
) => ({
  step: s,
  state,
  left: state === 'done' ? null : 'Left',
  optional,
});

const laid: SetupLaidOut = {
  states: [
    step('offer', 'done'),
    step('playbook', 'done'),
    step('video', 'todo', true),
    step('rules', 'done'),
    step('extension', 'done'),
    step('messages', 'todo'),
    step('networks', 'done'),
    step('numbers', 'todo'),
  ],
  networks: [
    {
      platform: 'facebook',
      steps: [step('profile', 'done'), step('choices', 'done'), step('start', 'todo')],
    },
  ],
};

describe('Set up in the menu', () => {
  it('counts every step but the optional video, the main ones and each network’s', () => {
    expect(setupDoneOf(laid)).toEqual({ done: 7, of: 10 });
  });

  it('is there while anything’s left and the reminder isn’t hidden', () => {
    expect(setUpInMenu({ banner: true, next: { net: null, step: 'messages' } })).toBe(true);
    // Hidden, or someone who has used it for weeks: gone, and Settings → You opens it.
    expect(setUpInMenu({ banner: false, next: { net: null, step: 'messages' } })).toBe(false);
    expect(setUpInMenu({ banner: true, next: null })).toBe(false);
  });
});

describe('Get ready, from Today', () => {
  it('says how much holds the day, then the profile’s advice, then nothing', () => {
    const items = [
      { item: 'offer', state: 'done' },
      { item: 'playbook', state: 'done' },
      { item: 'profile', state: 'todo' },
      { item: 'messages', state: 'todo' },
      { item: 'numbers', state: 'todo' },
    ] as const;
    expect(todayReadyWords('LinkedIn', false, items)).toBe(
      '2 things to do before the extension reaches anyone on LinkedIn.',
    );
    expect(todayReadyWords('LinkedIn', true, items)).toMatch(/^Your LinkedIn profile is still/);
    expect(
      todayReadyWords(
        'LinkedIn',
        true,
        items.map((i) => ({ ...i, state: 'done' as const })),
      ),
    ).toBeNull();
  });
});

describe('Run now', () => {
  it('offers each page’s jobs a network can be asked, and every one of them on Your computer', () => {
    for (const platform of PLATFORM_KEYS) {
      for (const kind of runNowOn(RUN_NOW_ON.people, platform))
        expect(askableOn(platform, kind)).toBe(true);
    }
    expect(runNowOn(RUN_NOW_ON.people, 'facebook')).toEqual([
      'requests',
      'friends',
      'checks',
      'chats',
    ]);
    // Your computer has them all, and checking the network too.
    for (const page of Object.values(RUN_NOW_ON))
      for (const kind of page) expect(RUN_NOW_ALL).toContain(kind);
    expect(RUN_NOW_ALL).toContain('checkup');
  });
});

describe('Which openers work', () => {
  const opener = (text: string, sent: number, replies: number, current = true): OpenerResult => ({
    kind: 'own',
    text,
    current,
    sent,
    replies,
    demos: 0,
  });

  it('names the best only once two in the playbook now have had a fair try', () => {
    expect(bestOpenerOf([opener('A', 10, 4), opener('B', 2, 2)])).toBeNull();
    expect(bestOpenerOf([opener('A', 10, 4), opener('B', 6, 1)])?.text).toBe('A');
    // One taken out of the playbook doesn't count.
    expect(bestOpenerOf([opener('A', 10, 1), opener('B', 6, 5, false)])).toBeNull();
    // Nobody wrote back to any: no best.
    expect(bestOpenerOf([opener('A', 10, 0), opener('B', 6, 0)])).toBeNull();
  });
});
