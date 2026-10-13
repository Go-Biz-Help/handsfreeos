/**
 * Social Outreach's groups in the worker (decision 48): a group's About page, rules and posts are checked by the AI
 * (the stand-in model here) for whether the business's people are there, and the posts let go; and a group's join
 * questions are answered by it from the playbook, one answer each, through the worker's actions route; and a helpful
 * post asked for is written by it for one of the person's groups, or put aside when the group's rules don't allow it
 * (decision 50).
 */
import { randomUUID } from 'node:crypto';
import { PLAYBOOK_TEMPLATES } from '@hfos/core/addons/outreach/playbooks';
import { createTokenVerifier } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachBusiness, runAs } from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { scriptedAi } from '../src/ai/scripted';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };

let owner: TestUser;
let ws: string;
let app: FastifyInstance;
let s: TestServices;

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-groups-${randomUUID().slice(0, 8)}`;
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

const group = (id: string, name: string) => ({
  id,
  slug: null,
  url: `https://www.facebook.com/groups/${id}/`,
  name,
});
const idOf = async (fb: string) =>
  (
    await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.groups where workspace_id = ${ws} and platform_id = ${fb}`,
    )
  )[0]!.id;

beforeAll(async () => {
  s = testServices({ ai: { provider: scriptedAi(), dailyTokens: 5_000_000 } });
  owner = await createTestUser('outreach-groups-owner', { fullName: 'Pat Owner' });
  ws = await outreachBusiness(owner, 'Outreach Groups Worker Co');
  const crm = PLAYBOOK_TEMPLATES.crm_demos;
  await runAs(owner, ws, 'outreach.playbook.save', {
    name: crm.name,
    template: 'crm_demos',
    details: crm.details,
  });
  await runAs(owner, ws, 'outreach.groups.save', {
    groups: [
      { group: group('600000001', 'Texas Contractors Network') },
      { group: group('600000002', 'Austin Owners') },
      { group: group('600000003', 'Home Bakers Club') },
    ],
  });
  const env = testEnv();
  app = await buildHttpServer({
    ...s,
    addonConnect: { fake: true, platformKeys: {} },
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('checking groups', () => {
  it('says whether the business’s people are there, and lets the posts go', async () => {
    for (const [fb, about] of [
      ['600000001', 'For licensed contractors across Texas'],
      ['600000002', 'For small business owners in Austin'],
      ['600000003', 'A club for home bakers'],
    ] as const)
      await runAs(owner, ws, 'outreach.group.look', {
        groupId: await idOf(fb),
        about: [about],
        posts: ['Anyone use a CRM?'],
      });
    await drain();
    const checked = await rows<{
      name: string;
      check_state: string;
      check_why: string[];
      check_who: string | null;
      check_lines: string[];
      playbook: string | null;
    }>(
      admin(),
      sql`select g.name, g.check_state, g.check_why, g.check_who, g.check_lines, pb.name as playbook
          from addon_outreach.groups g left join addon_outreach.playbooks pb on pb.id = g.check_playbook_id
          where g.workspace_id = ${ws} order by g.name`,
    );
    expect(checked).toEqual([
      {
        name: 'Austin Owners',
        check_state: 'maybe',
        check_why: ['Some owners post'],
        check_who: 'For small business owners in Austin',
        check_lines: [],
        playbook: 'CRM demos',
      },
      {
        name: 'Home Bakers Club',
        check_state: 'not',
        check_why: [],
        check_who: null,
        check_lines: [],
        playbook: null,
      },
      {
        name: 'Texas Contractors Network',
        check_state: 'good',
        check_why: ['Contractors ask for help here'],
        check_who: 'For licensed contractors across Texas',
        check_lines: [],
        playbook: 'CRM demos',
      },
    ]);
  });
});

describe('answering a group’s questions', () => {
  it('answers each question from the playbook, once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/addons/outreach/actions/outreach.join.answer',
      headers: { authorization: `Bearer ${await signInTestUser(owner)}` },
      payload: {
        workspaceId: ws,
        input: {
          groupId: await idOf('600000001'),
          questions: ['What trade are you in?', 'Where do you work?'],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      answers: ['Answer 1 from the playbook.', 'Answer 2 from the playbook.'],
    });
  });

  it('refuses a group that isn’t kept here', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/addons/outreach/actions/outreach.join.answer',
      headers: { authorization: `Bearer ${await signInTestUser(owner)}` },
      payload: { workspaceId: ws, input: { groupId: randomUUID(), questions: ['Why?'] } },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('picking a post to like', () => {
  const pick = async (posts: unknown[]) => {
    const profileId = randomUUID();
    await rows(
      admin(),
      sql`insert into addon_outreach.profiles (id, workspace_id, platform, username, url, name)
          values (${profileId}, ${ws}, 'facebook', ${`like.pick.${profileId.slice(0, 8)}`},
            ${`https://www.facebook.com/like.pick.${profileId.slice(0, 8)}`}, 'Dana Reyes')`,
    );
    return app.inject({
      method: 'POST',
      url: '/v1/addons/outreach/actions/outreach.like.pick',
      headers: { authorization: `Bearer ${await signInTestUser(owner)}` },
      payload: { workspaceId: ws, input: { profileId, posts } },
    });
  };

  it('asks the AI which post, and never takes one about a death', async () => {
    const res = await pick([
      { text: 'RIP Grandpa', pictures: [] },
      { text: 'Busy week at the shop', pictures: [] },
      { text: '', pictures: ['May be an image of 2 people and dog'] },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      pick: 2,
      about: 'personal',
      why: 'A photo they shared',
      by: 'ai',
    });
    // The AI's pick is a sad one: the words pick the first safe post instead.
    const sad = await pick([
      { text: 'Busy week at the shop', pictures: [] },
      { text: 'Funeral is Saturday', pictures: ['May be an image of flowers'] },
    ]);
    expect(sad.json()).toMatchObject({ pick: 0, by: 'words' });
  });
});

describe('writing a helpful post', () => {
  it('writes one for a group the person is in, or puts it aside when its rules don’t allow it', async () => {
    await runAs(owner, ws, 'outreach.groups.save', {
      groups: [{ group: group('600000001', 'Texas Contractors Network'), joined: true }],
    });
    const asked = await runAs(owner, ws, 'outreach.helpful.ask', {});
    expect(asked).toMatchObject({ groupName: 'Texas Contractors Network', fresh: true });
    await drain();
    const kept = () =>
      rows<{ state: string; topic: string | null; body: string | null; why_not: string | null }>(
        admin(),
        sql`select state, topic, body, why_not from addon_outreach.helpful
            where workspace_id = ${ws} order by asked_at`,
      );
    expect(await kept()).toEqual([
      {
        state: 'draft',
        topic: 'Following up on quotes',
        body: expect.stringMatching(/^One habit that won me more jobs/),
        why_not: null,
      },
    ]);
    // Put aside, and the next asked for a group whose rules say only admins post.
    await runAs(owner, ws, 'outreach.helpful.skip', { helpfulId: asked.helpfulId });
    await rows(
      admin(),
      sql`update addon_outreach.groups set rules = '{"Only admins post: members comment."}'
          where workspace_id = ${ws} and platform_id = '600000001'`,
    );
    await runAs(owner, ws, 'outreach.helpful.ask', {});
    await drain();
    expect((await kept())[1]).toEqual({
      state: 'skipped',
      topic: 'Follow-ups',
      body: null,
      why_not: 'Only admins post in this group',
    });
  });
});
