/**
 * What the extension does, counted, and the ticker (docs/outreach.md, decision 140). The owner's picks (31 Oct 2026,
 * "all of your picks"): everything it does on its own is counted, never the person's own steps, a day, a week (from
 * Monday) and a month (from the 1st) at a time, on each network and all together; owners and admins see the team's,
 * each person only their own; and a ticker of what it's doing that very second, which has the computer tell every
 * few seconds while it's on screen.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countedSinceWords,
  countPeriodStart,
  TALLY_KIND_KEYS,
  TALLY_KINDS,
  tallyLabel,
  tallyNetworks,
  tallyView,
  TICKER_SHORTEST_SECONDS,
  TICKER_STEPS,
  tickerOf,
  tickerSeconds,
  type TallyCount,
  type TickerOutput,
} from '../../src/addons/outreach/tallies';
import { computerOn, outreachBusiness, refused, runAs, runWith } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const MIN = 60_000;

describe('what’s counted, and how it reads', () => {
  it('says each line in the network’s own words, and all networks together in words for every one', () => {
    expect(tallyLabel('friend_request', 'facebook')).toBe('Friend requests sent');
    expect(tallyLabel('friend_request', 'linkedin')).toBe('Invitations to connect sent');
    expect(tallyLabel('friend_request', 'instagram')).toBe('Accounts followed');
    expect(tallyLabel('friend_request', null)).toBe('Friend requests and follows sent');
    expect(tallyLabel('unfriended', 'linkedin')).toBe('Connections removed');
    expect(tallyLabel('cancelled', 'instagram')).toBe('Follow requests taken back');
    // Every kind has a line on every network, and all together.
    for (const kind of TALLY_KIND_KEYS)
      for (const p of ['facebook', 'linkedin', 'instagram', 'alignable', null] as const)
        expect(tallyLabel(kind, p)).toMatch(/^[A-Z]/);
  });

  it('starts a week on Monday and a month on the 1st, on the business’s calendar', () => {
    // Sunday 1 November 2026: its week began Monday 26 October.
    expect(countPeriodStart('week', '2026-11-01')).toBe('2026-10-26');
    expect(countPeriodStart('week', '2026-10-26')).toBe('2026-10-26');
    expect(countPeriodStart('week', '2026-10-31')).toBe('2026-10-26');
    expect(countPeriodStart('month', '2026-10-31')).toBe('2026-10-01');
    expect(countPeriodStart('today', '2026-10-31')).toBe('2026-10-31');
  });

  it('groups the counts, shows the main lines even at 0, and narrows to one network', () => {
    const counts: TallyCount[] = [
      { platform: 'facebook', kind: 'friend_request', n: 12 },
      { platform: 'facebook', kind: 'profile', n: 40 },
      { platform: 'linkedin', kind: 'friend_request', n: 5 },
      { platform: 'linkedin', kind: 'member', n: 30 },
      { platform: 'alignable', kind: 'recommend', n: 2 },
    ];
    const all = tallyView(counts, null);
    expect(all.total).toBe(89);
    expect(all.groups.map((g) => [g.key, g.total])).toEqual([
      ['reached', 19],
      ['looked', 40],
      ['groups', 30],
      ['tidied', 0],
      ['wrote', 0],
    ]);
    const reached = all.groups.find((g) => g.key === 'reached')!;
    expect(reached.rows.map((r) => [r.kind, r.n])).toEqual([
      ['friend_request', 17],
      ['like', 0],
      ['comment', 0],
      ['message', 0],
      ['recommend', 2],
    ]);
    // On LinkedIn only: its own words, its own counts, and Alignable's recommendations never show.
    const linkedin = tallyView(counts, 'linkedin');
    expect(linkedin.total).toBe(35);
    const lr = linkedin.groups.find((g) => g.key === 'reached')!;
    expect(lr.rows[0]).toEqual({
      kind: 'friend_request',
      label: 'Invitations to connect sent',
      n: 5,
    });
    expect(lr.rows.some((r) => r.kind === 'recommend')).toBe(false);
    // Each group with nothing still has its main lines, or none when it has none.
    expect(tallyView([], null).groups.find((g) => g.key === 'tidied')!.rows).toEqual([]);
    expect(
      Object.entries(TALLY_KINDS)
        .filter(([, k]) => (k as { always?: boolean }).always)
        .map(([kind]) => kind),
    ).toEqual(['friend_request', 'like', 'comment', 'message', 'profile', 'post']);
  });

  it('offers the networks the person works, then any other with counts, in the usual order', () => {
    expect(tallyNetworks([], ['facebook'])).toEqual(['facebook']);
    expect(
      tallyNetworks(
        [
          { platform: 'alignable', kind: 'event', n: 3 },
          { platform: 'instagram', kind: 'like', n: 0 },
        ],
        ['linkedin', 'facebook'],
      ),
    ).toEqual(['facebook', 'linkedin', 'alignable']);
  });

  it('says when a stretch began before counting did', () => {
    expect(countedSinceWords({ from: '2026-10-26', since: '2026-10-31', to: '2026-11-02' })).toBe(
      'Counted since Oct 31.',
    );
    expect(countedSinceWords({ from: '2026-11-01', since: '2026-10-31', to: '2026-11-02' })).toBe(
      '',
    );
    expect(countedSinceWords({ from: '2026-11-01', since: null, to: '2026-11-02' })).toBe('');
  });
});

describe('the ticker’s words', () => {
  // Saturday 31 October 2026, 2:14 PM in Chicago.
  const at = Date.UTC(2026, 9, 31, 19, 14);
  const timezone = 'America/Chicago';
  const computer = (state: string, seen = at) => ({
    id: randomUUID(),
    name: 'Chrome on Mac',
    lastSeenAt: new Date(seen).toISOString(),
    activeAt: null,
    working: true,
    state: state as NonNullable<TickerOutput['computer']>['state'],
    version: '0.120.0',
    allowed: null,
  });
  const status = (state: string, line: string | null, nextAt: number | null = null) => ({
    state: state as NonNullable<TickerOutput['status']>['state'],
    line,
    lineAt: null,
    nextAt: nextAt === null ? null : new Date(nextAt).toISOString(),
    doing: null,
  });
  const step = (minutesAgo: number, line: string) => ({
    at: new Date(at - minutesAgo * MIN).toISOString(),
    kind: 'done' as const,
    line,
  });

  it('leads with what the computer is doing now, then today’s steps with their times', () => {
    const working = tickerOf(
      {
        timezone,
        computer: computer('working'),
        status: status('working', 'Sending a friend request to Dana Cole'),
        steps: [step(0, 'Liked a post by Dana Cole'), step(6, 'Looked at Sam Ortiz’s profile')],
      },
      at + 30_000,
    );
    expect(working.head).toEqual({
      state: 'working',
      tone: 'live',
      words: 'Now: Sending a friend request to Dana Cole',
    });
    expect(working.steps).toEqual([
      { at: '2:14 PM', line: 'Liked a post by Dana Cole' },
      { at: '2:08 PM', line: 'Looked at Sam Ortiz’s profile' },
    ]);
    const waiting = tickerOf(
      {
        timezone,
        computer: computer('waiting'),
        status: status('waiting', 'Liked a post by Dana Cole.', at + 4 * MIN),
        steps: [],
      },
      at + 30_000,
    );
    expect(waiting.head.words).toBe('Liked a post by Dana Cole. Next step at 2:18 PM.');
    expect(waiting.head.tone).toBe('quiet');
  });

  it('says plainly when there’s no computer, it’s offline or paused', () => {
    expect(tickerOf({ timezone, computer: null, status: null, steps: [] }, at).head).toMatchObject({
      state: 'none',
      tone: 'quiet',
    });
    const offline = tickerOf(
      {
        timezone,
        computer: computer('working', at - 10 * MIN),
        status: status('working', 'Sending a friend request to Dana Cole'),
        steps: [],
      },
      at,
    );
    expect(offline.head).toMatchObject({ state: 'offline', tone: 'warn' });
    expect(offline.head.words).toContain('Last seen 2:04 PM');
    const trouble = tickerOf(
      {
        timezone,
        computer: computer('trouble'),
        status: status('trouble', 'Facebook asked to sign in again.'),
        steps: [],
      },
      at,
    );
    expect(trouble.head).toEqual({
      state: 'trouble',
      tone: 'warn',
      words: 'Paused: Facebook asked to sign in again.',
    });
  });

  it('carries only the newest steps, and never goes past too fast to read', () => {
    const many = Array.from({ length: 30 }, (_, i) => step(i, `Step ${i}`));
    expect(
      tickerOf({ timezone, computer: computer('idle'), status: null, steps: many }, at).steps,
    ).toHaveLength(TICKER_STEPS);
    expect(tickerSeconds(100)).toBe(TICKER_SHORTEST_SECONDS);
    expect(tickerSeconds(6000)).toBe(100);
  });
});

describe('counting, the counts and the ticker’s watch', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  const someone = (username: string, name: string) => ({
    profile: { id: null, username, url: `https://www.facebook.com/${username}` },
    name,
  });
  const counted = async (userId: string) =>
    rows<{ platform: string; kind: string; n: number }>(
      admin(),
      sql`select platform, kind, n from addon_outreach.tallies
          where workspace_id = ${ws} and user_id = ${userId} order by platform, kind`,
    );
  const told = async (type: string, entityType?: string) =>
    (
      await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from app.events
            where workspace_id = ${ws} and event_type = ${type}
              and (${entityType ?? null}::text is null or entity_type = ${entityType ?? null})`,
      )
    )[0]!.n;

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('outtl-owner', { fullName: 'Morgan Owner' }),
      createTestUser('outtl-member', { fullName: 'Riley Member' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach Counted Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
  }, 60_000);
  afterAll(closeTestDbs);

  it('counts what the extension did on its own, never what the person did themselves', async () => {
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      ...someone('dana.cole.1', 'Dana Cole'),
      auto: true,
    });
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'like',
      ...someone('sam.ortiz.2', 'Sam Ortiz'),
      postUrl: 'https://www.facebook.com/sam.ortiz.2/posts/1001',
      auto: true,
    });
    // The person's own message, noted by the extension: not counted.
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'message',
      ...someone('jo.park.3', 'Jo Park'),
      threadKey: '7000000003',
    });
    expect(await counted(owner.id)).toEqual([
      { platform: 'facebook', kind: 'friend_request', n: 1 },
      { platform: 'facebook', kind: 'like', n: 1 },
    ]);
    // Another the same day adds to the same count.
    await runAs(owner, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      ...someone('kim.lee.4', 'Kim Lee'),
      auto: true,
    });
    expect((await counted(owner.id))[0]).toEqual({
      platform: 'facebook',
      kind: 'friend_request',
      n: 2,
    });
    await runAs(member, ws, 'outreach.touch.save', {
      kind: 'friend_request',
      ...someone('lee.ray.5', 'Lee Ray'),
      auto: true,
    });
  });

  it('gives each person their own counts, and owners the team’s, all together and person by person', async () => {
    const mine = await runAs(owner, ws, 'outreach.counts', {});
    expect(mine).toMatchObject({ period: 'today', everyone: false, people: null });
    expect(mine.counts).toEqual(
      expect.arrayContaining([
        { platform: 'facebook', kind: 'friend_request', n: 2 },
        { platform: 'facebook', kind: 'like', n: 1 },
      ]),
    );
    expect(mine.since).toBe(mine.to);
    const theirs = await runAs(member, ws, 'outreach.counts', { period: 'month' });
    expect(theirs.counts).toEqual([{ platform: 'facebook', kind: 'friend_request', n: 1 }]);
    expect(theirs.from).toBe(`${theirs.to.slice(0, 8)}01`);
    // A member never sees the team's.
    expect(await refused(runAs(member, ws, 'outreach.counts', { everyone: true }))).toBe(
      'outreach_counts_everyone',
    );
    const team = await runAs(owner, ws, 'outreach.counts', { everyone: true, period: 'week' });
    expect(team.counts).toEqual(
      expect.arrayContaining([{ platform: 'facebook', kind: 'friend_request', n: 3 }]),
    );
    expect(team.people.map((p: { name: string }) => p.name)).toEqual([
      'Morgan Owner',
      'Riley Member',
    ]);
  });

  it('has the computer tell every few seconds while a ticker is on screen, and says so once', async () => {
    const pc = await computerOn(owner, ws, '0.120.0');
    const beat = (line: string) =>
      runWith(
        owner,
        ws,
        'outreach.live.beat',
        {
          computer: { id: pc, name: 'Chrome on Mac', version: '0.120.0' },
          active: true,
          status: { state: 'working', line, lineAt: new Date().toISOString(), nextAt: null },
        },
        {
          channel: 'extension',
          commandId: randomUUID(),
          occurredAt: new Date(),
          sentAt: new Date(),
        },
      );
    expect(await beat('Looking at Dana Cole’s profile')).toMatchObject({ watched: false });
    const before = await told('outreach.live.watched');
    const watch = await runWith(owner, ws, 'outreach.live.watch', {}, { channel: 'web' });
    expect(Date.parse(watch.until)).toBeGreaterThan(Date.now() + 60_000);
    // A watch while one is on says nothing more.
    await runWith(owner, ws, 'outreach.live.watch', {}, { channel: 'web' });
    expect(await told('outreach.live.watched')).toBe(before + 1);
    expect(await beat('Liking Dana Cole’s post')).toMatchObject({ watched: true });
    // A line alone, told for the ticker, is the line's own: pages following the computer aren't drawn again.
    const lines = await told('outreach.live.changed', 'outreach_line');
    await rows(
      admin(),
      sql`update addon_outreach.computers set told_at = now() - interval '10 seconds'
          where workspace_id = ${ws} and install_id = ${pc}`,
    );
    await beat('Sending a friend request to Dana Cole');
    expect(await told('outreach.live.changed', 'outreach_line')).toBe(lines + 1);
    // The ticker's own read: the computer, its line, today's steps.
    const ticker = await runAs(owner, ws, 'outreach.ticker', {});
    expect(ticker.computer).toMatchObject({ working: true });
    expect(ticker.status).toMatchObject({ line: 'Sending a friend request to Dana Cole' });
    // Someone else's computer never shows on another's ticker.
    expect((await runAs(member, ws, 'outreach.ticker', {})).computer).toBeNull();
  });
});
