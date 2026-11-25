/**
 * Social Outreach: the plan, kept and shown (docs/outreach.md, decision 195). The extension says where its day is up
 * to on a network and only the working computer's word is kept, each person's their own; the plan is worked out from
 * it for today, says to update an older build, and puts what the person asked for first. A runner of a network
 * HandsFreeOS decides asks for its next move (step 2): only the working computer is answered, by the day's rules,
 * with every time on its own clock. A row of the plan is changed (step 3): put first, skipped, moved to a time or put
 * back, and the runner's next move follows.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { askNameOn } from '../../src/addons/outreach/asks';
import {
  AUTOMATION_DEFAULTS,
  businessDay,
  NETWORK_CHOICES_DEFAULTS,
  NETWORKS_DEFAULTS,
} from '../../src/addons/outreach/automation';
import { LIST_MARKS_ON } from '../../src/addons/outreach/lists';
import { PLAN_SINCE, PLAN_WORDS } from '../../src/addons/outreach/plan';
import { jobChangeKey, PLAN_CHANGE_UI } from '../../src/addons/outreach/plan-changes';
import { NEXT_SINCE, NOT_DECIDING, PLAN_DECIDES } from '../../src/addons/outreach/plan-next';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { RUNNERS } from '../../src/addons/outreach/runners';
import { zonedParts } from '../../src/calendar/engine/zoned';
import { outreachBusiness, refused, runAs, runWith } from './outreach-fixture';

/**
 * Threads and X switched on, as they will be: the switch itself (`PLAN_DECIDES`) is off until a day's plan has been
 * checked against a real day, so what a runner is answered once it's on is held here.
 */
vi.mock('../../src/addons/outreach/plan-next', async (original) => ({
  ...(await original<object>()),
  PLAN_DECIDES: ['threads', 'x'],
}));

const admin = () => testDbs().admin.db;
const MIN = 60_000;

/** Chicago, or Tokyo when it's within 3 hours of midnight there: the run stays on the business's today. */
const zone = (() => {
  const { hour } = zonedParts(Date.now(), 'America/Chicago');
  return hour >= 3 && hour < 21 ? 'America/Chicago' : 'Asia/Tokyo';
})();

describe('the plan, kept and shown', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  const home = randomUUID();
  const office = randomUUID();
  const today = () => businessDay(Date.now(), zone);

  const beat = (u: TestUser, installId: string, version: string, more = {}) =>
    runWith(
      u,
      ws,
      'outreach.live.beat',
      {
        computer: { id: installId, name: 'Chrome on Windows', version },
        status: { state: 'idle', line: null, lineAt: null, nextAt: null },
        ...more,
      },
      { channel: 'extension', commandId: randomUUID(), occurredAt: new Date(), sentAt: new Date() },
    );
  const state = (more: Record<string, unknown> = {}) => ({
    day: today(),
    started: true,
    stopped: null,
    tried: [],
    done: { friend_request: 2, warm_up: 1 },
    daily: { requests: 'Confirmed 2 friend requests.' },
    before: { friends: 'Saved 14 friends.' },
    ...more,
  });
  const note = (
    u: TestUser,
    installId: string,
    more: Record<string, unknown> = {},
    meta: Record<string, unknown> = {},
    platform = 'facebook',
  ) =>
    runWith(
      u,
      ws,
      'outreach.plan.note',
      { platform, computer: installId, state: state(more) },
      {
        channel: 'extension',
        commandId: randomUUID(),
        occurredAt: new Date(),
        sentAt: new Date(),
        ...meta,
      },
    );
  const kept = (u: TestUser, platform = 'facebook') =>
    rows<{ day: string; state: { nextAt: number | null; tried: string[] } }>(
      admin(),
      sql`select day::text as day, state from addon_outreach.plan_days
          where workspace_id = ${ws} and user_id = ${u.id} and platform = ${platform}`,
    );

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('outp-owner', { fullName: 'Morgan Owner' }),
      createTestUser('outp-member', { fullName: 'Riley Member' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach Plan Co', { timezone: zone });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: PLAYBOOK_TEMPLATES.crm_demos.details,
    });
    for (const u of [owner, member])
      await runAs(u, ws, 'outreach.automation.save', {
        settings: { ...AUTOMATION_DEFAULTS, sending: 'steps' },
      });
  }, 60_000);
  afterAll(closeTestDbs);

  it('says there’s no computer yet, and keeps nothing from one it doesn’t know', async () => {
    const plan = await runAs(member, ws, 'outreach.plan', {});
    expect(plan).toMatchObject({ platform: 'facebook', stand: 'none', reported: false });
    expect(plan.coming).toEqual([]);
    expect(await note(member, home)).toEqual({ kept: false });
    expect(await kept(member)).toEqual([]);
  });

  it('asks for the update while the working computer runs an older build', async () => {
    await beat(member, home, '0.153.0', { active: true });
    const plan = await runAs(member, ws, 'outreach.plan', {});
    expect(plan).toMatchObject({ stand: 'waiting', reported: false, line: PLAN_WORDS.update });
    expect(plan.coming).toEqual([]);
  });

  it('says it hasn’t heard yet from a build that will say', async () => {
    await beat(member, home, PLAN_SINCE);
    const plan = await runAs(member, ws, 'outreach.plan', {});
    expect(plan).toMatchObject({ stand: 'waiting', reported: false, line: PLAN_WORDS.notYet });
  });

  it('keeps what the working computer says, and shows the day so far from it', async () => {
    expect(await note(member, home)).toEqual({ kept: true });
    const plan = await runAs(member, ws, 'outreach.plan', {});
    expect(plan.reported).toBe(true);
    expect(plan.timezone).toBe(zone);
    expect(plan.done).toEqual([
      { title: expect.any(String), line: 'Saved 14 friends.' },
      { title: 'Friend requests', line: 'Confirmed 2 friend requests.' },
    ]);
    expect(plan.counts).toEqual([
      { label: 'friend requests sent', count: 2 },
      { label: 'like', count: 1 },
    ]);
    // One row a person and network: the next note takes its place.
    await note(member, home, { tried: ['step:friend_request:abc'] });
    const [row, ...others] = await kept(member);
    expect(others).toEqual([]);
    expect(row).toMatchObject({ day: today(), state: { tried: ['step:friend_request:abc'] } });
  });

  it('moves the extension’s times onto HandsFreeOS’s clock', async () => {
    // Its clock runs 10 minutes behind: what it calls 5 minutes from now is 5 minutes from now here too.
    const theirs = Date.now() - 10 * MIN;
    await note(member, home, { nextAt: theirs + 5 * MIN }, { sentAt: new Date(theirs) });
    const [row] = await kept(member);
    expect(Math.abs(row!.state.nextAt! - (Date.now() + 5 * MIN))).toBeLessThan(MIN);
  });

  it('keeps each network’s day on its own', async () => {
    await note(member, home, { tried: ['step:connect:xyz'] }, {}, 'linkedin');
    expect((await kept(member, 'linkedin'))[0]!.state.tried).toEqual(['step:connect:xyz']);
    expect((await kept(member))[0]!.state.tried).toEqual([]);
    expect((await runAs(member, ws, 'outreach.plan', { platform: 'linkedin' })).platform).toBe(
      'linkedin',
    );
  });

  it('keeps nothing from a computer on standby', async () => {
    // The office computer is there, and the one at home is still the one that works.
    await beat(member, office, PLAN_SINCE);
    expect(await note(member, office, { tried: ['step:like:standby'] })).toEqual({ kept: false });
    expect((await kept(member))[0]!.state.tried).toEqual([]);
  });

  it('shows nobody else’s, and takes yesterday’s for a day not begun', async () => {
    expect(await runAs(owner, ws, 'outreach.plan', {})).toMatchObject({
      stand: 'none',
      reported: false,
    });
    await rows(
      admin(),
      sql`update addon_outreach.plan_days set day = day - 1
          where workspace_id = ${ws} and user_id = ${member.id} and platform = 'facebook'`,
    );
    const fresh = await runAs(member, ws, 'outreach.plan', {});
    expect(fresh).toMatchObject({ reported: true, done: [], counts: [] });
    await note(member, home);
    expect((await runAs(member, ws, 'outreach.plan', {})).counts).toHaveLength(2);
  });

  it('puts what the person asked for first, once their day is going', async () => {
    await runWith(member, ws, 'outreach.day.start', {}, { channel: 'web' });
    await note(member, home);
    const before = await runAs(member, ws, 'outreach.plan', {});
    expect(before.asked).toEqual([]);
    expect(before.stand).not.toBe('asks');
    const [ask] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.asks (workspace_id, user_id, kind, via, asked_at, task)
          values (${ws}, ${member.id}, 'unfriend', 'web', now(), '{"names": ["Avery Lane"]}')
          returning id`,
    );
    const plan = await runAs(member, ws, 'outreach.plan', {});
    expect(plan.asked).toEqual([
      { askId: ask!.id, title: askNameOn('unfriend', 'facebook'), working: false },
    ]);
    expect(plan.stand).toBe('asks');
    // Another network's plan isn't held up by it.
    expect((await runAs(member, ws, 'outreach.plan', { platform: 'linkedin' })).asked).toEqual([]);
  });

  // ------------------------------------------------------------------------------------------------- the next move

  /** What only the computer knows: the person is at it, nothing is put off, and nothing they asked is in line. */
  const HERE = { away: false, passOver: [] as string[], asking: false };
  /** A runner's ask for its next move, its clock at `now`. */
  const next = (
    u: TestUser,
    installId: string,
    platform: string,
    more: Record<string, unknown> = {},
    here: Record<string, unknown> = HERE,
    now = Date.now(),
    version = NEXT_SINCE,
  ) =>
    runWith(
      u,
      ws,
      'outreach.plan.next',
      {
        platform,
        computer: installId,
        state: state({ done: {}, daily: {}, before: {}, ...more }),
        now,
        random: 0.5,
        here,
      },
      { channel: 'extension', appVersion: version },
    );

  it('leaves a network it doesn’t decide yet, and any computer but the one that works, to plan for itself', async () => {
    expect(await next(member, home, 'facebook')).toEqual(NOT_DECIDING);
    expect(await next(member, home, 'linkedin')).toEqual(NOT_DECIDING);
    for (const platform of PLAN_DECIDES) {
      // On standby, or one HandsFreeOS never heard from.
      expect(await next(member, office, platform)).toEqual(NOT_DECIDING);
      expect(await next(member, randomUUID(), platform)).toEqual(NOT_DECIDING);
      // Somebody else's computer.
      expect(await next(owner, home, platform)).toEqual(NOT_DECIDING);
    }
  });

  it('tells the working computer to wait while the network is off for the person, and an older build nothing', async () => {
    // A build from before runners asked isn't told what to do, whatever it sends.
    expect(await next(member, home, 'x', {}, HERE, Date.now(), PLAN_SINCE)).toEqual(NOT_DECIDING);
    expect(await next(member, home, 'x')).toEqual({
      decides: true,
      move: { do: 'wait', why: 'off', until: null },
      change: null,
      list: null,
    });
  });

  it('answers by the day’s rules, with what only the computer knows, each time on the runner’s clock', async () => {
    // X on, every hour of every day: the day is going whenever this runs.
    await runAs(member, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        sending: 'steps',
        hours: { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] },
        networks: {
          ...NETWORKS_DEFAULTS,
          x: { ...NETWORK_CHOICES_DEFAULTS, on: true, sending: 'everything' },
        },
      },
    });
    // Its clock runs 10 minutes behind HandsFreeOS's.
    const theirs = Date.now() - 10 * MIN;
    // A first day's lists are saved with the window on screen: it waits till the person's away.
    expect(await next(member, home, 'x', {}, HERE, theirs)).toEqual({
      decides: true,
      move: { do: 'wait', why: 'screen', until: theirs + 10 * MIN },
      change: null,
      list: null,
    });
    const away = await next(member, home, 'x', {}, { away: true, passOver: [] }, theirs);
    expect(away).toMatchObject({
      decides: true,
      move: { do: 'before', step: { do: 'save', list: 'friends', first: true } },
      change: null,
      list: null,
    });
    expect(Number.isInteger(away.move.gap)).toBe(true);

    // Their lists saved and the day's reading done, with nothing on the list: it looks again when its search is due.
    for (const list of LIST_MARKS_ON.x)
      await runAs(member, ws, 'outreach.lists.saved', { platform: 'x', list });
    const read = Object.fromEntries(RUNNERS.x.daily.map((job) => [job, 'Done.']));
    const rest = { daily: read, watchAt: theirs + 40 * MIN, round: 2, roundAt: theirs };
    expect(await next(member, home, 'x', rest, HERE, theirs)).toEqual({
      decides: true,
      move: { do: 'wait', why: 'idle', until: theirs + 40 * MIN },
      change: null,
      list: null,
    });
    // A read put off till they're away is tried again in a few minutes.
    const { tidy: _put, ...others } = read;
    const putOff = await next(
      member,
      home,
      'x',
      { ...rest, daily: others },
      { away: false, passOver: ['tidy'] },
      theirs,
    );
    expect(putOff.move).toEqual({ do: 'wait', why: 'idle', until: theirs + 10 * MIN });
  });

  // ------------------------------------------------------------------------------------------------- a row changed

  /** A change to a row of the plan, pressed on the web. */
  const change = (
    u: TestUser,
    platform: string,
    key: string,
    what: 'now' | 'skip' | 'at' | 'back',
    time?: string,
  ) =>
    runWith(
      u,
      ws,
      'outreach.plan.change',
      { platform, key, change: what, ...(time ? { time } : {}) },
      { channel: 'web' },
    );
  /** The business's clock some minutes from now, as 15:30. */
  const clock = (minutes: number) => {
    const { hour, minute } = zonedParts(Date.now() + minutes * MIN, zone);
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };
  const changesKept = (u: TestUser, platform: string) =>
    rows<{ key: string; change: string; day: string; title: string; at: Date | null }>(
      admin(),
      sql`select key, change, day::text as day, title, at from addon_outreach.plan_changes
          where workspace_id = ${ws} and user_id = ${u.id} and platform = ${platform}
          order by key`,
    );

  it('changes a once-a-day read only where HandsFreeOS decides the order, for a build that asks', async () => {
    // Facebook's order is still its runner's own: a read there can't be changed, nor anything put first.
    expect(await refused(change(member, 'facebook', jobChangeKey('requests'), 'skip'))).toBe(
      'outreach_plan_order_not_here',
    );
    // X is decided, and the working computer's build is from before its runner asked.
    expect(await refused(change(member, 'x', jobChangeKey('requests'), 'skip'))).toBe(
      'outreach_plan_order_not_here',
    );
    await beat(member, home, NEXT_SINCE);
    // A row that isn't on the plan: not one of X's reads, or nobody left on its list.
    expect(await refused(change(member, 'x', jobChangeKey('members'), 'skip'))).toBe(
      'outreach_plan_row_gone',
    );
    expect(await refused(change(member, 'x', 'work:follow:nobody', 'skip'))).toBe(
      'outreach_plan_row_gone',
    );
    expect(await changesKept(member, 'x')).toEqual([]);
  });

  it('skips a read, puts one first, moves one to a time and puts it back, and the runner’s next move follows', async () => {
    const theirs = Date.now();
    // The day's reading is to do, and the hourly search isn't due yet.
    const rest = { watchAt: theirs + 40 * MIN };
    const away = { away: true, passOver: [] as string[], asking: false };
    const job = async () => (await next(member, home, 'x', rest, away, theirs)).move.job as string;
    const [one, two, three] = RUNNERS.x.daily.filter((j) => j !== 'comment_research');
    expect(await job()).toBe(one);

    expect(await change(member, 'x', jobChangeKey(one!), 'skip')).toEqual({
      key: jobChangeKey(one!),
      change: 'skip',
      at: null,
      title: RUNNERS.x.names[one!],
      words: PLAN_CHANGE_UI.done.skip,
    });
    expect(await job()).toBe(two);
    const first = await change(member, 'x', jobChangeKey(three!), 'now');
    expect(first).toMatchObject({ change: 'now', words: PLAN_CHANGE_UI.done.now });
    expect(await job()).toBe(three);
    // Put back, it's in its own place again; and putting back twice is no trouble.
    expect(await change(member, 'x', jobChangeKey(three!), 'back')).toMatchObject({
      change: 'back',
      title: RUNNERS.x.names[three!],
      words: PLAN_CHANGE_UI.done.back,
    });
    expect(await change(member, 'x', jobChangeKey(three!), 'back')).toMatchObject({ title: '' });
    expect(await job()).toBe(two);
    // Moved to half an hour from now, it waits till then.
    const moved = await change(member, 'x', jobChangeKey(two!), 'at', clock(30));
    expect(moved).toMatchObject({ change: 'at', title: RUNNERS.x.names[two!] });
    expect(Math.abs(Date.parse(moved.at) - (Date.now() + 30 * MIN))).toBeLessThanOrEqual(2 * MIN);
    expect(await job()).toBe(three);

    // One row a row of the plan, for today, with what it said; a new change to it takes the old one's place.
    const first2 = await changesKept(member, 'x');
    expect(first2.map((c) => [c.key, c.change, c.day]).sort()).toEqual(
      [
        [jobChangeKey(one!), 'skip', today()],
        [jobChangeKey(two!), 'at', today()],
      ].sort(),
    );
    expect(first2.every((c) => c.title.length > 0)).toBe(true);
    await change(member, 'x', jobChangeKey(two!), 'skip');
    const kept = await changesKept(member, 'x');
    expect(kept.map((c) => [c.key, c.change, c.at]).sort()).toEqual(
      [
        [jobChangeKey(one!), 'skip', null],
        [jobChangeKey(two!), 'skip', null],
      ].sort(),
    );
    expect(await job()).toBe(three);
  });

  it('shows what was skipped or moved on the plan, to put back, and offers each row what it can be told', async () => {
    await note(member, home, { done: {}, daily: {}, before: {} }, {}, 'x');
    const [one, two] = RUNNERS.x.daily.filter((j) => j !== 'comment_research');
    await change(member, 'x', jobChangeKey(two!), 'at', clock(45));
    const plan = await runAs(member, ws, 'outreach.plan', { platform: 'x' });
    expect(plan.changes).toEqual([
      { key: jobChangeKey(one!), change: 'skip', at: null, title: RUNNERS.x.names[one!] },
      {
        key: jobChangeKey(two!),
        change: 'at',
        at: expect.any(String),
        title: RUNNERS.x.names[two!],
      },
    ]);
    const reads = (plan.coming as { kind: string; key: string | null; can: string[] }[]).filter(
      (r) => r.kind === 'job',
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const row of reads) {
      expect(row.can).toEqual(['now', 'skip', 'at']);
      expect(row.key).not.toBe(jobChangeKey(one!));
    }
    // Each person's changes are their own: the owner's plan there has none.
    expect((await runAs(owner, ws, 'outreach.plan', { platform: 'x' })).changes).toEqual([]);
    // A network whose order isn't decided offers no read anything.
    const facebook = await runAs(member, ws, 'outreach.plan', {});
    for (const row of facebook.coming as { kind: string; can: string[] }[])
      if (row.kind === 'job') expect(row.can).toEqual([]);
  });

  it('refuses a time that has passed, and yesterday’s changes count for nothing', async () => {
    const [one, two, three] = RUNNERS.x.daily.filter((j) => j !== 'comment_research');
    expect(await refused(change(member, 'x', jobChangeKey(three!), 'at', clock(-5)))).toBe(
      'outreach_plan_time_past',
    );
    expect(await refused(change(member, 'x', jobChangeKey(three!), 'at'))).toBe('validation');
    // The day turns: what was changed yesterday is a day not changed, and goes with the next change.
    await rows(
      admin(),
      sql`update addon_outreach.plan_changes set day = day - 1
          where workspace_id = ${ws} and user_id = ${member.id} and platform = 'x'`,
    );
    expect((await runAs(member, ws, 'outreach.plan', { platform: 'x' })).changes).toEqual([]);
    const theirs = Date.now();
    const away = { away: true, passOver: [] as string[], asking: false };
    const first = await next(member, home, 'x', { watchAt: theirs + 40 * MIN }, away, theirs);
    expect(first.move.job).toBe(one);
    await change(member, 'x', jobChangeKey(three!), 'skip');
    expect((await changesKept(member, 'x')).map((c) => c.key)).toEqual([jobChangeKey(three!)]);
    await change(member, 'x', jobChangeKey(three!), 'back');
    expect(two).toBeDefined();
    expect(await changesKept(member, 'x')).toEqual([]);
  });

  it('holds its own work for what the person asked only as the runner says it’s in line, and says nothing while Sending is off', async () => {
    const [ask] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.asks (workspace_id, user_id, platform, kind, via, asked_at, task)
          values (${ws}, ${member.id}, 'x', 'checkup', 'web', now(), '{}')
          returning id`,
    );
    // Its clock runs 5 minutes ahead of HandsFreeOS's.
    const theirs = Date.now() + 5 * MIN;
    const read = Object.fromEntries(RUNNERS.x.daily.map((job) => [job, 'Done.']));
    const rest = { daily: read, watchAt: theirs + 40 * MIN, round: 2, roundAt: theirs };
    // One no computer took yet holds no runner: it's in line once its computer takes it.
    expect((await next(member, home, 'x', rest, HERE, theirs)).move).toEqual({
      do: 'wait',
      why: 'idle',
      until: theirs + 40 * MIN,
    });
    expect((await next(member, home, 'x', rest, { ...HERE, asking: true }, theirs)).move).toEqual({
      do: 'wait',
      why: 'asks',
      until: theirs + 2 * MIN,
    });
    // Left unsaid, HandsFreeOS's own count of what they asked says.
    const unsaid = await next(member, home, 'x', rest, { away: false, passOver: [] }, theirs);
    expect(unsaid.move).toEqual({ do: 'wait', why: 'asks', until: theirs + 2 * MIN });
    await rows(admin(), sql`delete from addon_outreach.asks where id = ${ask!.id}`);
    await runAs(member, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        networks: {
          ...NETWORKS_DEFAULTS,
          x: { ...NETWORK_CHOICES_DEFAULTS, on: true, sending: 'off' },
        },
      },
    });
    expect((await next(member, home, 'x', rest)).move).toEqual({
      do: 'wait',
      why: 'off',
      until: null,
    });
  });
});
