/**
 * "What's on your site now" (POST /v1/telephony/site-forms), for texting approval's question on how customers will
 * agree (the owner's pick 9a, 2026-11-22): only for people who manage the business's channels; every form on the
 * business's website that asks for a phone number, each once with the page it's on; the business's own HandsFreeOS
 * form, framed on its contact page, known as its own; and a site that doesn't open comes back as no pages opened.
 */
import { randomUUID } from 'node:crypto';
import {
  createTokenVerifier,
  executeCommand,
  organizationCreate,
  registrationEnsureContactForm,
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
import { buildHttpServer } from '../src/http/server';
import { standInMedia, testServices } from './helpers';

const env = testEnv();
const admin = () => testDbs().admin.db;

const SITE = 'https://formsfound.test';
const NAV = `<nav><a href="/">Home</a> <a href="/contact">Contact</a> <a href="/quote">Get a quote</a></nav>`;
const page = (body: string) => ({
  bytes: Buffer.from(`<html><body>${NAV}${body}</body></html>`),
  contentType: 'text/html; charset=utf-8',
});

let owner: TestUser;
let member: TestUser;
let ownerToken: string;
let memberToken: string;
let ws: string;
let app: FastifyInstance;

const post = (token: string, website: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/telephony/site-forms',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: ws, website },
  });

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('site-forms-found-owner'),
    createTestUser('site-forms-found-member'),
  ]);
  const human = {
    type: 'human' as const,
    userId: owner.id,
    email: owner.email,
    claims: owner.claims,
  };
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Forms Found Roofing' },
    human,
    { correlationId: randomUUID(), channel: 'test' },
  );
  ws = output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  // The business's contact form, whose own page its website frames.
  const { output: form } = await executeCommand(
    testDbs().api.db,
    registrationEnsureContactForm,
    { workspaceId: ws },
    human,
    { correlationId: randomUUID(), channel: 'test' },
  );
  const ours = `http://localhost:3000/f/${form.siteSlug}/${form.slug}?embed=1`;
  const media = standInMedia({
    [SITE]: page('<h1>Forms Found Roofing</h1>'),
    [`${SITE}/`]: page('<h1>Forms Found Roofing</h1>'),
    [`${SITE}/contact`]: page(`<iframe src="${ours}" title="Get in touch"></iframe>`),
    [`${SITE}/quote`]: page(
      '<form><input type="text" name="name"><input type="tel" name="phone"><button>Send</button></form>',
    ),
    [ours]: {
      bytes: Buffer.from(
        '<form><input type="tel" name="phone"><label><input type="checkbox" name="sms"> Text me, Forms Found Roofing. Appointment reminders and quotes. Message frequency varies. Reply STOP to unsubscribe.</label></form>',
      ),
      contentType: 'text/html; charset=utf-8',
    },
  });
  [ownerToken, memberToken] = await Promise.all([signInTestUser(owner), signInTestUser(member)]);
  app = await buildHttpServer({
    ...testServices(),
    fetchUrl: media.fetchUrl,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('the forms on a business’s website, before it picks how customers agree', () => {
  it('is for people who manage the business’s channels', async () => {
    const res = await post(memberToken, 'formsfound.test');
    expect(res.statusCode).toBe(403);
  });

  it('lists each form with its page, and knows the business’s own form framed there', async () => {
    const res = await post(ownerToken, 'formsfound.test');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      opened: number;
      cut: boolean;
      blocked: number;
      forms: { page: string; framedUrl: string | null; asksPhone: boolean; ours: boolean }[];
    };
    expect(body).toMatchObject({ opened: 3, cut: false, blocked: 0 });
    expect(body.forms).toHaveLength(2);
    const mine = body.forms.find((f) => f.ours);
    expect(mine).toMatchObject({ page: `${SITE}/contact`, asksPhone: true });
    expect(mine?.framedUrl).toContain('/f/');
    expect(body.forms.find((f) => !f.ours)).toMatchObject({
      page: `${SITE}/quote`,
      framedUrl: null,
      asksPhone: true,
    });
  });

  it('answers with no pages opened for a site that isn’t there', async () => {
    const res = await post(ownerToken, 'nobody-home.test');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ opened: 0, forms: [] });
  });
});
