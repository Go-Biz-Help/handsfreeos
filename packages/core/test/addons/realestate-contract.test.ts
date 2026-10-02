/**
 * Real Estate Agent, round four, step 2: reading contracts and amendments (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md,
 * "Round four"). The pure checks first (a date stated in the words, a value on its page, a date counted from another
 * with the business's calendar), then on the database: a contract PDF read on its own, its values waiting for a person
 * beside what counts now, confirmed onto the key dates with their words, an amendment showing what it moves before
 * anyone confirms it, and a reading that failed or was set aside.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkedContractRead,
  contractReadPrompt,
  dateStatedIn,
  type ContractReadAnswer,
} from '../../src/addons/realestate/contract-read';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  executeCommand,
  executeQuery,
  fileBeginUpload,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

const window = { from: '2026-08-01', to: '2027-12-31' };

describe('a date stated in the words', () => {
  it('finds it written out, abbreviated, as numbers or as “the 10th day of”', () => {
    expect(dateStatedIn('2026-10-10', 'on or before October 10, 2026', window)).toBe(true);
    expect(dateStatedIn('2026-10-10', 'closing on Oct. 10, 2026', window)).toBe(true);
    expect(dateStatedIn('2026-10-10', 'Closing: 10/10/2026', window)).toBe(true);
    expect(dateStatedIn('2026-10-10', 'Closing: 10/10/26', window)).toBe(true);
    expect(dateStatedIn('2026-10-10', 'on the 10th day of October, 2026', window)).toBe(true);
    expect(dateStatedIn('2026-09-24', 'Effective Date: Sept 24', window)).toBe(true);
  });

  it('never takes a different day, month or year, or a year it had to guess far from now', () => {
    expect(dateStatedIn('2026-10-11', 'on or before October 10, 2026', window)).toBe(false);
    expect(dateStatedIn('2027-10-10', 'on or before October 10, 2026', window)).toBe(false);
    expect(dateStatedIn('2026-11-10', 'Closing: 10/10/2026', window)).toBe(false);
    expect(dateStatedIn('2029-10-10', 'on October 10', window)).toBe(false);
    expect(dateStatedIn('2026-10-10', 'within 10 days', window)).toBe(false);
  });
});

const pages = [
  [
    'ONE TO FOUR FAMILY RESIDENTIAL CONTRACT',
    '§1 Buyer: Jamie Smith and Chris Smith',
    '§1 Seller: Robert Okafor',
    '§3 Sales Price: $412,000',
    '§5 Earnest Money: $5,000, delivered within 3 days after the Effective Date',
  ].join('\n'),
  [
    '§5B Option Period: within 9 days after the Effective Date',
    '§9 Closing Date: on or before October 30, 2026',
    '§10 Possession: at closing and funding',
    'Effective Date: September 24, 2026',
  ].join('\n'),
];

const v = (
  key: ContractReadAnswer['values'][number]['key'],
  quote: string,
  more: Partial<ContractReadAnswer['values'][number]> = {},
): ContractReadAnswer['values'][number] => ({
  key,
  date: null,
  days_after: null,
  dollars: null,
  words: null,
  clause: null,
  page: 1,
  quote,
  ...more,
});

describe('a contract’s values, checked', () => {
  const ctx = { side: 'buyer' as const, pages, pageCount: 2, known: {}, today: '2026-09-25' };

  it('keeps what’s in the words, on the page it’s really on, and works out counted dates', () => {
    const read = checkedContractRead(
      {
        values: [
          v('price', '§3 Sales Price: $412,000', { dollars: 412000, clause: '§3' }),
          v('emd_amount', 'Earnest Money: $5,000', { dollars: 5000 }),
          // Counted from the Effective Date, which comes later in the answer.
          v('emd_due', 'within 3 days after the Effective Date', {
            days_after: { days: 3, business: false, from: 'acceptance' },
          }),
          // The model said page 1; it's on page 2.
          v('inspection_end', 'within 9 days after the Effective Date', {
            page: 1,
            days_after: { days: 9, business: false, from: 'acceptance' },
          }),
          v('closing', 'on or before October 30, 2026', { date: '2026-10-30', page: 2 }),
          v('possession', 'at closing and funding', {
            page: 2,
            days_after: { days: 0, business: false, from: 'closing' },
          }),
          v('acceptance', 'Effective Date: September 24, 2026', { date: '2026-09-24', page: 2 }),
          v('buyer_names', 'Buyer: Jamie Smith and Chris Smith', {
            words: 'Jamie Smith and Chris Smith',
          }),
        ],
        unclear: [],
      },
      ctx,
    );
    expect(read.dropped).toBe(0);
    const by = Object.fromEntries(read.values.map((x) => [x.key, x]));
    expect(by['price']).toMatchObject({ cents: 41_200_000, clause: '§3', page: 1 });
    expect(by['acceptance']).toMatchObject({ date: '2026-09-24', page: 2, worked: null });
    expect(by['emd_due']).toMatchObject({
      date: '2026-09-27',
      worked: { days: 3, business: false, from: 'acceptance', fromDate: '2026-09-24' },
    });
    expect(by['inspection_end']).toMatchObject({ date: '2026-10-03', page: 2 });
    expect(by['possession']!.date).toBe('2026-10-30');
    expect(by['buyer_names']!.text).toBe('Jamie Smith and Chris Smith');
    // In the catalogue's order, whatever order the model answered in.
    expect(read.values[0]!.key).toBe('acceptance');
  });

  it('drops what isn’t in the words, or doesn’t say its number, and never fixes it', () => {
    const read = checkedContractRead(
      {
        values: [
          v('price', 'Sales Price: $415,000', { dollars: 415000 }),
          v('emd_amount', 'Earnest Money: $5,000', { dollars: 6000 }),
          v('closing', 'on or before October 30, 2026', { date: '2026-10-31', page: 2 }),
          v('seller_names', 'Seller: Robert Okafor', { words: 'Elaine Okafor' }),
          v('inspection_end', 'within 9 days after the Effective Date', {
            page: 2,
            days_after: { days: 10, business: false, from: 'acceptance' },
          }),
          v('price', '§3 Sales Price: $412,000', { dollars: 412000 }),
        ],
        unclear: [],
      },
      ctx,
    );
    expect(read.values.map((x) => x.key)).toEqual(['price']);
    expect(read.dropped).toBe(5);
  });

  it('counts business days with the business’s calendar, and lists one counted from a date nobody knows', () => {
    const read = checkedContractRead(
      {
        values: [
          v('financing_end', 'within 3 business days after the Effective Date', {
            days_after: { days: 3, business: true, from: 'acceptance' },
          }),
          v('appraisal_end', 'within 5 days after the Closing Date', {
            days_after: { days: 5, business: false, from: 'closing' },
          }),
        ],
        unclear: [
          { what: 'Survey: within a reasonable time', clause: '§6C', page: 2, quote: null },
        ],
      },
      {
        side: 'buyer',
        pages: [
          'within 3 business days after the Effective Date\nwithin 5 days after the Closing Date',
        ],
        pageCount: 1,
        // Friday Oct 2: the 3 business days run Mon to Wed, and Monday the 5th is closed.
        known: { acceptance: '2026-10-02' },
        calendar: { closedDays: new Map([['2026-10-05', 'Office retreat']]) },
        today: '2026-10-02',
      },
    );
    expect(read.values).toHaveLength(1);
    expect(read.values[0]).toMatchObject({ key: 'financing_end', date: '2026-10-08' });
    expect(read.unclear.map((u) => u.what)).toEqual([
      'Appraisal contingency ends: 5 days after the closing, which isn’t known yet.',
      'Survey: within a reasonable time',
    ]);
  });

  it('reads a scan’s values without words to check, numbers still in their own quote', () => {
    const read = checkedContractRead(
      {
        values: [
          v('closing', 'The Closing Date is changed to November 4, 2026.', { date: '2026-11-04' }),
          v('seller_credit', 'Seller shall pay $3,500 toward Buyer’s costs.', { dollars: 3500 }),
          v('price', 'Sales Price: $412,000', { dollars: 421000, page: 9 }),
        ],
        unclear: [],
      },
      { side: 'buyer', pages: null, pageCount: 1, known: {}, today: '2026-10-01' },
    );
    expect(read.values.map((x) => [x.key, x.page])).toEqual([
      ['closing', 1],
      ['seller_credit', 1],
    ]);
    expect(read.dropped).toBe(1);
  });

  it('puts each page in its own tag, and says when a long one wasn’t all sent', () => {
    const { prompt, unread } = contractReadPrompt('amendment', ['a <b>', 'c']);
    expect(prompt).toContain('This document is an amendment to the contract.');
    expect(prompt).toContain('<page n="1">\na &lt;b&gt;\n</page>');
    expect(prompt.endsWith('Read the contract’s terms.')).toBe(true);
    expect(unread).toBeNull();
    expect(contractReadPrompt('contract', ['x'.repeat(149_000), 'y'.repeat(2_000)]).unread).toBe(2);
  });
});

// ---------- on the database ----------

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const op = (name: string) =>
  [...realestateAddonServer.commands!, ...realestateAddonServer.queries!].find(
    (x) => x.name === name,
  )!;
const run = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(who),
    meta(),
  ).then((r) => r.output);
const system = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    worker(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    { type: 'system', workspaceId: ws, organizationId: org },
    { correlationId: randomUUID(), channel: 'worker' },
  ).then((r) => r.output);
const ask = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(who), meta());
async function refused(p: Promise<unknown>): Promise<{ rule: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { rule?: string; code?: string; message: string };
    return { rule: err.rule ?? err.code ?? '', message: err.message };
  }
  throw new Error('It was allowed.');
}

let owner: TestUser;
let agent: TestUser;
let ws: string;
let org: string;
let deal: string;

/** A file on the deal, uploaded. */
async function fileOn(dealId: string, name: string, mimeType = 'application/pdf') {
  const up = await executeCommand(
    api(),
    fileBeginUpload,
    {
      workspaceId: ws,
      recordType: 'custom_record',
      recordId: dealId,
      name,
      mimeType,
      sizeBytes: 2048,
    },
    human(agent),
    meta(),
  );
  await asUser(api(), agent.claims, (tx) =>
    rows(tx, sql`update app.files set status = 'ready' where id = ${up.output.fileId}`),
  );
  return up.output.fileId as string;
}

const readsOf = (documentId: string) =>
  rows<{ id: string; state: string }>(
    admin(),
    sql`select id, state from addon_realestate.contract_reads where document_id = ${documentId}
        order by requested_at`,
  );

const value = (key: string, more: Record<string, unknown>) => ({
  key,
  date: null,
  cents: null,
  text: null,
  worked: null,
  clause: null,
  page: 1,
  quote: `The ${key} words`,
  ...more,
});

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rec-owner'),
    createTestUser('rec-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Contract Realty');
  const [w] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  );
  org = w!.organization_id;
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  deal = (
    await run(agent, 'realestate.deal.open', {
      side: 'buyer',
      name: 'Smith purchase',
      stage: 'under_contract',
    })
  ).dealId;
}, 90_000);

afterAll(closeTestDbs);

describe('Reading a contract', () => {
  let contract: string;
  let readId: string;

  it('starts on its own when a contract PDF is added, and only for PDFs', async () => {
    // The accepted offer's terms, not confirmed: what the contract is checked against.
    await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'closing',
      date: '2026-10-28',
      source: 'contract',
      confirm: false,
    });
    const added = await run(agent, 'realestate.document.add', {
      dealId: deal,
      fileId: await fileOn(deal, 'smith-contract-signed.pdf'),
      kind: 'contract',
      title: 'Smith contract',
    });
    contract = added.documentId;
    const reads = await readsOf(contract);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.state).toBe('reading');
    readId = reads[0]!.id;
    // Asked again while it's reading: the same reading.
    const again = await run(agent, 'realestate.document.read', { documentId: contract });
    expect(again.readId).toBe(readId);
    // A photo of a page isn't a PDF: added, never read, and asking says why.
    const photo = await run(agent, 'realestate.document.add', {
      dealId: deal,
      fileId: await fileOn(deal, 'page-3.jpg', 'image/jpeg'),
      kind: 'addendum',
      title: 'Page 3',
    });
    expect(await readsOf(photo.documentId)).toHaveLength(0);
    expect(
      (await refused(run(agent, 'realestate.document.read', { documentId: photo.documentId })))
        .rule,
    ).toBe('realestate_read_not_pdf');
    // An inspection report isn't read.
    const report = await run(agent, 'realestate.document.add', {
      dealId: deal,
      fileId: await fileOn(deal, 'inspection.pdf'),
      kind: 'inspection_report',
    });
    expect(await readsOf(report.documentId)).toHaveLength(0);
    expect(
      (await refused(run(agent, 'realestate.document.read', { documentId: report.documentId })))
        .rule,
    ).toBe('realestate_read_kind');
  });

  it('records what the worker found, for a person only to confirm', async () => {
    expect(
      (await refused(run(agent, 'realestate.contract.read_done', { readId, values: [] }))).rule,
    ).toBeTruthy();
    const done = await system('realestate.contract.read_done', {
      readId,
      values: [
        value('acceptance', { date: '2026-09-24', clause: 'Signature page', page: 9 }),
        value('price', { cents: 41_200_000, clause: '§3C' }),
        value('inspection_end', {
          date: '2026-10-03',
          clause: '§5B',
          page: 2,
          worked: { days: 9, business: false, from: 'acceptance', fromDate: '2026-09-24' },
        }),
        value('closing', { date: '2026-10-30', clause: '§9A', page: 5 }),
      ],
      unclear: [{ what: 'Survey: within a reasonable time', quote: null, page: 3, clause: '§6C' }],
      dropped: 1,
      pages: 9,
      model: 'scripted',
    });
    expect(done.state).toBe('read');
    // Once only.
    expect((await system('realestate.contract.read_done', { readId, values: [] })).state).toBe(
      'skipped',
    );
    const read = await ask(agent, 'realestate.contract.read', { readId });
    expect(read).toMatchObject({
      state: 'read',
      scan: false,
      pages: 9,
      dropped: 1,
      kind: 'contract',
    });
    const closing = read.values.find((x: Any) => x.key === 'closing');
    expect(closing).toMatchObject({
      value: 'Oct 30, 2026',
      now: 'Oct 28, 2026',
      nowFrom: 'the contract, not confirmed',
      same: false,
      state: 'waiting',
      clause: '§9A',
      page: 5,
    });
    expect(read.values.find((x: Any) => x.key === 'inspection_end').worked).toBe(
      '9 days after the contract accepted (Sep 24, 2026)',
    );
    expect(read.unclear).toHaveLength(1);
    // Nothing on the deal changed.
    const [entries] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_realestate.term_entries where deal_record_id = ${deal}`,
    );
    expect(entries!.n).toBe(1);
    const list = await ask(agent, 'realestate.contract.reads', { dealId: deal });
    expect(list.reads[0]).toMatchObject({ readId, waiting: 4, confirmed: 0, unclear: 1 });
  });

  it('puts each confirmed value on the key dates with its words, replacing what was there', async () => {
    const one = await run(agent, 'realestate.contract.confirm', {
      readId,
      valueIds: [
        (await ask(agent, 'realestate.contract.read', { readId })).values.find(
          (x: Any) => x.key === 'acceptance',
        ).id,
      ],
    });
    expect(one.confirmed).toBe(1);
    const rest = await run(agent, 'realestate.contract.confirm', { readId });
    expect(rest.confirmed).toBe(3);
    // Confirmed already: nothing more.
    expect((await run(agent, 'realestate.contract.confirm', { readId })).confirmed).toBe(0);
    const live = await rows<{
      key: string;
      value: string | null;
      source: string;
      source_ref: string | null;
      quote: string | null;
      page: number | null;
      read_id: string | null;
      confirmed: boolean;
    }>(
      admin(),
      sql`select key, coalesce(value_date::text, value_cents::text) as value, source, source_ref, quote, page, read_id,
            confirmed_at is not null as confirmed
          from addon_realestate.term_entries
          where deal_record_id = ${deal} and superseded_at is null and rejected_at is null order by key`,
    );
    expect(live.find((e) => e.key === 'closing')).toEqual({
      key: 'closing',
      value: '2026-10-30',
      source: 'contract',
      source_ref: '§9A, page 5',
      quote: 'The closing words',
      page: 5,
      read_id: readId,
      confirmed: true,
    });
    expect(live.map((e) => e.key)).toEqual(['acceptance', 'closing', 'inspection_end', 'price']);
    // The offer's closing is kept, replaced.
    const [old] = await rows<{ superseded: boolean }>(
      admin(),
      sql`select superseded_at is not null as superseded from addon_realestate.term_entries
          where deal_record_id = ${deal} and key = 'closing' and value_date = '2026-10-28'`,
    );
    expect(old!.superseded).toBe(true);
    const read = await ask(agent, 'realestate.contract.read', { readId });
    expect(
      read.values.every((x: Any) => x.state === 'confirmed' && x.decidedByName === 'Dana Reyes'),
    ).toBe(true);
    expect(read.moves).toEqual([]);
    // Proof for the contract timeline.
    const proof = await rows<{ duty_key: string }>(
      admin(),
      sql`select d.duty_key from addon_realestate.duty_evidence e
          join addon_realestate.duties d on d.id = e.duty_id
          where e.deal_record_id = ${deal} and e.ref_kind = 'contract_read' and e.ref_id = ${readId}`,
    );
    expect(proof.map((p) => p.duty_key)).toContain('X-15');
  });

  it('shows what an amendment moves before anyone confirms it, then moves it', async () => {
    const amendment = await run(agent, 'realestate.document.add', {
      dealId: deal,
      fileId: await fileOn(deal, 'amendment-1.pdf'),
      kind: 'amendment',
      title: 'Amendment 1',
    });
    const [r] = await readsOf(amendment.documentId);
    await system('realestate.contract.read_done', {
      readId: r!.id,
      values: [
        value('closing', { date: '2026-11-04', clause: '¶2' }),
        value('seller_credit', { cents: 350_000, clause: '¶4' }),
      ],
      scan: true,
      pages: 1,
    });
    const read = await ask(agent, 'realestate.contract.read', { readId: r!.id });
    expect(read.scan).toBe(true);
    expect(read.values.find((x: Any) => x.key === 'closing')).toMatchObject({
      now: 'Oct 30, 2026',
      nowFrom: 'the contract',
      same: false,
    });
    expect(read.moves.length).toBeGreaterThan(0);
    const closingDuty = read.moves.find((m: Any) => m.title === 'Final walkthrough workspace');
    expect(closingDuty).toMatchObject({ from: 'Oct 29', to: 'Nov 3', why: '1 day before closing' });
    const before = await rows<{ due_date: string | null }>(
      admin(),
      sql`select due_date::text from addon_realestate.duties where id = ${closingDuty.dutyId}`,
    );
    expect(before[0]!.due_date).toBe('2026-10-29');
    const done = await run(agent, 'realestate.contract.confirm', { readId: r!.id });
    expect(done.dutiesRedated).toBeGreaterThan(0);
    const after = await rows<{ due_date: string | null }>(
      admin(),
      sql`select due_date::text from addon_realestate.duties where id = ${closingDuty.dutyId}`,
    );
    expect(after[0]!.due_date).toBe('2026-11-03');
    const [closing] = await rows<{ source: string; scan: boolean }>(
      admin(),
      sql`select source, scan from addon_realestate.term_entries
          where deal_record_id = ${deal} and key = 'closing' and superseded_at is null`,
    );
    expect(closing).toEqual({ source: 'amendment', scan: true });
    const history = await rows<{ what: string }>(
      admin(),
      sql`select what from addon_realestate.deal_history where deal_record_id = ${deal} order by at`,
    );
    expect(history.map((h) => h.what)).toEqual(
      expect.arrayContaining(['contract_read', 'contract_confirmed', 'event']),
    );
  });

  it('sets aside a wrong value with why, and a reading done again replaces what waited', async () => {
    const again = await run(agent, 'realestate.document.read', { documentId: contract });
    expect(again.readId).not.toBe(readId);
    await system('realestate.contract.read_done', {
      readId: again.readId,
      values: [
        value('emd_amount', { cents: 500_000 }),
        value('loan_type', { text: 'Conventional' }),
      ],
    });
    const read = await ask(agent, 'realestate.contract.read', { readId: again.readId });
    const emd = read.values.find((x: Any) => x.key === 'emd_amount');
    await run(agent, 'realestate.contract.reject_value', {
      readId: again.readId,
      valueId: emd.id,
      reason: 'It’s $6,000 on page 2.',
    });
    expect(
      (
        await refused(
          run(agent, 'realestate.contract.reject_value', {
            readId: again.readId,
            valueId: emd.id,
            reason: 'Again',
          }),
        )
      ).rule,
    ).toBe('realestate_value_decided');
    // The first reading says a newer one exists.
    expect((await ask(agent, 'realestate.contract.read', { readId })).newerReadId).toBe(
      again.readId,
    );
    // Read a third time: what still waited in the second is set aside.
    const third = await run(agent, 'realestate.document.read', { documentId: contract });
    await system('realestate.contract.read_done', {
      readId: third.readId,
      values: [value('loan_type', { text: 'Conventional' })],
    });
    const second = await ask(agent, 'realestate.contract.read', { readId: again.readId });
    expect(second.values.map((x: Any) => [x.key, x.state, x.reason])).toEqual([
      ['emd_amount', 'rejected', 'It’s $6,000 on page 2.'],
      ['loan_type', 'rejected', 'Read again.'],
    ]);
  });

  it('says why a reading failed, and nothing confirms from it', async () => {
    const again = await run(agent, 'realestate.document.read', { documentId: contract });
    await system('realestate.contract.read_done', {
      readId: again.readId,
      failure: 'The AI is busy right now. Try again in a minute.',
    });
    const read = await ask(agent, 'realestate.contract.read', { readId: again.readId });
    expect(read).toMatchObject({
      state: 'failed',
      failure: 'The AI is busy right now. Try again in a minute.',
    });
    expect(
      (await refused(run(agent, 'realestate.contract.confirm', { readId: again.readId }))).rule,
    ).toBe('realestate_read_not_ready');
    // Finding nothing at all is a failure too, in words that say what to do.
    const nothing = await run(agent, 'realestate.document.read', { documentId: contract });
    await system('realestate.contract.read_done', { readId: nothing.readId, values: [] });
    expect((await ask(agent, 'realestate.contract.read', { readId: nothing.readId })).failure).toBe(
      'The AI didn’t find any terms in “Smith contract”. Enter the key dates yourself, or read it again.',
    );
  });

  it('keeps a reading to the people on its deal', async () => {
    const stranger = await createTestUser('rec-stranger');
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: stranger.id, role: 'member' });
    expect((await refused(ask(stranger, 'realestate.contract.read', { readId }))).rule).toBe(
      'not_found',
    );
    void owner;
  });
});
