/**
 * Social Outreach in the worker: group posts kept as worth a look are checked by the AI (the stand-in model here), a
 * batch at a time, and marked good or not with why. At the day's AI limit the rest wait, unchecked. A good post's
 * writer on LinkedIn is found (decision 92), for the AI's check of them; a Facebook group's writer isn't.
 */
import { randomUUID } from 'node:crypto';
import { PLAYBOOK_TEMPLATES } from '@hfos/core/addons/outreach/playbooks';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computerOn,
  outreachBusiness,
  runAs,
} from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { outreachAddonWorker } from '../src/addons/outreach';
import { CHECK_POSTS_JOB } from '../src/addons/outreach/posts';
import type { AddonDataMigration } from '../src/addons/types';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { costlyAi, setAiLimit, testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };

let owner: TestUser;

async function drain(s: TestServices, ws: string) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-posts-${randomUUID().slice(0, 8)}`;
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

const group = {
  id: '423456789',
  slug: null,
  url: 'https://www.facebook.com/groups/423456789/',
  name: 'Austin Small Business Owners',
};
const post = (n: number, text: string) => ({
  url: `https://www.facebook.com/groups/423456789/posts/20000${n}/`,
  author: {
    id: null,
    username: `made.up.${n}`,
    url: `https://www.facebook.com/made.up.${n}`,
  },
  name: `Made Up Person ${n}`,
  text,
});

/** A business with the CRM playbook, and these posts seen in a group. */
async function seen(name: string, texts: readonly string[]) {
  const ws = await outreachBusiness(owner, name);
  const crm = PLAYBOOK_TEMPLATES.crm_demos;
  await runAs(owner, ws, 'outreach.playbook.save', {
    name: crm.name,
    template: 'crm_demos',
    details: crm.details,
  });
  await runAs(owner, ws, 'outreach.posts.save', {
    group,
    posts: texts.map((t, i) => post(i + 1, t)),
  });
  return ws;
}

const states = (ws: string) =>
  rows<{ body: string; check_state: string; check_why: string | null }>(
    admin(),
    sql`select body, check_state, check_why from addon_outreach.posts
        where workspace_id = ${ws} order by url`,
  );

beforeAll(async () => {
  owner = await createTestUser('outreach-posts-owner', { fullName: 'Pat Owner' });
}, 60_000);

afterAll(closeTestDbs);

describe('checking group posts', () => {
  it('marks each post good or not, with why', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const ws = await seen('Outreach Posts Worker Co', [
      'Can anyone recommend a CRM for my crew?',
      'Business owners: what are you grilling this weekend?',
    ]);
    await drain(s, ws);
    expect(await states(ws)).toEqual([
      {
        body: 'Can anyone recommend a CRM for my crew?',
        check_state: 'good',
        check_why: 'Asking for a recommendation',
      },
      {
        body: 'Business owners: what are you grilling this weekend?',
        check_state: 'not',
        check_why: 'Nothing to answer',
      },
    ]);
  });

  it('leaves the rest waiting at the day’s AI limit', async () => {
    const none = testServices({ ai: { provider: costlyAi() } });
    const ws = await seen('Outreach Capped Posts Co', [
      'Can anyone recommend a CRM?',
      'Looking for a bookkeeper',
      'Anyone tried a scheduling app?',
    ]);
    await setAiLimit(ws, 1);
    await drain(none, ws);
    expect((await states(ws)).filter((p) => p.check_state === 'waiting').length).toBeGreaterThan(0);
    const [job] = await rows<{ later: boolean }>(
      admin(),
      sql`select run_at > now() + interval '1 hour' as later from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${CHECK_POSTS_JOB} and status = 'pending'`,
    );
    expect(job?.later).toBe(true);
  });
});

describe('finding good posts’ writers (decision 92)', () => {
  it('finds a good LinkedIn post’s writer, and not a Facebook group post’s', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const ws = await outreachBusiness(owner, 'Outreach Post Writers Co');
    // Only a computer that checks people found has them found (decision 92's 18).
    await computerOn(owner, ws, '0.95.0');
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: crm.name,
      template: 'crm_demos',
      details: {
        ...crm.details,
        platforms: ['facebook', 'linkedin'],
        postSearches: ['missed calls'],
      },
    });
    const onLinkedIn = (n: number, text: string) => ({
      url: `https://www.linkedin.com/feed/update/urn:li:activity:74000000000000000${n}/`,
      author: {
        id: null,
        username: `made-up-${n}`,
        url: `https://www.linkedin.com/in/made-up-${n}/`,
      },
      name: `Made Up Person ${n}`,
      text,
    });
    await runAs(owner, ws, 'outreach.posts.save', {
      platform: 'linkedin',
      group: null,
      found: 'search',
      words: 'missed calls',
      posts: [
        onLinkedIn(7, 'Can anyone recommend a way to stop missed calls?'),
        onLinkedIn(8, 'Missed calls today. The crew finished early anyway.'),
      ],
    });
    await runAs(owner, ws, 'outreach.posts.save', {
      group,
      posts: [post(9, 'Can anyone recommend a CRM for my crew?')],
    });
    await drain(s, ws);
    expect((await states(ws)).map((p) => p.check_state)).toEqual(['good', 'good', 'not']);
    const found = await rows<{ name: string; how: string; words: string | null }>(
      admin(),
      sql`select p.name, f.how, f.words from addon_outreach.finds f
          join addon_outreach.profiles p on p.id = f.profile_id
          where f.workspace_id = ${ws}`,
    );
    expect(found).toEqual([{ name: 'Made Up Person 7', how: 'posted', words: 'missed calls' }]);
  });
});

describe('checking again the posts an older check called good (decision 143)', () => {
  it('sends the ones still open for a comment back to the check, and leaves the rest', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const ws = await seen('Outreach Recheck Co', [
      'Can anyone recommend a CRM for my crew?',
      'Business owners: a breaker tripped twice? Check what is plugged in first.',
      'Anyone else miss calls while up on a roof?',
      'Recommend a scheduling app?',
      'Anyone have a bookkeeper they like?',
    ]);
    await drain(s, ws);
    // An older check called every one good.
    await rows(
      admin(),
      sql`update addon_outreach.posts set check_state = 'good', check_why = 'Old check'
          where workspace_id = ${ws}`,
    );
    const url = (n: number) => post(n, '').url;
    // One has its comment, one was skipped, and one is over a week old: a comment can't go on those.
    const [first] = await rows<{ user_id: string; profile_id: string }>(
      admin(),
      sql`select user_id, profile_id from addon_outreach.posts
          where workspace_id = ${ws} and url = ${url(3)}`,
    );
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, post_url, at)
          values (${ws}, ${first!.profile_id}, ${first!.user_id}, 'comment', ${url(3)}, now())`,
    );
    await rows(
      admin(),
      sql`update addon_outreach.posts set skipped_at = now()
          where workspace_id = ${ws} and url = ${url(4)}`,
    );
    await rows(
      admin(),
      sql`update addon_outreach.posts set seen_at = now() - interval '8 days'
          where workspace_id = ${ws} and url = ${url(5)}`,
    );

    const [org] = await rows<{ organization_id: string }>(
      admin(),
      sql`select organization_id from app.workspaces where id = ${ws}`,
    );
    await asWorker(testDbs().worker.db, { workspaceId: ws }, (tx) =>
      outreachAddonWorker.dataMigrations![10]!({
        tx,
        manifest: outreachAddonWorker.manifest,
        scope: { workspaceId: ws, organizationId: org!.organization_id },
      } as unknown as Parameters<AddonDataMigration>[0]),
    );
    expect((await states(ws)).map((p) => p.check_state)).toEqual([
      'waiting',
      'waiting',
      'good',
      'good',
      'good',
    ]);
    // The check is queued at once, and asks again.
    await drain(s, ws);
    expect(await states(ws)).toEqual([
      {
        body: 'Can anyone recommend a CRM for my crew?',
        check_state: 'good',
        check_why: 'Asking for a recommendation',
      },
      {
        body: 'Business owners: a breaker tripped twice? Check what is plugged in first.',
        check_state: 'not',
        check_why: 'Nothing to answer',
      },
      {
        body: 'Anyone else miss calls while up on a roof?',
        check_state: 'good',
        check_why: 'Old check',
      },
      { body: 'Recommend a scheduling app?', check_state: 'good', check_why: 'Old check' },
      { body: 'Anyone have a bookkeeper they like?', check_state: 'good', check_why: 'Old check' },
    ]);
  });
});
