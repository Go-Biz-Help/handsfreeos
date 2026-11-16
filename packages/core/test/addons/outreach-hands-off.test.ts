/**
 * Social Outreach: How hands-off? and the network status card (docs/outreach.md, decision 170). Four levels set the
 * choices kept since the start, Autopilot is each network's own, and the card at the top of a network's page says
 * what it's really doing there: running, waiting on the person, stuck, stopped for today, resting, or theirs to do.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_DEFAULTS,
  autopilotNetworks,
  autopilotOn,
  BusinessRules,
  choicesFor,
  keepOwnPicks,
  withinRules,
  type AutomationSettings,
} from '../../src/addons/outreach/automation';
import {
  handsOffAllowed,
  handsOffEverywhere,
  handsOffOf,
  withHandsOff,
  withHandsOffEverywhere,
} from '../../src/addons/outreach/hands-off';
import type { LiveStep } from '../../src/addons/outreach/live';
import {
  networkOfLine,
  networkStatus,
  soFarWords,
  stuckOn,
  type StatusLive,
} from '../../src/addons/outreach/network-status';

const rules = BusinessRules.parse({});
const mine: AutomationSettings = {
  ...AUTOMATION_DEFAULTS,
  sending: 'steps',
  replies: 'draft',
  networks: {
    ...AUTOMATION_DEFAULTS.networks,
    facebook: { ...AUTOMATION_DEFAULTS.networks.facebook, on: true },
    threads: { ...AUTOMATION_DEFAULTS.networks.threads, on: true, sending: 'steps' },
    linkedin: { ...AUTOMATION_DEFAULTS.networks.linkedin, on: true, sending: 'off' },
  },
};

describe('How hands-off?', () => {
  it('reads each network’s level from its choices, or none for the person’s own mix', () => {
    expect(handsOffOf({ sending: 'off', replies: 'draft' })).toBe('myself');
    expect(handsOffOf({ sending: 'steps', replies: 'draft' })).toBe('each');
    // Messages first each morning only moves messages up: still I OK each message.
    expect(handsOffOf({ sending: 'approve_all', replies: 'draft' })).toBe('each');
    expect(handsOffOf({ sending: 'everything', replies: 'everything' })).toBe('own');
    expect(handsOffOf({ sending: 'steps', replies: 'draft', autopilot: true })).toBe('autopilot');
    expect(handsOffOf({ sending: 'steps', replies: 'simple' })).toBeNull();
  });

  it('turns Autopilot on for one network, leaving the others as they stand', () => {
    const { settings, picked } = withHandsOff(mine, 'threads', 'autopilot', rules);
    expect(picked).toEqual([]);
    expect(autopilotOn(settings, 'threads')).toBe(true);
    expect(autopilotOn(settings, 'facebook')).toBe(false);
    expect(autopilotOn(settings, 'linkedin')).toBe(false);
    expect(autopilotNetworks(settings)).toEqual(['threads']);
    // Inside the rules, only Threads gets Autopilot's picks.
    const shown = withinRules(settings, rules);
    expect(choicesFor(shown, 'threads')).toMatchObject({ autopilot: true, sending: 'everything' });
    expect(choicesFor(shown, 'facebook')).toMatchObject({ autopilot: false, sending: 'steps' });
  });

  it('turning Facebook’s on no longer turns on every network, once each is said', () => {
    const { settings } = withHandsOff(mine, 'facebook', 'autopilot', rules);
    expect(autopilotNetworks(settings)).toEqual(['facebook']);
    // Kept from before decision 170, a network that never said follows Facebook's.
    expect(autopilotOn({ ...mine, autopilot: true }, 'threads')).toBe(true);
  });

  it('sets the level’s choices as Autopilot goes off, and those stay over the person’s own from before', () => {
    const on = withHandsOff(mine, 'threads', 'autopilot', rules).settings;
    const { settings, picked } = withHandsOff(withinRules(on, rules), 'threads', 'own', rules);
    expect(picked).toEqual(['threads']);
    expect(choicesFor(settings, 'threads')).toMatchObject({
      autopilot: false,
      sending: 'everything',
      replies: 'everything',
    });
    // What the save keeps: the picks just chosen, not Threads' own from before Autopilot.
    const kept = keepOwnPicks(settings, on, picked);
    expect(kept.networks.threads).toMatchObject({ sending: 'everything', replies: 'everything' });
    // Turned off with no pick (an old screen's switch), their own come back.
    const off = keepOwnPicks(
      {
        ...settings,
        networks: { ...settings.networks, threads: { ...settings.networks.threads } },
      },
      on,
    );
    expect(off.networks.threads.sending).toBe('steps');
  });

  it('keeps Messages first each morning on I OK each message, and posts after an OK a step back from All on its own', () => {
    const first = withHandsOff({ ...mine, sending: 'approve_all' }, 'facebook', 'each', rules);
    expect(first.settings.sending).toBe('approve_all');
    const own = withHandsOff(mine, 'facebook', 'own', rules).settings;
    expect(own.posting).toBe('own');
    expect(withHandsOff(own, 'facebook', 'myself', rules).settings).toMatchObject({
      sending: 'off',
      replies: 'draft',
      posting: 'after_ok',
    });
    // Threads' helpful posts are only ever copied: All on its own leaves them so.
    const threads = withHandsOff(mine, 'threads', 'own', rules).settings;
    expect(threads.networks.threads.posting).toBe(mine.networks.threads.posting);
  });

  it('sets every network at once from Settings → You, and says when they differ', () => {
    const networks = ['facebook', 'threads', 'linkedin'] as const;
    expect(handsOffEverywhere(mine, networks)).toBeNull();
    const { settings, picked } = withHandsOffEverywhere(mine, 'each', rules);
    expect(picked).toContain('threads');
    expect(handsOffEverywhere(settings, networks)).toBe('each');
    const pilot = withHandsOffEverywhere(mine, 'autopilot', rules).settings;
    expect(autopilotNetworks(pilot)).toEqual(['facebook', 'linkedin', 'threads']);
  });

  it('offers only the levels the business allows', () => {
    expect(handsOffAllowed('autopilot', BusinessRules.parse({ autopilotAllowed: false }))).toBe(
      false,
    );
    const stepsOnly = BusinessRules.parse({ sendingAllowed: ['off', 'steps'] });
    expect(handsOffAllowed('own', stepsOnly)).toBe(false);
    expect(handsOffAllowed('each', stepsOnly)).toBe(true);
    expect(handsOffAllowed('myself', stepsOnly)).toBe(true);
  });
});

describe('the network status card', () => {
  const tz = 'America/Chicago';
  // Tuesday 17 Nov 2026, 11:00 AM in Chicago, in the default working hours.
  const now = Date.parse('2026-11-17T17:00:00Z');
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const none = { done: 0, most: 20 };
  const live = (over: Partial<StatusLive> = {}): StatusLive => ({
    timezone: tz,
    day: { date: '2026-11-17', state: 'none', why: null, via: null, at: null },
    computer: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Chrome on Mac',
      lastSeenAt: ago(0.5),
      activeAt: null,
      working: true,
      state: 'working',
      version: '0.142.0',
    },
    limits: {
      friend_request: { done: 3, most: 20 },
      first_message: none,
      follow_up: none,
      comment: none,
      like: { done: 12, most: 70 },
    },
    warning: null,
    hours: AUTOMATION_DEFAULTS.hours,
    sending: 'steps',
    steps: [],
    ...over,
  });
  const status = (over: Partial<Parameters<typeof networkStatus>[0]> = {}) =>
    networkStatus({
      platform: 'facebook',
      live: live(),
      level: 'each',
      waiting: 0,
      people: 0,
      now,
      ...over,
    });

  it('says running, with today so far, in the working hours', () => {
    const s = status();
    expect(s.state).toBe('running');
    expect(s.title).toBe('Facebook is running');
    expect(s.chip).toMatch(/^Running till /);
    expect(s.line).toBe(
      'Today so far: 3 friend requests and 12 likes. Messages wait for your tap.',
    );
    expect(status({ level: 'autopilot' }).title).toBe('Autopilot is running Facebook');
  });

  it('says waiting on you for what only the person can do, and the rest keeps running', () => {
    expect(status({ waiting: 3 })).toMatchObject({ state: 'waiting', act: 'review' });
    expect(status({ people: 1, waiting: 3 })).toMatchObject({
      title: '1 person waits for your OK',
      act: 'people',
    });
    expect(status({ live: live({ computer: null }) })).toMatchObject({
      state: 'waiting',
      act: 'computer',
    });
    const offline = status({
      live: live({ computer: { ...live().computer!, lastSeenAt: ago(30) } }),
    });
    expect(offline).toMatchObject({ state: 'waiting', title: 'Your computer is offline' });
    expect(status({ chromeBlocked: true }).title).toBe('Facebook waits for Chrome');
  });

  it('says stopped for today on a warning, or when Stop for today was pressed', () => {
    const warned = status({
      live: live({
        warning: {
          at: ago(60),
          words: 'You’re going too fast',
          slowerUntil: ago(-10_000),
          requestsFrom: ago(-10_000),
          today: true,
        },
      }),
    });
    expect(warned).toMatchObject({ state: 'stopped', title: 'Stopped on Facebook for today' });
    expect(warned.line).toMatch(/showed a warning/);
    const pressed = status({
      live: live({
        day: { date: '2026-11-17', state: 'stopped', why: 'person', via: 'web', at: ago(5) },
      }),
    });
    expect(pressed).toMatchObject({ state: 'stopped', act: 'today' });
  });

  it('says theirs on I do it myself, and resting outside the working hours', () => {
    expect(status({ level: 'myself', live: live({ sending: 'off' }) }).state).toBe('yours');
    // 8 PM, after the working hours.
    const evening = Date.parse('2026-11-18T02:00:00Z');
    const seen = { ...live().computer!, lastSeenAt: new Date(evening).toISOString() };
    const resting = status({ now: evening, live: live({ computer: seen }) });
    expect(resting.state).toBe('resting');
    expect(resting.title).toMatch(/^Facebook starts /);
  });

  it('is stuck after the same failure 3 times in a row with nothing else there for an hour', () => {
    const failed = (
      minutes: number,
      line = 'Threads: Couldn’t open your followers list.',
    ): LiveStep => ({
      at: ago(minutes),
      kind: 'failed',
      line,
    });
    const steps = [
      failed(5),
      failed(35),
      failed(65),
      { at: ago(120), kind: 'done' as const, line: 'Threads: Followed Dana' },
    ];
    expect(stuckOn(steps, 'threads', now)).toEqual({
      since: ago(65),
      line: 'Couldn’t open your followers list.',
    });
    // Facebook's own lines aren't Threads'.
    expect(stuckOn(steps, 'facebook', now)).toBeNull();
    // Two in a row isn't stuck; nor is a step done there within the hour.
    expect(stuckOn(steps.slice(1), 'threads', now)).toBeNull();
    expect(
      stuckOn(
        [
          failed(5),
          failed(35),
          failed(65),
          { at: ago(30), kind: 'done', line: 'Threads: Liked a post' },
        ],
        'threads',
        now,
      ),
    ).toBeNull();
    // A different failure breaks the run.
    expect(
      stuckOn([failed(5), failed(35, 'Threads: Other'), failed(65)], 'threads', now),
    ).toBeNull();
    const s = status({ platform: 'threads', live: live({ steps }) });
    expect(s).toMatchObject({ state: 'stuck', title: 'Threads is stuck on one step' });
    expect(s.chip).toMatch(/^Stuck since /);
  });

  it('reads each feed line’s network, and counts today in the network’s words', () => {
    expect(networkOfLine('LinkedIn: Sent an invitation')).toBe('linkedin');
    expect(networkOfLine('X: Followed Sam')).toBe('x');
    expect(networkOfLine('Sent a friend request to Dana')).toBe('facebook');
    expect(
      soFarWords('threads', {
        friend_request: { done: 1, most: 10 },
        first_message: { done: 0, most: 5 },
        follow_up: { done: 0, most: 5 },
        comment: { done: 2, most: 15 },
        like: { done: 0, most: 40 },
      }),
    ).toBe('Today so far: 1 follow and 2 comments.');
  });
});
