/**
 * Words inside files (src/files/file-text.ts), on the real database and Storage: a file a person adds is read for
 * search by a job of its own, never inside the outbox; a PDF keeps where each page starts, so search says "page 3";
 * a scan, a CSV, a photo, a file over 25 MB and port papers each come out as they should; the words never reach an
 * event or the audit log; the last try that fails keeps the file as unreadable; a file deleted for good while its
 * words are being kept keeps none; a database error saving them is thrown with its SQLSTATE alone, never the words;
 * and the sweep queues only the files still to read, 20 at a time spread over five minutes, never one that's gone.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  executeQuery,
  fileBeginUpload,
  fileConfirm,
  hitLines,
  organizationCreate,
  personCreate,
  searchEverything,
  type HumanActor,
} from '@hfos/core/server';
import { asUser, asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FILE_TEXT_JOBS,
  fileTextJob,
  fileTextSweep,
  onFileText,
  sweepPlan,
} from '../../src/files/file-text';
import type { EventRow } from '../../src/handlers/types';
import { handlers } from '../../src/handlers/index';
import { processJobs, type JobRow } from '../../src/jobs';
import { MAX_ATTEMPTS, processOnce } from '../../src/outbox';
import { jobs } from '../../src/scheduled';
import type { WorkerServices } from '../../src/services';
import { testServices } from '../helpers';
import { textPdf } from '../pdf-maker';

const WORKER_ID = `vitest-file-text-${process.pid}`;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let ws: string;
let org: string;
let customer: string;
const s = testServices();

beforeAll(async () => {
  owner = await createTestUser('file-text-owner');
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'File Words Plumbing' },
    actor(owner),
    meta(),
  );
  ws = output.workspaceId;
  org = output.organizationId;
  ({ personId: customer } = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Kim', lastName: 'Le' },
      actor(owner),
      meta(),
    )
  ).output as { personId: string });
});
afterAll(closeTestDbs);

/** A file the owner adds to Kim, the way the web adds one: reserved, uploaded, confirmed. */
async function addFile(name: string, mimeType: string, data: Buffer): Promise<string> {
  const { output } = await executeCommand(
    api(),
    fileBeginUpload,
    {
      workspaceId: ws,
      recordType: 'person',
      recordId: customer,
      name,
      mimeType,
      sizeBytes: data.length,
    },
    actor(owner),
    meta(),
  );
  await s.store.upload(output.bucket, output.objectPath, data, mimeType);
  await executeCommand(
    api(),
    fileConfirm,
    { workspaceId: ws, fileId: output.fileId },
    actor(owner),
    meta(),
  );
  return output.fileId;
}

/** A file written straight into the table, as an import would leave one. */
async function fileRow(
  f: {
    type?: string;
    record?: string;
    name?: string;
    mime?: string;
    size?: number;
    createdAt?: string;
    /** Deleted already: in the bin, or gone for good. */
    deleted?: boolean;
  } = {},
): Promise<string> {
  const path = `${ws}/${f.type ?? 'person'}/${f.record ?? customer}/${randomUUID()}/${f.name ?? 'file.pdf'}`;
  const [row] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.files (workspace_id, record_type, record_id, bucket, object_path, name, mime_type,
          size_bytes, status, created_by, created_at, deleted_at)
        values (${ws}, ${f.type ?? 'person'}::app.record_type, ${f.record ?? customer}, 'attachments', ${path},
          ${f.name ?? 'file.pdf'}, ${f.mime ?? 'application/pdf'}, ${f.size ?? 100}, 'ready', ${owner.id},
          ${f.createdAt ?? new Date().toISOString()}::timestamptz, ${f.deleted ? sql`now()` : sql`null`})
        returning id`,
  );
  return row!.id;
}

interface Words {
  state: string;
  text: string;
  pages: number[];
  chars: number;
  reader: number;
}
const wordsOf = async (fileId: string): Promise<Words | undefined> =>
  (
    await rows<Words & Record<string, unknown>>(
      admin(),
      sql`select state, text, pages, chars, reader from app.file_texts where file_id = ${fileId}`,
    )
  )[0];

/** Runs this business's outbox and jobs until the file's words are kept. */
async function readWords(fileId: string): Promise<Words> {
  const deps = { ...s, workerId: WORKER_ID, batchSize: 50, reservedOnly: true };
  const deadline = Date.now() + 30_000;
  for (;;) {
    for (const table of ['outbox', 'scheduled_jobs'])
      await rows(
        admin(),
        sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
            where status = 'pending' and workspace_id = ${ws}`,
      );
    const passes = [await processOnce({ ...deps, handlers }), await processJobs({ ...deps, jobs })];
    if (passes.some((p) => p.retried + p.failed > 0))
      throw new Error(
        `worker work failed: ${JSON.stringify(
          await rows(
            admin(),
            sql`select kind, last_error from app.scheduled_jobs where workspace_id = ${ws} and last_error is not null`,
          ),
        )}`,
      );
    const words = await wordsOf(fileId);
    if (words) return words;
    if (Date.now() > deadline) throw new Error('the file’s words were not read in time');
  }
}

/** One run of the job for a file, straight, as the worker runs it. */
const runJob = (fileId: string, services: WorkerServices = s, attempt = 1) =>
  fileTextJob({
    ...services,
    job: { payload: { fileId } } as unknown as JobRow,
    scope: { workspaceId: ws, organizationId: org },
    attempt,
    now: Date.now(),
  });

/** The store, counting what it downloads, or failing every download. */
function watched(fail = false): { services: WorkerServices; downloads: () => number } {
  let n = 0;
  return {
    services: {
      ...s,
      store: {
        ...s.store,
        async download(bucket, path) {
          n++;
          if (fail) throw new Error('storage is not answering');
          return s.store.download(bucket, path);
        },
      },
    },
    downloads: () => n,
  };
}

describe('reading a file’s words', () => {
  it('queues one job when a file is added, and keeps a PDF’s words with where each page starts', async () => {
    const pdf = textPdf([
      ['Annual backflow inspection for Gulf Coast Realty, all buildings'],
      ['Building 1 passed. Every valve holds and the gauges read true.'],
      ['Building 2: the test cock is weeping. Quote the thermocouple swap.'],
    ]);
    const fileId = await addFile('Inspection.pdf', 'application/pdf', pdf);
    const words = await readWords(fileId);
    expect(words).toMatchObject({ state: 'done', reader: 1 });
    expect(words.pages).toHaveLength(3);
    expect(words.pages[0]).toBe(0);
    expect(words.text.slice(words.pages[2]!)).toMatch(/^Building 2: the test cock is weeping/);
    expect(words.chars).toBe([...words.text].length);
    const queued = await rows<{ dedupe_key: string }>(
      admin(),
      sql`select dedupe_key from app.scheduled_jobs where kind = ${FILE_TEXT_JOBS.read} and payload ->> 'fileId' = ${fileId}`,
    );
    expect(queued.map((j) => j.dedupe_key)).toEqual([`file.text:${fileId}`]);

    // Search finds it by the words on its third page, and says so.
    const answer = await executeQuery(
      api(),
      searchEverything,
      { workspaceId: ws, q: 'test cock weeping' },
      actor(owner),
      meta(),
    );
    const hit = answer.groups.find((g) => g.kind === 'files')!.items[0]!;
    expect(hit).toMatchObject({ id: fileId, why: { field: 'file_text', page: 3 } });
    expect(hitLines(hit, { timeZone: 'America/Chicago' }).line).toBe('On Kim Le · page 3');
  });

  it('never puts the words in the event or the audit log', async () => {
    const fileId = await addFile(
      'Gate.csv',
      'text/csv',
      Buffer.from('Customer,Gate code\r\nKim Le,Secretword 4471\r\n'),
    );
    const words = await readWords(fileId);
    expect(words).toMatchObject({
      state: 'done',
      text: 'Customer,Gate code\nKim Le,Secretword 4471',
      pages: [],
    });
    const [event] = await rows<{ id: string; payload: Record<string, unknown> }>(
      admin(),
      sql`select id, payload from app.events where event_type = 'file.text_saved' and entity_id = ${fileId}`,
    );
    expect(event!.payload).toEqual({ fileId, state: 'done', chars: words.chars, reader: 1 });
    const audit = await rows<{ after: unknown }>(
      admin(),
      sql`select after from app.audit_logs where event_id = ${event!.id}`,
    );
    expect(JSON.stringify([event, audit])).not.toMatch(/secretword|4471/i);
    // The Activity log names the file.
    expect(audit[0]!.after).toEqual({
      name: 'Gate.csv',
      state: 'done',
      chars: words.chars,
      reader: 1,
    });
  });

  it('keeps a scan as having no text, and reads nothing of port papers or knowledge files', async () => {
    const scan = await addFile('Scan.pdf', 'application/pdf', textPdf([[], []]));
    expect(await readWords(scan)).toMatchObject({ state: 'no_text', text: '' });

    for (const type of ['port', 'knowledge'] as const) {
      const fileId = await fileRow({ type, record: type === 'port' ? randomUUID() : ws });
      // Not queued when it arrives, and the job lets it be if asked.
      await asWorker(s.db, { workspaceId: ws, organizationId: org }, (tx) =>
        onFileText({
          ...s,
          tx,
          event: {
            eventType: 'file.attached',
            payload: { fileId },
            workspaceId: ws,
            organizationId: org,
          } as unknown as EventRow,
          scope: { workspaceId: ws, organizationId: org },
          attempt: 1,
          maxAttempts: MAX_ATTEMPTS,
        }),
      );
      const queued = await rows(
        admin(),
        sql`select 1 from app.scheduled_jobs where kind = ${FILE_TEXT_JOBS.read} and payload ->> 'fileId' = ${fileId}`,
      );
      expect(queued, type).toEqual([]);
      await runJob(fileId);
      expect(await wordsOf(fileId), type).toBeUndefined();
    }
  });

  it('keeps a photo as unsupported and a file over 25 MB as too large, downloading neither', async () => {
    const photo = await fileRow({ name: 'Leak.jpg', mime: 'image/jpeg' });
    const big = await fileRow({ name: 'Plans.pdf', size: 26 * 1024 * 1024 });
    const store = watched();
    await runJob(photo, store.services);
    await runJob(big, store.services);
    expect(await wordsOf(photo)).toMatchObject({ state: 'unsupported', text: '' });
    expect(await wordsOf(big)).toMatchObject({ state: 'too_large', text: '' });
    expect(store.downloads()).toBe(0);
  });

  it('tries again while storage fails, and keeps the file as unreadable on the last try', async () => {
    const fileId = await fileRow({ name: 'Contract.pdf' });
    const store = watched(true);
    await expect(runJob(fileId, store.services, 1)).rejects.toThrow('storage is not answering');
    expect(await wordsOf(fileId)).toBeUndefined();
    await runJob(fileId, store.services, MAX_ATTEMPTS);
    expect(await wordsOf(fileId)).toMatchObject({ state: 'unreadable', text: '' });
  });

  it('lets a file that’s gone be: nothing kept, nothing thrown', async () => {
    const fileId = await fileRow({ deleted: true });
    await runJob(fileId);
    expect(await wordsOf(fileId)).toBeUndefined();
  });

  it('keeps no words for a file deleted for good while they’re being kept', async () => {
    const fileId = await fileRow({ name: 'Leak.jpg', mime: 'image/jpeg' });
    let job: Promise<unknown> | undefined;
    // A person deletes it: the update is made, the words not yet kept, and it commits once the save waits on it.
    await asUser(api(), owner.claims, async (tx) => {
      const [{ pid }] = (await rows<{ pid: number }>(tx, sql`select pg_backend_pid() as pid`)) as [
        { pid: number },
      ];
      await rows(
        tx,
        sql`update app.files set deleted_at = now(), deleted_by = ${owner.id} where id = ${fileId}`,
      );
      job = runJob(fileId);
      await waitingOn(pid);
    });
    await job;
    expect(await wordsOf(fileId)).toBeUndefined();
  });

  it('throws a database error saving the words with its SQLSTATE alone, never the words', async () => {
    const fileId = await addFile(
      'Chart.csv',
      'text/csv',
      Buffer.from('Patient,Note\nKim Le,Cancelword 123-45-6789\n'),
    );
    await rows(
      admin(),
      sql`insert into app.file_texts (file_id, workspace_id, state, text, chars, reader)
          values (${fileId}, ${ws}, 'done', '', 0, 1)`,
    );
    let failed: unknown;
    // The row held, the save waits on it, and is cancelled as a statement timeout would cancel it.
    await admin().transaction(async (tx) => {
      const [{ pid }] = (await rows<{ pid: number }>(tx, sql`select pg_backend_pid() as pid`)) as [
        { pid: number },
      ];
      await rows(tx, sql`select 1 from app.file_texts where file_id = ${fileId} for update`);
      const job = runJob(fileId).catch((e: unknown) => {
        failed = e;
      });
      const waiting = await waitingOn(pid);
      await rows(admin(), sql`select pg_cancel_backend(${waiting})`);
      await job;
    });
    expect(failed).toBeInstanceOf(Error);
    const e = failed as Error;
    expect(e.message).toBe('file.save_text failed: 57014');
    expect(e.cause).toBeUndefined();
    expect(`${e.message}${e.stack ?? ''}${JSON.stringify(e)}`).not.toMatch(/cancelword|6789/i);
  });
});

/** Waits until a statement is waiting on this backend's locks, and says which backend it is. */
async function waitingOn(pid: number): Promise<number> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const [waiting] = await rows<{ pid: number }>(
      admin(),
      sql`select pid from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`,
    );
    if (waiting) return waiting.pid;
    if (Date.now() > deadline) throw new Error('nothing waited on the held row');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('the sweep', () => {
  // Files of long ago, so the sweep, oldest first across every business, reaches these before any other.
  const at = (n: number) => new Date(Date.UTC(1971, 0, 1, 0, n)).toISOString();
  const queuedFor = (ids: readonly string[]) =>
    rows<{ file_id: string; run_at: Date }>(
      admin(),
      sql`select payload ->> 'fileId' as file_id, run_at from app.scheduled_jobs
          where kind = ${FILE_TEXT_JOBS.read} and status = 'pending'
            and payload ->> 'fileId' = any(${`{${ids.join(',')}}`}::text[])`,
    );
  let old: string[] = [];

  beforeAll(async () => {
    // A run that stopped half way left its long-ago files: they'd take this run's places.
    await rows(
      admin(),
      sql`delete from app.files where created_at < '1971-02-01' and name like 'sweep-%'`,
    );
  });
  afterAll(async () => {
    if (old.length) {
      await rows(
        admin(),
        sql`delete from app.scheduled_jobs where kind = ${FILE_TEXT_JOBS.read}
            and payload ->> 'fileId' = any(${`{${old.join(',')}}`}::text[])`,
      );
      await rows(
        admin(),
        sql`delete from app.files where id = any(${`{${old.join(',')}}`}::uuid[])`,
      );
    }
  });

  it('queues only files still to read, 20 at a time over five minutes, never one that’s gone', async () => {
    const missing: string[] = [];
    for (let i = 0; i < 22; i++)
      missing.push(await fileRow({ name: `sweep-${i}.pdf`, createdAt: at(10 + i) }));
    const read = await fileRow({ name: 'sweep-read.pdf', createdAt: at(1) });
    const gone = await fileRow({ name: 'sweep-gone.pdf', createdAt: at(2), deleted: true });
    const port = await fileRow({
      name: 'sweep-port.pdf',
      type: 'port',
      record: randomUUID(),
      createdAt: at(3),
    });
    const knowledge = await fileRow({
      name: 'sweep-kb.pdf',
      type: 'knowledge',
      record: ws,
      createdAt: at(4),
    });
    old = [...missing, read, gone, port, knowledge];
    // One already read by this reader; one deleted, whose read ended with it gone.
    await rows(
      admin(),
      sql`insert into app.file_texts (file_id, workspace_id, state, text, chars, reader)
          values (${read}, ${ws}, 'done', 'Read already', 12, 1)`,
    );
    await runJob(gone);
    expect(await wordsOf(gone)).toBeUndefined();

    const before = Date.now();
    const result = await fileTextSweep({
      ...s,
      job: { payload: {} } as unknown as JobRow,
      scope: {},
      attempt: 1,
      now: before,
    });
    const queued = await queuedFor(old);
    // The 20 oldest still to read, and nothing else of these.
    expect(queued.map((q) => q.file_id).sort()).toEqual(missing.slice(0, 20).sort());
    // Spread over the next five minutes, 15 seconds apart.
    const times = queued.map((q) => new Date(q.run_at).getTime()).sort((a, b) => a - b);
    expect(times[0]! - before).toBeLessThan(60_000);
    expect(times[19]! - times[0]!).toBe(19 * 15_000);
    // A full batch comes back in ten minutes for the rest.
    expect(result!.rescheduleAt.getTime() - before).toBeGreaterThanOrEqual(10 * 60_000 - 1_000);
    expect(result!.rescheduleAt.getTime() - before).toBeLessThan(11 * 60_000);
  });

  it('comes back in a day once a run finds less than a full batch', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const few = sweepPlan([{ file_id: 'a' }, { file_id: 'b' }], now);
    expect(few.rescheduleAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect([...few.runAt.values()].map((d) => d.toISOString())).toEqual([
      '2026-10-20T12:00:00.000Z',
      '2026-10-20T12:00:15.000Z',
    ]);
    const full = sweepPlan(
      Array.from({ length: 20 }, (_, i) => ({ file_id: String(i) })),
      now,
    );
    expect(full.rescheduleAt.toISOString()).toBe('2026-10-20T12:10:00.000Z');
    expect([...full.runAt.values()].pop()!.toISOString()).toBe('2026-10-20T12:04:45.000Z');
  });
});
