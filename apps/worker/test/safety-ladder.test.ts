/**
 * Check-ins' ladder (round six, step 11; safety/ladder.ts and http/safety.ts). An agent checks in at a showing with
 * a teammate and someone outside as contacts. The outside contact is asked once by text and agrees with OK. At
 * the planned end the agent is asked "Still at …?"; nobody answers, so the teammate is pushed and emailed and the
 * outside contact is emailed a link of their own; the link's page shows the check-in, and "they're OK" there stops
 * the alerts for everyone, who then hear the person is OK.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  organizationCreate,
  safetyCheckIn,
  safetyContactSave,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { SAFETY_JOBS, safetyReply } from '../src/safety/ladder';
import { jobs } from '../src/scheduled';
import { waitForMail } from './booking-world';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const api = () => testDbs().api.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const MINUTE = 60_000;

let owner: TestUser;
let agent: TestUser;
let mate: TestUser;
let ws: string;
let org: string;
let s: TestServices;
let app: FastifyInstance;
const samEmail = `sam-${randomUUID().slice(0, 8)}@hfos.test`;
const samPhone = `+1512555${String(Math.floor(1000 + Math.random() * 8999))}`;
let sam: string;
const checkInId = randomUUID();
let plannedEnd: number;

async function runOutbox(eventType: string, entityId: string) {
  const runner = `vitest-safety-${randomUUID().slice(0, 8)}`;
  await rows(
    admin(),
    sql`update app.outbox set locked_at = now(), locked_by = ${runner}
        where status = 'pending' and event_id in
          (select id from app.events where event_type = ${eventType} and entity_id = ${entityId})`,
  );
  return processOnce({ ...s, handlers, workerId: runner, batchSize: 20, reservedOnly: true });
}

/** Runs this job now, as of `at`. */
async function runJob(kind: string, dedupeKey: string, at = Date.now()) {
  const runner = `vitest-safety-${randomUUID().slice(0, 8)}`;
  const claimed = await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${runner}
        where status = 'pending' and kind = ${kind} and dedupe_key = ${dedupeKey} returning id`,
  );
  expect(claimed).toHaveLength(1);
  return processJobs({
    ...s,
    jobs,
    workerId: runner,
    batchSize: 5,
    reservedOnly: true,
    clock: () => at,
  });
}

const checkIn = async () => {
  const [c] = await rows<{ state: string; alert_round: number }>(
    admin(),
    sql`select state, alert_round from app.safety_checkins where id = ${checkInId}`,
  );
  return c!;
};

/** The pushes queued for this check-in: their kind and who for. */
const pushes = () =>
  rows<{ category: string; user_ids: string[]; title: string }>(
    admin(),
    sql`select payload ->> 'category' as category, payload ->> 'title' as title,
          array(select jsonb_array_elements_text(payload -> 'userIds')) as user_ids
        from app.scheduled_jobs
        where kind = 'push.send' and payload -> 'refs' ->> 'checkInId' = ${checkInId}
        order by created_at`,
  );

beforeAll(async () => {
  [owner, agent, mate] = await Promise.all([
    createTestUser('safety-owner'),
    createTestUser('safety-agent', { fullName: 'Dana Reyes' }),
    createTestUser('safety-mate', { fullName: 'Marcus Lee' }),
  ]);
  ({ workspaceId: ws, organizationId: org } = (
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Hill Country Realty' },
      actor(owner),
      meta(),
    )
  ).output as { workspaceId: string; organizationId: string });
  for (const u of [agent, mate])
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${u.id}, 'member')`,
    );
  // Both have a phone on, so pushes reach them.
  for (const u of [agent, mate])
    await rows(
      admin(),
      sql`insert into app.push_devices (user_id, platform, expo_push_token, app_version)
          values (${u.id}, 'ios', ${`ExponentPushToken[${randomUUID()}]`}, '1.0.0')`,
    );
  s = testServices();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('a check-in nobody checks out of', () => {
  it('asks someone outside to agree once, and OK by text agrees', async () => {
    await executeCommand(
      api(),
      safetyContactSave,
      { workspaceId: ws, contactUserId: mate.id },
      actor(agent),
      meta(),
    );
    sam = (
      (
        await executeCommand(
          api(),
          safetyContactSave,
          { workspaceId: ws, name: 'Sam Reyes', phone: samPhone, email: samEmail },
          actor(agent),
          meta(),
        )
      ).output as { contact: { id: string } }
    ).contact.id;
    await runOutbox('safety_contact.saved', sam);
    await runJob(SAFETY_JOBS.tell, `safety-ask:${sam}`);
    const [asked] = await rows<{ asked: boolean; agreed: boolean }>(
      admin(),
      sql`select asked_at is not null as asked, agreed_at is not null as agreed from app.safety_contacts where id = ${sam}`,
    );
    expect(asked).toEqual({ asked: true, agreed: false });
    // Anything but the agreeing word goes on to the Inbox as usual; OK agrees, and stays out of it.
    expect(
      await safetyReply(
        s,
        { workspaceId: ws, organizationId: org },
        samPhone,
        'who is this?',
        false,
      ),
    ).toBe(false);
    expect(
      await safetyReply(s, { workspaceId: ws, organizationId: org }, samPhone, 'ok', false),
    ).toBe(true);
    const [agreed] = await rows<{ agreed: boolean }>(
      admin(),
      sql`select agreed_at is not null as agreed from app.safety_contacts where id = ${sam}`,
    );
    expect(agreed!.agreed).toBe(true);
  });

  it('waits for the planned end, then asks the person', async () => {
    plannedEnd = Date.now() + 30 * MINUTE;
    await executeCommand(
      api(),
      safetyCheckIn,
      {
        workspaceId: ws,
        id: checkInId,
        place: '2207 Juniper Trail',
        plannedEndAt: new Date(plannedEnd).toISOString(),
        latitude: 30.2,
        longitude: -97.8,
      },
      actor(agent),
      meta(),
    );
    await runOutbox('safety.checked_in', checkInId);
    // Too early: nothing yet.
    await runJob(SAFETY_JOBS.ladder, `safety:${checkInId}`, plannedEnd - MINUTE);
    expect((await checkIn()).state).toBe('in');
    await runJob(SAFETY_JOBS.ladder, `safety:${checkInId}`, plannedEnd + 1_000);
    expect((await checkIn()).state).toBe('asked');
    expect(await pushes()).toEqual([
      { category: 'safety_check', user_ids: [agent.id], title: 'Still at 2207 Juniper Trail?' },
    ]);
  });

  it('tells the contacts when nobody answers: the teammate by push and email, the outsider by email and a link', async () => {
    await runJob(SAFETY_JOBS.ladder, `safety:${checkInId}`, plannedEnd + 11 * MINUTE);
    expect(await checkIn()).toEqual({ state: 'alerted', alert_round: 1 });
    expect((await pushes()).at(-1)).toEqual({
      category: 'safety_alert',
      user_ids: [mate.id],
      title: 'Dana hasn’t checked out',
    });
    const mateMail = await waitForMail(mate.email, 'Dana Reyes hasn’t checked out');
    expect(mateMail.text).toContain(`/app/w/${ws}/safety/${checkInId}`);
    await runJob(SAFETY_JOBS.tell, `safety-tell:${checkInId}:${sam}:email:1`);
    const samMail = await waitForMail(samEmail, 'Dana Reyes hasn’t checked out');
    expect(samMail.text).toContain('2207 Juniper Trail');
    const token = /\/s\/([A-Za-z0-9_-]+)/.exec(samMail.text)![1]!;

    // The link's page: the check-in, while it's open.
    const page = await app.inject({ method: 'GET', url: `/public/safety/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.json()).toMatchObject({
      open: true,
      person: 'Dana Reyes',
      place: '2207 Juniper Trail',
      located: { latitude: 30.2, longitude: -97.8 },
    });
    expect(
      (await app.inject({ method: 'GET', url: '/public/safety/not-a-real-token-at-all' }))
        .statusCode,
    ).toBe(404);

    // "They're OK": the alerts stop for everyone, and the page shows only that.
    const ok = await app.inject({ method: 'POST', url: `/public/safety/${token}/ok` });
    expect(ok.json()).toEqual({
      open: false,
      person: 'Dana',
      business: 'Hill Country Realty',
      settled: 'ok',
    });
    expect((await checkIn()).state).toBe('ok');
    await runOutbox('safety.resolved', checkInId);
    expect((await pushes()).at(-1)).toMatchObject({
      category: 'safety_alert',
      user_ids: [mate.id],
      title: 'Dana is OK',
    });
    // The ladder has nothing left to do.
    await runJob(SAFETY_JOBS.ladder, `safety:${checkInId}`, plannedEnd + 30 * MINUTE);
    expect(await checkIn()).toEqual({ state: 'ok', alert_round: 1 });
  });
});
