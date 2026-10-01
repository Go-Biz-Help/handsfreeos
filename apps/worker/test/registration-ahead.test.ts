/**
 * Texting registration ahead of the number, the worker's half.
 *
 * A local (10DLC) registration names the business and how it texts, and its campaign sits on the messaging
 * service, so it goes to the carriers with no number at all: the worker makes the business's Twilio account
 * and messaging service for it. A number that starts working later joins that service and texts at once.
 *
 * Toll-free verification is for one number, so it waits for its number — and goes the moment that number
 * starts working, rather than sitting until somebody sends it again.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  executeCommand,
  organizationCreate,
  phoneNumberActivate,
  phoneNumberBuy,
  phoneSetupStatus,
  registrationSubmit,
  telephonyEnable,
  executeQuery,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { phoneNumbers, telephonyAccounts, telephonyRegistrations } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { payTextingFee, testServices, type TestServices } from './helpers';

const WORKER_ID = `vitest-registration-ahead-${process.pid}`;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const business = {
  legalName: 'Ahead Worker LLC',
  businessType: 'llc',
  ein: '12-3456789',
  website: 'https://example.com',
  address: { line1: '4410 Westpark Dr', city: 'Houston', state: 'TX', postalCode: '77027' },
  contact: {
    firstName: 'Dale',
    lastName: 'Ramsey',
    email: 'dale@example.com',
    phone: '(713) 555-0161',
  },
  useCase: 'customer_care',
  messageSamples: [
    'Hi Mike, this is Ahead HVAC. Marco is on the way. Reply STOP to opt out.',
    'Hi Mike, your estimate for the new AC unit is ready. Reply with questions or STOP to opt out.',
  ],
  optInDescription:
    'Customers give us their cell number when they book a visit and agree to texts about it.',
  monthlyVolume: 'under_1000',
};

let owner: TestUser;
let s: TestServices;

async function reserve(workspaceId: string): Promise<void> {
  for (const table of ['outbox', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${workspaceId}`,
    );
}

/** Runs the outbox and jobs for one workspace until `until` holds, or nothing is left to run now. */
async function drain(
  workspaceId: string,
  opts: { until?: () => Promise<boolean>; timeoutMs?: number } = {},
) {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  for (;;) {
    await reserve(workspaceId);
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const events = await processOnce({ ...d, handlers });
    const ran = await processJobs({ ...d, jobs });
    if ([events, ran].some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select 'outbox' as source, event_type as what, last_error from app.outbox
              where workspace_id = ${workspaceId} and last_error is not null
            union all select 'job', kind, last_error from app.scheduled_jobs
              where workspace_id = ${workspaceId} and last_error is not null`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (opts.until ? await opts.until() : events.claimed === 0 && ran.claimed === ran.rescheduled)
      return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
    await sleep(50);
  }
}

const registrationsOf = (workspaceId: string) =>
  admin()
    .select()
    .from(telephonyRegistrations)
    .where(eq(telephonyRegistrations.workspaceId, workspaceId));

beforeAll(async () => {
  owner = await createTestUser('ahead-worker-owner');
  s = testServices();
});
afterAll(closeTestDbs);

describe('a texting registration sent before the number is here', () => {
  it('registers a local business with no number, and a number bought later texts at once', async () => {
    const { output: org } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Ahead Worker Co' },
      actor(owner),
      meta(),
    );
    const workspaceId = org.workspaceId;
    const before = s.telephony.registrations.length;
    await executeCommand(
      api(),
      registrationSubmit,
      { workspaceId, kind: 'a2p_10dlc', business },
      actor(owner),
      meta(),
    );
    // Its fees are paid first (0105); then it goes.
    await drain(workspaceId);
    await payTextingFee(s, { workspaceId, organizationId: org.organizationId });
    await drain(workspaceId, {
      until: async () => (await registrationsOf(workspaceId)).every((r) => r.status === 'approved'),
    });

    // The chain made the business's own Twilio account and messaging service, since no number had.
    const [account] = await admin()
      .select()
      .from(telephonyAccounts)
      .where(eq(telephonyAccounts.workspaceId, workspaceId));
    expect(account?.accountSid).toBeTruthy();
    expect(account?.messagingServiceSid).toMatch(/^MGfake/);
    const asked = s.telephony.registrations.slice(before);
    expect(asked.map((r) => r.kind)).toEqual([
      'a2p_customer_profile',
      'a2p_trust_product',
      'a2p_brand',
      'a2p_campaign',
    ]);
    expect(asked.every((r) => r.phoneNumberSid === null && r.phoneNumberE164 === null)).toBe(true);
    expect(asked[3]!.messagingServiceSid).toBe(account!.messagingServiceSid);
    expect(
      await admin().select().from(phoneNumbers).where(eq(phoneNumbers.workspaceId, workspaceId)),
    ).toHaveLength(0);

    // A local number arrives: it goes on the same messaging service, and texting is on with nothing to send.
    const local = `+1713${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}7`;
    const bought = await executeCommand(
      api(),
      phoneNumberBuy,
      { workspaceId, e164: local, numberType: 'local' },
      actor(owner),
      meta(),
    );
    await drain(workspaceId);
    const [n] = await admin()
      .select()
      .from(phoneNumbers)
      .where(eq(phoneNumbers.id, bought.output.phoneNumberId));
    expect(n?.status).toBe('active');
    expect(s.telephony.serviced).toContainEqual({
      serviceSid: account!.messagingServiceSid,
      numberSid: n!.providerSid,
    });
    // Nothing went to the carriers again.
    expect(s.telephony.registrations.length).toBe(before + 4);
    const status = await executeQuery(
      api(),
      phoneSetupStatus,
      { workspaceId },
      actor(owner),
      meta(),
    );
    expect(status).toMatchObject({ nextStep: 'ready', messagingReady: true });
  });

  it('sends toll-free verification the moment its number starts working', async () => {
    const { output: org } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Toll Free Waits Co' },
      actor(owner),
      meta(),
    );
    const workspaceId = org.workspaceId;
    await executeCommand(api(), telephonyEnable, { workspaceId }, actor(owner), meta());
    await drain(workspaceId);
    const [account] = await admin()
      .select()
      .from(telephonyAccounts)
      .where(eq(telephonyAccounts.workspaceId, workspaceId));
    expect(account?.status).toBe('active');

    // A number still being set up: the registration can be sent, but has nothing to go against yet.
    const e164 = `+1833${String(100 + Math.floor(Math.random() * 899))}${1001 + Math.floor(Math.random() * 8998)}`;
    const [n] = await admin()
      .insert(phoneNumbers)
      .values({ workspaceId, e164, numberType: 'toll_free', status: 'provisioning' })
      .returning();
    const before = s.telephony.registrations.length;
    await executeCommand(
      api(),
      registrationSubmit,
      { workspaceId, kind: 'toll_free_verification', business },
      actor(owner),
      meta(),
    );
    await drain(workspaceId);
    expect(s.telephony.registrations.length).toBe(before);
    expect((await registrationsOf(workspaceId))[0]?.status).toBe('submitted');

    // The carrier finishes the purchase: the verification goes now, against that number.
    await executeCommand(
      testDbs().worker.db,
      phoneNumberActivate,
      {
        workspaceId,
        phoneNumberId: n!.id,
        providerSid: `PNahead${Date.now()}`,
        accountId: account!.id,
      },
      { type: 'system', workspaceId, organizationId: org.organizationId },
      meta(),
    );
    await drain(workspaceId, {
      until: async () => (await registrationsOf(workspaceId))[0]?.status !== 'submitted',
    });
    const asked = s.telephony.registrations.slice(before);
    expect(asked.map((r) => r.kind)).toEqual(['toll_free_verification']);
    expect(asked[0]!.phoneNumberE164).toBe(e164);
  });
});
