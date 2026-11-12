/**
 * AI Social Media Content Creator setting itself up (docs/socialcontent.md, "Setting up on its own"; decisions 28 to
 * 33): how creators' posts do for their followers, who it picks to study and who it swaps out each month, when it
 * starts writing, and the steps the Creators page shows. No database.
 */
import { describe, expect, it } from 'vitest';
import {
  checkedMatches,
  matchPrompt,
  type MatchCreator,
} from '../../src/addons/socialcontent/match-ai';
import {
  engagementOf,
  pickCreators,
  PICKING,
  recentKept,
  RecentPost,
  setupDone,
  SetupMarks,
  setupSteps,
  swapsFor,
  versionAtLeast,
  writeWaitsOn,
  type PickCandidate,
  type SetupFacts,
} from '../../src/addons/socialcontent/picking';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-12T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const post = (likes: number | null, comments: number | null = 0): RecentPost =>
  RecentPost.parse({ likes, comments });

describe('likes and comments for their followers', () => {
  it('takes the middle of their latest posts, so one big hit doesn’t count for much', () => {
    // 1%, 2%, 3% and one post that took off: the middle of the four is 2.5%.
    const recent = [post(90, 10), post(180, 20), post(250, 50), post(9_000, 1_000)];
    expect(engagementOf(recent, 10_000)).toBe(0.025);
  });

  it('says nothing under 3 posts with numbers, or with no followers known', () => {
    expect(engagementOf([post(100), post(200), post(null, null)], 10_000)).toBeNull();
    expect(engagementOf([post(100), post(200), post(300)], null)).toBeNull();
    expect(engagementOf([post(100), post(200), post(300)], 0)).toBeNull();
    expect(engagementOf(null, 10_000)).toBeNull();
  });

  it('keeps the latest 6 with words or numbers, their captions on one line and cut short', () => {
    const long = RecentPost.parse({ caption: `  Fix a\n\nleak   ${'x'.repeat(400)}` });
    expect(long.caption).toHaveLength(PICKING.captionKept);
    expect(long.caption!.startsWith('Fix a leak x')).toBe(true);
    const kept = recentKept([
      RecentPost.parse({}),
      long,
      ...Array.from({ length: 8 }, (_, i) => post(i)),
    ]);
    expect(kept).toHaveLength(PICKING.recentKept);
    expect(kept[0]).toBe(long);
  });
});

/** A suggested Instagram creator who did well, read today with their latest posts. */
const creator = (id: string, over: Partial<PickCandidate> = {}): PickCandidate => ({
  id,
  network: 'instagram',
  state: 'suggested',
  followers: 20_000,
  lastPostAt: ago(2),
  profileReadAt: ago(0),
  match: 8,
  engagement: null,
  recentRead: true,
  ...over,
});
const pick = (
  candidates: PickCandidate[],
  over: Partial<Parameters<typeof pickCreators>[0]> = {},
) =>
  pickCreators({
    candidates,
    studying: {},
    networks: ['instagram'],
    canRead: true,
    readsRecent: true,
    now: NOW,
    ...over,
  });

describe('picking who to study (decision 30)', () => {
  it('picks the closest matches, never one under 6 of 10, one not suggested, or one that didn’t do well', () => {
    const { pick: picked, readFirst } = pick([
      creator('close', { match: 9 }),
      creator('near', { match: 6 }),
      creator('far', { match: 5 }),
      creator('unknown', { match: null }),
      creator('skipped', { state: 'skipped', match: 10 }),
      creator('small', { followers: 4_000, match: 10 }),
      creator('quiet', { lastPostAt: ago(40), match: 10 }),
    ]);
    expect(readFirst).toEqual([]);
    expect(picked.map((p) => p.id)).toEqual(['close', 'near']);
  });

  it('picks up to 10 on a network, counting those already studied', () => {
    const many = Array.from({ length: 15 }, (_, i) => creator(`c${i}`));
    expect(pick(many).pick).toHaveLength(PICKING.perNetwork);
    expect(pick(many, { studying: { instagram: 7 } }).pick).toHaveLength(3);
    expect(pick(many, { studying: { instagram: 10 } }).pick).toEqual([]);
  });

  it('adds up to 3 for the best likes and comments for their followers among the closest', () => {
    const { pick: picked } = pick(
      [
        creator('closest', { match: 9, engagement: 0.005 }),
        creator('liked', { match: 7, engagement: 0.06 }),
        creator('middling', { match: 8, engagement: 0.02 }),
      ],
      { studying: { instagram: 8 } },
    );
    // liked: 7 + 3 = 10; middling: 8 + 1.5 = 9.5; closest: 9 + 0 = 9.
    expect(picked.map((p) => p.id)).toEqual(['liked', 'middling']);
  });

  it('reads the closest profiles first when not read lately, or never with their latest posts', () => {
    const candidates = [
      creator('fresh'),
      creator('old', { profileReadAt: ago(PICKING.freshDays + 1) }),
      creator('never', { profileReadAt: null }),
      creator('no-posts', { recentRead: false }),
    ];
    const first = pick(candidates);
    expect(first.pick).toEqual([]);
    expect(first.readFirst.map((r) => r.id)).toEqual(['old', 'never', 'no-posts']);
    // An older extension can't read their latest posts, so it doesn't wait for them.
    expect(pick(candidates, { readsRecent: false }).readFirst.map((r) => r.id)).toEqual([
      'old',
      'never',
    ]);
    // With no reading computer it picks from what it knows.
    const blind = pick(candidates, { canRead: false });
    expect(blind.readFirst).toEqual([]);
    expect(blind.pick.map((p) => p.id).sort()).toEqual(['fresh', 'never', 'no-posts', 'old']);
  });

  it('works out each network on its own', () => {
    const { pick: picked } = pick([creator('ig'), creator('fb', { network: 'facebook' })], {
      networks: ['instagram', 'facebook'],
      studying: { facebook: 10 },
    });
    expect(picked).toEqual([{ id: 'ig', network: 'instagram' }]);
  });
});

describe('swapping out quiet creators each month (decision 31)', () => {
  const picked = (id: string, over: Partial<Parameters<typeof swapsFor>[0][number]> = {}) => ({
    id,
    lastPostAt: ago(3),
    postsReadAt: ago(1),
    postsCount: 40,
    standoutsCount: 4,
    ...over,
  });

  it('swaps one with no post in 45 days, or under 1 standout in 30 posts once 30 are read', () => {
    expect(
      swapsFor(
        [
          picked('busy'),
          picked('quiet', { lastPostAt: ago(50) }),
          picked('flat', { postsCount: 60, standoutsCount: 1 }),
          picked('few-read', { postsCount: 20, standoutsCount: 0 }),
          picked('unread', { postsReadAt: null, lastPostAt: ago(90) }),
        ],
        NOW,
      ),
    ).toEqual([
      { id: 'quiet', why: 'Swapped out by the AI: no posts in 50 days.' },
      { id: 'flat', why: 'Swapped out by the AI: 1 standout in 60 posts.' },
    ]);
  });
});

const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  autoPick: true,
  autoFill: true,
  marks: { startedAt: ago(1), nichesAt: ago(1), findAt: ago(1) },
  readerSet: true,
  nichesPicked: 3,
  findsLeft: 0,
  readsLeft: 0,
  networks: [{ network: 'instagram', studying: 10, byAi: 10, pickable: 4 }],
  noted: 12,
  playbookAt: ago(0),
  filledAt: null,
  offerLive: true,
  listsFilled: 11,
  listsAll: 11,
  ...over,
});
const stepOf = (f: SetupFacts, key: string) => setupSteps(f, NOW).find((s) => s.key === key)!;

describe('when it starts writing (decision 32)', () => {
  it('waits for the main offer, then its lists for content, then the Playbook or 3 days', () => {
    expect(writeWaitsOn(facts({ offerLive: false }), NOW)).toBe('offer');
    expect(writeWaitsOn(facts({ listsFilled: 9 }), NOW)).toBe('lists');
    expect(writeWaitsOn(facts({ playbookAt: null }), NOW)).toBe('playbook');
    expect(
      writeWaitsOn(
        facts({ playbookAt: null, marks: { startedAt: ago(PICKING.writeAfterDays) } }),
        NOW,
      ),
    ).toBeNull();
    expect(writeWaitsOn(facts(), NOW)).toBeNull();
  });

  it('says on the page what writing waits on, with where to fix it', () => {
    expect(stepOf(facts({ offerLive: false }), 'write')).toMatchObject({
      state: 'waiting',
      fix: 'main-offer',
    });
    expect(stepOf(facts({ listsFilled: 9 }), 'write')).toMatchObject({
      state: 'waiting',
      fix: 'main-offer-lists',
      line: 'Waits for For your content in Settings → Main offer: 9 of 11 lists filled.',
    });
    expect(stepOf(facts({ playbookAt: null }), 'write').line).toBe(
      'Starts once the Playbook is written, or in 2 days anyway.',
    );
    expect(stepOf(facts({ autoFill: false }), 'write')).toMatchObject({
      state: 'off',
      fix: 'settings',
    });
    expect(stepOf(facts({ filledAt: ago(1) }), 'write').line).toBe(
      'Filled the calendar yesterday. Each post waits for your OK.',
    );
  });
});

describe('the steps the Creators page shows (decision 28)', () => {
  it('waits on a reading computer first, with a link to Settings', () => {
    const steps = setupSteps(
      facts({
        readerSet: false,
        marks: {},
        nichesPicked: 0,
        networks: [{ network: 'instagram', studying: 0, byAi: 0, pickable: 0 }],
        noted: 0,
        playbookAt: null,
      }),
      NOW,
    );
    expect(steps.map((s) => [s.key, s.state])).toEqual([
      ['reader', 'waiting'],
      ['niches', 'waiting'],
      ['find', 'waiting'],
      ['pick', 'waiting'],
      ['study', 'waiting'],
      ['write', 'waiting'],
    ]);
    expect(steps[0]!.fix).toBe('settings');
    expect(setupDone(steps)).toBe(false);
  });

  it('shows the searches and profile reads left, and how many are studied on each network', () => {
    expect(stepOf(facts({ findsLeft: 2 }), 'find')).toMatchObject({
      state: 'doing',
      line: '2 searches left on the reading computer.',
    });
    expect(
      stepOf(
        facts({
          readsLeft: 5,
          networks: [{ network: 'instagram', studying: 3, byAi: 3, pickable: 9 }],
        }),
        'pick',
      ),
    ).toMatchObject({
      state: 'doing',
      line: 'Reading 5 profiles first, for their latest likes and comments. Instagram 3 of 10.',
    });
    // Fewer than 10, but nobody left it could pick: done until the next search.
    expect(
      stepOf(
        facts({ networks: [{ network: 'instagram', studying: 6, byAi: 6, pickable: 0 }] }),
        'pick',
      ).state,
    ).toBe('done');
  });

  it('says a person ticks when picking on its own is off, and is done once each step is done or off', () => {
    const off = facts({ autoPick: false, autoFill: false });
    expect(stepOf(off, 'pick')).toMatchObject({
      state: 'off',
      line: 'You tick who to study. Instagram 10 of 10.',
    });
    expect(setupDone(setupSteps(off, NOW))).toBe(true);
    expect(setupDone(setupSteps(facts({ filledAt: ago(0) }), NOW))).toBe(true);
    expect(setupDone(setupSteps(facts(), NOW))).toBe(false);
  });

  it('reads marks it doesn’t know as none', () => {
    expect(SetupMarks.parse('nonsense')).toEqual({});
    expect(SetupMarks.parse({ startedAt: ago(0), extra: 1 })).toEqual({ startedAt: ago(0) });
  });
});

describe('how close the AI says each creator is', () => {
  const creators: MatchCreator[] = [
    {
      id: 'a',
      shown: '@pipequeen',
      name: 'Pipe Queen',
      bio: 'Plumbing tips',
      followers: 48_000,
      recent: [RecentPost.parse({ caption: 'Fix a drip in 5 minutes' })],
    },
    { id: 'b', shown: '@crm_guy', name: null, bio: null, followers: null, recent: null },
  ];

  it('shows the AI each creator by a ref, never their id, with their bio and latest captions', () => {
    const prompt = matchPrompt({
      business: 'Business: Pipe Dreams',
      niches: ['Home plumbing'],
      creators,
    });
    expect(prompt).toContain('<creator id="C1">');
    expect(prompt).toContain('Fix a drip in 5 minutes');
    expect(prompt).toContain('Latest posts: (not read)');
    expect(prompt).not.toMatch(/id="a"/);
  });

  it('keeps 0 to 10 for each creator it was asked about, once, with why cut short', () => {
    expect(
      checkedMatches(
        {
          creators: [
            { ref: 'C1', match: 12.4, why: '  Same   customers.  ' },
            { ref: 'C1', match: 1, why: 'Again.' },
            { ref: 'C2', match: -3, why: '' },
            { ref: 'C9', match: 8, why: 'Not asked about.' },
          ],
        },
        creators,
      ),
    ).toEqual([
      { creatorId: 'a', match: 10, why: 'Same customers.' },
      { creatorId: 'b', match: 0, why: null },
    ]);
  });
});

describe('the extension’s version', () => {
  it('reads their latest posts from 0.136.0', () => {
    expect(versionAtLeast('0.136.0', '0.136.0')).toBe(true);
    expect(versionAtLeast('0.136.2', '0.136.0')).toBe(true);
    expect(versionAtLeast('1.0', '0.136.0')).toBe(true);
    expect(versionAtLeast('0.135.9', '0.136.0')).toBe(false);
    expect(versionAtLeast(null, '0.136.0')).toBe(false);
  });
});
