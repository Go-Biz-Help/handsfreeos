/**
 * The review step's checks, written down (POST /v1/telephony/registration-preflight with the registration as Send
 * would send it): the worker opens the pages that registration names, works out what isn't green, and records it
 * against its fingerprint, so `registration.submit` lets through only details found all green (the owner's rule,
 * 2026-11-05). And when HandsFreeOS approves one it checked by hand, the worker sends it.
 */
import { randomUUID } from 'node:crypto';
import {
  createTokenVerifier,
  executeCommand,
  optInDescriptionFor,
  organizationCreate,
  policyAsText,
  privacyPolicy,
  registrationRequestReview,
  registrationReviewApprove,
  registrationSubmit,
  smsConsentWords,
  termsOfService,
  type HumanActor,
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
import { onRegistrationReviewDecided } from '../src/handlers/support';
import type { HandlerContext } from '../src/handlers/types';
import { buildHttpServer } from '../src/http/server';
import { standInMedia, testServices, type TestServices } from './helpers';

const env = testEnv();
const admin = () => testDbs().admin.db;
const SITE = 'https://greencheck.test';
const NAME = 'Green Check HVAC';
const LEGAL = 'Green Check HVAC LLC';

const policyFor = {
  name: NAME,
  legalName: LEGAL,
  website: `${SITE}/`,
  email: 'hi@greencheck.test',
};
const box = smsConsentWords(NAME, 'form', `${SITE}/privacy`, `${SITE}/terms`);
const CONTACT = `<html><body><main><h1>Contact ${NAME}</h1>
<form action="/send" method="post">
<label>Name <input name="name"></label>
<label>Mobile <input name="phone" type="tel"></label>
<label><input type="checkbox" name="texts"> ${box.title}. ${box.detail}</label>
<p><a href="${SITE}/privacy">Privacy policy</a> · <a href="${SITE}/terms">Terms</a></p>
<button type="submit">Send</button>
</form></main></body></html>`;
const HOME = `<html><body><main><h1>${LEGAL}</h1><p>${`${NAME} fixes heating and cooling across Houston, fast and friendly. `.repeat(8)}</p>
<a href="${SITE}/privacy">Privacy policy</a> <a href="${SITE}/terms">Terms</a></main></body></html>`;

const media = standInMedia({
  [`${SITE}/`]: { bytes: Buffer.from(HOME), contentType: 'text/html' },
  [SITE]: { bytes: Buffer.from(HOME), contentType: 'text/html' },
  [`${SITE}/privacy`]: {
    bytes: Buffer.from(
      `<html><body><pre>${policyAsText(privacyPolicy(policyFor))}</pre></body></html>`,
    ),
    contentType: 'text/html',
  },
  [`${SITE}/terms`]: {
    bytes: Buffer.from(
      `<html><body><pre>${policyAsText(termsOfService(policyFor))}</pre></body></html>`,
    ),
    contentType: 'text/html',
  },
  [`${SITE}/contact`]: { bytes: Buffer.from(CONTACT), contentType: 'text/html' },
});

const business = {
  legalName: LEGAL,
  businessType: 'llc',
  ein: '12-3456789',
  website: `${SITE}/`,
  address: { line1: '4410 Westpark Dr', city: 'Houston', state: 'TX', postalCode: '77027' },
  contact: {
    firstName: 'Dale',
    lastName: 'Ramsey',
    email: 'dale@greencheck.test',
    phone: '(713) 555-0161',
  },
  useCase: 'customer_care',
  messageSamples: [
    `Hi Mike, this is ${NAME}. Marco is on the way and should be there by 10. Reply STOP to opt out.`,
    `Hi Mike, ${NAME} here: your estimate for the new AC unit is ready. Reply with questions or STOP to opt out.`,
  ],
  optInDescription: optInDescriptionFor(
    NAME,
    'own_site',
    {},
    { pageUrl: `${SITE}/contact`, policyUrl: `${SITE}/privacy`, termsUrl: `${SITE}/terms` },
  ),
  optInPath: 'own_site',
  optInUrl: `${SITE}/contact`,
  policyUrl: `${SITE}/privacy`,
  termsUrl: `${SITE}/terms`,
  privacyPageUrl: `${SITE}/privacy`,
  termsPageUrl: `${SITE}/terms`,
  displayName: NAME,
  sensitiveTopics: [],
  monthlyVolume: 'under_1000',
};

let owner: TestUser;
let staff: TestUser;
let token: string;
let ws: string;
let org: string;
let s: TestServices;
let app: FastifyInstance;

const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

const preflight = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/telephony/registration-preflight',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      workspaceId: ws,
      website: business.website,
      policyUrl: business.privacyPageUrl,
      termsUrl: business.termsPageUrl,
      optInPath: 'own_site',
      optInUrl: business.optInUrl,
      names: [NAME, LEGAL],
      legalName: LEGAL,
      ...payload,
    },
  });

const send = (details: object) =>
  executeCommand(
    testDbs().api.db,
    registrationSubmit,
    {
      workspaceId: ws,
      kind: 'a2p_10dlc',
      business: { ...details, confirmed: ['own_form_sends', 'only_these_ways'] },
    },
    human(owner),
    meta(),
  );

beforeAll(async () => {
  [owner, staff] = await Promise.all([
    createTestUser('reg-checks-owner'),
    createTestUser('reg-checks-staff'),
  ]);
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'agent')
        on conflict (user_id) do update set role = 'agent', status = 'active'`,
  );
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: NAME },
    human(owner),
    meta(),
  );
  ws = output.workspaceId;
  org = output.organizationId;
  token = await signInTestUser(owner);
  s = testServices();
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

describe('the review step’s checks, written down', () => {
  it('without the registration, only looks: nothing is written down', async () => {
    const res = await preflight({});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().notGreen).toBeNull();
    const [row] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.registration_checks where workspace_id = ${ws}`,
    );
    expect(row?.n).toBe(0);
  });

  it('all green: written down, and exactly those details can be sent', async () => {
    const res = await preflight({ submission: { kind: 'a2p_10dlc', business } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().notGreen).toEqual([]);
    const [row] = await rows<{ all_green: boolean }>(
      admin(),
      sql`select all_green from app.registration_checks where workspace_id = ${ws}`,
    );
    expect(row?.all_green).toBe(true);
    // Anything else wasn't checked.
    await expect(send({ ...business, monthlyVolume: '1000_10000' })).rejects.toMatchObject({
      rule: 'registration_not_checked',
    });
  });

  it('not green: says what, and the send is refused with it', async () => {
    // A box with no "Message frequency varies" beside it (shopyoursolar.com, 23 Oct: 30924).
    const quiet = {
      ...business,
      otherWays: [{ path: 'in_person', url: `${SITE}/missing-proof` }],
    };
    const res = await preflight({ submission: { kind: 'a2p_10dlc', business: quiet } });
    expect(res.statusCode, res.body).toBe(200);
    const left = res.json().notGreen as string[];
    expect(left.length).toBeGreaterThan(0);
    expect(left.join(' ')).toContain('Customers also agree');
    await expect(send(quiet)).rejects.toMatchObject({ rule: 'registration_not_green' });
  });

  it('approved by HandsFreeOS: the worker sends it as it was left', async () => {
    const asked = await executeCommand(
      testDbs().api.db,
      registrationRequestReview,
      { workspaceId: ws, kind: 'a2p_10dlc', business, notGreen: ['A row'] },
      human(owner),
      meta(),
    );
    await executeCommand(
      testDbs().api.db,
      registrationReviewApprove,
      { reviewId: asked.output.reviewId },
      human(staff),
      meta(),
    );
    const [event] = await rows<{ id: string; correlation_id: string; payload: unknown }>(
      admin(),
      sql`select id, correlation_id, payload from app.events
          where entity_id = ${asked.output.reviewId} and event_type = 'platform.registration_review_decided'`,
    );
    await onRegistrationReviewDecided({
      ...s,
      db: testDbs().worker.db,
      event: {
        ...event,
        eventType: 'platform.registration_review_decided',
        correlationId: event!.correlation_id,
        payload: event!.payload,
      },
    } as unknown as HandlerContext);
    const [review] = await rows<{ sent_at: Date | null; n: number }>(
      admin(),
      sql`select r.sent_at, cardinality(r.registration_ids) as n from app.registration_reviews r
          where r.id = ${asked.output.reviewId}`,
    );
    expect(review?.sent_at).not.toBeNull();
    expect(review?.n).toBeGreaterThan(0);
    const [reg] = await rows<{ org: string }>(
      admin(),
      sql`select w.organization_id as org from app.telephony_registrations g
          join app.workspaces w on w.id = g.workspace_id where g.workspace_id = ${ws} limit 1`,
    );
    expect(reg?.org).toBe(org);
  });
});
