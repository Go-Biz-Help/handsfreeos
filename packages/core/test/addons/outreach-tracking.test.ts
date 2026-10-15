/**
 * Social Outreach: tracking, the daily numbers (docs/outreach.md, decision 70; ../../src/addons/outreach/tracking.ts).
 * - The three numbers (first messages sent, said yes, calls booked) in a stretch, with their rates against the
 *   video's and the person's targets from their goal, by playbook and by the main offer's version.
 * - Owners and admins count everyone's, though each person's answers are their own; anyone else only their own.
 * - What to fix first, in the video's order, and the review's words when the AI can't write them.
 * - The worker's day's report (on to start, off in My settings, kept by a screen from before it) and last week's
 *   numbers for the review, which it keeps and Results then shows.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import {
  bookStanding,
  checkedReview,
  dayReportWords,
  fixFirst,
  reviewPrompt,
  reviewPushWords,
  reviewWeek,
  rulesReview,
  targetFor,
  workingDaysIn,
  yesStanding,
  type ReviewWeekOutput,
} from '../../src/addons/outreach/tracking';
import { addDays, localDateOf, startOfLocalDay } from '../../src/calendar/engine/zoned';
import { executeQuery } from '../../src/server';
import { outreachAddonServer } from '../../src/addons/outreach/server';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import { getReady, outreachBusiness, refused, runAs, runAsSystem } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const HOUR = 3_600_000;

describe('the numbers’ rules', () => {
  it('works the targets out from the goal, never past Facebook’s safe pace', () => {
    // 8 calls a month over 22 working days: 0.4 calls, 1.1 yeses and 14 to 28 first messages a day; 15 is the pace.
    expect(targetFor({ goal: 8, daysAWeek: 5, canSend: 15, days: 1 })).toEqual({
      goal: 8,
      messages: 15,
      positive: 1.1,
      booked: 0.4,
    });
    // 2 calls a month fits well inside it: 7 first messages a day at the worst rate.
    expect(targetFor({ goal: 2, daysAWeek: 5, canSend: 15, days: 5 }).messages).toBe(35);
    expect(workingDaysIn('today', 5)).toBe(1);
    expect(workingDaysIn('week', 5)).toBe(5);
    expect(workingDaysIn('month', 5)).toBe(21);
  });

  it('says how each rate stands against the video’s, once there are enough to tell', () => {
    expect(yesStanding({ messages: 20, positive: 0, booked: 0 })).toBe('few');
    expect(yesStanding({ messages: 100, positive: 2, booked: 0 })).toBe('below');
    expect(yesStanding({ messages: 100, positive: 6, booked: 0 })).toBe('like');
    expect(yesStanding({ messages: 100, positive: 12, booked: 0 })).toBe('above');
    expect(bookStanding({ messages: 100, positive: 2, booked: 0 })).toBe('few');
    expect(bookStanding({ messages: 100, positive: 6, booked: 1 })).toBe('below');
    expect(bookStanding({ messages: 100, positive: 6, booked: 2 })).toBe('like');
    expect(bookStanding({ messages: 100, positive: 6, booked: 3 })).toBe('above');
  });

  it('picks what to fix first in the video’s order: volume, then the message, then the video', () => {
    expect(fixFirst({ messages: 40, positive: 0, booked: 0 }, 75)).toBe('volume');
    // Too few to tell anything by, even past a small target.
    expect(fixFirst({ messages: 12, positive: 3, booked: 0 }, 10)).toBe('volume');
    expect(fixFirst({ messages: 80, positive: 2, booked: 0 }, 75)).toBe('message');
    expect(fixFirst({ messages: 80, positive: 6, booked: 1 }, 75)).toBe('video');
    expect(fixFirst({ messages: 80, positive: 6, booked: 2 }, 75)).toBe('on_track');
    expect(fixFirst({ messages: 30, positive: 2, booked: 1 }, null)).toBe('on_track');
  });

  it('writes the review from the numbers when the AI can’t, and keeps only a plain answer of its own', () => {
    const volume = rulesReview('volume', { messages: 38, positive: 1, booked: 0 }, 75);
    expect(volume.headline).toBe('Send more messages first');
    expect(volume.why).toBe(
      'You sent 38 first messages last week. Your goal takes about 75. Too few messages is the most common reason for too few calls.',
    );
    expect(volume.steps).toHaveLength(3);
    expect(rulesReview('message', { messages: 80, positive: 2, booked: 0 }, 75).why).toBe(
      '2 of 80 first messages said yes last week, 2.5%. Most get 4 to 8%.',
    );
    expect(rulesReview('video', { messages: 80, positive: 6, booked: 1 }, 75).why).toBe(
      '6 people said yes last week and 1 booked a call. Most book 1 in 3.',
    );
    expect(
      checkedReview({
        headline: 'Send more messages — it’s the fix',
        why: 'You sent 38.',
        steps: ['Start your day each day.', 'Turn on sending.'],
      }),
    ).toEqual({
      headline: 'Send more messages, it’s the fix',
      why: 'You sent 38.',
      steps: ['Start your day each day.', 'Turn on sending.'],
    });
    expect(checkedReview({ headline: 'Hi', why: 'Why', steps: ['Only one'] })).toBeNull();
    expect(checkedReview({ headline: 'x'.repeat(81), why: 'Why', steps: ['a', 'b'] })).toBeNull();
  });

  it('tells the day and the week in a push', () => {
    expect(dayReportWords({ messages: 14, positive: 2, booked: 1 }, 15)).toEqual({
      title: 'Your day',
      body: 'Today: 14 messages, 2 said yes, 1 booked. 1 more message hits your target.',
    });
    expect(dayReportWords({ messages: 11, positive: 0, booked: 0 }, 15).body).toBe(
      'Today: 11 messages, 0 said yes, 0 booked. 4 more messages hit your target.',
    );
    expect(dayReportWords({ messages: 16, positive: 1, booked: 0 }, 15).body).toBe(
      'Today: 16 messages, 1 said yes, 0 booked. You hit your target of 15.',
    );
    expect(dayReportWords({ messages: 1, positive: 0, booked: 0 }, null).body).toBe(
      'Today: 1 message, 0 said yes, 0 booked.',
    );
    expect(
      reviewPushWords({
        headline: 'Send more messages first',
        numbers: { messages: 38, positive: 1, booked: 0 },
      }),
    ).toEqual({
      title: 'Your week’s review',
      body: 'Last week: 38 messages, 1 said yes, 0 booked. Send more messages first',
    });
  });

  it('reviews the Monday to Sunday before this week, in the business’s time zone', () => {
    // Monday Oct 12, 2026, 8 AM in Chicago: the week of Oct 5.
    expect(reviewWeek(Date.parse('2026-10-12T13:00:00Z'), 'America/Chicago')).toEqual({
      week: '2026-10-05',
      end: '2026-10-12',
    });
    // Run late, on Wednesday: still the week of Oct 5.
    expect(reviewWeek(Date.parse('2026-10-14T13:00:00Z'), 'America/Chicago').week).toBe(
      '2026-10-05',
    );
  });

  it('asks the AI about the one thing to fix, with only the numbers given', () => {
    const week: ReviewWeekOutput = {
      week: '2026-10-05',
      from: '2026-10-05T05:00:00.000Z',
      to: '2026-10-12T05:00:00.000Z',
      numbers: { messages: 80, positive: 2, booked: 0 },
      target: { goal: 8, messages: 75, positive: 5.5, booked: 1.8 },
      byPlaybook: [
        { playbookId: randomUUID(), name: 'Roofers', messages: 50, positive: 2, booked: 0 },
        { playbookId: null, name: null, messages: 30, positive: 0, booked: 0 },
      ],
      byVersion: [{ version: 2, live: true, messages: 80, positive: 2, booked: 0 }],
      fix: 'message',
      kept: false,
    };
    const prompt = reviewPrompt(week, 'Pine Roof Leads');
    expect(prompt).toMatch(/Said yes \(positive replies\): 2 \(2\.5% of messages\)/);
    expect(prompt).toMatch(/- Roofers: 50 sent, 2 yes, 0 booked/);
    expect(prompt).toMatch(/- No playbook: 30 sent, 0 yes, 0 booked/);
    expect(prompt).toMatch(/- Version 2 \(live now\): 80 sent/);
    expect(prompt).toMatch(/Fix first: message \(Fix the message or the offer/);
    expect(prompt.endsWith('Write the week’s review.')).toBe(true);
  });
});

describe('the numbers on Results', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  let tz: string;
  let roofers: string;

  /** Noon in the business's time zone, `days` from today (before it when negative). */
  const noon = (days: number) =>
    new Date(startOfLocalDay(addDays(localDateOf(Date.now(), tz), days), tz) + 12 * HOUR);
  const profile = async (username: string) => {
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
          values (${ws}, 'facebook', ${username}, ${`https://www.facebook.com/${username}`}, ${username})
          returning id`,
    );
    return p!.id;
  };
  /**
   * Someone `u` first messaged `days` from today, with a playbook's opener or none, pitched with a version or none;
   * then said yes and booked, if so.
   */
  const reached = async (
    u: TestUser,
    username: string,
    days: number,
    opts: {
      playbookId?: string | null;
      version?: number | null;
      yes?: boolean;
      booked?: boolean;
    } = {},
  ) => {
    const id = await profile(username);
    const at = noon(days).toISOString();
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, step, at)
          values (${ws}, ${id}, ${u.id}, 'message', 'first_message', ${at}::timestamptz)`,
    );
    if (opts.playbookId)
      await rows(
        admin(),
        sql`insert into addon_outreach.opener_uses (workspace_id, user_id, profile_id, playbook_id, kind, text, used_at)
            values (${ws}, ${u.id}, ${id}, ${opts.playbookId}, 'own', 'Hi there', ${at}::timestamptz)`,
      );
    if (opts.version)
      await rows(
        admin(),
        sql`insert into addon_outreach.follow_ups (workspace_id, user_id, profile_id, step, step_at, last_at, offer_version, created_at)
            values (${ws}, ${u.id}, ${id}, 'first', ${at}::timestamptz, ${at}::timestamptz, ${opts.version}, ${at}::timestamptz)`,
      );
    if (opts.yes)
      await rows(
        admin(),
        sql`insert into addon_outreach.stages (workspace_id, user_id, profile_id, positive_at)
            values (${ws}, ${u.id}, ${id}, ${at}::timestamptz)`,
      );
    if (opts.booked)
      await rows(
        admin(),
        sql`insert into addon_outreach.demos (workspace_id, user_id, profile_id, how, at)
            values (${ws}, ${u.id}, ${id}, 'marked', ${at}::timestamptz)`,
      );
  };
  /** One of the worker's queries, asked on `u`'s behalf. */
  const asWorkerFor = async (u: TestUser, name: string) => {
    const [w] = await rows<{ organization_id: string }>(
      admin(),
      sql`select organization_id from app.workspaces where id = ${ws}`,
    );
    const def = outreachAddonServer.queries!.find((q) => q.name === name)!;
    return executeQuery(
      testDbs().worker.db,
      def,
      { workspaceId: ws },
      {
        type: 'system',
        workspaceId: ws,
        organizationId: w!.organization_id,
        addon: { id: outreachAddon.id, name: outreachAddon.name, version: outreachAddon.version },
        onBehalfOf: u.id,
      },
      { correlationId: randomUUID(), channel: 'test' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as Promise<any>;
  };

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('outt-owner', { fullName: 'Morgan Owner' }),
      createTestUser('outt-member', { fullName: 'Sam Member' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach Tracking Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    const [w] = await rows<{ timezone: string }>(
      admin(),
      sql`select timezone from app.workspaces where id = ${ws}`,
    );
    tz = w!.timezone;
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    roofers = (
      await runAs(owner, ws, 'outreach.playbook.save', {
        name: 'Roofers',
        template: 'crm_demos',
        details: crm.details,
      })
    ).id;
    // A live main offer, version 1, and a goal of 8 calls a month for both.
    await getReady(ws, [owner.id, member.id]);

    // The owner, today: 3 first messages with Roofers on version 1, one a yes that booked; 1 with no playbook.
    await reached(owner, 'ann.today', 0, {
      playbookId: roofers,
      version: 1,
      yes: true,
      booked: true,
    });
    await reached(owner, 'bo.today', 0, { playbookId: roofers, version: 1 });
    await reached(owner, 'cy.today', 0, { playbookId: roofers, version: 1 });
    await reached(owner, 'di.today', 0);
    // Earlier this week, a yes; and 10 days ago, in the month only.
    await reached(owner, 'ed.week', -3, { playbookId: roofers, version: 1, yes: true });
    await reached(owner, 'fa.month', -10, { playbookId: roofers, version: 1 });
    // The member, today: 2 first messages on version 1, one a yes.
    await reached(member, 'gi.member', 0, { playbookId: roofers, version: 1, yes: true });
    await reached(member, 'ho.member', 0, { version: 1 });
  }, 120_000);
  afterAll(closeTestDbs);

  it('counts the person’s own three numbers in a stretch, with the rates and their targets', async () => {
    const today = await runAs(owner, ws, 'outreach.tracking', { period: 'today' });
    expect(today).toMatchObject({
      period: 'today',
      everyone: false,
      numbers: { messages: 4, positive: 1, booked: 1 },
      rates: { yes: 0.25, books: 1 },
      // A goal of 8 calls a month, 5 working days a week: 15 first messages a day at Facebook’s pace.
      target: { goal: 8, messages: 15, positive: 1.1, booked: 0.4 },
      review: null,
    });
    const week = await runAs(owner, ws, 'outreach.tracking', { period: 'week' });
    expect(week.numbers).toEqual({ messages: 5, positive: 2, booked: 1 });
    expect(week.target.messages).toBe(75);
    const month = await runAs(owner, ws, 'outreach.tracking', { period: 'month' });
    expect(month.numbers).toEqual({ messages: 6, positive: 2, booked: 1 });
  });

  it('breaks them down by playbook and by the offer’s version', async () => {
    const week = await runAs(owner, ws, 'outreach.tracking', { period: 'week' });
    expect(week.byPlaybook).toEqual([
      { playbookId: roofers, name: 'Roofers', messages: 4, positive: 2, booked: 1 },
      { playbookId: null, name: null, messages: 1, positive: 0, booked: 0 },
    ]);
    expect(week.byVersion).toEqual([
      { version: 1, live: true, messages: 4, positive: 2, booked: 1 },
    ]);
  });

  it('counts everyone’s for owners and admins, answers and all; anyone else only their own', async () => {
    const team = await runAs(owner, ws, 'outreach.tracking', { period: 'today', everyone: true });
    expect(team).toMatchObject({
      everyone: true,
      numbers: { messages: 6, positive: 2, booked: 1 },
      target: null,
      review: null,
    });
    const mine = await runAs(member, ws, 'outreach.tracking', { period: 'today' });
    expect(mine.numbers).toEqual({ messages: 2, positive: 1, booked: 0 });
    expect(
      await refused(runAs(member, ws, 'outreach.tracking', { period: 'today', everyone: true })),
    ).toBe('outreach_activity_everyone');
    // The main offer's page counts the team's yeses too, though each person's answers are their own.
    const versions = await runAs(owner, ws, 'outreach.offer.versions', {});
    expect(versions.versions).toEqual([{ version: 1, messages: 7, positive: 3, booked: 1 }]);
    const memberVersions = await runAs(member, ws, 'outreach.offer.versions', {});
    expect(memberVersions).toMatchObject({
      everyone: false,
      versions: [{ version: 1, messages: 2, positive: 1, booked: 0 }],
    });
  });

  it('hands the worker the day’s report: on to start, off in My settings, kept by a screen from before it', async () => {
    const day = await asWorkerFor(owner, 'outreach.day_report');
    expect(day).toMatchObject({
      on: true,
      hours: AUTOMATION_DEFAULTS.hours,
      numbers: { messages: 4, positive: 1, booked: 1 },
      target: 15,
    });
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, dayReport: false },
    });
    expect((await asWorkerFor(owner, 'outreach.day_report')).on).toBe(false);
    // A screen from before the day's report sends none: it stays off.
    const { dayReport: _left, ...before } = AUTOMATION_DEFAULTS;
    const saved = await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...before, pushes: 'each' },
    });
    expect(saved.settings).toMatchObject({ pushes: 'each', dayReport: false });
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, dayReport: true },
    });
    expect((await asWorkerFor(owner, 'outreach.day_report')).on).toBe(true);
  });

  it('reads last week for the review, keeps it, and shows it on Results', async () => {
    const week = await asWorkerFor(owner, 'outreach.review.week');
    const { week: monday } = reviewWeek(Date.now(), tz);
    expect(week).toMatchObject({ week: monday, kept: false, fix: 'volume' });
    expect(week.target).toMatchObject({ goal: 8, messages: 75 });
    const words = rulesReview(week.fix, week.numbers, week.target.messages);
    expect(
      await runAsSystem(ws, 'outreach.review.save', {
        userId: owner.id,
        week: week.week,
        fix: week.fix,
        numbers: week.numbers,
        target: week.target.messages,
        ...words,
        by: 'rules',
      }),
    ).toMatchObject({ saved: true });
    expect((await asWorkerFor(owner, 'outreach.review.week')).kept).toBe(true);
    const results = await runAs(owner, ws, 'outreach.tracking', { period: 'week' });
    expect(results.review).toMatchObject({
      week: monday,
      fix: 'volume',
      headline: 'Send more messages first',
      by: 'rules',
    });
    // Each person's own: the member sees none, and the team's numbers carry nobody's.
    expect((await runAs(member, ws, 'outreach.tracking', {})).review).toBeNull();
    expect((await runAs(owner, ws, 'outreach.tracking', { everyone: true })).review).toBeNull();
  });
});
