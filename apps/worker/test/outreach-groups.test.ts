/**
 * Social Outreach's groups in the worker (decision 48): a group's About page, rules and posts are checked by the AI
 * (the stand-in model here) for whether the business's people are there, and the posts let go; and a group's join
 * questions are answered by it from the playbook, one answer each, through the worker's actions route; and a helpful
 * post asked for is written by it for one of the person's groups, or put aside when the group's rules don't allow it
 * (decision 50). Alignable's groups are checked and answered the same way, in Alignable's words and with only the
 * playbooks that run there (decision 92).
 */
import { randomUUID } from 'node:crypto';
import type { AiProvider, AiRequest } from '@hfos/ai';
import {
  GROUP_CHECK_SYSTEM,
  groupCheckSystem,
  JOIN_ANSWER_SYSTEM,
  joinAnswerSystem,
} from '@hfos/core/addons/outreach/group-checks';
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

/** A model that remembers every request before the scripted stand-in answers it. */
function recording(inner: AiProvider) {
  const requests: AiRequest[] = [];
  const provider: AiProvider = {
    id: 'recording',
    model: inner.model,
    stream: (request, options) => {
      requests.push(request);
      return inner.stream(request, options);
    },
  };
  return { provider, requests };
}
const model = recording(scriptedAi());

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
  s = testServices({ ai: { provider: model.provider } });
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
      comment: null,
    });
    // A post about their work: liked, with a short warm-up comment for under it.
    const work = await pick([
      { text: 'Busy week at the shop', pictures: [] },
      { text: 'Our new crew finished the Miller roof', pictures: [] },
    ]);
    expect(work.json()).toMatchObject({
      pick: 1,
      about: 'business',
      comment: 'Great work, that looks sharp!',
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

  it('writes Instagram’s week’s post with the picture to take, for the person’s own account', async () => {
    const asked = await runAs(owner, ws, 'outreach.helpful.ask', { platform: 'instagram' });
    expect(asked).toMatchObject({ groupName: null, fresh: true });
    const from = model.requests.length;
    await drain();
    const request = model.requests.slice(from).find((r) => /Instagram/.test(r.system));
    expect(request).toBeTruthy();
    const [kept] = await rows<{ state: string; body: string | null; picture: string | null }>(
      admin(),
      sql`select state, body, picture from addon_outreach.helpful where id = ${asked.helpfulId}`,
    );
    expect(kept).toEqual({
      state: 'draft',
      body: expect.stringMatching(/^One habit that won me more jobs/),
      picture: 'Your notebook of follow-up dates open on the truck’s dashboard',
    });
  });
});

describe('Alignable’s groups (decision 92)', () => {
  const alignable = (slug: string, name: string) => ({
    id: null,
    slug,
    url: `https://www.alignable.com/groups/${slug}`,
    name,
  });
  const slugId = async (slug: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.groups where workspace_id = ${ws} and slug = ${slug}`,
      )
    )[0]!.id;
  const said = (request: AiRequest) => request.messages[0]!.content as string;
  const answer = async (groupId: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/addons/outreach/actions/outreach.join.answer',
      headers: { authorization: `Bearer ${await signInTestUser(owner)}` },
      payload: { workspaceId: ws, input: { groupId, questions: ['What does your business do?'] } },
    });

  beforeAll(async () => {
    // A playbook only on Facebook, and the CRM demos one (on every network) working with clients online.
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Facebook neighbors',
      template: 'crm_demos',
      details: { ...PLAYBOOK_TEMPLATES.crm_demos.details, platforms: ['facebook'] },
    });
    await rows(
      admin(),
      sql`update addon_outreach.playbooks set details = details || '{"worksOnline": true}'::jsonb
          where workspace_id = ${ws} and name = 'CRM demos'`,
    );
    await runAs(owner, ws, 'outreach.groups.save', {
      platform: 'alignable',
      groups: [{ group: alignable('austin-contractors-circle', 'Austin Contractors Circle') }],
    });
  }, 60_000);

  it('checks a group in its network’s words, with only the playbooks that run there', async () => {
    const from = model.requests.length;
    await runAs(owner, ws, 'outreach.group.look', {
      groupId: await slugId('austin-contractors-circle'),
      about: ['For contractors who run their own business around Austin'],
      posts: ['Who does your books?'],
    });
    await runAs(owner, ws, 'outreach.group.look', {
      groupId: await idOf('600000002'),
      about: ['For small business owners in Austin'],
      posts: ['Anyone use a CRM?'],
    });
    await drain();
    // The playbook saved asks the AI for its own words too: only the two groups' checks are looked at here.
    const asked = model.requests
      .slice(from)
      .filter((r) => r.system === GROUP_CHECK_SYSTEM || r.system === groupCheckSystem('alignable'));
    expect(asked).toHaveLength(2);
    const onAlignable = asked.find((r) => r.system === groupCheckSystem('alignable'))!;
    expect(onAlignable.system).toContain('Alignable groups');
    expect(onAlignable.system).not.toContain('Facebook');
    // Alignable's groups go by who's found there: a playbook for clients online is for anywhere.
    expect(said(onAlignable)).toContain('Name: CRM demos');
    expect(said(onAlignable)).toContain('Area: anywhere (it works with clients online)');
    expect(said(onAlignable)).not.toContain('Facebook neighbors');
    // Facebook's check is as it was: its own playbooks, and no word of anywhere.
    const onFacebook = asked.find((r) => r.system === GROUP_CHECK_SYSTEM)!;
    expect(said(onFacebook)).toContain('Name: Facebook neighbors');
    expect(said(onFacebook)).not.toContain('anywhere');
    const [checked] = await rows<{ check_state: string; playbook: string | null }>(
      admin(),
      sql`select g.check_state, pb.name as playbook
          from addon_outreach.groups g left join addon_outreach.playbooks pb on pb.id = g.check_playbook_id
          where g.workspace_id = ${ws} and g.slug = 'austin-contractors-circle'`,
    );
    expect(checked).toEqual({ check_state: 'good', playbook: 'CRM demos' });
  });

  it('answers an Alignable group’s questions as one of its groups, and a Facebook one’s as before', async () => {
    const from = model.requests.length;
    const res = await answer(await slugId('austin-contractors-circle'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ answers: ['Answer 1 from the playbook.'] });
    const onAlignable = model.requests
      .slice(from)
      .find((r) => r.system === joinAnswerSystem('alignable'));
    expect(onAlignable?.system).toContain('an Alignable group');
    expect(said(onAlignable!)).toContain('Area: anywhere (it works with clients online)');

    const back = model.requests.length;
    expect((await answer(await idOf('600000001'))).statusCode).toBe(200);
    const onFacebook = model.requests.slice(back).find((r) => r.system === JOIN_ANSWER_SYSTEM);
    expect(onFacebook).toBeDefined();
    expect(said(onFacebook!)).not.toContain('anywhere');
  });
});
