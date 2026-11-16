/**
 * Social Outreach: Settings → You, Team and Your computer (docs/outreach.md, decision 170, part 2). Each network's
 * level in a line under How hands-off, hours and limits in a few words, the levels a business allows, and the asks
 * that ended the same way folded under the newest of them.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_DEFAULTS,
  BusinessRules,
  type AutomationSettings,
} from '../../src/addons/outreach/automation';
import type { AskShown } from '../../src/addons/outreach/asks';
import {
  foldAsks,
  handsOffGroups,
  hoursLine,
  levelsAllowed,
  sameSince,
  SETTINGS_PAGE_WORDS as S,
  teamLimitsLine,
} from '../../src/addons/outreach/settings-pages';

const rules = BusinessRules.parse({});
const mine: AutomationSettings = {
  ...AUTOMATION_DEFAULTS,
  sending: 'steps',
  replies: 'draft',
  networks: {
    ...AUTOMATION_DEFAULTS.networks,
    facebook: { ...AUTOMATION_DEFAULTS.networks.facebook, on: true },
    linkedin: { ...AUTOMATION_DEFAULTS.networks.linkedin, on: true, sending: 'steps' },
    threads: { ...AUTOMATION_DEFAULTS.networks.threads, on: true, autopilot: true },
  },
};

const ask = (n: number, change: Partial<AskShown> = {}): AskShown => ({
  askId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  platform: 'threads',
  kind: 'requests',
  target: '',
  about: null,
  via: 'web',
  state: 'failed',
  line: 'Couldn’t open your followers list on Threads.',
  result: null,
  reply: null,
  askedAt: `2026-11-16T${String(9 + n).padStart(2, '0')}:00:00.000Z`,
  startedAt: null,
  endedAt: null,
  computerName: 'Office',
  ...change,
});

describe('Settings → You', () => {
  it('groups the networks by their level, in the menu’s order', () => {
    const groups = handsOffGroups(mine, ['facebook', 'linkedin', 'threads']);
    expect(groups).toEqual([
      { level: 'each', networks: ['facebook', 'linkedin'] },
      { level: 'autopilot', networks: ['threads'] },
    ]);
    expect(S.groupNetworks(groups[0]!)).toBe('Facebook, LinkedIn');
    expect(S.groupLine(groups[1]!)).toBe('Autopilot');
  });

  it('says the person’s own mix for a network that matches no level', () => {
    const mixed: AutomationSettings = { ...mine, replies: 'simple' };
    expect(handsOffGroups(mixed, ['facebook'])).toEqual([{ level: null, networks: ['facebook'] }]);
    expect(S.groupLine({ level: null, networks: ['facebook'] })).toBe('Your own mix');
  });

  it('says working hours in a few words', () => {
    expect(hoursLine({ start: 9, end: 17, days: [1, 2, 3, 4, 5] })).toBe('Mon–Fri, 9 AM–5 PM');
    expect(hoursLine({ start: 8, end: 24, days: [0, 1, 2, 3, 4, 5, 6] })).toBe(
      'Every day, 8 AM–midnight',
    );
    expect(hoursLine({ start: 10, end: 14, days: [1, 3] })).toBe('Mon, Wed, 10 AM–2 PM');
  });
});

describe('Settings → Team', () => {
  it('lists a network’s most a day for each person, as the business keeps them', () => {
    const line = teamLimitsLine('facebook', rules);
    expect(line).toMatch(/^\d+ friend requests, /);
    expect(line).toContain('likes');
    const fewer = BusinessRules.parse({ dailyLimits: { friend_request: 5 } });
    expect(teamLimitsLine('facebook', fewer)).toMatch(/^5 friend requests, /);
  });

  it('says which levels people may pick', () => {
    expect(S.mayGoLine(levelsAllowed(rules))).toBe('Any of the four.');
    const fewer = BusinessRules.parse({
      sendingAllowed: ['off', 'steps'],
      repliesAllowed: ['draft'],
      autopilotAllowed: false,
    });
    expect(levelsAllowed(fewer)).toEqual(['myself', 'each']);
    expect(S.mayGoLine(levelsAllowed(fewer))).toBe('I do it myself and I OK each message.');
  });
});

describe('Settings → Your computer', () => {
  it('folds the asks that ended the same way under the newest, keeping the order', () => {
    const asks = [
      ask(4),
      ask(3, { kind: 'groups', platform: 'facebook', state: 'done', line: 'Saved 12 groups.' }),
      ask(2),
      ask(1),
    ];
    const folded = foldAsks(asks);
    expect(folded.map((f) => f.ask.askId)).toEqual([asks[0]!.askId, asks[1]!.askId]);
    expect(folded[0]!.same.map((a) => a.askId)).toEqual([asks[2]!.askId, asks[3]!.askId]);
    expect(
      S.same(
        folded[0]!.same.length,
        sameSince(folded[0]!.same, 'UTC', Date.parse('2026-11-16T15:00:00Z')),
      ),
    ).toBe('The same, 2 more times since 10:00 AM');
  });

  it('never folds one still going, or ones that ended another way', () => {
    const folded = foldAsks([
      ask(4, { state: 'working', line: null }),
      ask(3, { state: 'working', line: null }),
      ask(2, { line: 'Couldn’t find the Follow button.' }),
      ask(1),
    ]);
    expect(folded).toHaveLength(4);
    expect(folded.every((f) => f.same.length === 0)).toBe(true);
  });
});
