/**
 * Facebook lead ads (funnels), through the worker's own routes, processor and jobs, on the real database, against
 * the stand-in Meta.
 *
 * What's worth holding:
 *   - a lead Meta's webhook names is read with the Page's token and becomes a customer and a lead, once however
 *     often Meta says it, with its other answers in the form's own words;
 *   - a ticked box about texts is the customer's OK to text, named after the form; an unticked one changes nothing;
 *   - where they came from is a touch of its own, with the form and the ad;
 *   - the hourly look finds a lead the webhook missed, and files one the webhook already filed only once;
 *   - a Page whose Leads Access keeps HandsFreeOS out is marked so, and its leads come once it's let in.
 */
import { randomInt, randomUUID } from 'node:crypto';
import {
  attributionList,
  executeCommand,
  executeQuery,
  metaAccountList,
  metaConnectionConnect,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { handlers } from '../src/handlers/index';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { finishSignIn, testTokenVerifier } from './finish-sign-in';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let workspaceId: string;
let s: TestServices;
let app: FastifyInstance;

const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = <T>(cmd: unknown, input: unknown): Promise<T> =>
  executeCommand(api(), cmd as never, input, actor(owner), meta()).then((r) => r.output as T);
const ask = <T>(q: unknown, input: unknown): Promise<T> =>
  executeQuery(api(), q as never, input, actor(owner), meta()) as Promise<T>;
const get = (url: string) => app.inject({ method: 'GET', url });

const digits = (n: number) =>
  String(randomInt(1, 10)) + Array.from({ length: n - 1 }, () => randomInt(0, 10)).join('');
const fbUser = digits(15);
const page = digits(15);
const runner = `vitest-meta-leads-${process.pid}`;

/** Everything this business has waiting (Meta's stored webhooks, events and its Meta jobs), until it's quiet. */
async function drain(limit = 20): Promise<void> {
  for (let i = 0; i < limit; i++) {
    await admin().execute(
      sql`update app.webhook_deliveries set locked_at = now(), locked_by = ${runner}, next_attempt_at = now()
          where workspace_id = ${workspaceId}::uuid and status = 'pending'`,
    );
    const delivered = await processDeliveries({
      ...s,
      processors,
      workerId: runner,
      batchSize: 50,
      reservedOnly: true,
    });
    await admin().execute(
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}, next_attempt_at = now()
          where status = 'pending' and event_id in (select id from app.events
            where workspace_id = ${workspaceId}::uuid)`,
    );
    const events = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 50,
      reservedOnly: true,
    });
    if (delivered.claimed === 0 && events.claimed === 0) return;
  }
}

/** The hourly look for missed leads, for this business, now. */
async function lookForMissed(): Promise<void> {
  await admin().execute(
    sql`insert into app.scheduled_jobs (kind, dedupe_key, run_at, payload, workspace_id, organization_id,
          locked_at, locked_by)
        select 'meta.leads', ${`meta.leads:${randomUUID()}`}, now(), '{}'::jsonb, w.id, w.organization_id,
          now(), ${runner}
        from app.workspaces w where w.id = ${workspaceId}::uuid`,
  );
  await processJobs({ ...s, jobs, workerId: runner, batchSize: 50, reservedOnly: true });
  await drain();
}

/** A lead somebody sent, and the webhook Meta sends for it (only its id). */
async function sendLead(input: {
  name: string;
  phone?: string;
  email?: string;
  texts?: boolean;
  answers?: Record<string, string>;
}): Promise<{ leadgenId: string; formId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/test/meta/lead',
    payload: { page, ...input },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { leadgenId: string; formId: string };
}

const personBy = (phone: string) =>
  rows<{
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    source: string | null;
    sms_consent: string;
    sms_consent_source: string | null;
  }>(
    admin(),
    sql`select id, first_name, last_name, email, source, sms_consent::text, sms_consent_source
        from app.people where workspace_id = ${workspaceId}::uuid and phone_e164 = ${phone}`,
  );
const leadsOf = (personId: string) =>
  rows<{ id: string; title: string; source: string | null }>(
    admin(),
    sql`select id, title, source from app.leads where person_id = ${personId}::uuid`,
  );
const pageAccount = async () =>
  (
    await rows<{ id: string; leads_access: string; last_lead_at: string | null }>(
      admin(),
      sql`select id, leads_access, last_lead_at from app.meta_accounts
          where workspace_id = ${workspaceId}::uuid and external_id = ${page}`,
    )
  )[0]!;

beforeAll(async () => {
  owner = await createTestUser('meta-leads-dana', { fullName: 'Dana Owner' });
  const org = await run<{ workspaceId: string }>(organizationCreate, {
    businessName: 'Bright Team',
    timezone: 'America/Chicago',
  });
  workspaceId = org.workspaceId;
  s = testServices();
  s.social.fake.addUser({
    id: fbUser,
    name: 'Dana Owner',
    pages: [{ id: page, name: 'Bright Team' }],
  });
  s.social.fake.addLeadForm(page, {
    name: 'Meet the team',
    questions: [
      { key: 'full_name', label: 'Full name' },
      { key: 'phone_number', label: 'Phone number' },
      { key: 'what_brings_you_here?', label: 'What brings you here?' },
    ],
  });
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: testTokenVerifier(),
    webOrigins: ['http://localhost:3000'],
  });
  // One Page, allowed to read leads: it connects straight away.
  const { state } = await run<{ state: string }>(metaConnectionConnect, { workspaceId });
  const start = await get(`/oauth/facebook/start?state=${encodeURIComponent(state)}`);
  const authorize = new URL(String(start.headers.location));
  const approve = await get(
    `/oauth/fake/meta/approve?${new URLSearchParams({
      state,
      redirect_uri: authorize.searchParams.get('redirect_uri')!,
      user: fbUser,
      decision: 'allow',
      messaging: '1',
      ads: '1',
      leads: '1',
    })}`,
  );
  const callback = new URL(String(approve.headers.location));
  const done = await finishSignIn(
    app,
    await get(`${callback.pathname}${callback.search}`),
    await signInTestUser(owner),
  );
  expect(done.status).toBe(302);
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('a lead from a lead ad', () => {
  it('becomes a customer and a lead, once, with their OK to text and the form they sent', async () => {
    const sent = await sendLead({
      name: 'Morgan Lee',
      phone: '+15125550701',
      texts: true,
      answers: { 'what_brings_you_here?': 'Extra income' },
    });
    await drain();
    const [person] = await personBy('+15125550701');
    expect(person).toMatchObject({
      first_name: 'Morgan',
      last_name: 'Lee',
      source: 'Facebook lead ad',
      sms_consent: 'opted_in',
      sms_consent_source: 'Facebook lead form: Meet the team',
    });
    const leads = await leadsOf(person!.id);
    expect(leads).toHaveLength(1);
    expect(leads[0]!.source).toBe('Facebook lead ad');
    const notes = await rows<{ body: string }>(
      admin(),
      sql`select body from app.activities where person_id = ${person!.id}::uuid and subtype = 'intake'`,
    );
    expect(notes[0]!.body).toContain('What brings you here?: Extra income');
    expect(notes[0]!.body).toContain('Lead form: Meet the team');

    const touches = await ask<{
      touches: { kind: string; formName: string | null; adId: string | null }[];
    }>(attributionList, { workspaceId, personId: person!.id });
    expect(touches.touches).toEqual([
      expect.objectContaining({
        kind: 'lead_form',
        formName: 'Meet the team',
        adId: '120200000000001',
      }),
    ]);
    expect((await pageAccount()).leads_access).toBe('ok');

    // Meta says it again, and the hourly look reads it too: still one customer, one lead, one touch.
    const raw = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: page,
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: 'leadgen',
              value: { leadgen_id: sent.leadgenId, page_id: page, form_id: sent.formId },
            },
          ],
        },
      ],
    });
    const again = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': s.social.fake.sign(raw),
      },
      payload: raw,
    });
    expect(again.statusCode).toBe(200);
    await drain();
    await lookForMissed();
    expect(await personBy('+15125550701')).toHaveLength(1);
    expect(await leadsOf(person!.id)).toHaveLength(1);
    const touched = await ask<{ total: number }>(attributionList, {
      workspaceId,
      personId: person!.id,
    });
    expect(touched.total).toBe(1);
  });

  it('leaves their OK to text alone when the box about texts wasn’t ticked', async () => {
    await sendLead({ name: 'Riley Park', phone: '+15125550702', texts: false });
    await drain();
    const [person] = await personBy('+15125550702');
    expect(person!.sms_consent).not.toBe('opted_in');
  });

  it('finds a lead the webhook missed on the hourly look', async () => {
    // Sent on Facebook, and Meta's webhook never came.
    s.social.fake.addLead({
      pageId: page,
      answers: [
        { name: 'full_name', values: ['Sam Ortiz'] },
        { name: 'phone_number', values: ['+15125550703'] },
      ],
    });
    expect(await personBy('+15125550703')).toEqual([]);
    await lookForMissed();
    const [person] = await personBy('+15125550703');
    expect(person).toMatchObject({ first_name: 'Sam', source: 'Facebook lead ad' });
  });

  it('marks a Page whose Leads Access keeps us out, and brings its leads once it lets us in', async () => {
    s.social.fake.blockLeads(page, true);
    await sendLead({ name: 'Jo Kim', phone: '+15125550704' });
    await drain();
    expect(await personBy('+15125550704')).toEqual([]);
    expect((await pageAccount()).leads_access).toBe('blocked');
    const listed = await ask<{
      accounts: { externalId: string; leadsAccess: string; leadForms: { name: string }[] }[];
      connections: { readsLeads: boolean }[];
    }>(metaAccountList, { workspaceId });
    expect(listed.accounts.find((a) => a.externalId === page)).toMatchObject({
      leadsAccess: 'blocked',
      leadForms: [{ name: 'Meet the team' }],
    });
    expect(listed.connections[0]!.readsLeads).toBe(true);

    s.social.fake.blockLeads(page, false);
    await lookForMissed();
    expect(await personBy('+15125550704')).toHaveLength(1);
    expect((await pageAccount()).leads_access).toBe('ok');
  });
});
