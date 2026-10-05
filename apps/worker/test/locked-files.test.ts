/**
 * A signed file is kept (Real Estate, step 3): the worker records what every file held when it arrived (its
 * SHA-256), and once a file is locked nobody deletes, renames or unlocks it — not its owner through the command, not
 * a person writing the row, not the worker — while deleting the whole business still removes it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import {
  executeCommand,
  fileBeginUpload,
  fileConfirm,
  fileDelete,
  fileLock,
  HfosError,
  organizationCreate,
  personCreate,
  type HumanActor,
} from '@hfos/core/server';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { processOnce, type OutboxDeps } from '../src/outbox';
import { testServices } from './helpers';

const env = testEnv();
const WORKER_ID = `vitest-locked-files-${process.pid}`;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const admin = () => testDbs().admin.db;
const PDF = Buffer.from('%PDF-1.4\n% The Smiths’ purchase contract, signed\n%%EOF\n');

let owner: TestUser;
let workspaceId: string;
let personId: string;
let deps: OutboxDeps;

async function processReserved() {
  await rows(
    admin(),
    sql`update app.outbox set locked_at = now(), locked_by = ${WORKER_ID}
        where status = 'pending' and workspace_id = ${workspaceId}`,
  );
  return processOnce(deps);
}

/** A file on the customer, uploaded and confirmed, with the worker's pass run. */
async function addFile(name: string): Promise<string> {
  const begun = await executeCommand(
    testDbs().api.db,
    fileBeginUpload,
    {
      workspaceId,
      recordType: 'person',
      recordId: personId,
      name,
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
    },
    actor(owner),
    meta(),
  );
  const storage = createClient(env.supabaseUrl, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const up = await storage.storage
    .from(begun.output.bucket)
    .upload(begun.output.objectPath, PDF, { contentType: 'application/pdf' });
  expect(up.error).toBeNull();
  await executeCommand(
    testDbs().api.db,
    fileConfirm,
    { workspaceId, fileId: begun.output.fileId },
    actor(owner),
    meta(),
  );
  await processReserved();
  return begun.output.fileId;
}

async function fileRow(fileId: string) {
  const [row] = await rows<{
    sha256: string | null;
    locked_at: string | null;
    locked_reason: string | null;
    deleted_at: string | null;
    name: string;
  }>(
    admin(),
    sql`select sha256, locked_at, locked_reason, deleted_at, name from app.files where id = ${fileId}::uuid`,
  );
  return row!;
}

/** The database's reason for refusing, however deep the driver wrapped it. */
function refusal(e: unknown): string | undefined {
  let err = e as { detail?: string; cause?: unknown } | undefined;
  while (err && !err.detail && err.cause) err = err.cause as typeof err;
  return err?.detail;
}

beforeAll(async () => {
  owner = await createTestUser('locked-files-owner');
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Hill Country Realty' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  const person = await executeCommand(
    testDbs().api.db,
    personCreate,
    { workspaceId, firstName: 'Ann', lastName: 'Smith' },
    actor(owner),
    meta(),
  );
  personId = person.output.personId;
  deps = { ...testServices(), handlers, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
});
afterAll(closeTestDbs);

describe('a file’s fingerprint', () => {
  it('is recorded by the worker when the file arrives', async () => {
    const fileId = await addFile('contract.pdf');
    const row = await fileRow(fileId);
    expect(row.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
  });

  it('is written once, and never by a person', async () => {
    const fileId = await addFile('disclosure.pdf');
    const byOwner = await asUser(testDbs().api.db, owner.claims, (tx) =>
      rows(tx, sql`update app.files set sha256 = ${'0'.repeat(64)} where id = ${fileId}::uuid`),
    ).catch((e: unknown) => e);
    expect(refusal(byOwner)).toBe('file_hash_is_ours');
  });
});

describe('a locked file', () => {
  it('is locked once, and says so on the customer’s timeline', async () => {
    const fileId = await addFile('purchase-contract.pdf');
    const first = await executeCommand(
      testDbs().api.db,
      fileLock,
      { workspaceId, fileId },
      actor(owner),
      meta(),
    );
    expect(first.output.changed).toBe(true);
    const again = await executeCommand(
      testDbs().api.db,
      fileLock,
      { workspaceId, fileId },
      actor(owner),
      meta(),
    );
    expect(again.output.changed).toBe(false);
    expect(await fileRow(fileId)).toMatchObject({ locked_reason: 'signed' });
    const lines = await rows<{ subtype: string; body: string }>(
      admin(),
      sql`select subtype, body from app.activities where person_id = ${personId}::uuid and subtype = 'file_locked'`,
    );
    expect(lines).toEqual([{ subtype: 'file_locked', body: 'purchase-contract.pdf' }]);
  });

  it('can’t be deleted, renamed or unlocked by its owner, the worker or anyone', async () => {
    const fileId = await addFile('signed-amendment.pdf');
    await executeCommand(testDbs().api.db, fileLock, { workspaceId, fileId }, actor(owner), meta());

    const viaCommand = await executeCommand(
      testDbs().api.db,
      fileDelete,
      { workspaceId, fileId },
      actor(owner),
      meta(),
    ).catch((e: unknown) => e);
    expect(viaCommand).toBeInstanceOf(HfosError);
    expect((viaCommand as HfosError).rule).toBe('file_locked');
    expect((viaCommand as HfosError).message).toContain('signed-amendment.pdf');

    for (const change of [
      sql`update app.files set deleted_at = now() where id = ${fileId}::uuid`,
      sql`update app.files set name = 'forged.pdf' where id = ${fileId}::uuid`,
      sql`update app.files set locked_at = null, locked_reason = null where id = ${fileId}::uuid`,
    ]) {
      const byOwner = await asUser(testDbs().api.db, owner.claims, (tx) => rows(tx, change)).catch(
        (e: unknown) => e,
      );
      expect(refusal(byOwner)).toBe('file_locked');
    }
    // Not even the database's own superuser, short of deleting the whole business.
    const direct = await rows(admin(), sql`delete from app.files where id = ${fileId}::uuid`).catch(
      (e: unknown) => e,
    );
    expect(refusal(direct)).toBe('file_locked');
    expect(await fileRow(fileId)).toMatchObject({
      deleted_at: null,
      name: 'signed-amendment.pdf',
    });
  });

  it('goes when the whole business is deleted', async () => {
    const fileId = await addFile('kept-until-the-end.pdf');
    await executeCommand(testDbs().api.db, fileLock, { workspaceId, fileId }, actor(owner), meta());
    await admin().transaction(async (tx) => {
      await tx.execute(
        sql`insert into private.workspace_purges (workspace_id) values (${workspaceId}::uuid)`,
      );
      await tx.execute(sql`delete from app.files where id = ${fileId}::uuid`);
      await tx.execute(
        sql`delete from private.workspace_purges where workspace_id = ${workspaceId}::uuid`,
      );
    });
    const left = await rows(admin(), sql`select 1 from app.files where id = ${fileId}::uuid`);
    expect(left).toEqual([]);
  });

  it('can only be locked once it has finished uploading', async () => {
    const begun = await executeCommand(
      testDbs().api.db,
      fileBeginUpload,
      {
        workspaceId,
        recordType: 'person',
        recordId: personId,
        name: 'half-there.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length,
      },
      actor(owner),
      meta(),
    );
    const early = await executeCommand(
      testDbs().api.db,
      fileLock,
      { workspaceId, fileId: begun.output.fileId },
      actor(owner),
      meta(),
    ).catch((e: unknown) => e);
    expect((early as HfosError).rule).toBe('file_not_ready');
  });
});
