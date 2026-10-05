/**
 * Real Estate Agent, round two, step 11: financing, inspections and repairs. The Closing Disclosure's deadline by the
 * federal rule's own business days; a financing step done only by a person, with proof, and its dates on the deal;
 * an inspection's first report bringing its duties; findings drafted into a repair request kept as sent; and the
 * seller's agreement bringing the duties that follow agreed repairs.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cdDeadline, repairDraft, stepWords } from '../../src/addons/realestate/closing';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  executeCommand,
  executeQuery,
  fileBeginUpload,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

describe('the Closing Disclosure’s deadline', () => {
  it('is three business days before closing, Saturdays counting, Sundays and federal holidays not', () => {
    expect(cdDeadline('2026-11-06')).toBe('2026-11-03'); // Fri → Tue
    expect(cdDeadline('2026-11-10')).toBe('2026-11-06'); // Tue: Mon, Sat, Fri
    expect(cdDeadline('2026-11-13')).toBe('2026-11-09'); // Fri: Thu, (Veterans Day), Tue, Mon
  });
});

describe('a financing step in words', () => {
  const step = {
    step: 'rate_lock' as const,
    status: 'done' as const,
    startedOn: null,
    expectedOn: null,
    doneOn: '2026-10-05',
    amountCents: null,
    rate: 6.125,
    expiresOn: '2026-11-02',
  };
  it('says what matters, and what’s wrong', () => {
    expect(stepWords(step, { closing: '2026-11-06', priceCents: null })).toEqual({
      line: '6.125% until Nov 2',
      warning: 'The lock ends before closing',
    });
    expect(
      stepWords(
        { ...step, step: 'appraisal', rate: null, expiresOn: null, amountCents: 39_500_000 },
        { closing: null, priceCents: 40_550_000 },
      ),
    ).toEqual({ line: 'Came in at $395,000', warning: '$10,500 below the price' });
  });
});

describe('the repair request draft', () => {
  it('asks for what the client didn’t skip, must-fixes first', () => {
    const d = repairDraft([
      {
        id: 'a',
        title: 'Roof flashing loose',
        location: 'Chimney',
        clientPriority: 'would_like',
        ask: 'credit',
        creditCents: 60_000,
        estimateCents: 60_000,
      },
      {
        id: 'b',
        title: 'Water heater past its life',
        location: 'Garage',
        clientPriority: 'must_fix',
        ask: 'replace',
        creditCents: null,
        estimateCents: 140_000,
      },
      {
        id: 'c',
        title: 'Worn weather stripping',
        location: 'Doors',
        clientPriority: 'skip',
        ask: 'repair',
        creditCents: null,
        estimateCents: 12_000,
      },
      {
        id: 'd',
        title: 'Hairline crack',
        location: null,
        clientPriority: null,
        ask: 'not_asked',
        creditCents: null,
        estimateCents: null,
      },
    ]);
    expect(d.items.map((i) => i.findingId)).toEqual(['b', 'a']);
    expect(d.creditCents).toBe(60_000);
    expect(d.words).toBe(
      [
        'The buyers ask the seller for the following, done by licensed professionals with receipts:',
        '- Replace: water heater past its life (garage)',
        '- A credit of $600 at closing for roof flashing loose (chimney)',
      ].join('\n'),
    );
  });
});

// ---------- on the database ----------

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const meta = (channel: 'test' | 'assistant' = 'test') => ({ correlationId: randomUUID(), channel });
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
const run = (
  name: string,
  input: Record<string, unknown>,
  channel: 'test' | 'assistant' = 'test',
): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(agent),
    meta(channel),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(agent), meta());
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
let deal: string;

/** A document on the deal, of a kind. */
async function document(kind: string, name: string): Promise<string> {
  const up = await executeCommand(
    api(),
    fileBeginUpload,
    {
      workspaceId: ws,
      recordType: 'custom_record',
      recordId: deal,
      name,
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    },
    human(agent),
    meta(),
  );
  await asUser(api(), agent.claims, (tx) =>
    rows(tx, sql`update app.files set status = 'ready' where id = ${up.output.fileId}`),
  );
  return (await run('realestate.document.add', { dealId: deal, fileId: up.output.fileId, kind }))
    .documentId;
}

const events = async () =>
  (
    await rows<{ events: string[] }>(
      admin(),
      sql`select after -> 'events' as events from addon_realestate.deal_history
          where deal_record_id = ${deal} and what = 'event'`,
    )
  ).flatMap((r) => r.events);

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rcl-owner'),
    createTestUser('rcl-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Closing Realty');
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  const client = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Linh', lastName: 'Nguyen' },
      human(agent),
      meta(),
    )
  ).output.personId;
  deal = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen purchase',
      clientPersonId: client,
      stage: 'under_contract',
    })
  ).dealId;
  await run('realestate.term.enter', { dealId: deal, key: 'closing', date: '2026-11-06' });
}, 120_000);

afterAll(closeTestDbs);

describe('financing', () => {
  it('keeps where each step stands, and is done only by a person, with proof', async () => {
    await run('realestate.financing.set_lender', {
      dealId: deal,
      lenderName: 'Summit Lending',
      officerName: 'Jo Park',
      loanType: 'conventional',
      loanAmountCents: 32_440_000,
    });
    await run('realestate.financing.update_step', {
      dealId: deal,
      step: 'appraisal',
      startedOn: '2026-10-06',
      expectedOn: '2026-10-14',
    });
    expect(
      (
        await refused(
          run('realestate.financing.mark_done', {
            dealId: deal,
            step: 'rate_lock',
            proof: { kind: 'document', id: randomUUID() },
          }),
        )
      ).rule,
    ).toBe('realestate_step_proof');
    const lock = await document('rate_lock', 'Lock confirmation.pdf');
    expect(
      (
        await refused(
          run(
            'realestate.financing.mark_done',
            { dealId: deal, step: 'rate_lock', proof: { kind: 'document', id: lock } },
            'assistant',
          ),
        )
      ).rule,
    ).toBe('forbidden');
    expect(
      await run('realestate.financing.mark_done', {
        dealId: deal,
        step: 'rate_lock',
        proof: { kind: 'document', id: lock },
        rate: 6.125,
        expiresOn: '2026-11-09',
      }),
    ).toMatchObject({ termsEntered: 1 });
    const f = await ask('realestate.financing', { dealId: deal });
    expect(f.lender).toMatchObject({ lenderName: 'Summit Lending', officerName: 'Jo Park' });
    expect(f.cdDeadline).toBe('2026-11-03');
    const byStep = Object.fromEntries(f.steps.map((s: { step: string }) => [s.step, s]));
    expect(byStep.rate_lock).toMatchObject({
      status: 'done',
      line: '6.125% until Nov 9',
      warning: null,
      proof: { kind: 'document', label: 'Lock confirmation.pdf' },
      doneBy: { id: agent.id, fullName: 'Dana Reyes' },
    });
    expect(byStep.appraisal).toMatchObject({
      status: 'in_progress',
      line: 'Ordered Oct 6 · due Oct 14',
    });
    expect(byStep.closing_disclosure.line).toBe('Must reach the buyers by Nov 3');
    const [lockEnds] = await rows<{ date: string }>(
      admin(),
      sql`select value_date::text as date from addon_realestate.term_entries
          where deal_record_id = ${deal} and key = 'rate_lock_expiry'`,
    );
    expect(lockEnds!.date).toBe('2026-11-09');
    await run('realestate.financing.reopen_step', {
      dealId: deal,
      step: 'rate_lock',
      reason: 'Lock was extended; new letter coming',
    });
    const after = await ask('realestate.financing', { dealId: deal });
    expect(after.steps.find((s: { step: string }) => s.step === 'rate_lock')).toMatchObject({
      status: 'in_progress',
      proof: null,
    });
  });
});

describe('inspections and repairs', () => {
  it('bring their duties with the first report, and the request is kept as sent', async () => {
    const { inspectionId } = await run('realestate.inspection.add', {
      dealId: deal,
      kind: 'general',
      inspector: 'Lone Star Inspections',
      scheduledAt: '2026-10-06T14:00:00Z',
    });
    for (const f of [
      {
        title: 'Water heater past its life',
        location: 'Garage',
        severity: 'safety',
        estimateCents: 140_000,
        clientPriority: 'must_fix',
        ask: 'replace',
      },
      {
        title: 'GFCI outlets missing',
        location: 'Kitchen, baths',
        severity: 'safety',
        estimateCents: 35_000,
        clientPriority: 'must_fix',
        ask: 'repair',
      },
      {
        title: 'Roof flashing loose',
        location: 'Chimney',
        severity: 'repair',
        estimateCents: 60_000,
        clientPriority: 'would_like',
        ask: 'credit',
      },
      {
        title: 'Worn weather stripping',
        location: 'Doors',
        severity: 'minor',
        estimateCents: 12_000,
        clientPriority: 'skip',
      },
    ])
      await run('realestate.finding.add', { inspectionId, ...f });
    const report = await document('inspection_report', 'General inspection.pdf');
    await run('realestate.inspection.report_in', { inspectionId, documentId: report, pages: 41 });
    expect(await events()).toContain('inspection_report');
    const view = await ask('realestate.inspections', { dealId: deal });
    expect(view.inspections[0]).toMatchObject({
      status: 'report_in',
      reportDocument: { title: 'General inspection.pdf' },
      pages: 41,
    });
    expect(view.draft).toMatchObject({ items: 3, creditCents: 60_000 });
    expect(view.draft.words).toContain('- Replace: water heater past its life (garage)');
    const sent = await run('realestate.repair.send', {
      dealId: deal,
      words: view.draft.words,
      respondBy: '2026-10-09T22:00:00Z',
    });
    expect(sent.number).toBe(1);
    await expect(
      admin().execute(
        sql`update addon_realestate.repair_requests set words = 'x' where id = ${sent.repairId}`,
      ),
    ).rejects.toThrow();
    const agreed = await run('realestate.repair.record_answer', {
      dealId: deal,
      outcome: 'agreed',
      words: 'Seller will replace the water heater and add GFCI outlets, and credit $600.',
      creditCents: 60_000,
    });
    expect(agreed.number).toBe(2);
    expect(await events()).toContain('repairs_agreed');
    const done = await ask('realestate.inspections', { dealId: deal });
    expect(
      done.repairs.map((r: { side: string; outcome: string | null }) => [r.side, r.outcome]),
    ).toEqual([
      ['us', null],
      ['them', 'agreed'],
    ]);
  });
});
