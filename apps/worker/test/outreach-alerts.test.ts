/**
 * Social Outreach's phone alerts and demo link in the worker (docs/outreach.md, decisions 22 and 24): a reply the
 * extension saw is pushed to the person, unless they were looking, and one handed over to them (decision 27); at the business's hour each person who used the
 * extension lately hears how much is on their list for today; a post asking for what the business offers pushes at
 * once when it's fresh (decision 49); someone accepting the person's friend request pushes when they switched that on
 * (decision 101); and a booking through someone's demo link counts as a demo by itself.
 */
import { randomUUID } from 'node:crypto';
import { demoRef, partnerRef } from '@hfos/core/addons/outreach/demos';
import { nextWeekly } from '@hfos/core/addons/outreach/results';
import { PLAYBOOK_TEMPLATES } from '@hfos/core/addons/outreach/playbooks';
import {
  formCreate,
  formPublish,
  formResponseStart,
  formResponseSubmit,
  formSaveDraft,
  pushDeviceRegister,
  sessionPublish,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bookOnline,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  runSystem,
  setupTeam,
} from '../../../packages/core/test/calendar-helpers';
import {
  getReady,
  outreachBusiness,
  runAs,
} from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { MORNING_JOB } from '../src/addons/outreach/alerts';
import { LIVE_PRUNE_JOB } from '../src/addons/outreach/live';
import { WEEKLY_JOB } from '../src/addons/outreach/weekly';
import { scriptedAi } from '../src/ai/scripted';
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
      body: 'Their reply waits for your OK on Today: it’s about a refund.',
      path: `/app/w/${ws}/a/outreach?view=waiting`,
      user_ids: [owner.id],
    });
  });

  it('pushes who accepted the person’s friend requests only once they switch it on, in one push', async () => {
    const s = testServices();
    const ws = await outreachBusiness(owner, 'Outreach Accepted Co');
    const sent = (people: { username: string; name: string }[]) =>
      runAs(owner, ws, 'outreach.friends.save', {
        list: 'sent',
        people: people.map((p) => ({ profile: fb(p.username), name: p.name })),
      });
    const friendsNow = (people: { username: string; name: string }[]) =>
      runAs(owner, ws, 'outreach.friends.save', {
        list: 'friends',
        people: people.map((p) => ({ profile: fb(p.username), name: p.name })),
      });
    const ana = { username: 'ana.moss.3', name: 'Ana Moss' };
    const ben = { username: 'ben.cole.4', name: 'Ben Cole' };
    const cy = { username: 'cy.dunn.5', name: 'Cy Dunn' };
    const dee = { username: 'dee.fox.6', name: 'Dee Fox' };
    // Off to start: Ana accepting pushes nothing.
    await sent([ana, ben, cy, dee]);
    await friendsNow([ana]);
    await drain(s, ws);
    expect(await pushes(ws)).toEqual([]);
    // Switched on: Ben, then Cy and Dee together, and a friend who was never sent a request never counts.
    await runAs(owner, ws, 'outreach.automation.save', {
      settings: {
        sending: 'off',
        warmUp: true,
        confirmRequests: true,
        hours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] },
        acceptedPush: true,
      },
    });
    await friendsNow([ben, { username: 'eli.gray.7', name: 'Eli Gray' }]);
    await friendsNow([cy, dee, ben]);
    await drain(s, ws);
    const pushed = await pushes(ws);
    expect(pushed).toHaveLength(2);
    expect(pushed).toEqual(
      expect.arrayContaining([
        {
          title: 'Ben Cole accepted your friend request',
          body: 'On Facebook. Tap for your list for today.',
          path: `/app/w/${ws}/a/outreach?view=today`,
          user_ids: [owner.id],
        },
        {
          title: '2 people accepted your friend requests',
          body: 'Cy Dunn and Dee Fox. On Facebook. Tap for your list for today.',
          path: `/app/w/${ws}/a/outreach?view=today`,
          user_ids: [owner.id],
        },
      ]),
    );
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

    // The morning push is armed; at the business's hour, the person hears what's on their list (once they're ready).
    await getReady(ws, [owner.id]);
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

describe('posts asking for what the business offers', () => {
  it('pushes a fresh one to the person who found it, once, and puts it first on Today', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const ws = await outreachBusiness(owner, 'Outreach Fast Posts Co');
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: crm.details,
    });
    const post = (n: number, when: string, text: string) => ({
      url: `https://www.facebook.com/groups/523456789/posts/30000${n}/`,
      author: fb(`made.up.fast.${n}`),
      name: `Fast Person ${n}`,
      when,
      text,
    });
    const group = {
      id: '523456789',
      slug: null,
      url: 'https://www.facebook.com/groups/523456789/',
      name: 'Austin Small Business Owners',
    };
    await runAs(owner, ws, 'outreach.posts.save', {
      group,
      found: 'watch',
      posts: [
        post(1, '12m', 'Can anyone recommend a good accountant?'),
        post(2, '25m', 'Looking for a CRM for my crew, who do you use?'),
        // Asking just as much, but days ago: on Today, without a buzz.
        post(3, '4d', 'Looking for a CRM that does invoices too?'),
      ],
    });
    await drain(s, ws);
    expect(await pushes(ws)).toEqual([
      {
        title: 'Fast Person 2 is asking for what you offer',
        body: 'In Austin Small Business Owners. Looking for a CRM now. Answer it first: it’s at the top of your list for today.',
        path: `/app/w/${ws}/a/outreach?view=today`,
        user_ids: [owner.id],
      },
    ]);
    // The same post seen again changes nothing: one push a post.
    await runAs(owner, ws, 'outreach.posts.save', {
      group,
      found: 'watch',
      posts: [post(2, '40m', 'Looking for a CRM for my crew, who do you use?')],
    });
    await drain(s, ws);
    expect(await pushes(ws)).toHaveLength(1);
    const list = await runAs(owner, ws, 'outreach.today', {});
    expect(
      list.items.map((i: { name: string; asking: boolean }) => [i.name, i.asking]).slice(0, 3),
    ).toEqual([
      // Both asking first, the one seen latest first; then the rest.
      ['Fast Person 2', true],
      ['Fast Person 3', true],
      ['Fast Person 1', false],
    ]);
  });
});

describe('live status', () => {
  it('pushes a Facebook warning to that person alone, once a day, and keeps the feed a week', async () => {
    const s = testServices();
    const ws = await outreachBusiness(owner, 'Outreach Live Worker Co');
    const teammate = await createTestUser('outreach-alerts-teammate', { fullName: 'Riley Member' });
    await phone(teammate);
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${ws}, ${teammate.id}, 'member')`,
    );
    await runAs(owner, ws, 'outreach.warning.note', {
      words: ['You’re temporarily blocked from sending friend requests'],
    });
    await runAs(owner, ws, 'outreach.warning.note', { words: ['We limit how often you can post'] });
    await drain(s, ws);
    expect(await pushes(ws)).toEqual([
      {
        title: 'Facebook showed a warning.',
        body: 'The extension stopped on Facebook for today.',
        path: `/app/w/${ws}/a/outreach?view=live`,
        user_ids: [owner.id],
      },
    ]);

    // The feed: a line from last week goes, today's stays, and the pruning comes back tomorrow.
    const install = randomUUID();
    await runAs(owner, ws, 'outreach.live.beat', {
      computer: { id: install, name: 'Chrome on Mac', version: '0.17.0' },
      status: { state: 'idle', line: null, lineAt: null, nextAt: null },
      steps: [
        {
          id: randomUUID(),
          at: new Date().toISOString(),
          kind: 'done',
          line: 'Sent Dana Reyes a friend request',
        },
      ],
    });
    await rows(
      admin(),
      sql`insert into addon_outreach.live_steps (workspace_id, user_id, at, kind, line)
          values (${ws}, ${owner.id}, now() - interval '8 days', 'done', 'A line from last week')`,
    );
    await drain(s, ws);
    const [armed] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${LIVE_PRUNE_JOB} and status = 'pending'`,
    );
    expect(armed).toBeDefined();
    await rows(admin(), sql`update app.scheduled_jobs set run_at = now() where id = ${armed!.id}`);
    await drain(s, ws);
    const kept = await rows<{ line: string }>(
      admin(),
      sql`select line from addon_outreach.live_steps where workspace_id = ${ws} order by at`,
    );
    expect(kept.map((k) => k.line)).not.toContain('A line from last week');
    expect(kept.map((k) => k.line)).toContain('Sent Dana Reyes a friend request');
    const [again] = await rows<{ run_at: Date }>(
      admin(),
      sql`select run_at from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${LIVE_PRUNE_JOB} and status = 'pending'`,
    );
    expect(new Date(again!.run_at).getTime()).toBeGreaterThan(Date.now() + 20 * 60 * MIN);

    // A step from a computer HandsFreeOS knows already tells the app, but doesn't arm the pruning again.
    await rows(
      admin(),
      sql`delete from app.scheduled_jobs where workspace_id = ${ws} and kind = ${LIVE_PRUNE_JOB}`,
    );
    await runAs(owner, ws, 'outreach.live.beat', {
      computer: { id: install, name: 'Chrome on Mac', version: '0.17.0' },
      status: { state: 'idle', line: null, lineAt: null, nextAt: null },
      steps: [
        {
          id: randomUUID(),
          at: new Date().toISOString(),
          kind: 'done',
          line: 'Liked a post of Dana Reyes',
        },
      ],
    });
    await drain(s, ws);
    expect(
      await rows(
        admin(),
        sql`select id from app.scheduled_jobs
            where workspace_id = ${ws} and kind = ${LIVE_PRUNE_JOB} and status = 'pending'`,
      ),
    ).toEqual([]);
  });
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

describe('the demo link to a form that books a time', () => {
  it('counts the time booked on the form as a demo, by itself', async () => {
    const s = testServices();
    const t = await setupTeam('outreach-demo-form');
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${t.wsId}, 'outreach', 'enabled', '0.5.0')`,
    );
    await runAs(
      t.owner,
      t.wsId,
      'outreach.touch.save',
      { kind: 'message', profile: fb('rae.c'), name: 'Rae Collins' },
      new Date(Date.now() - MIN),
    );
    const [rae] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${t.wsId} and username = 'rae.c'`,
    );
    // A recruiting page: their name, their phone, and a presentation to pick.
    const cal = await makeCalendar(t, 'Live presentation', {
      public: false,
      team: { members: [{ userId: t.owner.id }] },
      schedule: { mode: 'sessions' },
      capacity: { seats: 10 },
    });
    const startsAt = isoAt(nextWeekday(2, 7), '10:00');
    const session = await run(
      sessionPublish,
      { workspaceId: t.wsId, calendarId: cal.id, startsAt, userIds: [t.owner.id] },
      t.owner,
    );
    const created = await run(formCreate, { workspaceId: t.wsId, name: 'Join the team' }, t.owner);
    const [form] = await rows<{ definition: { pages: { id: string }[] } }>(
      admin(),
      sql`select definition from app.forms where id = ${created.formId}`,
    );
    const pageId = form!.definition.pages[0]!.id;
    const add = (question: Record<string, unknown>) => ({
      op: 'add_question',
      pageId,
      index: null,
      question,
    });
    const saved = await run(
      formSaveDraft,
      {
        workspaceId: t.wsId,
        formId: created.formId,
        baseRevision: created.revision,
        ops: [
          add({
            id: 'q_name0000',
            type: 'short_text',
            title: 'Your name',
            required: true,
            mapTo: 'person.first_name',
            config: {},
          }),
          add({
            id: 'q_phone000',
            type: 'phone',
            title: 'Your phone',
            mapTo: 'person.phone',
            config: {},
          }),
          add({
            id: 'q_when0000',
            type: 'booking',
            title: 'Pick a presentation',
            required: true,
            config: { calendarId: cal.id },
          }),
        ],
      },
      t.owner,
    );
    await run(
      formPublish,
      { workspaceId: t.wsId, formId: created.formId, baseRevision: saved.revision },
      t.owner,
    );
    // Opened from Rae's demo link.
    const started = await runSystem(
      formResponseStart,
      {
        workspaceId: t.wsId,
        formId: created.formId,
        source: 'link',
        linkRef: demoRef(t.owner.id, rae!.id),
      },
      t.scope,
    );
    const sent = await runSystem(
      formResponseSubmit,
      {
        workspaceId: t.wsId,
        responseId: started.responseId,
        token: started.token,
        answers: {
          q_name0000: 'Rae',
          q_phone000: '(512) 555-0611',
          q_when0000: { startsAt, sessionId: session.appointmentId, label: 'Tuesday' },
        },
      },
      t.scope,
    );
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
        profile_id: rae!.id,
        how: 'link',
        appointment_id: session.appointmentId,
        person_id: sent.personId,
      },
    ]);
  }, 90_000);
});

describe('the partner link', () => {
  it('moves the partner a call was booked through to Call booked, and never counts a demo', async () => {
    const s = testServices();
    const t = await setupTeam('outreach-partner-link');
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${t.wsId}, 'outreach', 'enabled', '0.5.0')`,
    );
    await runAs(t.owner, t.wsId, 'outreach.touch.save', {
      kind: 'message',
      profile: fb('gail.a'),
      name: 'Gail Admin',
    });
    const [gail] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${t.wsId} and username = 'gail.a'`,
    );
    // On the owner's Partners list, asked.
    await rows(
      admin(),
      sql`insert into addon_outreach.partners (workspace_id, user_id, profile_id, kind, fit, stage, found_at,
            asked_at, looked_at)
          values (${t.wsId}, ${t.owner.id}, ${gail!.id}, 'group_admin', 'good', 'asked', now(), now(), now())`,
    );
    const online = await makeCalendar(t, 'Partner calls', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
    });
    await bookOnline(t, online.id, isoAt(nextWeekday(3), '10:00'), {
      linkRef: partnerRef(t.owner.id, gail!.id),
    });
    await drain(s, t.wsId);
    expect(
      await rows(
        admin(),
        sql`select stage, call_at is not null as call from addon_outreach.partners where workspace_id = ${t.wsId}`,
      ),
    ).toEqual([{ stage: 'call_booked', call: true }]);
    const [demos] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.demos where workspace_id = ${t.wsId}`,
    );
    expect(demos!.n).toBe(0);
  }, 90_000);
});
