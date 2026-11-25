/**
 * Changes to today's plan (src/addons/outreach/plan-changes.ts, docs/outreach.md decision 195, step 3): Do now, Skip
 * today and Move to a time, as the day's rules read them (`nextMove`), as the plan shows them (`planAhead`,
 * `planRow`), and as today's list is cut for the extension (`listWithoutOut`). A change only picks among what the day
 * would do anyway: every wait and limit of the rules stays.
 */
import { describe, expect, it } from 'vitest';
import { NO_LISTS, type ListsSaved } from '../../src/addons/outreach/lists';
import {
  freshPlanDay,
  moveChangeKey,
  nextMove,
  planAhead,
  planRow,
  planShown,
  planUntil,
  rowCan,
  type PlanDay,
  type PlanFacts,
} from '../../src/addons/outreach/plan';
import {
  changesAt,
  itemChangeKeys,
  jobChangeKey,
  listWithoutOut,
  PLAN_CHANGE_UI,
  PlanChangeInput,
  planMoveStart,
  planMoveTimes,
  workChangeKey,
  workInLine,
  type PlanChange,
} from '../../src/addons/outreach/plan-changes';
import { ASKS_SINCE, NEXT_SINCE } from '../../src/addons/outreach/plan-next';
import { PLATFORM_KEYS } from '../../src/addons/outreach/networks';
import { itemKey, type PlanItem, type Work } from '../../src/addons/outreach/plan-rules';
import { RUNNERS } from '../../src/addons/outreach/runners';
import type { TodayKind } from '../../src/addons/outreach/today';

const TZ = 'America/Chicago';
/** 10 a.m. on Tuesday, October 13 2026, in Chicago: an hour into the working hours. */
const NOW = Date.parse('2026-10-13T15:00:00Z');
const TODAY = '2026-10-13';
const FIVE_PM = Date.parse('2026-10-13T22:00:00Z');
const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const HOURS = { start: 9, end: 17, days: [1, 2, 3, 4, 5] };

const SAVED: ListsSaved = {
  friendsAt: at(NOW),
  requestsAt: at(NOW),
  sentAt: at(NOW),
  groupsAt: at(NOW),
  groupChecksAt: at(NOW),
  tidyAt: at(NOW),
  checksAt: at(NOW),
};

let made = 0;
const item = (kind: TodayKind, name: string, more: Partial<PlanItem> = {}): PlanItem => ({
  kind,
  name,
  profileId: `00000000-0000-4000-8000-${String(++made).padStart(12, '0')}`,
  profileUrl: `https://www.facebook.com/${name.replace(/\s+/g, '.').toLowerCase()}`,
  threadKey: null,
  postId: null,
  postUrl: null,
  asking: false,
  send: null,
  ...more,
});

const DANA = item('friend_request', 'Dana Reyes');
const SAM = item('friend_request', 'Sam Lee');
const KIM = item('warm_up', 'Kim Park');
const step = (i: PlanItem): Work => ({ do: 'step', item: i });
const key = (i: PlanItem) => workChangeKey(step(i));

const facts = (more: Partial<PlanFacts> = {}): PlanFacts => ({
  platform: 'facebook',
  now: NOW,
  timeZone: TZ,
  hours: HOURS,
  choices: { on: true, sending: 'steps', collect: true, watchPosts: true },
  noting: true,
  day: { date: TODAY, state: 'none', why: null },
  warned: false,
  asks: 0,
  lists: SAVED,
  list: {
    items: [DANA, SAM, KIM],
    partners: [],
    auto: ['friend_request', 'warm_up'],
    messages: [],
    sending: 'steps',
  },
  ...more,
});
const fresh = (more: Partial<PlanDay> = {}): PlanDay => ({ ...freshPlanDay(TODAY), ...more });
/** A day with all of Facebook's reading done. */
const read = (more: Partial<PlanDay> = {}): PlanDay =>
  fresh({
    daily: Object.fromEntries(RUNNERS.facebook.daily.map((job) => [job, 'Done.'])),
    watchAt: NOW + 90 * MIN,
    ...more,
  });
const skip = (k: string, madeAt = NOW - MIN): PlanChange => ({
  key: k,
  change: 'skip',
  at: null,
  made: madeAt,
});
const first = (k: string, madeAt = NOW - MIN): PlanChange => ({
  key: k,
  change: 'now',
  at: null,
  made: madeAt,
});
const moved = (k: string, to: number, madeAt = NOW - MIN): PlanChange => ({
  key: k,
  change: 'at',
  at: to,
  made: madeAt,
});
const who = (move: ReturnType<typeof nextMove>['move']) =>
  move.do === 'work' ? move.work.item.name : move.do === 'daily' ? move.job : move.do;

describe('the day’s changes, as they stand at a moment', () => {
  it('leaves out what’s skipped, and what’s moved till its time; then it goes first', () => {
    const changes = [skip('a'), moved('b', NOW + 30 * MIN), moved('c', NOW - 5 * MIN), first('d')];
    const now = changesAt(changes, NOW);
    expect([...now.out].sort()).toEqual(['a', 'b']);
    expect(now.wakes).toEqual([NOW + 30 * MIN]);
    // What was moved goes from its time; what was put first, from when it was said: the earliest first.
    expect(now.first).toEqual(['c', 'd']);
    const later = changesAt(changes, NOW + 30 * MIN);
    expect([...later.out]).toEqual(['a']);
    expect(later.wakes).toEqual([]);
    expect(later.first).toEqual(['c', 'd', 'b']);
  });

  it('is nothing with no changes', () => {
    for (const none of [undefined, []]) {
      const now = changesAt(none, NOW);
      expect(now.first).toEqual([]);
      expect(now.out.size + now.wakes.length).toBe(0);
    }
  });

  it('puts what’s first at the front of the work, in the order said, and keeps the rest’s order', () => {
    const left = [DANA, SAM, KIM].map(step);
    expect(workInLine(left, changesAt([], NOW))).toEqual(left);
    const line = workInLine(
      left,
      changesAt([first(key(KIM), NOW - 2 * MIN), first(key(SAM), NOW - 3 * MIN)], NOW),
    );
    expect(line.map((w) => w.item.name)).toEqual(['Sam Lee', 'Kim Park', 'Dana Reyes']);
    const without = workInLine(left, changesAt([skip(key(DANA)), first(key(KIM))], NOW));
    expect(without.map((w) => w.item.name)).toEqual(['Kim Park', 'Sam Lee']);
    // Something first that isn't left changes nothing.
    expect(workInLine(left, changesAt([first('work:friend_request:gone')], NOW))).toEqual(left);
  });
});

describe('today’s list, as the extension is given it', () => {
  const list = (items: PlanItem[], partners?: PlanItem[]) => ({
    items,
    ...(partners ? { partners } : {}),
    limits: { friend_request: 10 },
  });

  it('is the list itself with nothing skipped or moved', () => {
    const whole = list([DANA, SAM]);
    expect(listWithoutOut(whole, [], NOW)).toBe(whole);
    expect(listWithoutOut(whole, [first(key(DANA))], NOW)).toBe(whole);
    expect(listWithoutOut(whole, [moved(key(DANA), NOW - MIN)], NOW)).toBe(whole);
  });

  it('leaves out someone skipped, or moved to a time still ahead, and nobody else', () => {
    const whole = list([DANA, SAM, KIM]);
    const cut = listWithoutOut(whole, [skip(key(DANA)), moved(key(KIM), NOW + 20 * MIN)], NOW);
    expect(cut.items).toEqual([SAM]);
    // Everything else of the list is its own.
    expect(cut.limits).toBe(whole.limits);
    // The time comes, and they're back on it.
    expect(listWithoutOut(whole, [moved(key(KIM), NOW + 20 * MIN)], NOW + 20 * MIN).items).toEqual([
      DANA,
      SAM,
      KIM,
    ]);
  });

  it('leaves out a message to write by its own row, and a partner too', () => {
    const hi = item('follow_up', 'Avery Lane');
    const partner = item('partner_warm_up', 'Jo Park');
    const whole = list([hi, SAM], [partner]);
    const draft: Work = { do: 'draft', item: hi };
    expect(itemChangeKeys(hi)).toContain(workChangeKey(draft));
    const cut = listWithoutOut(whole, [skip(workChangeKey(draft)), skip(key(partner))], NOW);
    expect(cut.items).toEqual([SAM]);
    expect(cut.partners).toEqual([]);
  });

  it('still sends a message the person OK’d after they skipped its writing', () => {
    const hi = item('follow_up', 'Avery Lane');
    const skipped = [skip(workChangeKey({ do: 'draft', item: hi }))];
    const okd = { ...hi, send: { sendId: 'send-1', state: 'approved' } };
    expect(listWithoutOut(list([okd]), skipped, NOW).items).toEqual([okd]);
    // The message itself skipped today doesn't go.
    const send: Work = { do: 'send', item: okd };
    expect(listWithoutOut(list([okd]), [skip(workChangeKey(send))], NOW).items).toEqual([]);
  });
});

describe('the next move, with what the person changed', () => {
  /** The list's turn: a part of the reading went last. */
  const turn = (more: Partial<PlanDay> = {}) =>
    fresh({ daily: { requests: 'None new.' }, readLast: true, ...more });

  it('goes by its own order with no changes, whatever the day', () => {
    const days = [fresh(), turn(), read(), read({ tried: [itemKey(DANA)] })];
    for (const day of days)
      for (const f of [facts(), facts({ now: FIVE_PM + MIN }), facts({ asks: 1 })])
        expect(nextMove({ ...f, changes: [] }, day)).toEqual(nextMove(f, day));
  });

  it('never does a step skipped today, and counts what’s left without it', () => {
    const plain = nextMove(facts(), turn());
    expect(plain.move).toMatchObject({ do: 'work', work: { item: DANA }, left: 2 });
    const changed = nextMove(facts({ changes: [skip(key(DANA))] }), turn());
    expect(changed.move).toMatchObject({ do: 'work', work: { item: SAM }, left: 1 });
    // Everyone skipped: the reading goes on, and then nothing's left.
    const all = [DANA, SAM, KIM].map((i) => skip(key(i)));
    expect(who(nextMove(facts({ changes: all }), turn()).move)).toBe('tidy');
    expect(nextMove(facts({ changes: all }), read()).move).toMatchObject({
      do: 'wait',
      why: 'idle',
    });
  });

  it('holds a step moved to a time till then, and does it first from then on', () => {
    const changes = [moved(key(KIM), NOW + 30 * MIN)];
    const before = nextMove(facts({ changes }), read());
    expect(who(before.move)).toBe('Dana Reyes');
    expect(before.move).toMatchObject({ left: 1 });
    const then = nextMove(facts({ changes, now: NOW + 30 * MIN }), read());
    expect(then.move).toMatchObject({ do: 'work', work: { item: KIM }, left: 2 });
  });

  it('looks again when something moved comes back, with nothing else to do', () => {
    const changes = [skip(key(DANA)), skip(key(SAM)), moved(key(KIM), NOW + 25 * MIN)];
    expect(nextMove(facts({ changes }), read()).move).toEqual({
      do: 'wait',
      why: 'idle',
      until: NOW + 25 * MIN,
    });
  });

  it('does what was put first next, though it’s the reading’s turn, in the order said', () => {
    // The reading's turn: without a change the next read goes.
    const reading = fresh({ daily: { requests: 'None new.' }, readLast: false });
    expect(who(nextMove(facts(), reading).move)).toBe('tidy');
    const one = nextMove(facts({ changes: [first(key(KIM))] }), reading);
    expect(one.move).toMatchObject({ do: 'work', work: { item: KIM }, left: 2, reading: true });
    const two = nextMove(
      facts({ changes: [first(key(KIM), NOW - MIN), first(key(SAM), NOW - 2 * MIN)] }),
      reading,
    );
    expect(who(two.move)).toBe('Sam Lee');
    // Done, it's first no more: the day goes on by its own order.
    const after = nextMove(
      facts({ changes: [first(key(KIM))] }),
      fresh({ daily: { requests: 'None new.' }, tried: [itemKey(KIM)], readLast: false }),
    );
    expect(who(after.move)).toBe('tidy');
  });

  it('puts a once-a-day read first, before the list’s turn and the reads before it', () => {
    expect(who(nextMove(facts(), turn()).move)).toBe('Dana Reyes');
    const changes = [first(jobChangeKey('chats'))];
    expect(nextMove(facts({ changes }), turn()).move).toMatchObject({ do: 'daily', job: 'chats' });
    // Done today, it isn't first any more.
    const done = turn({ daily: { requests: 'None new.', chats: 'Read 3 chats.' } });
    expect(who(nextMove(facts({ changes }), done).move)).toBe('Dana Reyes');
  });

  it('never puts a read first while its batch waits, or while it’s put off till they’re away', () => {
    const changes = [first(jobChangeKey('checks'))];
    // The next batch of checks is 20 minutes off: Do now doesn't shorten a batch's wait.
    const waits = turn({ againAt: { checks: NOW + 20 * MIN } });
    expect(who(nextMove(facts({ changes }), waits).move)).toBe('Dana Reyes');
    expect(nextMove(facts({ changes, now: NOW + 20 * MIN }), waits).move).toMatchObject({
      do: 'daily',
      job: 'checks',
    });
    // The runner put it off till the person's away: it's passed over, first or not.
    const here = { away: false, passOver: ['checks'] };
    expect(who(nextMove(facts({ changes }), turn(), 0.5, here).move)).toBe('Dana Reyes');
  });

  it('skips a read for the day, and holds one moved till its time', () => {
    const start = fresh();
    expect(who(nextMove(facts(), start).move)).toBe('requests');
    const skipped = nextMove(facts({ changes: [skip(jobChangeKey('requests'))] }), start);
    expect(skipped.move).toMatchObject({ do: 'daily' });
    expect(who(skipped.move)).not.toBe('requests');
    const later = [moved(jobChangeKey('requests'), NOW + 45 * MIN)];
    expect(who(nextMove(facts({ changes: later }), start).move)).toBe(who(skipped.move));
    expect(who(nextMove(facts({ changes: later, now: NOW + 45 * MIN }), start).move)).toBe(
      'requests',
    );
    // Every read skipped, and the list done: nothing's left to do.
    const none = RUNNERS.facebook.daily.map((job) => skip(jobChangeKey(job)));
    const end = nextMove(
      facts({ changes: none, list: { ...facts().list, items: [] } }),
      fresh({ watchAt: NOW + 90 * MIN }),
    );
    expect(end.move).toMatchObject({ do: 'wait', why: 'idle' });
  });

  it('keeps every hold of the day: what they asked, a first day’s lists, a warning, the hours', () => {
    const changes = [first(key(KIM)), first(jobChangeKey('chats'))];
    // Something they asked of the extension is in line: it goes before anything put first.
    expect(nextMove(facts({ changes, asks: 1 }), turn()).move).toMatchObject({
      do: 'wait',
      why: 'asks',
    });
    // A first day's lists are saved before anything.
    const none = nextMove(facts({ changes, lists: NO_LISTS }), fresh());
    expect(none.move).toMatchObject({ do: 'before', step: { do: 'save', first: true } });
    // A warning today, noting off, Sending off: nothing goes.
    expect(nextMove(facts({ changes, warned: true }), turn()).move).toMatchObject({
      why: 'warned',
    });
    expect(nextMove(facts({ changes, noting: false }), turn()).move).toMatchObject({
      why: 'noting',
    });
    const off = { on: true, sending: 'off', collect: true, watchPosts: true } as const;
    expect(nextMove(facts({ changes, choices: off }), turn()).move).toMatchObject({ why: 'off' });
    // Outside the hours nothing new goes, first or not (decision 133).
    expect(nextMove(facts({ changes, now: FIVE_PM + MIN }), turn()).move).toMatchObject({
      do: 'wait',
      why: 'hours',
    });
  });

  it('answers a reply first outside the hours too, and never one skipped', () => {
    const ann = item('reply', 'Ann Cole', { threadKey: 't-1' });
    const bo = item('reply', 'Bo Diaz', { threadKey: 't-2' });
    const list = {
      ...facts().list,
      items: [ann, bo, DANA],
      messages: ['reply'],
      sending: 'everything' as const,
    };
    const late = { list, now: FIVE_PM + MIN };
    const draft = (i: PlanItem) => workChangeKey({ do: 'draft', item: i });
    expect(who(nextMove(facts(late), read()).move)).toBe('Ann Cole');
    expect(who(nextMove(facts({ ...late, changes: [first(draft(bo))] }), read()).move)).toBe(
      'Bo Diaz',
    );
    expect(who(nextMove(facts({ ...late, changes: [skip(draft(ann))] }), read()).move)).toBe(
      'Bo Diaz',
    );
  });

  it('lets the reading have its turn while a reply skipped today waits', () => {
    const ann = item('reply', 'Ann Cole', { threadKey: 't-1' });
    const list = {
      ...facts().list,
      items: [ann, DANA],
      messages: ['reply'],
      sending: 'everything' as const,
    };
    const day = fresh({
      daily: { requests: 'None new.' },
      readLast: false,
      replied: [ann.profileId!],
    });
    // Someone wrote back: their reply goes before the reading's turn.
    expect(who(nextMove(facts({ list }), day).move)).toBe('Ann Cole');
    // Skipped today, they don't hold the list's turn: the reading goes on, and they're still kept as waiting.
    const skipped = nextMove(
      facts({ list, changes: [skip(workChangeKey({ do: 'draft', item: ann }))] }),
      day,
    );
    expect(who(skipped.move)).toBe('tidy');
    expect(skipped.state.replied).toEqual([ann.profileId]);
  });
});

describe('the plan, with what the person changed', () => {
  it('shows what was moved at about its time, and nothing skipped', () => {
    const changes = [skip(key(DANA)), moved(key(KIM), NOW + 120 * MIN)];
    const { moves } = planAhead(facts({ changes }), read());
    const names = moves.map((m) => who(m.move));
    expect(names).not.toContain('Dana Reyes');
    const kim = moves.find((m) => who(m.move) === 'Kim Park')!;
    expect(kim.at).toBeGreaterThanOrEqual(NOW + 120 * MIN);
    expect(kim.at).toBeLessThan(NOW + 135 * MIN);
    expect(names.indexOf('Sam Lee')).toBeLessThan(names.indexOf('Kim Park'));
  });

  it('names each row for a change, and says what it can be told', () => {
    const { moves } = planAhead(facts({ changes: [first(key(KIM))] }), fresh());
    const rows = (decides: boolean) =>
      moves.map((m) => planRow('facebook', m, { decides, changes: [first(key(KIM))] }));
    for (const row of rows(false)) {
      // A step for someone can be skipped or moved anywhere; a read, the search and the lists stay as they are.
      if (['step', 'draft', 'send'].includes(row.kind)) expect(row.can).toEqual(['skip', 'at']);
      else expect(row).toMatchObject({ can: [] });
    }
    for (const row of rows(true)) {
      if (['step', 'draft', 'send', 'job'].includes(row.kind))
        expect(row).toMatchObject({ can: ['now', 'skip', 'at'], key: expect.any(String) });
      else expect(row).toMatchObject({ can: [], key: null });
    }
    // What was put first says so on its row, wherever the order is decided.
    const kim = rows(false).find((r) => r.who === 'Kim Park')!;
    expect(kim).toMatchObject({ key: key(KIM), changed: 'now' });
    expect(rows(true)[0]).toMatchObject({ who: 'Kim Park', changed: 'now' });
    // A row only shown, as before, can be told nothing.
    expect(planRow('facebook', moves[0]!)).toMatchObject({ key: null, can: [], changed: null });
  });

  it('can tell a row under way nothing', () => {
    const { moves } = planAhead(facts(), read({ working: true, nextAt: null }));
    expect(moves[0]).toMatchObject({ now: true });
    expect(planRow('facebook', moves[0]!, { decides: true })).toMatchObject({ can: [], key: null });
  });

  it('keeps the rows’ names the ones the rules read', () => {
    const { moves } = planAhead(facts(), fresh());
    for (const m of moves) {
      const k = moveChangeKey(m.move);
      if (m.move.do === 'daily') expect(k).toBe(jobChangeKey(m.move.job));
      else if (m.move.do === 'work') expect(k).toBe(workChangeKey(m.move.work));
      else expect(k).toBeNull();
      expect(rowCan(m.move, true).length > 0).toBe(k !== null);
    }
  });

  it('shows the rows with their names from the plan itself', () => {
    const computer = { state: 'idle' as const, lastSeenAt: at(NOW), version: '0.160.0' };
    const plan = planShown({
      facts: facts({ changes: [skip(key(DANA))] }),
      reported: read(),
      computer,
      decides: true,
    });
    const people = plan.coming.filter((r) => r.who !== null);
    expect(people.map((r) => r.who)).toEqual(['Sam Lee', 'Kim Park']);
    expect(people[0]).toMatchObject({ key: key(SAM), can: ['now', 'skip', 'at'] });
    // Left out, the rows only show: an order HandsFreeOS doesn't decide offers no Do now.
    const shown = planShown({ facts: facts(), reported: read(), computer });
    expect(shown.coming[0]).toMatchObject({ can: ['skip', 'at'] });
  });

  it('puts nothing first where the runner plans its own go: a move there only holds a step till its time', () => {
    // Kim was moved to a time that has come. Where HandsFreeOS decides, she goes first.
    const changes = [moved(key(KIM), NOW - MIN)];
    expect(who(nextMove(facts({ changes }), read()).move)).toBe('Kim Park');
    // Where the runner plans its own go, she's back on the list in her own place.
    expect(who(nextMove(facts({ changes, changesLead: false }), read()).move)).toBe('Dana Reyes');
    // Still out till her time, there too.
    const ahead = [moved(key(DANA), NOW + 30 * MIN)];
    expect(who(nextMove(facts({ changes: ahead, changesLead: false }), read()).move)).toBe(
      'Sam Lee',
    );
    // The plan shown says the same, and her row still says it was moved.
    const computer = { state: 'idle' as const, lastSeenAt: at(NOW), version: '0.160.0' };
    const people = (decides: boolean) =>
      planShown({ facts: facts({ changes }), reported: read(), computer, decides }).coming.filter(
        (r) => r.who !== null,
      );
    expect(people(true)[0]).toMatchObject({ who: 'Kim Park', changed: 'at' });
    expect(people(false)[0]).toMatchObject({ who: 'Dana Reyes', changed: null });
    expect(people(false).find((r) => r.who === 'Kim Park')).toMatchObject({ changed: 'at' });
  });

  it('ends at the working hours’ end, or the day’s after Start my day, and is over after hours', () => {
    expect(planUntil(facts())).toEqual({ until: FIVE_PM, over: false });
    const midnight = Date.parse('2026-10-14T05:00:00Z');
    const started = { date: TODAY, state: 'started' as const, why: null };
    expect(planUntil(facts({ day: started }))).toEqual({ until: midnight, over: false });
    expect(planUntil(facts({ now: FIVE_PM + MIN }))).toEqual({ until: midnight, over: true });
    expect(planUntil(facts({ now: FIVE_PM + MIN, day: started }))).toMatchObject({ over: false });
  });
});

describe('a change, as it’s asked', () => {
  const ws = '00000000-0000-4000-8000-000000000001';
  it('takes a row’s name, what to do, and a time on the business’s clock', () => {
    expect(PlanChangeInput.parse({ workspaceId: ws, key: 'job:chats', change: 'skip' })).toEqual({
      workspaceId: ws,
      platform: 'facebook',
      key: 'job:chats',
      change: 'skip',
    });
    const ok = { workspaceId: ws, key: 'job:chats', change: 'at' };
    expect(PlanChangeInput.safeParse({ ...ok, time: '15:30' }).success).toBe(true);
    for (const time of ['3:30', '24:00', '15:60', '3pm'])
      expect(PlanChangeInput.safeParse({ ...ok, time }).success, time).toBe(false);
    expect(PlanChangeInput.safeParse({ ...ok, change: 'later' }).success).toBe(false);
  });

  it('says what happened in a line', () => {
    expect(PLAN_CHANGE_UI.done.at(at(NOW + 5 * 60 * MIN), TZ)).toBe('Moved to about 3:00 PM.');
    expect(PLAN_CHANGE_UI.movedTo(at(NOW + 5 * 60 * MIN), TZ)).toBe('Moved to 3:00 PM');
  });

  it('starts the box for a move at the next half hour, a quarter of an hour off or more', () => {
    // 10:00 AM in Chicago.
    expect(planMoveStart(NOW, TZ)).toBe('10:30');
    expect(planMoveStart(NOW + 14 * MIN, TZ)).toBe('10:30');
    expect(planMoveStart(NOW + 16 * MIN, TZ)).toBe('11:00');
    expect(planMoveStart(NOW + 45 * MIN, TZ)).toBe('11:00');
    // The day's last minute at the latest.
    expect(planMoveStart(Date.parse('2026-10-14T04:50:00Z'), TZ)).toBe('23:59');
    expect(planMoveStart(NOW, '')).toBe('15:30');
  });

  it('offers every half hour from then till the day’s plan ends', () => {
    // 10:00 AM, and the plan ends at 5:00 PM: 10:30 to 4:30.
    const times = planMoveTimes(NOW, TZ, at(FIVE_PM));
    expect(times[0]).toEqual({ time: '10:30', label: '10:30 AM' });
    expect(times.at(-1)).toEqual({ time: '16:30', label: '4:30 PM' });
    expect(times).toHaveLength(13);
    expect(times.find((t) => t.time === '12:00')?.label).toBe('12:00 PM');
    // After Start my day the plan ends at midnight: every half hour left today.
    const midnight = Date.parse('2026-10-14T05:00:00Z');
    expect(planMoveTimes(NOW, TZ, midnight).at(-1)).toEqual({ time: '23:30', label: '11:30 PM' });
    expect(planMoveTimes(NOW, TZ, null).at(-1)?.time).toBe('23:30');
    // Nothing's left once the next half hour is the plan's end.
    expect(planMoveTimes(FIVE_PM - 40 * MIN, TZ, at(FIVE_PM))).toEqual([]);
    expect(planMoveTimes(FIVE_PM - 50 * MIN, TZ, at(FIVE_PM)).map((t) => t.time)).toEqual([
      '16:30',
    ]);
  });

  it('knows the first build that asks on every network', () => {
    for (const platform of PLATFORM_KEYS) expect(ASKS_SINCE[platform]).toMatch(/^0\.1\d\d\.0$/);
    expect(ASKS_SINCE.threads).toBe(NEXT_SINCE);
  });
});
