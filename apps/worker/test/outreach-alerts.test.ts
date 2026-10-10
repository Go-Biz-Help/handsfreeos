/**
 * Social Outreach's phone alerts and demo link in the worker (docs/outreach.md, decisions 22 and 24): a reply the
 * extension saw is pushed to the person, unless they were looking, and one handed over to them (decision 27); at the business's hour each person who used the
 * extension lately hears how much is on their list for today; and a booking through someone's demo link counts as a
 * demo by itself.
 */
import { randomUUID } from 'node:crypto';
import { demoRef } from '@hfos/core/addons/outreach/demos';
import { nextWeekly } from '@hfos/core/addons/outreach/results';
import { PLAYBOOK_TEMPLATES } from '@hfos/core/addons/outreach/playbooks';
import { pushDeviceRegister } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bookOnline,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  setupTeam,
} from '../../../packages/core/test/calendar-helpers';
import { outreachBusiness, runAs } from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { MORNING_JOB } from '../src/addons/outreach/alerts';
import { WEEKLY_JOB } from '../src/addons/outreach/weekly';
import { processJobs } from '../src/jobs';
import type { MailMessage } from '../src/mailer';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };
const MIN = 60_000;
const fb = (username: string) => ({
  id: null,
  username,
  url: `https://www.facebook.com/${username}`,
});

/** Runs the outbox and the add-on's jobs that are due, in this business only; pushes stay queued to be read. */
async function drain(s: TestServices, ws: string) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-alerts-${randomUUID().slice(0, 8)}`;
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

const phone = (u: TestUser) =>
  run(
    pushDeviceRegister,
    {
      platform: 'ios',
      token: `ExponentPushToken[outreach-${randomUUID().slice(0, 12)}]`,
      appVersion: '1.0.0',
      deviceName: 'ios',
    },
    u,
  );

let owner: TestUser;
afterAll(closeTestDbs);
beforeAll(async () => {
  owner = await createTestUser('outreach-alerts-owner', { fullName: 'Pat Owner' });
  await phone(owner);
}, 60_000);

describe('phone alerts', () => {
  it('hands a reply that needs the person over to their phone', async () => {
    const s = testServices();
    const ws = await outreachBusiness(owner, 'Outreach Hand Over Co');
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: {
        sending: 'steps',
        replies: 'simple',
        warmUp: true,
        confirmRequests: true,
        collect: true,
        hours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] },
      },
    });
    await runAs(owner, ws, 'outreach.wheels.end', { userId: owner.id });
    await runAs(owner, ws, 'outreach.chats.collect', {
      chats: [
        {
          name: 'Ana Moss',
          thread: { id: '3001', encrypted: false },
          profile: fb('ana.moss.3'),
          messages: [{ fromMe: false, text: 'Can I get a refund?', at: new Date().toISOString() }],
        },
      ],
    });
    const [chat] = await rows<{ id: string; profile_id: string }>(
      admin(),
      sql`select id, profile_id from addon_outreach.file_chats where workspace_id = ${ws}`,
    );
    const queued = await runAs(owner, ws, 'outreach.send.queue', {
      profileId: chat!.profile_id,
      kind: 'reply',
      chatId: chat!.id,
      text: 'Sure, let me look into it.',
      simple: true,
    });
    expect(queued.state).toBe('waiting');
    await drain(s, ws);
    expect(await pushes(ws)).toContainEqual({
      title: 'Ana Moss needs you',
      body: 'Their reply waits for your OK in Today: it’s about a refund.',
      path: `/app/w/${ws}/a/outreach?view=today`,
      user_ids: [owner.id],
    });
  });

  it('pushes a reply, unless they were looking, and the list in the morning', async () => {
    const s = testServices();
    const ws = await outreachBusiness(owner, 'Outreach Alerts Worker Co');
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: PLAYBOOK_TEMPLATES.crm_demos.details,
    });
    const message = (username: string, name: string, threadKey: string, at: number) =>
      runAs(
        owner,
        ws,
        'outreach.touch.save',
        { kind: 'message', profile: fb(username), name, threadKey },
        new Date(at),
      );
    await message('dana.reyes.12', 'Dana Reyes', '2001', Date.now() - 10 * MIN);
    await message('sam.lee.1', 'Sam Lee', '2002', Date.now() - 10 * MIN);
    await runAs(owner, ws, 'outreach.replies.note', {
      seen: [{ name: 'Dana Reyes', threadKey: '2001' }],
    });
    await runAs(owner, ws, 'outreach.replies.note', {
      seen: [{ name: 'Sam Lee', threadKey: '2002' }],
      looking: true,
    });
    await drain(s, ws);
    expect(await pushes(ws)).toEqual([
      {
        title: 'Dana Reyes wrote back',
        body: 'On Facebook. Your list for today has them, with drafts for your reply.',
        path: `/app/w/${ws}/a/outreach?view=today`,
        user_ids: [owner.id],
      },
    ]);

    // The morning push is armed; at the business's hour, the person hears what's on their list.
    const [armed] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${MORNING_JOB} and status = 'pending'`,
    );
    expect(armed).toBeDefined();
    const hour = new Date().getUTCHours();
    await rows(admin(), sql`update app.workspaces set timezone = 'UTC' where id = ${ws}`);
    await rows(
      admin(),
      sql`update app.addon_installations set settings = jsonb_build_object('morningPushHour', ${hour}::int)
          where workspace_id = ${ws} and addon_id = 'outreach'`,
    );
    await rows(admin(), sql`update app.scheduled_jobs set run_at = now() where id = ${armed!.id}`);
    await drain(s, ws);
    const morning = (await pushes(ws)).slice(1);
    expect(morning).toEqual([
      expect.objectContaining({
        title: '2 on your list for today',
        body: '2 replies. Open the extension on Facebook to start.',
        user_ids: [owner.id],
      }),
    ]);
    // It comes back tomorrow, and only once today.
    const [next] = await rows<{ run_at: Date }>(
      admin(),
      sql`select run_at from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${MORNING_JOB} and status = 'pending'`,
    );
    expect(new Date(next!.run_at).getTime()).toBeGreaterThan(Date.now() + 20 * 3_600_000);
  }, 60_000);
});

describe('the weekly report', () => {
  it('emails each person their week on Monday, with their best group and opener, then next Monday’s', async () => {
    const s = testServices();
    const ws = await outreachBusiness(owner, 'Outreach Weekly Worker Co');
    await rows(admin(), sql`update app.workspaces set timezone = 'UTC' where id = ${ws}`);
    const group = {
      id: '5550001111',
      slug: null,
      url: 'https://www.facebook.com/groups/5550001111/',
      name: 'Austin Small Business Owners',
    };
    const note = (input: Record<string, unknown>, at = Date.now() - 10 * MIN) =>
      runAs(owner, ws, 'outreach.touch.save', input, new Date(at));
    await note({ kind: 'friend_request', profile: fb('rowan.b'), name: 'Rowan Blake', group });
    await note({ kind: 'message', profile: fb('rowan.b'), name: 'Rowan Blake', threadKey: '3001' });
    await note({ kind: 'friend_request', profile: fb('quinn.h'), name: 'Quinn Harper', group });
    await runAs(owner, ws, 'outreach.replies.note', {
      seen: [{ name: 'Rowan Blake', threadKey: '3001' }],
    });
    await runAs(owner, ws, 'outreach.demo.mark', {
      profile: fb('quinn.h'),
      name: 'Quinn Harper',
      booked: true,
    });
    await drain(s, ws);
    // Armed with the morning push, for Monday at its hour.
    const [armed] = await rows<{ id: string; run_at: Date }>(
      admin(),
      sql`select id, run_at from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${WEEKLY_JOB} and status = 'pending'`,
    );
    const monday = nextWeekly(Date.now(), 'UTC', 8).getTime();
    expect(new Date(armed!.run_at).getTime()).toBe(monday);

    // On Monday morning, the owner hears of their week.
    const sent: MailMessage[] = [];
    await rows(admin(), sql`update app.scheduled_jobs set run_at = now() where id = ${armed!.id}`);
    const runner = `vitest-weekly-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner} where id = ${armed!.id}`,
    );
    await processJobs({
      ...s,
      mailer: { send: async (m) => (sent.push(m), { messageId: 'weekly' }) },
      jobs,
      workerId: runner,
      batchSize: 10,
      reservedOnly: true,
      clock: () => monday,
    });
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      [owner.email, 'Your week on Facebook: 2 friend requests, 1 reply, 1 demo'],
    ]);
    expect(sent[0]!.text).toContain(
      'Best group: Austin Small Business Owners, 1 wrote back · 1 demo booked.',
    );
    expect(sent[0]!.text).toContain(`/app/w/${ws}/a/outreach?view=activity`);
    const [next] = await rows<{ run_at: Date }>(
      admin(),
      sql`select run_at from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${WEEKLY_JOB} and status = 'pending'`,
    );
    expect(new Date(next!.run_at).getTime()).toBe(monday + 7 * 24 * 3_600_000);
  }, 60_000);
});

describe('the demo link', () => {
  it('counts a booking through it as a demo, by itself', async () => {
    const s = testServices();
    const t = await setupTeam('outreach-demo-link');
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${t.wsId}, 'outreach', 'enabled', '0.5.0')`,
    );
    await runAs(
      t.owner,
      t.wsId,
      'outreach.touch.save',
      { kind: 'message', profile: fb('quinn.h'), name: 'Quinn Harper' },
      new Date(Date.now() - MIN),
    );
    const [quinn] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${t.wsId} and username = 'quinn.h'`,
    );
    const online = await makeCalendar(t, 'Demos', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
    });
    // Someone else's ref is left alone.
    await bookOnline(t, online.id, isoAt(nextWeekday(2), '09:00'), { linkRef: 'spring-mailer' });
    const booked = await bookOnline(t, online.id, isoAt(nextWeekday(2), '11:00'), {
      linkRef: demoRef(t.owner.id, quinn!.id),
    });
    await drain(s, t.wsId);
    expect(
      await rows(
        admin(),
        sql`select user_id, profile_id, how, appointment_id, person_id from addon_outreach.demos
            where workspace_id = ${t.wsId}`,
      ),
    ).toEqual([
      {
        user_id: t.owner.id,
        profile_id: quinn!.id,
        how: 'link',
        appointment_id: booked.appointmentId,
        person_id: booked.personId,
      },
    ]);
  }, 90_000);
});
