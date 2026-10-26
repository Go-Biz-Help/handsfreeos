import { randomUUID } from 'node:crypto';
import {
  createTokenVerifier,
  executeCommand,
  MOBILE_DATA_CLAUSE,
  organizationCreate,
} from '@hfos/core/server';
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
import { scriptedAi } from '../src/ai/scripted';
import { buildHttpServer } from '../src/http/server';
import { standInMedia, testServices } from './helpers';

/**
 * "Add it to my policy for me" (POST /v1/telephony/policy-update): only for people who manage the business's
 * channels; the business's page read, or its pasted words, and given back whole with the texting section in place;
 * the tokens counted as texting_policy use; and a page that can't be read or isn't a policy refused in words that
 * say to paste it instead.
 */

const env = testEnv();
const admin = () => testDbs().admin.db;

const POLICY = `<html><body><nav>Home | Book now</nav><main>
<h1>Privacy Policy</h1>
<p>Last updated: January 4, 2024</p>
<p>Lone Star HVAC LLC respects your privacy. This policy explains what we collect when you use our website or book a
repair with us, and how we use and protect it.</p>
<h2>Information we collect</h2>
<p>We collect your name, phone number, email address and service address when you book with us.</p>
<h2>How we share it</h2>
<p>We may share your information with our partners for marketing purposes.</p>
<h2>Contact us</h2>
<p>Lone Star HVAC LLC, 100 Main St, Austin, TX 78701</p>
</main></body></html>`;

const HOME = `<html><body><main><h1>Lone Star HVAC</h1><p>${'Fast, friendly heating and cooling repairs across Austin. '.repeat(10)}</p></main></body></html>`;

const media = standInMedia({
  'https://lonestar.test/privacy': { bytes: Buffer.from(POLICY), contentType: 'text/html' },
  'https://lonestar.test/': { bytes: Buffer.from(HOME), contentType: 'text/html' },
  'https://lonestar.test/blank': {
    bytes: Buffer.from('<html><body><div id="app"></div></body></html>'),
    contentType: 'text/html',
  },
});

const business = {
  name: 'Lone Star HVAC',
  legalName: 'Lone Star HVAC LLC',
  phone: '(512) 555-0123',
};

let owner: TestUser;
let member: TestUser;
let ownerToken: string;
let memberToken: string;
let ws: string;
let app: FastifyInstance;

const post = (token: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/telephony/policy-update',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: ws, business, ...payload },
  });

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('policy-update-owner'),
    createTestUser('policy-update-member'),
  ]);
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Lone Star HVAC' },
    { type: 'human', userId: owner.id, email: owner.email, claims: owner.claims },
    { correlationId: randomUUID(), channel: 'test' },
  );
  ws = output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  [ownerToken, memberToken] = await Promise.all([signInTestUser(owner), signInTestUser(member)]);
  const s = testServices({ ai: { provider: scriptedAi() } });
  app = await buildHttpServer({
    ...s,
    fetchUrl: media.fetchUrl,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('adding the texting section to a business’s own policy', () => {
  it('is for people who manage the business’s channels', async () => {
    const res = await post(memberToken, { kind: 'privacy', url: 'https://lonestar.test/privacy' });
    expect(res.statusCode).toBe(403);
  });

  it('gives the policy back whole, with the section in place, and counts the tokens', async () => {
    const res = await post(ownerToken, { kind: 'privacy', url: 'lonestar.test/privacy' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      url: string;
      blocks: { text: string; mark: string | null }[];
      changes: { before: string }[];
    };
    expect(body.url).toBe('https://lonestar.test/privacy');
    const texts = body.blocks.map((b) => b.text);
    expect(texts[0]).toBe('Privacy Policy');
    expect(texts).not.toContain('Home | Book now');
    expect(texts).toContain(MOBILE_DATA_CLAUSE);
    expect(texts.indexOf(MOBILE_DATA_CLAUSE)).toBeLessThan(texts.indexOf('Contact us'));
    expect(body.changes.map((c) => c.before)).toEqual([
      'Last updated: January 4, 2024',
      'We may share your information with our partners for marketing purposes.',
    ]);
    const [used] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.ai_usage where workspace_id = ${ws}
            and source = 'texting_policy' and user_id = ${owner.id}`,
    );
    expect(used?.n).toBe(1);
  });

  it('works on pasted words, and links the terms to the privacy policy', async () => {
    const pasted = [
      'Terms of Service',
      'These terms cover your use of our website and the repairs we book through it. By booking with us you agree to them, so please read them carefully before you book.',
      'Payment',
      'Payment is due when the work is finished. We take cards and checks, and we will tell you the price before we start any work on your system.',
    ].join('\n\n');
    const res = await post(ownerToken, {
      kind: 'terms',
      text: pasted,
      business: { ...business, privacyUrl: 'https://lonestar.test/privacy' },
    });
    expect(res.statusCode).toBe(200);
    const texts = (res.json() as { blocks: { text: string }[] }).blocks.map((b) => b.text);
    expect(texts[0]).toBe('Terms of Service');
    expect(texts.join(' ')).toContain('privacy policy at https://lonestar.test/privacy');
    expect(texts.join(' ')).toMatch(/Reply STOP/);
  });

  it('says to paste it when the page can’t be read, isn’t there, or isn’t a policy', async () => {
    const blank = await post(ownerToken, { kind: 'privacy', url: 'https://lonestar.test/blank' });
    expect(blank.statusCode).toBe(422);
    expect(blank.json().error).toMatchObject({ rule: 'policy_unreadable' });
    expect(blank.json().error.message).toMatch(/paste it here/);

    const missing = await post(ownerToken, { kind: 'privacy', url: 'https://lonestar.test/gone' });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error).toMatchObject({ rule: 'policy_unreachable' });

    const home = await post(ownerToken, { kind: 'privacy', url: 'https://lonestar.test/' });
    expect(home.statusCode).toBe(422);
    expect(home.json().error).toMatchObject({ rule: 'policy_not_a_policy' });

    const nothing = await post(ownerToken, { kind: 'privacy' });
    expect(nothing.json().error).toMatchObject({ rule: 'policy_missing' });
  });
});
