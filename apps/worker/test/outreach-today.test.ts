/**
 * Social Outreach's drafts for Today (`outreach.today.draft`), through the worker's actions route against the
 * stand-in model: a few to pick from, each once, none with the playbook's words to avoid. A person's chat is only
 * theirs to draft from.
 */
import { createTokenVerifier } from '@hfos/core/server';
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
import {
  fileChats,
  playbooks,
  posts,
  profiles,
} from '../../../packages/core/src/addons/outreach/tables';
import { PLAYBOOK_TEMPLATES } from '../../../packages/core/src/addons/outreach/playbooks';
import { scriptedAi } from '../src/ai/scripted';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

let app: FastifyInstance;
let owner: TestUser;
let member: TestUser;
let ws: string;
let profileId: string;
let chatId: string;
let postId: string;

const draft = async (u: TestUser, input: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/addons/outreach/actions/outreach.today.draft',
    headers: { authorization: `Bearer ${await signInTestUser(u)}` },
    payload: { workspaceId: ws, input },
  });

beforeAll(async () => {
  const s = testServices({ ai: { provider: scriptedAi(), dailyTokens: 5_000_000 } });
  [owner, member] = await Promise.all([
    createTestUser('outreach-draft-owner'),
    createTestUser('outreach-draft-member'),
  ]);
  ws = await outreachBusiness(owner, 'Outreach Draft Co');
  const crm = PLAYBOOK_TEMPLATES.crm_demos;
  await testDbs()
    .admin.db.insert(playbooks)
    .values({
      workspaceId: ws,
      name: crm.name,
      details: { ...crm.details, avoid: ['free trial'] },
    });
  const [p] = await testDbs()
    .admin.db.insert(profiles)
    .values({
      workspaceId: ws,
      platform: 'facebook',
      username: 'dana.reyes.12',
      url: 'https://www.facebook.com/dana.reyes.12',
      name: 'Dana Reyes',
      intro: ['Owner at Reyes Plumbing'],
    })
    .returning({ id: profiles.id });
  profileId = p!.id;
  const [c] = await testDbs()
    .admin.db.insert(fileChats)
    .values({
      workspaceId: ws,
      userId: owner.id,
      platform: 'facebook',
      name: 'Dana Reyes',
      nameKey: 'danareyes',
      firstAt: new Date(),
      lastAt: new Date(),
      messages: 1,
      lastFromMe: false,
      recent: [{ fromMe: false, text: 'How much is it?', at: new Date().toISOString() }],
    })
    .returning({ id: fileChats.id });
  chatId = c!.id;
  const [po] = await testDbs()
    .admin.db.insert(posts)
    .values({
      workspaceId: ws,
      userId: owner.id,
      profileId,
      url: 'https://www.facebook.com/groups/323456789/posts/100001/',
      body: 'Can anyone recommend a CRM for a plumber?',
      found: 'scroll',
      checkState: 'good',
      seenAt: new Date(),
    })
    .returning({ id: posts.id });
  postId = po!.id;
  await testDbs()
    .admin.db.insert(workspaceMemberships)
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

describe('drafts for Today', () => {
  it('gives a few to pick from, each once, without the words to avoid', async () => {
    const res = await draft(owner, { kind: 'opener', profileId });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      drafts: [
        'Hi Dana, thanks for adding me! How’s business going?',
        'Hey Dana, good to connect. What keeps you busiest these days?',
      ],
    });
  });

  it('drafts two comments on a post, from what the look-up found too', async () => {
    const res = await draft(owner, {
      kind: 'comment',
      postId,
      lookup: ['Owner at Reyes Plumbing', 'Their business page: Reyes Plumbing'],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().drafts).toHaveLength(2);
    expect((await draft(owner, { kind: 'comment' })).statusCode).toBe(404);
    expect((await draft(member, { kind: 'comment', postId })).statusCode).toBe(404);
  });

  it('drafts from the person’s own chats only', async () => {
    expect((await draft(owner, { kind: 'reply', chatId })).statusCode).toBe(200);
    expect((await draft(member, { kind: 'reply', chatId })).statusCode).toBe(404);
  });
});
