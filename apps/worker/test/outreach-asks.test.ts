/**
 * Asking the extension in the worker (docs/outreach.md, decision 43): an ask that first needs the person pushes to
 * them at once, once for each way it needs them, to them alone; a line alone pushes nothing; and asks are kept a
 * week, pruned with the feed, as are needs done, let go or off the list a while, and computers unseen for a month.
 */
import { randomUUID } from 'node:crypto';
import { pushDeviceRegister } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../../packages/core/test/calendar-helpers';
import {
  outreachBusiness,
  runAs,
  runWith,
} from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { LIVE_PRUNE_JOB } from '../src/addons/outreach/live';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };

/** Runs the outbox and the add-on's jobs that are due, in this business only; pushes stay queued to be read. */
async function drain(s: TestServices, ws: string) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-asks-${randomUUID().slice(0, 8)}`;
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
      token: `ExponentPushToken[asks-${randomUUID().slice(0, 12)}]`,
      appVersion: '1.0.0',
      deviceName: 'ios',
    },
    u,
  );

let owner: TestUser;
let member: TestUser;
afterAll(closeTestDbs);
beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('outreach-asks-owner', { fullName: 'Morgan Owner' }),
    createTestUser('outreach-asks-member', { fullName: 'Riley Member' }),
  ]);
  await Promise.all([phone(owner), phone(member)]);
}, 60_000);

describe('asking the extension', () => {
  it('pushes once when an ask first needs the person, to them alone, and nothing for a line', async () => {
    const s = testServices();
    const ws = await outreachBusiness(owner, 'Outreach Asks Worker Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    const pc = randomUUID();
    await runAs(owner, ws, 'outreach.live.beat', {
      computer: { id: pc, name: 'Chrome on Windows', version: '0.19.0' },
      active: true,
      status: { state: 'idle', line: null, lineAt: null, nextAt: null },
    });
    await runWith(
      owner,
      ws,
      'outreach.ask.make',
      { ask: { kind: 'file_download' } },
      { channel: 'web' },
    );
    const { ask } = await runAs(owner, ws, 'outreach.ask.take', { installId: pc });
    const progress = (state: string, line: string) =>
      runAs(owner, ws, 'outreach.ask.progress', { askId: ask.askId, state, line });

    await progress('working', 'Opening Download your information…');
    await drain(s, ws);
    expect(await pushes(ws)).toEqual([]);

    await progress('stuck', 'It couldn’t find Download. Press it yourself, then Carry on.');
    await drain(s, ws);
    expect(await pushes(ws)).toEqual([
      {
        title: 'Your computer needs you',
        body: 'It couldn’t find Download. Press it yourself, then Carry on.',
        path: `/app/w/${ws}/a/outreach?view=live`,
        user_ids: [owner.id],
      },
    ]);
    // Back to work and stuck again on the same ask: nothing more.
    await progress('working', 'Carrying on…');
    await progress('stuck', 'It couldn’t find Download again.');
    await drain(s, ws);
    expect(await pushes(ws)).toHaveLength(1);
    // Facebook asks for the password: the person hears that, in plain words.
    await progress('typing', 'Waiting for your password…');
    await drain(s, ws);
    const all = await pushes(ws);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({
      title: 'Your computer needs you',
      body: 'Facebook is asking for your password or PIN. Type it on your computer, in the Facebook tab it opened.',
      user_ids: [owner.id],
    });
  });

  it('keeps asks a week, pruned with the feed', async () => {
    const s = testServices();
    const ws = await outreachBusiness(owner, 'Outreach Asks Prune Co');
    const pc = randomUUID();
    await runAs(owner, ws, 'outreach.live.beat', {
      computer: { id: pc, name: 'Chrome on Mac', version: '0.19.0' },
      active: true,
      status: { state: 'idle', line: null, lineAt: null, nextAt: null },
    });
    await runWith(owner, ws, 'outreach.ask.make', { ask: { kind: 'friends' } }, { channel: 'web' });
    await rows(
      admin(),
      sql`insert into addon_outreach.asks (workspace_id, user_id, kind, via, state, asked_at, started_at, ended_at, line)
          values (${ws}, ${owner.id}, 'groups', 'web', 'done', now() - interval '8 days', now() - interval '8 days',
            now() - interval '8 days', 'Saved 23 groups.')`,
    );
    await drain(s, ws);
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where workspace_id = ${ws} and kind = ${LIVE_PRUNE_JOB} and status = 'pending'`,
    );
    await drain(s, ws);
    const kept = await rows<{ kind: string }>(
      admin(),
      sql`select kind from addon_outreach.asks where workspace_id = ${ws}`,
    );
    expect(kept.map((k) => k.kind)).toEqual(['friends']);
  });

  it('prunes needs done, let go or off the list a while, and computers unseen a month but the working one', async () => {
    const s = testServices();
    const ws = await outreachBusiness(owner, 'Outreach Needs Prune Co');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    await runAs(owner, ws, 'outreach.live.beat', {
      computer: { id: randomUUID(), name: 'Chrome on Mac', version: '0.19.0' },
      active: true,
      status: { state: 'idle', line: null, lineAt: null, nextAt: null },
    });
    const computer = async (u: TestUser, name: string) =>
      (
        await rows<{ id: string }>(
          admin(),
          sql`insert into addon_outreach.computers
                (workspace_id, user_id, install_id, name, last_seen_at, active_at)
              values (${ws}, ${u.id}, ${randomUUID()}, ${name}, now() - interval '40 days',
                now() - interval '40 days')
              returning id`,
        )
      )[0]!.id;
    // The owner's old laptop goes, and the ask it took keeps no computer; the member's only one stays.
    const laptop = await computer(owner, 'Chrome on an old laptop');
    await computer(member, 'Chrome on Windows');
    await rows(
      admin(),
      sql`insert into addon_outreach.asks
            (workspace_id, user_id, kind, via, state, asked_at, started_at, ended_at, computer_id, line)
          values (${ws}, ${owner.id}, 'groups', 'web', 'done', now() - interval '1 day', now() - interval '1 day',
            now() - interval '1 day', ${laptop}, 'Saved 23 groups.')`,
    );
    const [profile] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, url, name, username)
          values (${ws}, 'facebook', 'https://www.facebook.com/dana.reyes.4', 'Dana Reyes', 'dana.reyes.4')
          returning id`,
    );
    const need = (step: string, state: string, seen: string, cleared: string | null) =>
      rows(
        admin(),
        sql`insert into addon_outreach.needs
              (workspace_id, user_id, step, profile_id, name, why, state, seen_at, cleared_at)
            values (${ws}, ${owner.id}, ${step}, ${profile!.id}, ${`${step} ${state}`}, 'The button wasn’t there.',
              ${state}, now() - ${seen}::interval, now() - ${cleared}::interval)`,
      );
    await need('comment', 'done', '9 days', '8 days');
    await need('message', 'dismissed', '3 days', '2 days');
    await need('confirm', 'open', '15 days', null);
    await need('friend_request', 'open', '10 days', null);
    await need('warm_up', 'open', '1 hour', null);
    await drain(s, ws);
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where workspace_id = ${ws} and kind = ${LIVE_PRUNE_JOB} and status = 'pending'`,
    );
    await drain(s, ws);
    const needs = await rows<{ name: string }>(
      admin(),
      sql`select name from addon_outreach.needs where workspace_id = ${ws} order by name`,
    );
    expect(needs.map((n) => n.name)).toEqual([
      'friend_request open',
      'message dismissed',
      'warm_up open',
    ]);
    const computers = await rows<{ user_id: string; name: string }>(
      admin(),
      sql`select user_id, name from addon_outreach.computers where workspace_id = ${ws} order by name`,
    );
    expect(computers).toEqual([
      { user_id: owner.id, name: 'Chrome on Mac' },
      { user_id: member.id, name: 'Chrome on Windows' },
    ]);
    const [ask] = await rows<{ computer_id: string | null }>(
      admin(),
      sql`select computer_id from addon_outreach.asks where workspace_id = ${ws}`,
    );
    expect(ask).toEqual({ computer_id: null });
  });
});
