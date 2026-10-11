/**
 * Pushes about what waits for the person (docs/outreach.md, decision 40): bundled, one push at most every 2 hours in
 * their working hours, 10 minutes after the first new message or step, and only when something is new; or one for
 * each, at once. A reply handed over pushes at once either way (outreach-alerts.test.ts).
 */
import { randomUUID } from 'node:crypto';
import { HfosError } from '@hfos/core';
import { AUTOMATION_DEFAULTS } from '@hfos/core/addons/outreach/automation';
import { pushDeviceRegister } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../../packages/core/test/calendar-helpers';
import { outreachBusiness, runAs } from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { refusedForGood, WAITING_PUSH_JOB } from '../src/addons/outreach/waiting';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };
const MIN = 60_000;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

/** Runs the outbox and the add-on's jobs that are due, in this business only; pushes stay queued to be read. */
async function drain(s: TestServices, ws: string) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-waiting-${randomUUID().slice(0, 8)}`;
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
          where status = 'pending' and workspace_id = ${ws} and run_at <= now() and kind <> 'push.send'`,
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
  throw new Error('the worker never settled');
}

const pushes = (ws: string) =>
  rows<{ title: string; body: string; path: string; user_ids: string[] }>(
    admin(),
    sql`select payload->>'title' as title, payload->>'body' as body, payload->>'path' as path,
          array(select jsonb_array_elements_text(payload->'userIds')) as user_ids
        from app.scheduled_jobs where workspace_id = ${ws} and kind = 'push.send'
        order by created_at`,
  );

/** The person's bundled push waiting to go: when, or null. */
const armed = async (ws: string): Promise<number | null> => {
  const [job] = await rows<{ run_at: Date }>(
    admin(),
    sql`select run_at from app.scheduled_jobs
        where workspace_id = ${ws} and kind = ${WAITING_PUSH_JOB} and status = 'pending'`,
  );
  return job ? new Date(job.run_at).getTime() : null;
};
const runNow = (ws: string) =>
  rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now()
        where workspace_id = ${ws} and kind = ${WAITING_PUSH_JOB} and status = 'pending'`,
  );

const phone = (u: TestUser) =>
  run(
    pushDeviceRegister,
    {
      platform: 'ios',
      token: `ExponentPushToken[waiting-${randomUUID().slice(0, 12)}]`,
      appVersion: '1.0.0',
      deviceName: 'ios',
    },
    u,
  );

let owner: TestUser;
afterAll(closeTestDbs);
beforeAll(async () => {
  owner = await createTestUser('outreach-waiting-owner', { fullName: 'Morgan Owner' });
  await phone(owner);
}, 60_000);

/** A business in UTC where the owner's first messages wait for their OK, with these hours and pushes. */
async function business(
  name: string,
  pushesChoice: 'bundled' | 'each',
  days: number[] = ALL_DAYS,
): Promise<string> {
  const ws = await outreachBusiness(owner, name);
  await rows(admin(), sql`update app.workspaces set timezone = 'UTC' where id = ${ws}`);
  await runAs(owner, ws, 'outreach.automation.save', {
    settings: {
      ...AUTOMATION_DEFAULTS,
      sending: 'steps',
      hours: { start: 0, end: 24, days },
      pushes: pushesChoice,
    },
  });
  await runAs(owner, ws, 'outreach.wheels.end', { userId: owner.id });
  return ws;
}

/** Someone the owner sent a friend request to, with a first message that waits for their OK. */
async function opener(ws: string, username: string, name: string): Promise<string> {
  await runAs(owner, ws, 'outreach.touch.save', {
    kind: 'friend_request',
    profile: fb(username),
    name,
  });
  const [profile] = await rows<{ id: string }>(
    admin(),
    sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
  );
  const queued = await runAs(owner, ws, 'outreach.send.queue', {
    profileId: profile!.id,
    kind: 'opener',
    text: `Hi ${name.split(' ')[0]}! How do you keep track of customers?`,
  });
  expect(queued.state).toBe('waiting');
  return profile!.id;
}

describe('pushes about what waits', () => {
  it('bundles them: 10 minutes after the first, at most every 2 hours, only when something is new', async () => {
    const s = testServices();
    const ws = await business('Outreach Waiting Bundled Co', 'bundled');
    const start = Date.now();
    await opener(ws, 'dana.reyes.21', 'Dana Reyes');
    await opener(ws, 'sam.lee.21', 'Sam Lee');
    await drain(s, ws);
    expect(await pushes(ws)).toEqual([]);
    expect(await armed(ws)).toBeGreaterThanOrEqual(start + 10 * MIN - 1000);

    await runNow(ws);
    await drain(s, ws);
    expect(await pushes(ws)).toEqual([
      {
        title: '2 messages wait for your OK',
        body: 'Open Waiting for you to OK, change or skip them.',
        path: `/app/w/${ws}/a/outreach?view=waiting`,
        user_ids: [owner.id],
      },
    ]);
    const [kept] = await rows<{ pushed_at: Date }>(
      admin(),
      sql`select pushed_at from addon_outreach.waiting_pushes
          where workspace_id = ${ws} and user_id = ${owner.id}`,
    );
    const pushedAt = new Date(kept!.pushed_at).getTime();
    expect(pushedAt).toBeGreaterThanOrEqual(start - 1000);

    // A new one within 2 hours waits for 2 hours after the last; run early, it comes back then.
    await opener(ws, 'ana.moss.21', 'Ana Moss');
    await drain(s, ws);
    expect(await armed(ws)).toBe(pushedAt + 120 * MIN);
    await runNow(ws);
    await drain(s, ws);
    expect(await pushes(ws)).toHaveLength(1);
    expect(await armed(ws)).toBe(pushedAt + 120 * MIN);

    // Two hours on, the three go as one.
    await rows(
      admin(),
      sql`update addon_outreach.waiting_pushes set pushed_at = pushed_at - interval '3 hours'
          where workspace_id = ${ws}`,
    );
    await runNow(ws);
    await drain(s, ws);
    expect((await pushes(ws)).map((p) => p.title)).toEqual([
      '2 messages wait for your OK',
      '3 messages wait for your OK',
    ]);
    expect(await armed(ws)).toBeNull();

    // Nothing new since the last: no push, even when it's due.
    await rows(
      admin(),
      sql`update addon_outreach.waiting_pushes set pushed_at = pushed_at - interval '3 hours'
          where workspace_id = ${ws}`,
    );
    await rows(
      admin(),
      sql`update addon_outreach.sends set created_at = created_at - interval '4 hours'
          where workspace_id = ${ws}`,
    );
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload,
            addon_id, addon_generation)
          select organization_id, workspace_id, kind, null, now(), payload, addon_id, addon_generation
          from app.scheduled_jobs where workspace_id = ${ws} and kind = ${WAITING_PUSH_JOB} limit 1`,
    );
    await drain(s, ws);
    expect(await pushes(ws)).toHaveLength(2);
  }, 90_000);

  it('takes a step noted late from the extension’s queue for new', async () => {
    const s = testServices();
    const ws = await business('Outreach Waiting Late Co', 'bundled');
    await opener(ws, 'dana.reyes.25', 'Dana Reyes');
    await drain(s, ws);
    await runNow(ws);
    await drain(s, ws);
    expect((await pushes(ws)).map((p) => p.title)).toEqual(['1 message waits for your OK']);
    // The last push went 3 hours ago; a step the extension couldn't do 5 hours ago reaches HandsFreeOS only now.
    await rows(
      admin(),
      sql`update addon_outreach.waiting_pushes set pushed_at = pushed_at - interval '3 hours'
          where workspace_id = ${ws}`,
    );
    await rows(
      admin(),
      sql`update addon_outreach.sends set created_at = created_at - interval '4 hours'
          where workspace_id = ${ws}`,
    );
    await runAs(owner, ws, 'outreach.friend.set', {
      profile: fb('eli.brook.25'),
      name: 'Eli Brook',
      keep: false,
    });
    const [eli] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = 'eli.brook.25'`,
    );
    await runAs(
      owner,
      ws,
      'outreach.need.note',
      {
        step: 'friend_request',
        profileId: eli!.id,
        name: 'Eli Brook',
        url: null,
        why: 'couldn’t find “Add friend”',
      },
      new Date(Date.now() - 5 * 60 * MIN),
    );
    await drain(s, ws);
    await runNow(ws);
    await drain(s, ws);
    expect((await pushes(ws)).map((p) => p.title)).toEqual([
      '1 message waits for your OK',
      '1 message waits for your OK',
    ]);
    expect((await pushes(ws))[1]!.body).toBe(
      'And 1 step the extension couldn’t do. Open Waiting for you.',
    );
  }, 90_000);

  it('gives up only when the person may not be told: anything else is tried again', () => {
    expect(
      refusedForGood(HfosError.addonInactive({ id: 'outreach', name: 'Social Outreach' })),
    ).toBe(true);
    expect(refusedForGood(HfosError.forbidden('Ask an owner of this business.'))).toBe(true);
    expect(refusedForGood(HfosError.internal())).toBe(false);
    expect(refusedForGood(new Error('Connection terminated unexpectedly'))).toBe(false);
  });

  it('waits for the person’s working hours', async () => {
    const s = testServices();
    // Working only the day after tomorrow, worked out once: the same day still, should the test run past midnight.
    const now = new Date();
    const opens = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2);
    const ws = await business('Outreach Waiting Hours Co', 'bundled', [
      new Date(opens).getUTCDay(),
    ]);
    await opener(ws, 'dana.reyes.22', 'Dana Reyes');
    await drain(s, ws);
    expect(await armed(ws)).toBe(opens);
    await runNow(ws);
    await drain(s, ws);
    expect(await pushes(ws)).toEqual([]);
    expect(await armed(ws)).toBe(opens);
  }, 60_000);

  it('pushes each message and step at once with “one for each”, and nothing bundled', async () => {
    const s = testServices();
    const ws = await business('Outreach Waiting Each Co', 'each');
    await opener(ws, 'dana.reyes.23', 'Dana Reyes');
    await runAs(owner, ws, 'outreach.friend.set', {
      profile: fb('eli.brook.23'),
      name: 'Eli Brook',
      keep: false,
    });
    const [eli] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = 'eli.brook.23'`,
    );
    await runAs(owner, ws, 'outreach.need.note', {
      step: 'friend_request',
      profileId: eli!.id,
      name: 'Eli Brook',
      url: 'https://www.facebook.com/eli.brook.23',
      why: 'couldn’t find “Add friend”',
    });
    await drain(s, ws);
    expect(await pushes(ws)).toEqual([
      {
        title: 'Dana Reyes: a message waits for your OK',
        body: 'OK it, change it or skip it in Waiting for you.',
        path: `/app/w/${ws}/a/outreach?view=waiting`,
        user_ids: [owner.id],
      },
      {
        title: 'Eli Brook: the extension needs you',
        body: 'Couldn’t find “Add friend”. Do it yourself, or let it go, in Waiting for you.',
        path: `/app/w/${ws}/a/outreach?view=waiting`,
        user_ids: [owner.id],
      },
    ]);
    expect(await armed(ws)).toBeNull();
  }, 60_000);

  it('sends nothing bundled once the person switched to one for each', async () => {
    const s = testServices();
    const ws = await business('Outreach Waiting Switch Co', 'bundled');
    await opener(ws, 'dana.reyes.24', 'Dana Reyes');
    await drain(s, ws);
    expect(await armed(ws)).not.toBeNull();
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: {
        ...AUTOMATION_DEFAULTS,
        sending: 'steps',
        hours: { start: 0, end: 24, days: ALL_DAYS },
        pushes: 'each',
      },
    });
    await runNow(ws);
    await drain(s, ws);
    expect(await pushes(ws)).toEqual([]);
    expect(await armed(ws)).toBeNull();
  }, 60_000);
});
