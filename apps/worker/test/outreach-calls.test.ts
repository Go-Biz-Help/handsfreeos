/**
 * Social Outreach's networking calls in the worker (docs/outreach.md, decision 187): a booking through the person's
 * networking call link, or on their Networking calendar under the name of someone they chat with, is kept, and half an
 * hour before it their phone gets the prep note: what they do, where, who they could refer them to, and a question.
 * Once a call time; Monday's push says last week's 1-on-1s.
 */
import { randomUUID } from 'node:crypto';
import { callRef } from '@hfos/core/addons/outreach/demos';
import { outreachAddon } from '@hfos/core/addons/outreach/manifest';
import { pushDeviceRegister } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bookOnline,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  setupTeam,
  type Team,
} from '../../../packages/core/test/calendar-helpers';
import { season } from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { CALL_PREP_JOB, mondayCallsPush } from '../src/addons/outreach/calls';
import type { AddonJobContext } from '../src/addons/types';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };
const MIN = 60_000;

async function drain(s: TestServices, ws: string) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-calls-${randomUUID().slice(0, 8)}`;
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
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()`,
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
  rows<{ title: string; body: string; path: string }>(
    admin(),
    sql`select payload->>'title' as title, payload->>'body' as body, payload->>'path' as path
        from app.scheduled_jobs where workspace_id = ${ws} and kind = 'push.send'
        order by created_at`,
  );

let t: Team;
let chatsId: string;
const s = testServices({ ai: { provider: scriptedAi() } });

/** Someone the owner chats with: their profile, what they do, and `replies` times they wrote back. */
async function person(username: string, name: string, work: string | null, replies: number) {
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name, work, area, reach)
        values (${t.wsId}, 'facebook', ${username}, ${`https://www.facebook.com/${username}`}, ${name},
          ${work}, ${work ? 'Boise, ID' : null}, ${work ? 'local' : null})
        returning id`,
  );
  for (let i = 0; i < replies; i++)
    await rows(
      admin(),
      sql`insert into addon_outreach.replies (workspace_id, user_id, profile_id, after_at, seen_at, pushed)
          values (${t.wsId}, ${t.owner.id}, ${p!.id}, now() - make_interval(days => ${10 - i}::int),
            now() - make_interval(days => ${9 - i}::int), false)`,
    );
  await rows(
    admin(),
    sql`insert into addon_outreach.file_chats (workspace_id, user_id, profile_id, name, name_key, platform, first_at,
          last_at, messages, last_from_me, recent)
        values (${t.wsId}, ${t.owner.id}, ${p!.id}, ${name}, ${username}, 'facebook', now() - interval '5 days',
          now() - interval '2 days', 4, false, '[]'::jsonb)`,
  );
  return p!.id;
}

beforeAll(async () => {
  t = await setupTeam('outw-calls');
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${t.wsId}, 'outreach', 'enabled', ${outreachAddon.version})`,
  );
  await season(t.wsId, t.owner.id);
  await run(
    pushDeviceRegister,
    {
      platform: 'ios',
      token: `ExponentPushToken[calls-${randomUUID().slice(0, 12)}]`,
      appVersion: '1.0.0',
      deviceName: 'ios',
    },
    t.owner,
  );
  const chats = await makeCalendar(t, 'Networking chats', {
    public: true,
    team: { members: [{ userId: t.owner.id }] },
  });
  chatsId = chats.id;
}, 90_000);
afterAll(closeTestDbs);

describe('a networking call', () => {
  it('booked through the link gets the prep note half an hour before, once', async () => {
    const dana = await person('dana.w', 'Dana Wells', 'wedding photos', 0);
    await person('riley.s', 'Riley Stone', 'event planning', 2);
    const startsAt = isoAt(nextWeekday(3), '10:00');
    const booked = await bookOnline(t, chatsId, startsAt, {
      linkRef: callRef(t.owner.id, dana),
    });
    await drain(s, t.wsId);
    const [call] = await rows<{ id: string; how: string; profile_id: string }>(
      admin(),
      sql`select id, how, profile_id from addon_outreach.calls where appointment_id = ${booked.appointmentId}`,
    );
    expect(call).toMatchObject({ how: 'link', profile_id: dana });
    const [job] = await rows<{ id: string; run_at: Date }>(
      admin(),
      sql`select id, run_at from app.scheduled_jobs
          where workspace_id = ${t.wsId} and kind = ${CALL_PREP_JOB} and status = 'pending'`,
    );
    expect(new Date(job!.run_at).getTime()).toBe(Date.parse(startsAt) - 30 * MIN);

    // The call is now 25 minutes away.
    const soon = new Date(Date.now() + 25 * MIN);
    await rows(
      admin(),
      sql`update app.appointments set starts_at = ${soon.toISOString()}::timestamptz,
            ends_at = ${new Date(soon.getTime() + 30 * MIN).toISOString()}::timestamptz
          where id = ${booked.appointmentId}`,
    );
    await rows(admin(), sql`update app.scheduled_jobs set run_at = now() where id = ${job!.id}`);
    const before = (await pushes(t.wsId)).length;
    await drain(s, t.wsId);
    const pushed = (await pushes(t.wsId)).slice(before);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.title).toMatch(/^Call with Dana Wells in 2[45] minutes$/);
    const note = [
      'They do wedding photos.',
      'Could refer them to: Riley Stone (could use what they do).',
      'Ask: Who’s your best customer, so I know who to send your way?',
    ];
    // A push puts its lines on one.
    expect(pushed[0]!.body).toBe(note.join(' '));
    expect(pushed[0]!.path).toBe(`/app/w/${t.wsId}/a/outreach?view=today`);
    const [kept] = await rows<{ prep: string; prepped_for: Date }>(
      admin(),
      sql`select prep, prepped_for from addon_outreach.calls where id = ${call!.id}`,
    );
    expect(kept!.prep).toBe(note.join('\n'));
    expect(new Date(kept!.prepped_for).getTime()).toBe(soon.getTime());

    // Once for the time: the same job again pushes nothing more.
    await rows(
      admin(),
      sql`update app.scheduled_jobs set status = 'pending', run_at = now(), locked_at = null, locked_by = null
          where id = ${job!.id}`,
    );
    await drain(s, t.wsId);
    expect(await pushes(t.wsId)).toHaveLength(before + 1);
  }, 90_000);

  it('booked on the Networking calendar under one chat’s name is theirs; two of that name are nobody’s', async () => {
    const sam = await person('sam.o', 'Sam Ortiz', 'catering', 0);
    await rows(
      admin(),
      sql`insert into addon_outreach.automation (workspace_id, user_id, networking_calendar_id)
          values (${t.wsId}, ${t.owner.id}, ${chatsId})
          on conflict (workspace_id, user_id) do update set networking_calendar_id = excluded.networking_calendar_id`,
    );
    const booked = await bookOnline(t, chatsId, isoAt(nextWeekday(4), '11:00'), {
      customer: { firstName: 'Sam', lastName: 'Ortiz', phone: '+12085550144' },
    });
    await drain(s, t.wsId);
    const [call] = await rows<{ how: string; profile_id: string }>(
      admin(),
      sql`select how, profile_id from addon_outreach.calls where appointment_id = ${booked.appointmentId}`,
    );
    expect(call).toEqual({ how: 'name', profile_id: sam });

    await person('jo.k', 'Jo Kim', null, 0);
    await person('jo.k2', 'Jo Kim', null, 0);
    const twice = await bookOnline(t, chatsId, isoAt(nextWeekday(4), '14:00'), {
      customer: { firstName: 'Jo', lastName: 'Kim', phone: '+12085550145' },
    });
    await drain(s, t.wsId);
    const none = await rows(
      admin(),
      sql`select 1 from addon_outreach.calls where appointment_id = ${twice.appointmentId}`,
    );
    expect(none).toEqual([]);
  }, 90_000);

  it('counts on Monday’s push, for whoever had one lately', async () => {
    // A call last week.
    const [call] = await rows<{ appointment_id: string }>(
      admin(),
      sql`select appointment_id from addon_outreach.calls where workspace_id = ${t.wsId} and how = 'link'`,
    );
    await rows(
      admin(),
      sql`update app.appointments set starts_at = now() - interval '7 days',
            ends_at = now() - interval '7 days' + interval '30 minutes'
          where id = ${call!.appointment_id}`,
    );
    const [scope] = await rows<{ organization_id: string }>(
      admin(),
      sql`select organization_id from app.workspaces where id = ${t.wsId}`,
    );
    const [install] = await rows<{ generation: number }>(
      admin(),
      sql`select generation from app.addon_installations where workspace_id = ${t.wsId} and addon_id = 'outreach'`,
    );
    const ctx = {
      ...s,
      db: testDbs().worker.db,
      scope: { workspaceId: t.wsId, organizationId: scope!.organization_id },
      manifest: outreachAddon,
      generation: install!.generation,
      now: Date.now(),
    } as unknown as AddonJobContext;
    const before = (await pushes(t.wsId)).length;
    await mondayCallsPush(ctx, '2026-11-23');
    await mondayCallsPush(ctx, '2026-11-23');
    const pushed = (await pushes(t.wsId)).slice(before);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.title).toMatch(/one-on-ones? last week$/);
  }, 60_000);
});
