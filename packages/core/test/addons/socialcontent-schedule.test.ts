/**
 * AI Social Media Content Creator's schedule (docs/socialcontent.md, "The schedule"; decisions 21 to 27): I pick and
 * AI picks, the hours AI picks learns from the creators' posts and then the business's own, trying a new hour about 1
 * in 5 times, and moving its posts that haven't gone up. No database.
 */
import { describe, expect, it } from 'vitest';
import { localDateOf, localInstant, zonedParts } from '../../src/calendar/engine/zoned';
import { planOf, type PostedTo } from '../../src/addons/socialcontent/calendar';
import {
  learnedShown,
  learnTimes,
  movesFor,
  openSlots,
  ownSamples,
  perWeekday,
  rankedHours,
  SCHEDULE,
  timesFor,
  type MovablePost,
  type TimeSample,
} from '../../src/addons/socialcontent/schedule';
import { learnedLine } from '../../src/addons/socialcontent/words';

const TZ = 'America/Chicago';
/** Tuesday 10 November 2026, noon in Chicago. */
const NOW = Date.parse('2026-11-10T18:00:00Z');
const hourIn = (at: number) => zonedParts(at, TZ).hour;
/** An instant at a local hour on a local date in Chicago. */
const at = (date: string, hour: number) =>
  localInstant(date, `${String(hour).padStart(2, '0')}:00`, TZ);

const only = (network: 'instagram' | 'facebook' | 'linkedin', p: Record<string, unknown>) =>
  planOf({
    instagram: { mode: 'ai', perWeek: 0 },
    facebook: { mode: 'ai', perWeek: 0 },
    linkedin: { mode: 'ai', perWeek: 0 },
    [network]: p,
  });

describe('AI picks: the days', () => {
  it('spreads 3 a week over Monday, Wednesday and Friday, from tomorrow, letting go of days already past', () => {
    const slots = openSlots({
      plan: only('instagram', { mode: 'ai', perWeek: 3 }),
      times: {},
      taken: [],
      timeZone: TZ,
      now: NOW,
    });
    // Monday the 9th was this week's first day, and it's past.
    expect(slots.map((s) => s.date)).toEqual([
      '2026-11-11',
      '2026-11-13',
      '2026-11-16',
      '2026-11-18',
      '2026-11-20',
      '2026-11-23',
    ]);
    expect(slots.every((s) => s.network === 'instagram')).toBe(true);
    // With nothing learned it starts near the plan's time; a new hour now and then.
    for (const s of slots) expect(s.trying ? true : hourIn(s.at) === 9).toBe(true);
  });

  it('counts a post moved by hand toward its week, on the nearest day, and a skipped one not at all', () => {
    const slots = openSlots({
      plan: only('instagram', { mode: 'ai', perWeek: 3 }),
      times: {},
      taken: [
        // Moved by hand to Tuesday the 17th: it takes Monday the 16th's place (the nearest), not a fourth post.
        { network: 'instagram', postAt: at('2026-11-17', 15), state: 'draft' },
        { network: 'instagram', postAt: at('2026-11-18', 9), state: 'skipped' },
        { network: 'instagram', postAt: null, state: 'draft' },
        // What went up on Monday the 9th still counts toward this week.
        { network: 'instagram', postAt: at('2026-11-09', 9), state: 'posted' },
      ],
      timeZone: TZ,
      now: NOW,
    });
    expect(slots.map((s) => s.date)).toEqual([
      '2026-11-11',
      '2026-11-13',
      '2026-11-18',
      '2026-11-20',
      '2026-11-23',
    ]);
  });

  it('puts more than 7 a week two to a day, up to the most a day', () => {
    expect(perWeekday(10)).toEqual([1, 2, 1, 2, 1, 2, 1]);
    expect(perWeekday(21)).toEqual([3, 3, 3, 3, 3, 3, 3]);
    const slots = openSlots({
      plan: only('facebook', { mode: 'ai', perWeek: 10, perDay: 2 }),
      times: {},
      taken: [],
      timeZone: TZ,
      now: NOW,
      days: 7,
    });
    const friday = slots.filter((s) => s.date === '2026-11-13');
    expect(friday).toHaveLength(2);
    // Two on one day go at least two hours apart.
    expect(Math.abs(hourIn(friday[0]!.at) - hourIn(friday[1]!.at))).toBeGreaterThanOrEqual(2);
    expect(slots.filter((s) => s.date === '2026-11-14')).toHaveLength(1);
  });

  it('keeps every hour between the plan’s hours', () => {
    const plan = only('linkedin', { mode: 'ai', perWeek: 21, from: '10:30', to: '13:00' });
    const slots = openSlots({ plan, times: {}, taken: [], timeZone: TZ, now: NOW });
    expect(slots.length).toBeGreaterThan(30);
    for (const s of slots) expect([11, 12, 13]).toContain(hourIn(s.at));
  });
});

describe('I pick', () => {
  it('puts a post at each time picked on each day, less the nearest one for each post that day', () => {
    const week = [[], ['08:00', '17:30'], [], ['12:00'], [], [], ['10:00']];
    const slots = openSlots({
      plan: only('facebook', { mode: 'mine', week }),
      times: {},
      taken: [{ network: 'facebook', postAt: at('2026-11-16', 16), state: 'ready' }],
      timeZone: TZ,
      now: NOW,
    });
    expect(slots.map((s) => [s.date, hourIn(s.at)])).toEqual([
      ['2026-11-11', 12],
      ['2026-11-14', 10],
      ['2026-11-16', 8],
      ['2026-11-18', 12],
      ['2026-11-21', 10],
      ['2026-11-23', 8],
      ['2026-11-23', 17],
    ]);
    expect(slots.every((s) => !s.trying)).toBe(true);
  });
});

const sample = (hour: number, times: number, own = false, network = 'instagram'): TimeSample => ({
  network,
  at: at('2026-10-01', hour),
  times,
  own,
});

describe('learning the hours', () => {
  it('leans to the hours the creators’ best posts went up at, before its own posts tell (decision 25)', () => {
    const times = learnTimes(
      [
        ...Array.from({ length: 6 }, () => sample(18, 4)),
        ...Array.from({ length: 6 }, () => sample(9, 1)),
      ],
      TZ,
    );
    const ig = times.instagram!;
    expect(ig.from).toBe('creators');
    expect(ig.counts[18]).toBe(6);
    expect(ig.hours[18]!).toBeGreaterThan(ig.hours[9]!);
    // Facebook has no creators of its own: everyone's hours stand in.
    expect(times.facebook!.creators).toBe(12);
    const plan = planOf({});
    expect(rankedHours(plan.instagram, ig)[0]).toBe(18);
    expect(learnedShown(plan, times).instagram.best[0]).toBe('18:00');
  });

  it('counts its own posts more, and only its own once 10 have numbers there', () => {
    const creators = Array.from({ length: 8 }, () => sample(18, 4));
    const fewOwn = Array.from({ length: 3 }, () => sample(12, 3, true));
    const some = learnTimes([...creators, ...fewOwn], TZ).instagram!;
    expect(some.from).toBe('both');
    expect(some.own).toBe(3);
    const many = learnTimes(
      [...creators, ...Array.from({ length: SCHEDULE.ownEnough }, () => sample(12, 3, true))],
      TZ,
    ).instagram!;
    expect(many.from).toBe('own');
    expect(many.creators).toBe(0);
    expect(many.hours[18]).toBeNull();
    expect(rankedHours(planOf({}).instagram, many)[0]).toBe(12);
  });

  it('lets one post that took off count for 5 times its normal at most', () => {
    const t = learnTimes(
      [sample(10, 400), sample(10, 400), sample(15, 2), sample(15, 2)],
      TZ,
    ).instagram!;
    // Two posts at 5 times, with the one normal post every hour starts with: (5 + 5 + 1) / 3, near enough.
    expect(t.hours[10]).toBeLessThanOrEqual(SCHEDULE.timesMost);
    expect(t.hours[10]).toBeGreaterThan(3);
  });

  it('weighs its own posts by views where shown, else likes plus comments, against its own normal (decision 23)', () => {
    const up = (hour: number): PostedTo[] => [
      {
        place: 'feed',
        link: 'https://x.test/p',
        at: new Date(at('2026-10-01', hour)).toISOString(),
      },
    ];
    const read = (views: number | null, likes: number) => ({
      d7: { at: '2026-10-08T00:00:00Z', days: 7, views, likes, comments: 0, shares: null },
    });
    const samples = ownSamples([
      { network: 'instagram', postedTo: up(19), numbers: { feed: read(3000, 10) } },
      { network: 'instagram', postedTo: up(9), numbers: { feed: read(1000, 90) } },
      { network: 'instagram', postedTo: up(10), numbers: { feed: read(1000, 90) } },
      { network: 'instagram', postedTo: up(11), numbers: { feed: read(1000, 90) } },
      // Too few to make a normal on likes and comments alone.
      { network: 'instagram', postedTo: up(12), numbers: { feed: read(null, 50) } },
    ]);
    expect(samples).toHaveLength(4);
    expect(samples[0]!.times).toBe(3);
    expect(samples[1]!.times).toBe(1);
    expect(samples.every((s) => s.own)).toBe(true);
  });

  it('says what it learned in a line', () => {
    expect(learnedLine({ best: [], from: 'none', own: 0, creators: 0 }, '09:00')).toMatch(
      /^Nothing learned yet: it starts near 9:00 AM/,
    );
    expect(
      learnedLine({ best: ['18:00', '09:00'], from: 'creators', own: 0, creators: 24 }, '09:00'),
    ).toBe(
      'Best times so far: 6:00 PM and 9:00 AM, from 24 posts by the creators you study. About 1 in 5 posts go at a new time, so it keeps learning.',
    );
  });
});

describe('trying a new hour (decision 26)', () => {
  it('tries the hour it knows least about about 1 in 5 times, the same way every time', () => {
    const plan = planOf({}).instagram;
    const times = learnTimes(
      Array.from({ length: 20 }, (_, i) => sample(9 + (i % 3), 2)),
      TZ,
    ).instagram!;
    const days = Array.from({ length: 400 }, (_, d) => localDateOf(NOW + d * 86_400_000, TZ));
    const picks = days.map((date) => timesFor('instagram', date, plan, times, 1)[0]!);
    const tried = picks.filter((p) => p.trying);
    expect(tried.length / picks.length).toBeGreaterThan(0.12);
    expect(tried.length / picks.length).toBeLessThan(0.28);
    // Never at an hour it learned from: those have posts already.
    for (const p of tried) expect(['09:00', '10:00', '11:00']).not.toContain(p.time);
    expect(days.map((date) => timesFor('instagram', date, plan, times, 1)[0])).toEqual(picks);
  });
});

describe('moving the AI’s posts to better hours (decision 27)', () => {
  const plan = only('instagram', { mode: 'ai', perWeek: 3 });
  const learned = learnTimes(
    Array.from({ length: 8 }, () => sample(18, 4)),
    TZ,
  );
  const post = (id: string, postAt: number, extra: Partial<MovablePost> = {}): MovablePost => ({
    id,
    network: 'instagram',
    postAt,
    state: 'draft',
    placedBy: 'ai',
    ...extra,
  });

  it('moves its drafts and OK’d posts on their days, never a person’s, one going up soon, or I pick’s', () => {
    const moves = movesFor({
      plan,
      times: learned,
      timeZone: TZ,
      now: NOW,
      posts: [
        post('draft', at('2026-11-13', 9)),
        post('okd', at('2026-11-16', 9), { state: 'ready' }),
        post('theirs', at('2026-11-18', 9), { placedBy: 'person' }),
        post('up', at('2026-11-20', 9), { state: 'posted' }),
        post('soon', NOW + 10 * 60_000),
      ],
    });
    expect(moves.map((m) => m.id).sort()).toEqual(['draft', 'okd']);
    for (const m of moves) {
      expect(localDateOf(m.to, TZ)).toBe(localDateOf(m.from, TZ));
      expect(m.to).not.toBe(m.from);
    }
    const mine = movesFor({
      plan: only('instagram', { mode: 'mine', week: [[], ['09:00'], [], [], [], [], []] }),
      times: learned,
      timeZone: TZ,
      now: NOW,
      posts: [post('draft', at('2026-11-16', 9))],
    });
    expect(mine).toEqual([]);
  });

  it('leaves a post where it is once it’s at the AI’s hour', () => {
    const first = movesFor({
      plan,
      times: learned,
      timeZone: TZ,
      now: NOW,
      posts: [post('draft', at('2026-11-13', 9))],
    });
    expect(first).toHaveLength(1);
    const again = movesFor({
      plan,
      times: learned,
      timeZone: TZ,
      now: NOW,
      posts: [post('draft', first[0]!.to)],
    });
    expect(again).toEqual([]);
  });

  it('writes a new post at the hour a move would put it at, so the two agree', () => {
    const [slot] = openSlots({ plan, times: learned, taken: [], timeZone: TZ, now: NOW });
    const moves = movesFor({
      plan,
      times: learned,
      timeZone: TZ,
      now: NOW,
      posts: [post('new', slot!.at)],
    });
    expect(moves).toEqual([]);
  });
});
