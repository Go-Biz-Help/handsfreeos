/**
 * Social Outreach in the worker: referring the people the owner has really talked with on posts asking for a
 * recommendation (docs/outreach.md, decision 174). A post the check says asks for one queues one look; the stand-in
 * model picks someone who wrote back at least twice and does what's asked, then writes the comment and the heads-up
 * with the post's link; it waits on Today and the phone hears of it once. Nobody who wrote back once, was marked not a
 * fit, or whose playbook has the switch off is referred.
 */
import { randomUUID } from 'node:crypto';
import { PLAYBOOK_TEMPLATES } from '@hfos/core/addons/outreach/playbooks';
import { pushDeviceRegister } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../../packages/core/test/calendar-helpers';
import { outreachBusiness, runAs } from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { FIND_REFERRAL_JOB } from '../src/addons/outreach/referrals';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };

async function drain(s: TestServices, ws: string) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-refer-${randomUUID().slice(0, 8)}`;
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

const group = {
  id: '623456789',
  slug: null,
  url: 'https://www.facebook.com/groups/623456789/',
  name: 'Boise Small Business Owners',
};
const post = (n: number, text: string) => ({
  url: `https://www.facebook.com/groups/623456789/posts/40000${n}/`,
  author: { id: null, username: `asker.${n}`, url: `https://www.facebook.com/asker.${n}` },
  name: `Asker ${n}`,
  when: '2h',
  text,
});

let owner: TestUser;
beforeAll(async () => {
  owner = await createTestUser('outreach-refer-owner', { fullName: 'Pat Owner' });
  await run(
    pushDeviceRegister,
    {
      platform: 'ios',
      token: `ExponentPushToken[refer-${randomUUID().slice(0, 12)}]`,
      appVersion: '1.0.0',
      deviceName: 'ios',
    },
    owner,
  );
}, 60_000);
afterAll(closeTestDbs);

/** A business with the CRM playbook, its id and the playbook's. */
async function business(name: string, details: Record<string, unknown> = {}) {
  const ws = await outreachBusiness(owner, name);
  const crm = PLAYBOOK_TEMPLATES.crm_demos;
  const saved = await runAs(owner, ws, 'outreach.playbook.save', {
    name: crm.name,
    template: 'crm_demos',
    details: { ...crm.details, ...details },
  });
  return { ws, playbookId: saved.id as string };
}

/** Someone the owner talked with: their profile, `replies` times they wrote back, and the playbook they were reached with. */
async function talkedWith(
  ws: string,
  playbookId: string,
  username: string,
  name: string,
  intro: readonly string[],
  replies: number,
) {
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name, intro)
        values (${ws}, 'facebook', ${username}, ${`https://www.facebook.com/${username}`}, ${name},
          ${`{${intro.map((l) => `"${l}"`).join(',')}}`}::text[])
        returning id`,
  );
  for (let i = 0; i < replies; i++)
    await rows(
      admin(),
      sql`insert into addon_outreach.replies (workspace_id, user_id, profile_id, after_at, seen_at, pushed)
          values (${ws}, ${owner.id}, ${p!.id}, now() - make_interval(days => ${10 - i}::int),
            now() - make_interval(days => ${9 - i}::int), false)`,
    );
  await rows(
    admin(),
    sql`insert into addon_outreach.opener_uses (workspace_id, user_id, profile_id, playbook_id, kind, text, used_at)
        values (${ws}, ${owner.id}, ${p!.id}, ${playbookId}, 'style', 'Hi there!', now() - interval '12 days')`,
  );
  return p!.id;
}

const referrals = (ws: string) =>
  runAs(owner, ws, 'outreach.referrals', {}).then(
    (r: {
      referrals: {
        name: string;
        asks: string | null;
        comment: string;
        note: string;
        postUrl: string;
      }[];
    }) => r.referrals,
  );

describe('referring someone on a post asking for a recommendation', () => {
  it('picks someone who wrote back twice and does it, and writes both with the post’s link', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const { ws, playbookId } = await business('Outreach Refer Co');
    await talkedWith(ws, playbookId, 'once.roofer', 'Once Roofer', ['Owner at Once Roofing'], 1);
    await talkedWith(ws, playbookId, 'baker.boise', 'Bea Baker', ['Owner at Boise Bakery'], 3);
    await talkedWith(
      ws,
      playbookId,
      'dana.roofs',
      'Dana Reyes',
      ['Owner at Reyes Roofing, Boise'],
      2,
    );
    await runAs(owner, ws, 'outreach.posts.save', {
      group,
      found: 'scroll',
      posts: [post(1, 'Can anyone recommend a good roofer in Boise?')],
    });
    await drain(s, ws);
    const list = await referrals(ws);
    expect(list).toEqual([
      expect.objectContaining({
        name: 'Dana Reyes',
        asks: 'a roofer in Boise',
        postUrl: post(1, '').url,
      }),
    ]);
    expect(list[0]!.comment).toContain('Dana Reyes');
    expect(list[0]!.note).toContain(post(1, '').url);
    expect(list[0]!.note).not.toContain('[post link]');
    expect(list[0]!.comment + list[0]!.note).not.toContain(group.name);
    expect(await pushes(ws)).toEqual([
      {
        title: 'You could refer Dana Reyes',
        body: 'Someone is asking for a roofer in Boise. Your comment and their heads-up are ready on Today.',
        path: `/app/w/${ws}/a/outreach?view=today`,
      },
    ]);
    // Seen again: one look a post, one referral a post.
    await runAs(owner, ws, 'outreach.posts.save', {
      group,
      found: 'scroll',
      posts: [post(1, 'Can anyone recommend a good roofer in Boise?')],
    });
    await drain(s, ws);
    expect(await referrals(ws)).toHaveLength(1);
    const [looks] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.scheduled_jobs where workspace_id = ${ws} and kind = ${FIND_REFERRAL_JOB}`,
    );
    expect(looks!.n).toBe(1);
  });

  it('refers nobody marked not a fit, nobody when none fits, and nobody whose playbook has it off', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const { ws, playbookId } = await business('Outreach Refer Not Co');
    const dana = await talkedWith(
      ws,
      playbookId,
      'dana.r2',
      'Dana Reyes',
      ['Owner at Reyes Roofing'],
      2,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.stages (workspace_id, user_id, profile_id, mark, marked_by, marked_at)
          values (${ws}, ${owner.id}, ${dana}, 'lost', 'person', now())`,
    );
    await talkedWith(ws, playbookId, 'bea.b2', 'Bea Baker', ['Owner at Boise Bakery'], 2);
    await runAs(owner, ws, 'outreach.posts.save', {
      group,
      found: 'scroll',
      posts: [post(2, 'Can anyone recommend a good roofer in Boise?')],
    });
    await drain(s, ws);
    expect(await referrals(ws)).toEqual([]);

    const off = await business('Outreach Refer Off Co', { refer: false });
    await talkedWith(
      off.ws,
      off.playbookId,
      'dana.r3',
      'Dana Reyes',
      ['Owner at Reyes Roofing'],
      2,
    );
    await runAs(owner, off.ws, 'outreach.posts.save', {
      group,
      found: 'scroll',
      posts: [post(3, 'Can anyone recommend a good roofer in Boise?')],
    });
    await drain(s, off.ws);
    expect(await referrals(off.ws)).toEqual([]);
  });
});
