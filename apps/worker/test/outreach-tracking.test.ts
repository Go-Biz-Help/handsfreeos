/**
 * Social Outreach's daily numbers in the worker (docs/outreach.md, decision 70): the day's report at the end of the
 * person's working hours, while it's on; the week's review on Monday, written by the AI (or from the numbers alone
 * without it), kept for Results and pushed, once; and a new main offer told to whoever OK'd their messages against
 * an older one.
 */
import { randomUUID } from 'node:crypto';
import { AUTOMATION_DEFAULTS } from '@hfos/core/addons/outreach/automation';
import { nextWeekly } from '@hfos/core/addons/outreach/results';
import { nextDayEnd, reviewWeek } from '@hfos/core/addons/outreach/tracking';
import { addDays, localDateOf, pushDeviceRegister, startOfLocalDay } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../../packages/core/test/calendar-helpers';
import {
  getReady,
  outreachBusiness,
  runAs,
} from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { DAY_REPORT_JOB, REVIEW_JOB } from '../src/addons/outreach/tracking';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };
const HOUR = 3_600_000;
const EVERY_DAY = { start: 9, end: 17, days: [0, 1, 2, 3, 4, 5, 6] };

/**
 * Runs the outbox for this business only, and what's due from it: events reach the add-on, and the jobs they arm for
 * later wait to be run. Pushes stay queued to be read.
 */
async function events(s: TestServices, ws: string) {
  for (let i = 0; i < 10; i++) {
    const runner = `vitest-tracking-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const outbox = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and run_at <= now() and kind = 'addon.deliver'`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    if (outbox.claimed === 0 && done.claimed === 0) return;
  }
}

/** The job of this kind waiting in the business: its id and when it runs. */
const armed = async (ws: string, kind: string) => {
  const [job] = await rows<{ id: string; run_at: Date }>(
    admin(),
    sql`select id, run_at from app.scheduled_jobs
        where workspace_id = ${ws} and kind = ${kind} and status = 'pending'`,
  );
  return job ? { id: job.id, at: new Date(job.run_at).getTime() } : null;
};

/** Runs one waiting job now, as if the clock said `at`. */
async function runJob(s: TestServices, id: string, at: number) {
  const runner = `vitest-tracking-${randomUUID().slice(0, 8)}`;
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${runner} where id = ${id}`,
  );
  await processJobs({
    ...s,
    jobs,
    workerId: runner,
    batchSize: 10,
    reservedOnly: true,
    clock: () => at,
  });
}

const pushes = (ws: string) =>
  rows<{ title: string; body: string; path: string }>(
    admin(),
    sql`select payload->>'title' as title, payload->>'body' as body, payload->>'path' as path
        from app.scheduled_jobs where workspace_id = ${ws} and kind = 'push.send'
        order by created_at`,
  );

let owner: TestUser;
afterAll(closeTestDbs);
beforeAll(async () => {
  owner = await createTestUser('outreach-tracking-owner', { fullName: 'Pat Owner' });
  await run(
    pushDeviceRegister,
    {
      platform: 'ios',
      token: `ExponentPushToken[tracking-${randomUUID().slice(0, 12)}]`,
      appVersion: '1.0.0',
      deviceName: 'ios',
    },
    owner,
  );
}, 60_000);

/**
 * A reply the extension saw: the review is armed by it, as by the weekly report (for a business that had the add-on
 * before it).
 */
async function replied(s: TestServices, ws: string, username: string) {
  await runAs(
    owner,
    ws,
    'outreach.touch.save',
    {
      kind: 'message',
      profile: { id: null, username, url: `https://www.facebook.com/${username}` },
      name: username,
      threadKey: '3001',
    },
    new Date(Date.now() - 10 * 60_000),
  );
  await runAs(owner, ws, 'outreach.replies.note', {
    seen: [{ name: username, threadKey: '3001' }],
  });
  await events(s, ws);
}

/** A business on UTC, with the owner ready (a goal of 8 calls a month: 15 first messages a day). */
async function business(name: string): Promise<string> {
  const ws = await outreachBusiness(owner, name);
  await rows(admin(), sql`update app.workspaces set timezone = 'UTC' where id = ${ws}`);
  await getReady(ws, [owner.id]);
  return ws;
}

/** `n` first messages the owner sent at `at`, the first `yes` of them said yes. */
async function sent(ws: string, n: number, at: Date, yes = 0) {
  for (let i = 0; i < n; i++) {
    const username = `p${randomUUID().slice(0, 8)}`;
    const [p] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
          values (${ws}, 'facebook', ${username}, ${`https://www.facebook.com/${username}`}, ${username})
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, step, at)
          values (${ws}, ${p!.id}, ${owner.id}, 'message', 'first_message', ${at.toISOString()}::timestamptz)`,
    );
    if (i < yes)
      await rows(
        admin(),
        sql`insert into addon_outreach.stages (workspace_id, user_id, profile_id, positive_at)
            values (${ws}, ${owner.id}, ${p!.id}, ${at.toISOString()}::timestamptz)`,
      );
  }
}

describe('the day’s report', () => {
  it('pushes the day’s numbers at the end of the working hours, then the next day’s, while it’s on', async () => {
    const s = testServices();
    const ws = await business('Outreach Day Report Co');
    const today = localDateOf(Date.now(), 'UTC');
    await sent(ws, 3, new Date(startOfLocalDay(today, 'UTC') + 12 * HOUR), 1);
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, hours: EVERY_DAY },
    });
    await events(s, ws);
    // Saving the settings armed it for the end of the hours.
    const first = await armed(ws, DAY_REPORT_JOB);
    expect(first!.at).toBe(nextDayEnd(EVERY_DAY, 'UTC', Date.now()).getTime());

    // At 5:05 PM today: the day, and how far from the target.
    const end = startOfLocalDay(today, 'UTC') + 17 * HOUR;
    await runJob(s, first!.id, end + 5 * 60_000);
    expect(await pushes(ws)).toEqual([
      {
        title: 'Your day',
        body: 'Today: 3 messages, 1 said yes, 0 booked. 12 more messages hit your target.',
        path: `/app/w/${ws}/a/outreach?view=results&period=today`,
      },
    ]);
    // Back tomorrow at 5 PM: they noted steps this week.
    const next = await armed(ws, DAY_REPORT_JOB);
    expect(next!.at).toBe(startOfLocalDay(addDays(today, 1), 'UTC') + 17 * HOUR);

    // Turned off in My settings: nothing tomorrow, and it doesn't come back.
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, hours: EVERY_DAY, dayReport: false },
    });
    await events(s, ws);
    await runJob(s, next!.id, next!.at + 5 * 60_000);
    expect(await pushes(ws)).toHaveLength(1);
    expect(await armed(ws, DAY_REPORT_JOB)).toBeNull();
  }, 60_000);
});

describe('the week’s review', () => {
  it('has the AI say what to fix first on Monday, keeps it for Results and pushes it, once', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const ws = await business('Outreach Review Co');
    const { week } = reviewWeek(Date.now(), 'UTC');
    // Last Tuesday: 3 first messages. And a reply this week, which arms the review.
    await sent(ws, 3, new Date(startOfLocalDay(addDays(week, 1), 'UTC') + 12 * HOUR));
    await replied(s, ws, 'rowan.b');
    const job = await armed(ws, REVIEW_JOB);
    const monday = nextWeekly(Date.now(), 'UTC', 8).getTime();
    expect(job!.at).toBe(monday);

    await runJob(s, job!.id, monday);
    const [kept] = await rows<{ fix: string; headline: string; by: string; numbers: unknown }>(
      admin(),
      sql`select fix, headline, by, numbers from addon_outreach.reviews
          where workspace_id = ${ws} and user_id = ${owner.id} and week = ${week}`,
    );
    expect(kept).toEqual({
      fix: 'volume',
      headline: 'Send more first messages this week',
      by: 'ai',
      numbers: { messages: 3, positive: 0, booked: 0 },
    });
    const review = await runAs(owner, ws, 'outreach.tracking', {});
    expect(review.review).toMatchObject({ week, fix: 'volume', by: 'ai' });
    // The reply that armed it pushed too.
    const reviews = async () => (await pushes(ws)).filter((p) => p.title === 'Your week’s review');
    expect(await reviews()).toEqual([
      {
        title: 'Your week’s review',
        body: 'Last week: 3 messages, 0 said yes, 0 booked. Send more first messages this week',
        path: `/app/w/${ws}/a/outreach?view=results`,
      },
    ]);
    // Next Monday's is armed; run again now, nobody hears it twice.
    const again = await armed(ws, REVIEW_JOB);
    expect(again!.at).toBe(monday + 7 * 24 * HOUR);
    await runJob(s, again!.id, monday);
    expect(await reviews()).toHaveLength(1);
  }, 60_000);

  it('writes it from the numbers alone without the AI', async () => {
    const s = testServices();
    const ws = await business('Outreach Review Rules Co');
    const { week } = reviewWeek(Date.now(), 'UTC');
    await sent(ws, 2, new Date(startOfLocalDay(addDays(week, 2), 'UTC') + 12 * HOUR));
    await replied(s, ws, 'quinn.h');
    const job = await armed(ws, REVIEW_JOB);
    await runJob(s, job!.id, nextWeekly(Date.now(), 'UTC', 8).getTime());
    const [kept] = await rows<{ headline: string; by: string }>(
      admin(),
      sql`select headline, by from addon_outreach.reviews where workspace_id = ${ws} and week = ${week}`,
    );
    expect(kept).toEqual({ headline: 'Send more messages first', by: 'rules' });
  }, 60_000);
});

describe('a new main offer', () => {
  it('tells whoever OK’d their messages against the older version to look again', async () => {
    const s = testServices();
    const ws = await business('Outreach New Offer Co');
    const [w] = await rows<{ organization_id: string }>(
      admin(),
      sql`select organization_id from app.workspaces where id = ${ws}`,
    );
    // Version 2 goes live: core says so.
    const published = async (version: number) => {
      const eventId = randomUUID();
      await rows(
        admin(),
        sql`insert into app.events (id, organization_id, workspace_id, event_type, actor_type, entity_type, entity_id,
              payload, correlation_id)
            values (${eventId}, ${w!.organization_id}, ${ws}, 'main_offer.published', 'system', 'main_offer', ${ws},
              ${JSON.stringify({ version })}::jsonb, ${randomUUID()})`,
      );
      await rows(
        admin(),
        sql`insert into app.outbox (event_id, organization_id, workspace_id, event_type)
            values (${eventId}, ${w!.organization_id}, ${ws}, 'main_offer.published')`,
      );
      await events(s, ws);
    };
    await published(2);
    expect(await pushes(ws)).toEqual([
      {
        title: 'Your main offer changed',
        body: 'Look over your messages again under Get ready: they now use version 2.',
        path: `/app/w/${ws}/a/outreach?view=today`,
      },
    ]);
    // Once they've OK'd version 2, version 2 again tells nobody.
    await rows(
      admin(),
      sql`update addon_outreach.setup set messages_version = 2 where workspace_id = ${ws}`,
    );
    await published(2);
    expect(await pushes(ws)).toHaveLength(1);
  }, 60_000);
});
