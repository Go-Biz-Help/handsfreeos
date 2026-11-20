/**
 * Social Outreach: the ways a playbook may start a chat (docs/outreach.md, decision 183), without the database. A
 * playbook ticks the ways the AI may use, none to start on a new one; for each person the AI picks the one that fits,
 * leaving out a way missing what it needs; a playbook saved before them goes the one way it chose then; and the
 * editors' list, the card's line and the Test console say what's ticked and what was picked.
 */
import { describe, expect, it } from 'vitest';
import {
  visitLine,
  WARM_BEFORE_HI_DAYS,
  warmBeforeHiWhy,
} from '../../src/addons/outreach/keep-warm';
import {
  firstMessageChoices,
  kindOfWay,
  kindStartsAChat,
  OPENER_KIND_KEYS,
  openerKey,
  openersOf,
  wayOfKind,
} from '../../src/addons/outreach/openers';
import { TEST_WORDS, testAdds, testLabel } from '../../src/addons/outreach/playbook-test';
import {
  blankPlaybook,
  NEW_PLAYBOOK_WAYS,
  PLAYBOOK_KEPT_KEYS,
  PLAYBOOK_TEMPLATES,
  PlaybookDetails,
  upgradePlaybookDetails,
} from '../../src/addons/outreach/playbooks';
import {
  chatsOnly,
  firstMessagesOf,
  OPEN_WAY_KEYS,
  OPEN_WAYS,
  opensFor,
  partShown,
  pitchVersionsOf,
  scriptOf,
  STARTING_WAYS,
  startsChats,
  wayMissing,
  wayRows,
  waysIssue,
  waysLine,
  waysOf,
  WAYS_WORDS,
  withWay,
} from '../../src/addons/outreach/script';
import { fallbackWay, openerTask, wayOf } from '../../src/addons/outreach/today';

const crm = PLAYBOOK_TEMPLATES.crm_demos.details;
const all = { proof: true, useful: true, video: true };
const none = { proof: false, useful: false, video: false };

describe('the ways a playbook may start a chat', () => {
  it('has the ten ways, each with its own words, and what follows each', () => {
    expect(OPEN_WAY_KEYS).toEqual([
      'pitch',
      'intro',
      'valueFirst',
      'trigger',
      'compliment',
      'opinion',
      'socialProof',
      'permission',
      'sharedGround',
      'problemCheck',
    ]);
    for (const way of OPEN_WAY_KEYS) {
      const part = OPEN_WAYS[way].part;
      if (part !== 'first' && part !== 'intro') expect(STARTING_WAYS[part]).toBeTruthy();
    }
    // Shared ground never names a group (decision 157).
    expect(STARTING_WAYS.sharedGround).toContain('Never a group you’re both in');
    expect(OPEN_WAYS.sharedGround.hint).toContain('Never a group');
  });

  it('goes the one way it chose before them, and none on a new one till ticked (the owner’s 7a)', () => {
    expect(waysOf(blankPlaybook())).toEqual(['pitch']);
    expect(waysOf({ ...blankPlaybook(), opens: 'intro' })).toEqual(['intro']);
    expect(waysOf({ ...blankPlaybook(), ways: [...NEW_PLAYBOOK_WAYS] })).toEqual([]);
    expect(waysIssue([])).toBe(WAYS_WORDS.none);
    expect(waysIssue(['compliment'])).toBeNull();
    // Old phones still read `opens`: an introduction when every way ticked starts a chat.
    expect(opensFor(['intro'])).toBe('intro');
    expect(opensFor(['compliment', 'sharedGround'])).toBe('intro');
    expect(opensFor(['pitch', 'intro'])).toBe('pitch');
    expect(chatsOnly({ ways: ['intro', 'compliment'] })).toBe(true);
    expect(startsChats({ ways: ['pitch', 'compliment'] })).toBe(true);
    expect(startsChats({ ways: ['pitch', 'valueFirst'] })).toBe(false);
  });

  it('keeps the ways saved when an old phone saves without them, and the upgrade leaves them be', () => {
    expect(PLAYBOOK_KEPT_KEYS).toContain('ways');
    // A playbook in today's shape comes back as it was: no ways are filled in from `opens`.
    expect(upgradePlaybookDetails(crm)).toBe(crm);
    const old = { ...blankPlaybook(), opens: 'intro' as const };
    expect(PlaybookDetails.parse(upgradePlaybookDetails(old)).ways).toBeUndefined();
    expect(() => PlaybookDetails.parse({ ...blankPlaybook(), ways: ['pitch', 'pitch'] })).toThrow();
  });

  it('shows each way’s part only while it’s ticked, and the pitch for Reconnect always', () => {
    expect(partShown('compliment', ['pitch'])).toBe(false);
    expect(partShown('compliment', ['compliment'])).toBe(true);
    expect(partShown('intro', ['pitch', 'intro'])).toBe(true);
    expect(partShown('first', ['intro'])).toBe(true);
  });

  it('lists the first messages way by way, the pitch’s versions to take turns', () => {
    const d = { ...crm, ways: ['pitch', 'compliment'] as const };
    const firsts = firstMessagesOf({ ...d, ways: [...d.ways] });
    expect(firsts.map((f) => f.way)).toEqual([
      ...scriptOf(crm).first.map(() => 'pitch'),
      'compliment',
    ]);
    expect(firsts.at(-1)!.text).toBe(STARTING_WAYS.compliment);
    expect(pitchVersionsOf({ ...crm, ways: ['compliment'] })).toBe(0);
    expect(openersOf({ ...crm, ways: ['compliment'] })).toEqual([
      { kind: 'compliment', text: STARTING_WAYS.compliment },
    ]);
  });
});

describe('the editors’ list', () => {
  it('draws every way, ticked or not, with what follows it, whom it suits and what’s missing (6a)', () => {
    const rows = wayRows(['pitch', 'socialProof'], none);
    expect(rows.map((r) => r.way)).toEqual(OPEN_WAY_KEYS);
    const proof = rows.find((r) => r.way === 'socialProof')!;
    expect(proof).toMatchObject({
      on: true,
      missing: WAYS_WORDS.needs.proof,
      flow: WAYS_WORDS.flow.ask,
    });
    expect(proof.tags).toEqual(['Works well on LinkedIn']);
    expect(rows.find((r) => r.way === 'problemCheck')!.tags).toEqual([
      'Best for businesses',
      'Works well on LinkedIn',
    ]);
    expect(rows.find((r) => r.way === 'compliment')).toMatchObject({
      on: false,
      missing: null,
      flow: WAYS_WORDS.flow.chat,
      tags: ['Works well on Facebook and Instagram'],
    });
    expect(wayRows([], all).every((r) => r.missing === null)).toBe(true);
  });

  it('keeps the list’s order as ways are ticked and unticked', () => {
    expect(withWay(['compliment'], 'pitch', true)).toEqual(['pitch', 'compliment']);
    expect(withWay(['pitch', 'compliment'], 'pitch', false)).toEqual(['compliment']);
    expect(withWay(['pitch'], 'pitch', true)).toEqual(['pitch']);
  });

  it('says on the card how it starts a chat', () => {
    expect(waysLine({ ...crm, ways: [] })).toBe(
      'No way to start a chat is ticked yet, so it starts none. Tick one under What it says.',
    );
    expect(waysLine({ ...crm, ways: ['pitch', 'compliment'] })).toBe(
      'Picks one of 2 ways to start a chat for each person: Direct pitch, Compliment first.',
    );
    expect(waysLine({ ...crm, ways: ['compliment'] })).toBe(
      `Starts with Compliment first: ${STARTING_WAYS.compliment}`,
    );
  });
});

describe('picking a way for someone', () => {
  it('leaves out a way missing what it needs, and falls back on the pitch when none can go', () => {
    expect(wayMissing('permission', none)).toBe('video');
    expect(wayMissing('permission', all)).toBeNull();
    const d = {
      ...crm,
      ways: ['valueFirst', 'socialProof', 'opinion'] as (
        'valueFirst' | 'socialProof' | 'opinion'
      )[],
    };
    expect(firstMessageChoices(d, new Map(), none).map((c) => c.way)).toEqual(['opinion']);
    // In the list's order, whatever order they were ticked in.
    expect(firstMessageChoices(d, new Map(), all).map((c) => c.way)).toEqual([
      'valueFirst',
      'opinion',
      'socialProof',
    ]);
    const stuck = { ...crm, ways: ['socialProof'] as 'socialProof'[] };
    expect(firstMessageChoices(stuck, new Map(), none).map((c) => c.way)).toEqual(['pitch']);
  });

  it('puts the ways used least first, so the AI takes turns', () => {
    const d = { ...crm, ways: ['opinion', 'compliment'] as ('opinion' | 'compliment')[] };
    // None used yet: the list's order.
    expect(firstMessageChoices(d, new Map(), all).map((c) => c.way)).toEqual([
      'compliment',
      'opinion',
    ]);
    const used = new Map([[openerKey({ kind: 'compliment', text: STARTING_WAYS.compliment }), 3]]);
    expect(firstMessageChoices(d, used, all).map((c) => c.way)).toEqual(['opinion', 'compliment']);
  });

  it('tells the AI the ways, how to pick, the network’s lean, and to say which it used', () => {
    const task = openerTask(
      [
        { way: 'pitch', text: 'Open to more jobs this month?' },
        { way: 'compliment', text: STARTING_WAYS.compliment },
        { way: 'socialProof', text: STARTING_WAYS.socialProof },
      ],
      { fresh: true, two: false, platform: 'linkedin' },
    );
    expect(task).toContain('Way 1, pitch (Direct pitch)');
    expect(task).toContain('Way 2, compliment (Compliment first)');
    expect(task).toContain('On LinkedIn, Social proof tend to work best');
    expect(task).toContain('When none fits, use Direct pitch (pitch).');
    expect(task).toContain('under wayWhy');
    expect(fallbackWay(['compliment', 'opinion'])).toBe('opinion');
  });

  it('takes the AI’s word on the way when it’s one offered, else the one way or the fallback', () => {
    const two = [{ way: 'opinion' as const }, { way: 'compliment' as const }];
    expect(wayOf({ way: 'compliment' }, two)).toBe('compliment');
    expect(wayOf({ way: 'trigger' }, two)).toBe('opinion');
    expect(wayOf({ way: null }, [{ way: 'trigger' }])).toBe('trigger');
    expect(wayOf({ way: 'pitch' }, [])).toBeNull();
  });

  it('counts each way apart in Results, the pitch as the first message', () => {
    expect(kindOfWay('pitch')).toBe('own');
    for (const way of OPEN_WAY_KEYS) expect(wayOfKind(kindOfWay(way))).toBe(way);
    expect(OPENER_KIND_KEYS).toEqual(
      expect.arrayContaining(OPEN_WAY_KEYS.filter((w) => w !== 'pitch')),
    );
    expect(kindStartsAChat('sharedGround')).toBe(true);
    expect(kindStartsAChat('own')).toBe(false);
  });
});

describe('the Test console', () => {
  it('labels the first message by its way, and says which it picked and why', () => {
    expect(testLabel('opener', { way: 'socialProof' })).toBe('First message: Social proof');
    const out = {
      theirs: null,
      answer: null,
      read: null,
      kind: 'opener' as const,
      label: 'First message: Compliment first',
      message: 'Love the deck you just finished, Sam! How long did it take?',
      others: [],
      note: null,
      next: null,
      unanswered: null,
      state: null,
      about: null,
      aboutYou: false,
      way: 'compliment' as const,
      why: 'They just posted a deck they finished',
    };
    expect(testAdds(out as never, 'start').lines.find((l) => l.kind === 'note')).toEqual({
      kind: 'note',
      text: 'It picked Compliment first: They just posted a deck they finished.',
    });
    expect(TEST_WORDS.noWays).toContain('Tick one under What it says');
  });
});

describe('warming up before the first message (the owner’s 4b)', () => {
  it('says hi a few days after the first like, and says so on Today and in the ticker', () => {
    expect(WARM_BEFORE_HI_DAYS).toBe(3);
    expect(warmBeforeHiWhy('2026-11-23T12:00:00Z')).toEqual([
      'Warming up before your first message',
      'Like 1 or 2 of their newest posts every few days, then say hi from Nov 23',
    ]);
    expect(visitLine('Sam Lee', 'facebook', 1, true)).toBe(
      'Liked a post of Sam Lee’s before your first message',
    );
    expect(visitLine('Sam Lee', 'facebook', 1)).toBe(
      'Liked a post of Sam Lee’s while they decide on your friend request',
    );
  });
});
