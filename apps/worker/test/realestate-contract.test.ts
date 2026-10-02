/**
 * Real Estate Agent, round four, in the worker (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round four"): a
 * contract added to a deal is read from its words by the model (the stand-in here), every value checked against
 * them, and left for a person, who hears while values wait. A scan goes to the model as its pages, and says so. A
 * file that isn't a PDF, or is too big, says why it wasn't read.
 */
import { randomUUID } from 'node:crypto';
import type { AiRequest, ScriptRule } from '@hfos/ai';
import {
  ADDON_SERVER_MODULES,
  executeCommand,
  executeQuery,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { standInMedia, testServices, type TestServices } from './helpers';
import { textPdf } from './pdf-maker';

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
const run = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(agent),
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(agent), meta());

/** What the stand-in was sent for a scan, and what it reads there: the new closing date. */
let scanAsked: AiRequest | null = null;
const RULES: ScriptRule[] = [
  {
    when: /It’s a scan[\s\S]*Read the contract’s terms\.$/,
    json: (_q, _c, request) => {
      scanAsked = request;
      return {
        values: [
          {
            key: 'closing',
            date: '2026-11-04',
            days_after: null,
            dollars: null,
            words: null,
            clause: '¶2',
            page: 1,
            quote: 'The Closing Date is changed to November 4, 2026.',
          },
        ],
        unclear: [],
      };
    },
  },
];

const media = standInMedia();
const handlers = withAddons({});
const jobs = { ...addonJobs };

let s: TestServices;
let agent: TestUser;
let ws: string;
let deal: string;

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-contract-${randomUUID().slice(0, 8)}`;
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
            and kind <> 'realestate.sweep'`,
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

/** A PDF uploaded to the deal and stored, as the files screen leaves it. Its file's id. */
async function pdfOn(name: string, bytes: Buffer, sizeBytes = bytes.length): Promise<string> {
  const path = `${ws}/${randomUUID()}/${name}`;
  await media.store.upload('attachments', path, bytes, 'application/pdf');
  const [f] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, size_bytes,
          status, created_by)
        values (${ws}, 'custom_record', ${deal}, ${path}, ${name}, 'application/pdf', ${sizeBytes}, 'ready',
          ${agent.id})
        returning id`,
  );
  return f!.id;
}

const add = (fileId: string, kind: string, title: string) =>
  run('realestate.document.add', { dealId: deal, fileId, kind, title });
const readOf = async (documentId: string) => {
  const [r] = await rows<{ id: string }>(
    admin(),
    sql`select id from addon_realestate.contract_reads where document_id = ${documentId}
        order by requested_at desc limit 1`,
  );
  return ask('realestate.contract.read', { readId: r!.id });
};
const alertOf = async (readId: string) =>
  (
    await rows<{ title: string; cleared: boolean }>(
      admin(),
      sql`select title, cleared_at is not null as cleared from app.addon_alerts
          where workspace_id = ${ws} and key = ${`read:${readId}`}`,
    )
  )[0];

beforeAll(async () => {
  s = {
    ...testServices({ ai: { provider: scriptedAi(RULES), dailyTokens: 5_000_000 } }),
    store: media.store,
  };
  agent = await createTestUser('rec-worker-agent', { fullName: 'Dana Reyes' });
  ws = await realestateBusiness(agent, 'Contract Worker Realty');
  deal = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Smith purchase',
      stage: 'under_contract',
    })
  ).dealId;
}, 90_000);

afterAll(closeTestDbs);

describe('a contract read from its words', () => {
  it('finds each value on its page, works out counted dates, and waits for a person', async () => {
    const pdf = textPdf([
      [
        'ONE TO FOUR FAMILY RESIDENTIAL CONTRACT (RESALE)',
        '§1 Buyer: Jamie Smith and Chris Smith',
        '§1 Seller: Robert Okafor',
        '§3 Sales Price: $412,000',
        '§5 Earnest Money: $5,000 delivered within 3 days after the Effective Date',
      ],
      [
        '§5B Option Period: within 9 days after the Effective Date',
        '§6C Survey: within a reasonable time',
        '§9 Closing Date: October 30, 2026',
        '§10 Possession: at closing and funding',
        'Effective Date: September 24, 2026',
      ],
    ]);
    const doc = await add(await pdfOn('smith-contract.pdf', pdf), 'contract', 'Smith contract');
    await drain();
    const read = await readOf(doc.documentId);
    expect(read).toMatchObject({ state: 'read', scan: false, pages: 2, failure: null });
    const by = Object.fromEntries(read.values.map((v: Any) => [v.key, v]));
    expect(Object.keys(by).sort()).toEqual(
      [
        'acceptance',
        'buyer_names',
        'closing',
        'emd_amount',
        'emd_due',
        'inspection_end',
        'possession',
        'price',
        'seller_names',
      ].sort(),
    );
    expect(by['price']).toMatchObject({
      value: '$412,000',
      clause: '§3',
      page: 1,
      state: 'waiting',
    });
    expect(by['emd_due']).toMatchObject({
      date: '2026-09-27',
      worked: '3 days after the contract accepted (Sep 24, 2026)',
    });
    expect(by['inspection_end']).toMatchObject({ date: '2026-10-03', page: 2 });
    expect(by['possession'].date).toBe('2026-10-30');
    expect(by['buyer_names'].value).toBe('Jamie Smith and Chris Smith');
    expect(read.unclear.map((u: Any) => [u.clause, u.page])).toEqual([['§6C', 2]]);
    // Its agent hears, until no value waits.
    const alert = await alertOf(read.readId);
    expect(alert).toEqual({
      title: 'Smith purchase: 9 values from “Smith contract” to confirm',
      cleared: false,
    });
    await run('realestate.contract.confirm', { readId: read.readId });
    await drain();
    expect((await alertOf(read.readId))!.cleared).toBe(true);
  });
});

describe('a scan', () => {
  it('goes to the model as its pages, and every value says it was read from a scan', async () => {
    const scan = textPdf([[]]);
    const doc = await add(await pdfOn('amendment-1.pdf', scan), 'amendment', 'Amendment 1');
    await drain();
    const read = await readOf(doc.documentId);
    expect(read).toMatchObject({ state: 'read', scan: true, pages: 1 });
    expect(read.values.map((v: Any) => [v.key, v.value, v.now])).toEqual([
      ['closing', 'Nov 4, 2026', 'Oct 30, 2026'],
    ]);
    const sent = scanAsked!.messages[0]!.content as Any[];
    expect(sent[0]).toMatchObject({
      type: 'document',
      mediaType: 'application/pdf',
      title: 'Amendment 1',
      pages: 1,
      data: scan.toString('base64'),
    });
    expect(sent[1].text).toContain('It’s a scan');
    expect((await alertOf(read.readId))!.title).toBe(
      'Smith purchase: 1 value from “Amendment 1” to confirm',
    );
  });
});

describe('a document that can’t be read', () => {
  it('says why: not really a PDF, or too big', async () => {
    const broken = await add(
      await pdfOn('addendum.pdf', Buffer.from('%PDF-1.4 not really a PDF')),
      'addendum',
      'Addendum A',
    );
    const big = await add(
      await pdfOn('huge.pdf', textPdf([['x']]), 30 * 1024 * 1024),
      'addendum',
      'Huge addendum',
    );
    await drain();
    expect((await readOf(broken.documentId)).failure).toBe(
      '“Addendum A” couldn’t be opened as a PDF. Save it again as a PDF, add that to the deal, and it’s read on its own.',
    );
    const tooBig = await readOf(big.documentId);
    expect(tooBig.state).toBe('failed');
    expect(tooBig.failure).toContain('over 25 MB');
    expect((await alertOf(tooBig.readId))!.title).toBe(
      'Smith purchase: “Huge addendum” couldn’t be read',
    );
  });
});
