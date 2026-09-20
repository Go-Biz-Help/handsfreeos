/**
 * M17: a business brings a number it already owns, all the way through.
 *
 * **Needs the stack up** (`pnpm supabase:start && pnpm db:reset`), because the parts worth doubting here are
 * the database's: the guard that makes the carrier's fields the worker's alone, the partial index that stops
 * two businesses claiming one number, and RLS keeping the losing carrier's PIN away from a member. The pure
 * parts — the fake carrier's three magic suffixes, the claimed/sendable split — are covered without a
 * database in `ports-fake.test.ts` and `packages/core/test/number-statuses.test.ts`.
 *
 * The suffixes those tests document are used here to drive the three endings a business can actually get:
 *
 *   …0000  the old carrier says no
 *   …0001  the old carrier sits on it
 *   any other  it lands
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  executeCommand,
  numberPortAttach,
  numberPortCancel,
  numberPortSave,
  numberPortStart,
  numberPortSubmit,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { files, numberPorts, phoneNumbers } from '@hfos/db/schema';
import {
  as,
  closeTestDbs,
  createTestUser,
  expectPgError,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processJobs } from '../src/jobs';
import { handlers } from '../src/handlers/index';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

testEnv();
const WORKER_ID = `vitest-ports-${process.pid}`;
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

/** A number nobody else in the test database holds. The last four decide what the fake carrier does with it. */
const aNumber = (ending: string) =>
  `+1713${String(100 + Math.floor(Math.random() * 899))}${ending}`;

let owner: TestUser;
let member: TestUser;
let workspaceId: string;
let s: TestServices;

async function reserve(): Promise<void> {
  for (const table of ['outbox', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${workspaceId}`,
    );
}

/** Runs the outbox and job loops over this workspace's work until nothing is left. */
async function drain(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await reserve();
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const passes = [await processOnce({ ...d, handlers }), await processJobs({ ...d, jobs })];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select 'outbox' as source, event_type as what, last_error from app.outbox
              where workspace_id = ${workspaceId} and last_error is not null
            union all select 'job', kind, last_error from app.scheduled_jobs
              where workspace_id = ${workspaceId} and last_error is not null`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
    await sleep(50);
  }
}

const portRow = async (id: string) =>
  (await admin().select().from(numberPorts).where(eq(numberPorts.id, id)))[0]!;
const numberFor = async (e164: string) =>
  (
    await admin()
      .select()
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.e164, e164)))
  )[0];

/**
 * A port with its details and its signed authorisation in, ready to send.
 *
 * The file row is made the way `number_port.begin_upload` makes it and then marked ready directly, because
 * the object itself only matters to Storage: `file.confirm` would ask Storage whether the bytes arrived, and
 * this test is about the carrier loop rather than the upload.
 */
async function readyPort(e164: string, kind: 'full' | 'hosted_messaging' = 'full') {
  const { output } = await executeCommand(
    api(),
    numberPortStart,
    { workspaceId, e164, kind },
    actor(owner),
    meta(),
  );
  await executeCommand(
    api(),
    numberPortSave,
    {
      workspaceId,
      portId: output.portId,
      submission: {
        accountNumber: '8675309',
        pin: '1234',
        authorizedBy: 'Dale Cooper',
        serviceAddress: '1 Main St, Twin Peaks, WA 98170',
      },
    },
    actor(owner),
    meta(),
  );
  const fileId = randomUUID();
  await admin()
    .insert(files)
    .values({
      id: fileId,
      workspaceId,
      recordType: 'port',
      recordId: output.portId,
      bucket: 'attachments',
      objectPath: `${workspaceId}/port/${output.portId}/${fileId}/loa.pdf`,
      name: 'loa.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      status: 'ready',
      createdBy: owner.id,
    });
  await executeCommand(
    api(),
    numberPortAttach,
    { workspaceId, portId: output.portId, document: 'loa', fileId },
    actor(owner),
    meta(),
  );
  return output.portId;
}

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('ports-owner'),
    createTestUser('ports-member'),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Ports Test HVAC' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${workspaceId}, ${member.id}, 'member')`,
  );
  s = await testServices({});
}, 60_000);

afterAll(async () => {
  await closeTestDbs();
});

describe('a number that moves', () => {
  it('is claimed the moment it is sent, and cannot send until it lands', async () => {
    const e164 = aNumber('0123');
    const portId = await readyPort(e164);
    // Before sending: a draft holds nothing. Somebody who changes their mind has taken no number off anyone.
    expect(await numberFor(e164)).toBeUndefined();

    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    const claimed = await numberFor(e164);
    expect(claimed?.status).toBe('porting');
    // `porting` is deliberately outside the partial index the default is kept by, so a number that cannot
    // send a thing can never become the one new conversations go out from.
    expect(claimed?.isDefault).toBe(false);

    await drain();
    const after = await portRow(portId);
    expect(after.providerSid).toMatch(/^PO/);
    expect(after.status).toBe('complete');
    const landed = await numberFor(e164);
    expect(landed?.status).toBe('active');
    expect(landed?.providerSid).toBeTruthy();
    // A full port arrives with no webhooks on it. Pointing it at ours is the difference between a customer's
    // text reaching the inbox and reaching nothing.
    expect(s.telephony.configured).toContain(landed!.providerSid!);
  });

  it('does not configure a hosted-messaging number, because there is nothing of ours to configure', async () => {
    const before = [...s.telephony.configured];
    const e164 = aNumber('0124');
    const portId = await readyPort(e164, 'hosted_messaging');
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    await drain();
    expect((await portRow(portId)).status).toBe('complete');
    // Calls still ring the old carrier's line; only texting came here, through the messaging service.
    const landed = await numberFor(e164);
    expect(s.telephony.configured.filter((sid) => !before.includes(sid))).not.toContain(
      landed?.providerSid,
    );
  });

  it('gives the number back when the old carrier says no', async () => {
    const e164 = aNumber('0000');
    const portId = await readyPort(e164);
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    await drain();
    const after = await portRow(portId);
    expect(after.status).toBe('rejected');
    expect(after.rejectionReason).toMatch(/account number or PIN/i);
    // Released, not left sitting in `porting`: another business may want this number, and this one should
    // not keep paying a slot against its ceiling for a number it never got.
    expect((await numberFor(e164))?.status).toBe('released');
  });

  it('keeps asking while the old carrier keeps thinking', async () => {
    const e164 = aNumber('0001');
    const portId = await readyPort(e164);
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    await drain();
    const after = await portRow(portId);
    expect(after.status).toBe('carrier_review');
    expect(after.nextPollAt).not.toBeNull();
    expect((await numberFor(e164))?.status).toBe('porting');
  });

  it('calls a port off at the carrier, and lets the number go', async () => {
    const e164 = aNumber('0001');
    const portId = await readyPort(e164);
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    await drain();
    const sid = (await portRow(portId)).providerSid!;
    await executeCommand(api(), numberPortCancel, { workspaceId, portId }, actor(owner), meta());
    await drain();
    expect((await portRow(portId)).status).toBe('cancelled');
    expect(s.telephony.portsCancelled).toContain(sid);
    expect((await numberFor(e164))?.status).toBe('released');
  });
});

describe('what the database refuses', () => {
  it('will not let a person write what the carrier said', async () => {
    const portId = await readyPort(aNumber('0001'));
    // Drizzle wraps a driver error, so the guard's own words are on the innermost cause and never on the
    // message `rejects.toThrow` reads — that only ever sees `Failed query: …`. `expectPgError` unwraps it,
    // and `detail` is the part the guard actually promises a caller.
    const e = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`update app.number_ports set provider_status = 'APPROVED' where id = ${portId}`,
        ),
      ),
    );
    expect(e.message).toMatch(/Only HandsFreeOS records what the carrier said/);
    expect(e.detail).toBe('number_port_provider_fields');
  });

  it('will not let a person re-point the claim once the port has been sent', async () => {
    // Sending is the one transition on which a person writes `phone_number_id`, because sending is what
    // claims the number. The carve-out is that transition and nothing else: afterwards the column is the
    // worker's like the rest of the carrier's side, or a business could hand a landed number to itself.
    const portId = await readyPort(aNumber('0001'));
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    const e = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.number_ports set phone_number_id = null where id = ${portId}`),
      ),
    );
    expect(e.detail).toBe('number_port_provider_fields');
  });

  it('will not let a person change a port the carrier already has', async () => {
    const portId = await readyPort(aNumber('0001'));
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    await drain();
    const e = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.number_ports set kind = 'hosted_messaging' where id = ${portId}`),
      ),
    );
    expect(e.message).toMatch(/already with the carrier/);
    expect(e.detail).toBe('number_port_with_carrier');
  });

  it('keeps the old carrier’s PIN away from a member', async () => {
    const portId = await readyPort(aNumber('0001'));
    // `channels.manage` is owner and admin only, which is the whole reason the submission lives on a table
    // with its own policy rather than on app.phone_numbers.
    const seen = await as(member)((tx) =>
      rows(tx, sql`select id from app.number_ports where id = ${portId}`),
    );
    expect(seen).toHaveLength(0);
  });

  it('will not let a second business claim a number already moving', async () => {
    const e164 = aNumber('0001');
    const portId = await readyPort(e164);
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    const other = await createTestUser('ports-rival');
    const { output } = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Rival HVAC' },
      actor(other),
      meta(),
    );
    const rival = await executeCommand(
      api(),
      numberPortStart,
      { workspaceId: output.workspaceId, e164, kind: 'full' },
      actor(other),
      meta(),
    );
    // Starting is fine — two businesses may both believe the number is theirs. Sending is where the database
    // decides, because that is when a claim is actually staked.
    await executeCommand(
      api(),
      numberPortSave,
      {
        workspaceId: output.workspaceId,
        portId: rival.output.portId,
        submission: {
          accountNumber: '1',
          pin: '2',
          authorizedBy: 'Somebody Else',
          serviceAddress: '2 Other St, Elsewhere, TX 77001',
        },
      },
      actor(other),
      meta(),
    );
    const fileId = randomUUID();
    await admin()
      .insert(files)
      .values({
        id: fileId,
        workspaceId: output.workspaceId,
        recordType: 'port',
        recordId: rival.output.portId,
        bucket: 'attachments',
        objectPath: `${output.workspaceId}/port/${rival.output.portId}/${fileId}/loa.pdf`,
        name: 'loa.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        status: 'ready',
        createdBy: other.id,
      });
    await executeCommand(
      api(),
      numberPortAttach,
      { workspaceId: output.workspaceId, portId: rival.output.portId, document: 'loa', fileId },
      actor(other),
      meta(),
    );
    await expect(
      executeCommand(
        api(),
        numberPortSubmit,
        { workspaceId: output.workspaceId, portId: rival.output.portId },
        actor(other),
        meta(),
      ),
    ).rejects.toThrow();
  });
});
