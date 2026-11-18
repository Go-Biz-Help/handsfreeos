/**
 * Texting registrations looked at again every few hours (telephony/registration-check.ts).
 *
 * Twilio sends no webhook for a brand or a campaign, so the 15-minute poll is how HandsFreeOS hears. That poll
 * stops for good after five failed tries in a row, and nothing asked about an approved step again. The check
 * starts a stopped poll again, so an approval still reaches the business, and notices an approval the carriers
 * took back, which emails owners and admins.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  executeCommand,
  organizationCreate,
  registrationSubmit,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { events, telephonyRegistrations } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { processJobs, type JobRow } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { checkRegistrations } from '../src/telephony/registration-check';
import { allGreen, payTextingFee, testServices, type TestServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-registration-check-${process.pid}`;
const BUSINESS_NAME = 'Recheck Solar Co';
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
  legalName: 'Recheck Solar LLC',
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
    'Hi Mike, this is Recheck Solar. Your panel check is tomorrow at 9. Reply STOP to opt out.',
    'Hi Mike, your solar estimate is ready. Reply with questions or STOP to opt out.',
  ],
  optInDescription:
    'Customers give us their cell number when they ask for an estimate and agree to texts about it.',
  monthlyVolume: 'under_1000',
};

let owner: TestUser;
let s: TestServices;
let workspaceId: string;
let organizationId: string;

async function reserve(): Promise<void> {
  for (const table of ['outbox', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${workspaceId}`,
    );
}

/** Runs the outbox and jobs for this workspace until `until` holds, or nothing is left to run now. */
async function drain(opts: { until?: () => Promise<boolean>; timeoutMs?: number } = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  for (;;) {
    await reserve();
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const sent = await processOnce({ ...d, handlers });
    const ran = await processJobs({ ...d, jobs });
    if ([sent, ran].some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select 'outbox' as source, event_type as what, last_error from app.outbox
              where workspace_id = ${workspaceId} and last_error is not null
            union all select 'job', kind, last_error from app.scheduled_jobs
              where workspace_id = ${workspaceId} and last_error is not null`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (opts.until ? await opts.until() : sent.claimed === 0 && ran.claimed === ran.rescheduled)
      return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
    await sleep(50);
  }
}

const registration = async (kind: string) =>
  (
    await admin()
      .select()
      .from(telephonyRegistrations)
      .where(
        and(
          eq(telephonyRegistrations.workspaceId, workspaceId),
          eq(telephonyRegistrations.kind, kind as 'a2p_campaign'),
        ),
      )
  )[0]!;

/** This business's check, run now, as the sweep would have it run. */
const check = () =>
  checkRegistrations({
    ...s,
    job: { payload: {} } as unknown as JobRow,
    scope: { workspaceId, organizationId },
    attempt: 1,
    now: Date.now(),
  });

const listed = async () =>
  (
    await rows<{ workspace_id: string }>(
      admin(),
      sql`select workspace_id from private.registrations_to_check() where workspace_id = ${workspaceId}`,
    )
  ).length > 0;

interface MailpitMessage {
  Subject: string;
}
async function waitForMail(to: string, subject: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`);
    const found = ((await res.json()) as { messages: MailpitMessage[] }).messages;
    if (found.some((m) => m.Subject === subject)) return;
    await sleep(250);
  }
  throw new Error(`no "${subject}" email reached ${to}`);
}

beforeAll(async () => {
  owner = await createTestUser('registration-check-owner');
  s = testServices();
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: BUSINESS_NAME },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
});
afterAll(async () => {
  s.telephony.holding.clear();
  s.telephony.suspended.clear();
  await closeTestDbs();
});

describe('texting registrations looked at again', () => {
  it('starts a check that stopped, so the campaign’s approval still reaches the business', async () => {
    // The carriers sit on the campaign while everything before it is approved.
    s.telephony.holding.add('a2p_campaign');
    await executeCommand(
      api(),
      registrationSubmit,
      await allGreen({ workspaceId, kind: 'a2p_10dlc', business }),
      actor(owner),
      meta(),
    );
    await drain();
    await payTextingFee(s, { workspaceId, organizationId });
    await drain({
      until: async () => {
        const c = await registration('a2p_campaign');
        return c.status === 'in_review' && !!c.providerSid;
      },
    });
    expect((await registration('a2p_brand')).status).toBe('approved');
    expect(await listed()).toBe(true);

    // Five failed tries in a row: the poll is failed for good, and nothing else would ask again.
    await rows(
      admin(),
      sql`update app.scheduled_jobs set status = 'failed', attempts = 5, finished_at = now(),
            last_error = 'Twilio did not answer'
          where workspace_id = ${workspaceId} and kind = 'registration.poll' and status = 'pending'`,
    );
    s.telephony.holding.delete('a2p_campaign');
    await drain();
    expect((await registration('a2p_campaign')).status).toBe('in_review');

    // The check starts it again, and the approval lands.
    await check();
    await drain({ until: async () => (await registration('a2p_campaign')).status === 'approved' });
    await drain();
    // No number yet, so the email says texting is approved and the number can text once it’s here.
    await waitForMail(owner.email, `Texting is approved for ${BUSINESS_NAME}`);
  });

  it('notices an approved campaign the carriers took back, and tells owners texting stopped', async () => {
    const campaign = await registration('a2p_campaign');
    expect(campaign.status).toBe('approved');
    // Asking again about what's approved changes nothing while the carriers still say yes.
    await check();
    expect((await registration('a2p_campaign')).status).toBe('approved');

    s.telephony.suspended.add(campaign.providerSid!);
    await check();
    expect(await registration('a2p_campaign')).toMatchObject({
      status: 'rejected',
      providerStatus: 'SUSPENDED',
      rejectionReason: 'The carriers suspended this registration.',
    });
    const changes = await admin()
      .select()
      .from(events)
      .where(
        and(eq(events.entityId, campaign.id), eq(events.eventType, 'registration.status_changed')),
      )
      .orderBy(asc(events.createdAt));
    expect(changes.at(-1)?.payload).toMatchObject({
      kind: 'a2p_campaign',
      from: 'approved',
      to: 'rejected',
    });
    await drain();
    await waitForMail(owner.email, `Texting stopped for ${BUSINESS_NAME}`);
    // Turned down, it's the business's to fix and send again: nothing to look at until they do.
    s.telephony.suspended.delete(campaign.providerSid!);
  });
});
