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
import { createClient } from '@supabase/supabase-js';
import { and, eq } from 'drizzle-orm';
import {
  executeCommand,
  numberPortAttach,
  numberPortCancel,
  numberPortSave,
  numberPortStart,
  numberPortSubmit,
  organizationCreate,
  type HfosError,
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
import { MAX_ATTEMPTS } from '../src/outbox';
import type { ObjectStore } from '../src/storage';
import { testServices, type TestServices } from './helpers';

const env = testEnv();
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
/** The worker's own key, the way every other test that needs bytes in Storage does it. */
const bucket = () =>
  createClient(env.supabaseUrl, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage.from('attachments');
/** Something that is a PDF as far as anything here is concerned. The carrier only ever sees bytes. */
const LOA = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/**
 * A number nobody else in the test database holds, and nothing in this file has had before. The last four
 * decide what the fake carrier does with it.
 *
 * The middle is still drawn at random, because `app.phone_numbers.e164` is unique across the whole database
 * and other suites run beside this one. What it may not do is repeat within the file: `number_port.start`
 * hands back a port already open on a number rather than opening a second one, so two tests drawing the same
 * number left the later one saving a port the carrier already had, refused with `port_with_carrier`. Six
 * draws of one ending out of 899 middles collided about once in sixty runs, which is what a green file and
 * the occasional red one looked like.
 */
const drawn = new Set<string>();
const aNumber = (ending: string) => {
  for (;;) {
    const n = `+1713${String(100 + Math.floor(Math.random() * 899))}${ending}`;
    if (!drawn.has(n)) {
      drawn.add(n);
      return n;
    }
  }
};

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

/**
 * Runs the outbox and job loops over this workspace's work until nothing is left that wants to run *now*.
 *
 * **A job that only asks to come back later is not progress.** A port on a carrier that is still thinking
 * polls, records the same status, and asks for another poll — forever, by design. At production's six hours
 * that is invisible to a test; at the test interval it would be claimed again every 50ms until the deadline,
 * and every later drain in the file would inherit the spin. So a pass whose every claim was a reschedule
 * ends the drain, which also gives each poll exactly one turn per drain — enough for a carrier that answers.
 */
async function drain(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await reserve();
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const events = await processOnce({ ...d, handlers });
    const ran = await processJobs({ ...d, jobs });
    const passes = [events, ran];
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
    if (events.claimed === 0 && ran.claimed - ran.rescheduled === 0) return;
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
 * **The bytes go in for real.** The `files` row is made the way `number_port.begin_upload` makes it and
 * marked ready directly, because `file.confirm` is the browser's half and not what this file is about — but
 * the object itself goes into Storage with the worker's key first, as `knowledge-document.test.ts` does.
 *
 * It used to skip that, on the premise that "the object itself only matters to Storage". That premise was
 * wrong — `portSubmit` downloads it and hands it to the carrier — and while it stood, nothing here ever ran
 * the half of the job that actually sends a business's signed authorisation.
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
  const objectPath = `${workspaceId}/port/${output.portId}/${fileId}/loa.pdf`;
  const put = await bucket().upload(objectPath, LOA, { contentType: 'application/pdf' });
  expect(put.error).toBeNull();
  await admin().insert(files).values({
    id: fileId,
    workspaceId,
    recordType: 'port',
    recordId: output.portId,
    bucket: 'attachments',
    objectPath,
    name: 'loa.pdf',
    mimeType: 'application/pdf',
    sizeBytes: LOA.length,
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

/**
 * The real store with its first `n` downloads made to fail, and nothing else changed.
 *
 * A carrier's paperwork failing to fetch is the one thing `drain()` cannot express — it throws on the first
 * retried job, which is exactly the state these two tests are about.
 */
function flakyStore(n: number): ObjectStore {
  let left = n;
  return {
    ...s.store,
    async download(bucket, path) {
      if (left > 0) {
        left -= 1;
        throw new Error('storage download failed: Object not found');
      }
      return s.store.download(bucket, path);
    },
  };
}

/** Brings a retried job forward: the backoff is real time, and a test cannot wait it out. */
async function pushDue(): Promise<void> {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now()
        where workspace_id = ${workspaceId} and status = 'pending'`,
  );
}

/**
 * One pass of both loops with a store of our choosing, without `drain`'s "a retry is a failure" rule.
 *
 * Reserved twice on purpose: the outbox pass is what creates the job, and `reservedOnly` claims nothing that
 * was not locked before it ran.
 */
async function runOnce(store: ObjectStore, telephony: TestServices['telephony'] = s.telephony) {
  const d = { ...s, store, telephony, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
  await reserve();
  await processOnce({ ...d, handlers });
  await reserve();
  return processJobs({ ...d, jobs });
}

/** Asks for the port to be sent again, the way `port.poll` does when it finds one it thinks never went. */
async function askAgain(portId: string): Promise<void> {
  await rows(
    admin(),
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        select w.organization_id, w.id, 'port.submit', ${`again:${randomUUID()}`}, now(),
               jsonb_build_object('portId', ${portId}::text)
        from app.workspaces w where w.id = ${workspaceId}`,
  );
}

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
    // A full port arrives bare. Both halves are the difference between a customer reaching the inbox and
    // reaching nothing: our webhooks on the number, and the number on the messaging service.
    expect(landed?.providerSid).toMatch(/^PNfake/);
    expect(s.telephony.configured).toContain(landed!.providerSid!);
    expect(s.telephony.serviced.map((x) => x.numberSid)).toContain(landed!.providerSid!);
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
    // And no carrier reference for the number, because there is no number of theirs to name. It used to
    // hold the *port's* reference, which everything that reads this column reads as a number's — releasing
    // one would hand a port id to the carrier and then tell the business it was gone.
    expect(landed?.providerSid).toBeNull();
  });

  it('ticks off the migration’s step for the number once it lands, and only that one', async () => {
    const e164 = aNumber('0125');
    const other = aNumber('0126');
    const [ws] = await rows<{ organization_id: string }>(
      admin(),
      sql`select organization_id from app.workspaces where id = ${workspaceId}`,
    );
    const org = ws!.organization_id;
    const [connection] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.migration_connections (organization_id, source_system, status, adapter_version)
          values (${org}, 'gohighlevel', 'active', 1) returning id`,
    );
    const [migration] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.migrations (organization_id, connection_id, source_system, status, name, adapter_version)
          values (${org}, ${connection!.id}, 'gohighlevel', 'transition'::app.migration_status, 'Old CRM', 1)
          returning id`,
    );
    // The two numbers the migration found customers texting and ringing, as `findReconnectTasks` writes them.
    for (const n of [e164, other])
      await rows(
        admin(),
        sql`insert into app.migration_reconnect_tasks (migration_id, organization_id, workspace_id, kind,
              provider, label, instructions, settings_path, descriptor, blocks_live_use)
            values (${migration!.id}, ${org}, ${workspaceId}, 'messaging', 'carrier', ${n}, 'Move it here.',
              '/settings/texting', ${JSON.stringify({ number: n })}::jsonb, true)`,
      );

    const portId = await readyPort(e164);
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    await drain();
    expect((await portRow(portId)).status).toBe('complete');

    const tasks = await rows<{
      label: string;
      state: string;
      completed_at: Date | null;
      completed_by: string | null;
    }>(
      admin(),
      sql`select label, state::text as state, completed_at, completed_by
          from app.migration_reconnect_tasks where migration_id = ${migration!.id}`,
    );
    const step = new Map(tasks.map((t) => [t.label, t]));
    expect(step.get(e164)?.state).toBe('done');
    expect(step.get(e164)?.completed_at).not.toBeNull();
    // HandsFreeOS saw the carrier finish it; no person claimed it.
    expect(step.get(e164)?.completed_by).toBeNull();
    // The number that has not moved is still on the list.
    expect(step.get(other)?.state).toBe('todo');
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

  it('lets a business fix a rejected port and send it again', async () => {
    /*
     * The half the suite was missing, and the reason a guard shipped that refused a resend: every test
     * stopped at the rejection. `rejected → submitted` is in the guard precisely so a business that got the
     * account number wrong can correct it and try again — nothing exercised it until now.
     *
     * The number goes back on the market on the rejection and has to be re-taken by the second send, on the
     * same row rather than a second one, with the old carrier's answer cleared off the port.
     */
    const e164 = aNumber('0000');
    const portId = await readyPort(e164);
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    await drain();
    expect((await portRow(portId)).status).toBe('rejected');
    const released = await numberFor(e164);
    expect(released?.status).toBe('released');

    await executeCommand(
      api(),
      numberPortSave,
      {
        workspaceId,
        portId,
        submission: {
          accountNumber: '8675309',
          pin: '4321',
          authorizedBy: 'Dale Cooper',
          serviceAddress: '1 Main St, Twin Peaks, WA 98170',
        },
      },
      actor(owner),
      meta(),
    );
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    const resent = await portRow(portId);
    expect(resent.status).toBe('submitted');
    expect(resent.rejectionReason).toBeNull();
    const retaken = await numberFor(e164);
    expect(retaken?.id).toBe(released!.id);
    expect(retaken?.status).toBe('porting');
    expect(retaken?.releasedAt).toBeNull();

    /*
     * And it really is sent again. Asserting the row alone is what let this pass while the resend did
     * nothing: a person cannot clear `provider_sid`, so the worker saw the dead request's reference, decided
     * the carrier already had it, and the corrected PIN never left the building. Two submissions at the
     * carrier is the proof the row cannot give.
     */
    const sentBefore = s.telephony.ports.filter((p) => p.e164 === e164).length;
    await drain();
    expect(s.telephony.ports.filter((p) => p.e164 === e164)).toHaveLength(sentBefore + 1);
    const asked = s.telephony.ports.filter((p) => p.e164 === e164).at(-1)!;
    expect((asked.submission as { pin?: string }).pin).toBe('4321');
    // A new request, so the paperwork goes up against it rather than being taken as already sent.
    const papers = (await portRow(portId)).documents as { loa?: { sentFor?: string } };
    expect(papers.loa?.sentFor).toBe((await portRow(portId)).providerSid);
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

describe('when the paperwork cannot be sent', () => {
  /*
   * The half of `port.submit` that nothing ever ran. Until the test put real bytes in Storage the download
   * failed on the first try every time, and until the loop below was fixed a retry returned the moment it
   * saw a provider sid — so a business's signed authorisation never reached the carrier and nobody was told.
   */
  it('sends the paper on the next try when the first one could not be fetched', async () => {
    const e164 = aNumber('0001');
    const portId = await readyPort(e164);
    const before = s.telephony.portDocuments.length;
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());

    // The port reaches the carrier; the paper does not.
    const first = await runOnce(flakyStore(1));
    expect(first.retried).toBe(1);
    const sid = (await portRow(portId)).providerSid;
    expect(sid).toMatch(/^PO/);
    expect(s.telephony.portDocuments.length).toBe(before);

    // The retry comes back for the paper rather than past it.
    await pushDue();
    const second = await runOnce(s.store);
    expect(second.retried + second.failed).toBe(0);
    expect(s.telephony.portDocuments.slice(before)).toEqual([{ portSid: sid, name: 'loa.pdf' }]);

    // And it is written down, so a job that runs again does not send the carrier a second copy. This is the
    // whole reason coming back through the loop is safe, so it is asked for rather than assumed: without the
    // marker, an at-least-once job leaves a carrier holding three copies of one business's authorisation.
    const docs = (await portRow(portId)).documents as {
      loa?: { sentSid?: string; sentFor?: string };
    };
    expect(docs.loa?.sentSid).toMatch(/^RI/);
    expect(docs.loa?.sentFor).toBe(sid);
    await askAgain(portId);
    // Not an exact claim count: earlier tests leave ports the carrier is still thinking about, and their
    // polls are claimable too. What matters is that this job ran and sent nothing.
    const third = await runOnce(s.store);
    expect(third.claimed).toBeGreaterThan(0);
    expect(third.retried + third.failed).toBe(0);
    expect(s.telephony.portDocuments.length).toBe(before + 1);
  });

  it('waits rather than calling a full port done before the carrier hands the number over', async () => {
    /*
     * The hole the fake was hiding. `findOwnedNumber` returning null is ordinary — a carrier can answer
     * "moved" a moment before it lists the number — and finishing anyway costs everything: no webhooks on
     * the number so a customer reaches nobody, no messaging service so nothing goes out, a port reference
     * written where the number's belongs, and the port marked complete so this handler never runs again.
     */
    const e164 = aNumber('0002');
    const portId = await readyPort(e164);
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    const configuredBefore = s.telephony.configured.length;

    // The carrier says it moved, and has not handed the number over yet.
    const withholding = {
      ...s.telephony,
      findOwnedNumber: async () => null,
    } as TestServices['telephony'];
    for (let i = 0; i < 3; i += 1) {
      await pushDue();
      await runOnce(s.store, withholding);
    }
    const waiting = await portRow(portId);
    expect(waiting.status).not.toBe('complete');
    expect(waiting.lastError).toMatch(/has not handed it over/i);
    expect(s.telephony.configured).toHaveLength(configuredBefore);
    expect(await numberFor(e164)).toMatchObject({ status: 'porting' });

    // It appears, and the same poll finishes the job it would not finish half of.
    await pushDue();
    await drain();
    expect((await portRow(portId)).status).toBe('complete');
    const landed = await numberFor(e164);
    expect(landed?.status).toBe('active');
    expect(landed?.providerSid).toMatch(/^PNfake/);
    expect(s.telephony.configured).toContain(landed!.providerSid!);
  });

  it('fails the port and pulls it back when the paper never goes up at all', async () => {
    const e164 = aNumber('0001');
    const portId = await readyPort(e164);
    await executeCommand(api(), numberPortSubmit, { workspaceId, portId }, actor(owner), meta());
    const never = flakyStore(Number.MAX_SAFE_INTEGER);
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await pushDue();
      await runOnce(never);
    }

    // Said, not left saying "with the carrier": a business must not wait weeks for a number that was never
    // going to move.
    const after = await portRow(portId);
    expect(after.status).toBe('failed');
    expect(after.rejectionReason).toMatch(/could not send loa\.pdf/i);
    // The number goes back on the market, so they can start again.
    expect((await numberFor(e164))?.status).toBe('released');
    // And the half-finished request does not stay in their name at the carrier.
    await pushDue();
    await runOnce(never);
    expect(s.telephony.portsCancelled).toContain(after.providerSid);
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

  it('never lets a person write the claim, before sending or after', async () => {
    // Sending claims the number, but a person is not what writes the claim down: `private.port_claim_number`
    // does, on their behalf, after asking whether they may. So this column is the worker's at every point —
    // otherwise a business could point a port at a number that landed for somebody else.
    const sent = await readyPort(aNumber('0001'));
    await executeCommand(
      api(),
      numberPortSubmit,
      { workspaceId, portId: sent },
      actor(owner),
      meta(),
    );
    // A real id, captured rather than looked up: `set phone_number_id = (select … limit 1)` writes NULL when
    // the subquery finds nothing, which equals what is already there, so the guard never fires and the test
    // would pass by asserting nothing.
    const claimed = (await portRow(sent)).phoneNumberId;
    expect(claimed).toBeTruthy();

    const draft = await readyPort(aNumber('0001'));
    const before = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.number_ports set phone_number_id = ${claimed} where id = ${draft}`),
      ),
    );
    expect(before.detail).toBe('number_port_provider_fields');

    const after = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.number_ports set phone_number_id = null where id = ${sent}`),
      ),
    );
    expect(after.detail).toBe('number_port_provider_fields');
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
    const e = (await executeCommand(
      api(),
      numberPortSubmit,
      { workspaceId: output.workspaceId, portId: rival.output.portId },
      actor(other),
      meta(),
    ).catch((x: unknown) => x)) as HfosError;
    // Told why, not just refused: `private.port_claim_number` can see across businesses where the rival
    // cannot, so it answers instead of letting the unique index surface as "That already exists."
    expect(e.rule).toBe('number_already_moving');
    expect(e.status).toBe(409);
  });
});
