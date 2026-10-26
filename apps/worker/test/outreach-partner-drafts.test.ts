/**
 * A partner's messages for Today (`outreach.today.draft` with a partner's kind, decision 81), through the worker's
 * actions route against the stand-in model: the ask, and a reply that reads their answer, a yes drafted as the details
 * with the person's partner link. Only someone on the person's own Partners list is drafted for.
 */
import { readPartnerRef } from '@hfos/core/addons/outreach/demos';
import { createTokenVerifier } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
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
import { outreachBusiness } from '../../../packages/core/test/addons/outreach-fixture';
import { blankPlaybook } from '../../../packages/core/src/addons/outreach/playbooks';
import {
  fileChats,
  partners,
  playbooks,
  profiles,
} from '../../../packages/core/src/addons/outreach/tables';
import { scriptedAi } from '../src/ai/scripted';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

const admin = () => testDbs().admin.db;
const LINK = 'https://book.example.com/partner-call';

let app: FastifyInstance;
let owner: TestUser;
let member: TestUser;
let ws: string;
let profileId: string;
let partnerId: string;

const draft = async (u: TestUser, input: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/addons/outreach/actions/outreach.today.draft',
    headers: { authorization: `Bearer ${await signInTestUser(u)}` },
    payload: { workspaceId: ws, input },
  });

beforeAll(async () => {
  const s = testServices({ ai: { provider: scriptedAi() } });
  [owner, member] = await Promise.all([
    createTestUser('outreach-partner-draft-owner'),
    createTestUser('outreach-partner-draft-member'),
  ]);
  ws = await outreachBusiness(owner, 'Outreach Partner Draft Co');
  const [book] = await admin()
    .insert(playbooks)
    .values({
      workspaceId: ws,
      name: 'Partners',
      details: {
        ...blankPlaybook(),
        goal: 'partner',
        offer: '10% of what each customer pays for a year',
        link: LINK,
      },
    })
    .returning({ id: playbooks.id });
  const [p] = await admin()
    .insert(profiles)
    .values({
      workspaceId: ws,
      platform: 'facebook',
      username: 'gail.admin.1',
      url: 'https://www.facebook.com/gail.admin.1',
      name: 'Gail Admin',
      intro: ['Realtor in Austin'],
      partnerFoundAt: new Date(),
    })
    .returning({ id: profiles.id });
  profileId = p!.id;
  const [row] = await admin()
    .insert(partners)
    .values({
      workspaceId: ws,
      userId: owner.id,
      profileId,
      kind: 'group_admin',
      fit: 'good',
      playbookId: book!.id,
      audience: 'About 4,200 Austin homeowners',
      why: ['Runs a busy homeowners group'],
      stage: 'asked',
      foundAt: new Date(),
      askedAt: new Date(),
      lookedAt: new Date(),
    })
    .returning({ id: partners.id });
  partnerId = row!.id;
  await admin()
    .insert(fileChats)
    .values({
      workspaceId: ws,
      userId: owner.id,
      profileId,
      platform: 'facebook',
      name: 'Gail Admin',
      nameKey: 'gailadmin',
      firstAt: new Date(),
      lastAt: new Date(),
      messages: 2,
      lastFromMe: false,
      recent: [
        {
          fromMe: true,
          text: 'Would you be open to a partnership?',
          at: new Date(Date.now() - 60_000).toISOString(),
        },
        { fromMe: false, text: 'Sure, sounds good', at: new Date().toISOString() },
      ],
    });
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
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

describe('a partner’s drafts', () => {
  it('asks about partnering only', async () => {
    const res = await draft(owner, { kind: 'partner_ask', profileId });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: 'partner_ask',
      answer: null,
      drafts: [
        'Hi Gail, would you be open to a partnership? I’d share what each person you send pays.',
      ],
      opener: null,
      simple: false,
    });
  });

  it('reads a yes in their reply, makes them Interested, and drafts the details with the partner link', async () => {
    const res = await draft(owner, { kind: 'partner_reply', profileId });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out).toMatchObject({ kind: 'partner_details', answer: 'yes', simple: false });
    const link = /https:\/\/book\.example\.com\/partner-call\?ref=[A-Za-z0-9_-]+/.exec(
      out.drafts[0],
    )?.[0];
    expect(readPartnerRef(new URL(link!).searchParams.get('ref'))).toEqual({
      userId: owner.id,
      profileId,
    });
    const [kept] = await rows<{ stage: string; answer: string }>(
      admin(),
      sql`select stage, answer from addon_outreach.partners where id = ${partnerId}`,
    );
    expect(kept).toEqual({ stage: 'interested', answer: 'yes' });
  });

  it('drafts for nobody off the person’s own Partners list', async () => {
    const res = await draft(member, { kind: 'partner_ask', profileId });
    expect(res.statusCode).toBe(404);
  });
});
