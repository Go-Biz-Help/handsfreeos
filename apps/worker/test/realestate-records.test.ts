/**
 * Real Estate round six, in the worker: a deal's records kept (a retention hold for as long as the business keeps
 * closed deals, and phones keeping it while it's open or lately ended), a field note's recording put into words,
 * and the whole transaction exported as one zip whose manifest names each file's fingerprint.
 */
import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import {
  ADDON_SERVER_MODULES,
  executeCommand,
  executeQuery,
  fileBeginUpload,
  fileConfirm,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { handlers } from '../src/handlers/index';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const realestate = ADDON_SERVER_MODULES.find((m) => m.manifest.id === 'realestate')!;
const op = (name: string) =>
  [...realestate.commands!, ...realestate.queries!].find((c) => c.name === name)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = (name: string, input: Record<string, unknown>, as: TestUser = owner): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(as),
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(owner), meta());

let s: TestServices;
let owner: TestUser;
let ws: string;
let deal: string;

/** Runs this business's events and due jobs until nothing is left (the daily records pass aside). */
async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-records-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const outbox = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()
            and kind not in ('realestate.sweep', 'realestate.records_pass')`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    if (outbox.claimed === 0 && done.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

/** A file on the deal, uploaded to storage and kept ready, as the phone leaves it. */
async function fileOn(name: string, mimeType: string, bytes: Buffer): Promise<string> {
  const up = await executeCommand(
    api(),
    fileBeginUpload,
    {
      workspaceId: ws,
      recordType: 'custom_record',
      recordId: deal,
      name,
      mimeType,
      sizeBytes: bytes.length,
    },
    human(owner),
    meta(),
  );
  await s.store.upload('attachments', up.output.objectPath, bytes, mimeType);
  await executeCommand(
    api(),
    fileConfirm,
    { workspaceId: ws, fileId: up.output.fileId },
    human(owner),
    meta(),
  );
  // Its fingerprint, taken as it arrives (handlers/file-fingerprint.ts).
  await drain();
  return up.output.fileId;
}

/** A zip's entries by name, read from its central directory. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + packed);
    out.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return out;
}

beforeAll(async () => {
  s = testServices();
  owner = await createTestUser('rr-owner', { fullName: 'Dana Reyes' });
  ws = await realestateBusiness(owner, 'Records Realty');
  deal = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Okafor purchase',
      stage: 'under_contract',
    })
  ).dealId;
  await drain();
}, 120_000);

afterAll(closeTestDbs);

const hold = async () => {
  const [h] = await rows<{ until: string | null }>(
    admin(),
    sql`select held_until::text as until from app.record_holds
        where custom_record_id = ${deal} and kind = 'retention' and lifted_at is null`,
  );
  return h ?? null;
};

describe('a deal’s records, kept', () => {
  it('are held with no end while the deal is open, and stay on phones', async () => {
    expect(await hold()).toEqual({ until: null });
    const [r] = await rows<{ on: boolean }>(
      admin(),
      sql`select sync_window as on from app.custom_records where id = ${deal}`,
    );
    expect(r!.on).toBe(true);
  });
});

describe('a field note’s recording', () => {
  it('is put into words by the transcriber, and billed as speech', async () => {
    const audio = await fileOn('Note at 12 Oak.m4a', 'audio/mp4', Buffer.from('not really audio'));
    const id = randomUUID();
    await run('realestate.field_note.add', {
      dealId: deal,
      id,
      aboutKind: 'deal',
      audioFileId: audio,
    });
    await drain();
    const note = (await ask('realestate.field_notes', { dealId: deal })).notes.find(
      (n: { id: string }) => n.id === id,
    );
    expect(note.transcriptState).toBe('done');
    expect(note.transcript).toContain('Give me a call back');
    expect(s.transcriber.asked).toContain(`field-note-${id}`);
    const [usage] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.speech_usage where workspace_id = ${ws} and ref = ${`field-note:${id}`}`,
    );
    expect(usage!.n).toBe(1);
  });
});

describe('the whole transaction, exported', () => {
  it('is one zip with every file, checked against its fingerprint, and every record', async () => {
    const pdf = Buffer.from('%PDF-1.4 purchase contract');
    const contract = await fileOn('Purchase contract.pdf', 'application/pdf', pdf);
    await run('realestate.document.add', {
      dealId: deal,
      fileId: contract,
      kind: 'contract',
      title: 'Purchase contract',
    });
    await run('realestate.term.enter', { dealId: deal, key: 'closing', date: '2026-11-06' });
    const asked = await run('realestate.deal.export', { dealId: deal });
    expect(asked.state).toBe('building');
    // Asked again while it builds: the same one.
    expect((await run('realestate.deal.export', { dealId: deal })).exportId).toBe(asked.exportId);
    await drain();
    const [x] = (await ask('realestate.exports', { dealId: deal })).exports;
    expect(x).toMatchObject({ id: asked.exportId, state: 'ready', failure: null });
    expect(x.counts.term_entries).toBeGreaterThan(0);
    const [f] = await rows<{
      bucket: string;
      object_path: string;
      name: string;
      mime_type: string;
    }>(
      admin(),
      sql`select bucket, object_path, name, mime_type from app.files where id = ${x.fileId}`,
    );
    expect(f).toMatchObject({ mime_type: 'application/zip' });
    expect(f!.name).toMatch(/^Okafor purchase transaction \d{4}-\d{2}-\d{2}\.zip$/);
    const zip = unzip(await s.store.download(f!.bucket, f!.object_path));
    const manifest = JSON.parse(zip.get('manifest.json')!.toString('utf8'));
    expect(manifest).toMatchObject({ format: 'hfos.transaction-export', version: 1 });
    expect(createHash('sha256').update(zip.get('manifest.json')!).digest('hex')).toBe(
      x.manifestSha256,
    );
    const listed = manifest.files.find((e: { fileId: string }) => e.fileId === contract);
    expect(listed).toMatchObject({
      path: 'files/documents/Purchase contract (Purchase contract.pdf)',
      sha256: createHash('sha256').update(pdf).digest('hex'),
      matchesStored: true,
      document: { kind: 'contract', title: 'Purchase contract' },
    });
    expect(zip.get(listed.path)!.equals(pdf)).toBe(true);
    expect(zip.has('README.html')).toBe(true);
    expect(JSON.parse(zip.get('data/deals.json')!.toString('utf8'))[0].record_id).toBe(deal);
    // Audit lines keep who and when, never where from.
    const audit = JSON.parse(zip.get('data/core/audit.json')!.toString('utf8')) as Record<
      string,
      unknown
    >[];
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => !('ip' in a) && !('user_agent' in a))).toBe(true);
    // The person who asked hears it's ready.
    const [alert] = await rows<{ title: string }>(
      admin(),
      sql`select title from app.addon_alerts where workspace_id = ${ws} and key = ${`export:${asked.exportId}`}`,
    );
    expect(alert!.title).toBe('The whole transaction for Okafor purchase is ready');
  });
});
