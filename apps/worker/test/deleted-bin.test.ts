/**
 * Emptying the Deleted bin (bin/index.ts) on the real database and Storage: "Delete now" empties a customer at
 * once, with the files they held removed from storage, and the daily sweep starts what has waited its 30 days.
 */
import { randomUUID } from 'node:crypto';
import { binEmpty, personCreate, personDelete } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIN_JOBS } from '../src/bin/index';
import { admin, drain, makeWorld, nextPhone, run, type World } from './booking-world';

let w: World;

beforeAll(async () => {
  w = await makeWorld('bin');
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

/** A customer with a file stored for them: the row, and the bytes in Storage. */
async function withFile(first: string): Promise<{ personId: string; path: string }> {
  const { personId } = await run(w, personCreate, {
    workspaceId: w.workspaceId,
    firstName: first,
    lastName: 'Gone',
    phone: nextPhone(),
  });
  const path = `${w.workspaceId}/person/${personId}/${randomUUID()}/Quote.pdf`;
  await w.s.store.upload('attachments', path, Buffer.from('%PDF-1.4 quote'), 'application/pdf');
  await rows(
    admin(),
    sql`insert into app.files (workspace_id, record_type, record_id, bucket, object_path, name, mime_type,
          size_bytes, status)
        values (${w.workspaceId}, 'person', ${personId}, 'attachments', ${path}, 'Quote.pdf', 'application/pdf',
          14, 'ready')`,
  );
  return { personId, path };
}

const binItemOf = async (personId: string) =>
  (await run(w, personDelete, { workspaceId: w.workspaceId, personIds: [personId] })).deleted[0]!
    .binItemId;

const gone = async (personId: string, binItemId: string) => ({
  person: (await rows(admin(), sql`select 1 from app.people where id = ${personId}`)).length,
  item: (await rows(admin(), sql`select 1 from app.bin_items where id = ${binItemId}`)).length,
});

describe('emptying the bin', () => {
  it('“Delete now” takes a customer for good, with the files they held in storage', async () => {
    const { personId, path } = await withFile('Fay');
    const item = await binItemOf(personId);
    await drain(w);
    // In the bin, the file is still there to come back.
    expect(await w.s.store.exists('attachments', path)).toBe(true);

    await run(w, binEmpty, { workspaceId: w.workspaceId, binItemIds: [item] });
    await drain(w);
    expect(await gone(personId, item)).toEqual({ person: 0, item: 0 });
    expect(await w.s.store.exists('attachments', path)).toBe(false);
  });

  it('the daily sweep empties what has waited its 30 days', async () => {
    const { personId, path } = await withFile('Gus');
    const item = await binItemOf(personId);
    await drain(w);
    await rows(
      admin(),
      sql`update app.bin_items set purge_after = now() - interval '1 minute' where id = ${item}`,
    );
    // The sweep runs across every business, so this one is held to it: its own job, due now.
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          values (${w.organizationId}, ${w.workspaceId}, ${BIN_JOBS.sweep}, ${`test-sweep:${randomUUID()}`},
            now(), '{}'::jsonb)`,
    );
    await drain(w);
    expect(await gone(personId, item)).toEqual({ person: 0, item: 0 });
    expect(await w.s.store.exists('attachments', path)).toBe(false);
  });
});
