import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import {
  executeCommand,
  executeQuery,
  guessMapping,
  importCancel,
  importCreate,
  importGet,
  importStart,
  organizationCreate,
  personCreate,
  personList,
  timelineList,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { auditLogs, events, imports, outbox } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { runImport } from '../src/handlers/import-run';
import type { HandlerContext } from '../src/handlers/types';
import { MAX_ATTEMPTS, processOnce, type OutboxDeps } from '../src/outbox';
import { createSupabaseStore } from '../src/storage';
import { testServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-import-${process.pid}`;
const CSV = readFileSync(
  fileURLToPath(new URL('../fixtures/customers.csv', import.meta.url)),
  'utf8',
);
const HEADERS = CSV.split('\n')[0]!.split(',');
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const admin = () =>
  createClient(env.supabaseUrl, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
let deps: OutboxDeps;

/** Reserves an import, uploads the CSV with the worker key, and starts it; returns the import id and the request event. */
async function startImport(
  csv: string,
  options: { onMatch: 'skip' | 'update' } = { onMatch: 'skip' },
  opts: { viaOutbox?: boolean } = {},
  mapping = guessMapping(HEADERS, 'people'),
) {
  const created = await executeCommand(
    testDbs().api.db,
    importCreate,
    { workspaceId, kind: 'people', fileName: 'customers.csv' },
    actor(owner),
    meta(),
  );
  const up = await admin()
    .storage.from(created.output.bucket)
    .upload(created.output.objectPath, Buffer.from(csv), { contentType: 'text/csv' });
  expect(up.error).toBeNull();
  const started = await executeCommand(
    testDbs().api.db,
    importStart,
    { workspaceId, importId: created.output.importId, mapping, options },
    actor(owner),
    meta(),
  );
  const [event] = await testDbs()
    .admin.db.select()
    .from(events)
    .where(eq(events.id, started.eventIds[0]!));
  // The dev stack runs a worker that polls the same outbox: hand-driven runs take the job away from it,
  // outbox-driven ones pre-lock the row for this test's worker id (processOnce re-claims its own locks).
  if (!opts.viaOutbox)
    await testDbs()
      .admin.db.update(outbox)
      .set({ status: 'done' })
      .where(eq(outbox.eventId, event!.id));
  else
    await testDbs()
      .admin.db.update(outbox)
      .set({ lockedAt: new Date(), lockedBy: WORKER_ID })
      .where(eq(outbox.eventId, event!.id));
  return {
    importId: created.output.importId,
    objectPath: created.output.objectPath,
    event: event!,
  };
}

function contextFor(event: typeof events.$inferSelect, attempt = 1): Omit<HandlerContext, 'tx'> {
  const { handlers: _handlers, workerId: _workerId, batchSize: _batchSize, ...services } = deps;
  return {
    ...services,
    event,
    scope: { workspaceId, organizationId },
    attempt,
    maxAttempts: MAX_ATTEMPTS,
  };
}

beforeAll(async () => {
  owner = await createTestUser('import-owner');
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Import Co' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  deps = {
    ...testServices(),
    handlers,
    workerId: WORKER_ID,
    batchSize: 200,
    // Only rows this suite reserved (startImport pre-locks them): other suites leave their own work pending.
    reservedOnly: true,
  };
});
afterAll(closeTestDbs);

describe('CSV import through the outbox', () => {
  it('imports the fixture: creates people, companies and tags, skips duplicates and blanks, records bad rows, and cleans up', async () => {
    // One person already exists so the duplicate policy has something to hit.
    await executeCommand(
      testDbs().api.db,
      personCreate,
      { workspaceId, firstName: 'Sarah', lastName: 'Alvarez', phone: '281-555-0199' },
      actor(owner),
      meta(),
    );
    const { importId, objectPath, event } = await startImport(
      CSV,
      { onMatch: 'skip' },
      { viaOutbox: true },
    );
    // Keep going until ours is done (the import may take more than one pass).
    let stats = await processOnce(deps);
    for (let pass = 0; pass < 25; pass++) {
      const [row] = await testDbs()
        .admin.db.select()
        .from(outbox)
        .where(eq(outbox.eventId, event.id));
      if (row && row.status !== 'pending') break;
      stats = await processOnce(deps);
    }
    expect(stats.failed).toBe(0);

    const got = await executeQuery(
      testDbs().api.db,
      importGet,
      { workspaceId, importId },
      actor(owner),
      meta(),
    );
    // 9 data rows: Mike, Sarah (dup of the existing person → skipped), Robert (+ABC Dental), blank, Mike again
    // (dup email → skipped), Linda (bad email → error), Maria (+Riverside), nameless row (phone matches Sarah → skipped), James.
    expect(got.import).toMatchObject({
      status: 'done',
      totalRows: 9,
      processedRows: 9,
      createdCount: 4,
      updatedCount: 0,
      skippedCount: 4,
      errorCount: 1,
    });
    expect(got.import.finishedAt).not.toBeNull();
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toMatchObject({ rowNumber: 7 });
    expect(got.errors[0]!.message).toMatch(/email/i);

    const people = await executeQuery(
      testDbs().api.db,
      personList,
      { workspaceId, limit: 50 },
      actor(owner),
      meta(),
    ).then((r) => r.items);
    const names = people.map((p) => p.fullName).sort();
    expect(names).toEqual([
      'James Whitfield',
      'Maria Santos',
      'Mike Johnson',
      'Robert Chen',
      'Sarah Alvarez',
    ]);
    const robert = people.find((p) => p.fullName === 'Robert Chen')!;
    expect(robert.company?.name).toBe('ABC Dental');
    expect(robert.tags.map((t) => t.name)).toEqual(['Commercial']);
    const mike = people.find((p) => p.fullName === 'Mike Johnson')!;
    expect(mike.tags.map((t) => t.name).sort()).toEqual(['Referral', 'Residential']);
    expect(mike.phone).toBe('(713) 555-0142');
    const james = people.find((p) => p.fullName === 'James Whitfield')!;
    expect(james.company?.id).toBe(robert.company?.id); // the company was created once and reused

    // Each imported person carries a system activity and an event by the system actor on the importer's behalf.
    const timeline = await executeQuery(
      testDbs().api.db,
      timelineList,
      { workspaceId, recordType: 'person', recordId: mike.id },
      actor(owner),
      meta(),
    );
    expect(timeline.items[0]).toMatchObject({
      kind: 'system',
      subtype: 'created',
      actorType: 'system',
      actor: null,
    });
    expect(timeline.items[0]!.meta.onBehalfOf).toBe(owner.id);
    const [created] = await testDbs()
      .admin.db.select()
      .from(events)
      .where(eq(events.entityId, mike.id));
    expect(created).toMatchObject({
      eventType: 'person.created',
      actorType: 'system',
      actorId: null,
      causationId: event.id,
      correlationId: event.correlationId,
    });
    expect((created!.payload as { _broadcast?: boolean })._broadcast).toBe(false);
    const audit = await testDbs()
      .admin.db.select()
      .from(auditLogs)
      .where(eq(auditLogs.eventId, created!.id));
    expect(audit[0]).toMatchObject({ actorType: 'system', actorRole: 'system', channel: 'worker' });

    // Progress and finish events broadcast (no _broadcast flag), one per batch.
    const system = await testDbs()
      .admin.db.select()
      .from(events)
      .where(eq(events.causationId, event.id));
    const types = system.map((e) => e.eventType);
    expect(types.filter((t) => t === 'import.progressed')).toHaveLength(1);
    expect(types).toContain('import.finished');
    const finished = system.find((e) => e.eventType === 'import.finished')!;
    const [finishedAudit] = await testDbs()
      .admin.db.select()
      .from(auditLogs)
      .where(eq(auditLogs.eventId, finished.id));
    expect(finishedAudit!.after).toMatchObject({
      fileName: 'customers.csv',
      created: 4,
      updated: 0,
      skipped: 4,
      errors: 1,
    });

    // The CSV is gone from the bucket.
    expect(await deps.store.exists('imports', objectPath)).toBe(false);
    // Rows carry the import row so a retried batch is a no-op.
    const [tagged] = await rows<{ n: number }>(
      testDbs().admin.db,
      sql`select count(*)::int as n from app.people where import_id = ${importId}`,
    );
    expect(tagged!.n).toBe(4);
  });

  it('updates matches when asked to, and a second claim of a live import is a no-op', async () => {
    const csv = `${HEADERS.join(',')}\nMike,Johnson,mike.johnson@example.com,,,,Katy,TX,77494,,Moved to Katy\n`;
    const { importId, event } = await startImport(csv, { onMatch: 'update' });
    // A concurrent worker sees a live run and does nothing.
    await testDbs()
      .admin.db.update(imports)
      .set({ status: 'running', heartbeatAt: new Date() })
      .where(eq(imports.id, importId));
    const second = await deps.db.transaction(async (tx) =>
      runImport({ ...contextFor(event), tx }, { batchSize: 2 }),
    );
    expect(second).toBe('not_claimed');
    await testDbs()
      .admin.db.update(imports)
      .set({ status: 'pending', heartbeatAt: null })
      .where(eq(imports.id, importId));
    const ran = await deps.db.transaction(async (tx) =>
      runImport({ ...contextFor(event), tx }, { batchSize: 2 }),
    );
    expect(ran).toBe('done');
    const got = await executeQuery(
      testDbs().api.db,
      importGet,
      { workspaceId, importId },
      actor(owner),
      meta(),
    );
    expect(got.import).toMatchObject({
      status: 'done',
      createdCount: 0,
      updatedCount: 1,
      skippedCount: 0,
      errorCount: 0,
    });
    const people = await executeQuery(
      testDbs().api.db,
      personList,
      { workspaceId, q: 'johnson', limit: 10 },
      actor(owner),
      meta(),
    ).then((r) => r.items);
    expect(people.find((p) => p.fullName === 'Mike Johnson')?.address.city).toBe('Katy');
  });

  it('adds a matched customer’s new number and email beside theirs instead of replacing them', async () => {
    const { output } = await executeCommand(
      testDbs().api.db,
      personCreate,
      {
        workspaceId,
        firstName: 'Dana',
        lastName: 'Reyes',
        phone: '713-555-0171',
        email: 'dana@home.example',
        otherPhones: [{ phone: '713-555-0172', label: 'Work' }],
      },
      actor(owner),
      meta(),
    );
    // Matched on her work number; the file's email is new to her.
    const csv = `${HEADERS.join(',')}\nDana,Reyes,dana@office.example,713-555-0172,,,,,,,\n`;
    const { event } = await startImport(csv, { onMatch: 'update' });
    await deps.db.transaction(async (tx) =>
      runImport({ ...contextFor(event), tx }, { batchSize: 2 }),
    );
    const [row] = await rows<{
      email: string;
      phone_e164: string;
      other_emails: { email: string }[];
      other_phones: { phone: string; label?: string }[];
    }>(
      testDbs().admin.db,
      sql`select email::text, phone_e164, other_emails, other_phones from app.people where id = ${output.personId}`,
    );
    expect(row!.phone_e164).toBe('+17135550171');
    expect(row!.other_phones).toEqual([{ phone: '+17135550172', label: 'Work' }]);
    expect(row!.email).toBe('dana@home.example');
    expect(row!.other_emails).toEqual([{ email: 'dana@office.example' }]);
  });

  it('resumes after a crash without duplicating rows, and stops between batches when cancelled', async () => {
    const lines = Array.from(
      { length: 6 },
      (_, i) => `Batch${i},Person${i},batch${i}@example.com,,,,,,,,`,
    );
    const csv = `${HEADERS.join(',')}\n${lines.join('\n')}\n`;
    const { importId, event } = await startImport(csv);
    // Simulate a worker that died after the first batch of 2: rows 1-2 exist, processed_rows says 2, heartbeat is stale.
    const first = await deps.db.transaction(async (tx) => {
      const ctx = { ...contextFor(event), tx };
      // Run one batch by hand: claim + batch, then pretend we crashed by rolling the status back to a stale running state.
      return runImport(ctx, { batchSize: 2 });
    });
    expect(first).toBe('done');
    let got = await executeQuery(
      testDbs().api.db,
      importGet,
      { workspaceId, importId },
      actor(owner),
      meta(),
    );
    expect(got.import).toMatchObject({ status: 'done', createdCount: 6, processedRows: 6 });

    // Force the "crashed mid-way" state: back to running, processed_rows 2, stale heartbeat, counts as after batch one.
    await testDbs()
      .admin.db.update(imports)
      .set({
        status: 'running',
        processedRows: 2,
        createdCount: 2,
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
        finishedAt: null,
      })
      .where(eq(imports.id, importId));
    await admin()
      .storage.from('imports')
      .upload(`${workspaceId}/${importId}.csv`, Buffer.from(csv), {
        contentType: 'text/csv',
        upsert: true,
      });
    const resumed = await deps.db.transaction(async (tx) =>
      runImport({ ...contextFor(event, 2), tx }, { batchSize: 2 }),
    );
    expect(resumed).toBe('done');
    got = await executeQuery(
      testDbs().api.db,
      importGet,
      { workspaceId, importId },
      actor(owner),
      meta(),
    );
    expect(got.import).toMatchObject({
      status: 'done',
      createdCount: 6,
      processedRows: 6,
      errorCount: 0,
    });
    const [count] = await rows<{ n: number }>(
      testDbs().admin.db,
      sql`select count(*)::int as n from app.people where import_id = ${importId}`,
    );
    expect(count!.n).toBe(6);

    // Cancel between batches: the second batch never runs.
    const csv2 = `${HEADERS.join(',')}\n${Array.from({ length: 4 }, (_, i) => `Cancel${i},Person${i},cancel${i}@example.com,,,,,,,,`).join('\n')}\n`;
    const started = await startImport(csv2);
    const cancelling = createSupabaseStore(env.supabaseUrl, env.secretKey);
    const store = {
      ...cancelling,
      // Cancel right after the CSV is downloaded, before the first batch commits.
      async download(bucket: string, path: string) {
        const data = await cancelling.download(bucket, path);
        await executeCommand(
          testDbs().api.db,
          importCancel,
          { workspaceId, importId: started.importId },
          actor(owner),
          meta(),
        );
        return data;
      },
    };
    const result = await deps.db.transaction(async (tx) =>
      runImport({ ...contextFor(started.event), tx, store }, { batchSize: 2 }),
    );
    expect(result).toBe('cancelled');
    got = await executeQuery(
      testDbs().api.db,
      importGet,
      { workspaceId, importId: started.importId },
      actor(owner),
      meta(),
    );
    expect(got.import).toMatchObject({ status: 'cancelled', processedRows: 2, createdCount: 2 });
    expect(await deps.store.exists('imports', started.objectPath)).toBe(false);
  });

  it('gives up after the last attempt and marks the import failed with the reason', async () => {
    const { importId, event } = await startImport(CSV);
    await admin()
      .storage.from('imports')
      .remove([`${workspaceId}/${importId}.csv`]);
    const result = await deps.db.transaction(async (tx) =>
      runImport({ ...contextFor(event, MAX_ATTEMPTS), tx }, { batchSize: 2 }),
    );
    expect(result).toBe('failed');
    const [row] = await testDbs().admin.db.select().from(imports).where(eq(imports.id, importId));
    expect(row).toMatchObject({ status: 'failed' });
    expect(row?.lastError).toMatch(/download failed/);
  });
});
