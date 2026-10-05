/**
 * Real Estate Agent, round four, step 3: contingencies (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round four").
 * The pure parts first (where one stands against today, its words, the health reasons round four adds), then on the
 * database: one tracked as soon as its end date is entered, one the agent names, how one ended recorded with the
 * signed form or by an owner with a reason, the sweep's card for one past its end, and the client's view.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contingencyClock,
  contingencyMeaning,
  contingencyOfKey,
  contingencyStateWords,
} from '../../src/addons/realestate/contingencies';
import { healthOf, type HealthDuty, type HealthInput } from '../../src/addons/realestate/health';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  executeCommand,
  executeQuery,
  fileBeginUpload,
  localDateOf,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
  type CommandDef,
  type CustomerActor,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { addDays } from '../../src/calendar/engine/zoned';
import { realestateBusiness } from './realestate-fixture';

describe('a contingency against today', () => {
  it('is open, ending within two business days, past, or has no date yet', () => {
    // Friday Oct 2: Monday and Tuesday are the next two business days.
    expect(contingencyClock('2026-10-06', '2026-10-02')).toBe('ending');
    expect(contingencyClock('2026-10-07', '2026-10-02')).toBe('open');
    expect(contingencyClock('2026-10-02', '2026-10-02')).toBe('ending');
    expect(contingencyClock('2026-10-01', '2026-10-02')).toBe('passed');
    expect(contingencyClock(null, '2026-10-02')).toBe('unknown');
  });

  it('says where it stands, and what it is for whoever reads it', () => {
    expect(contingencyStateWords({ state: 'open' }, '2026-10-08', '2026-10-02')).toBe(
      'Open · ends Oct 8',
    );
    expect(contingencyStateWords({ state: 'open' }, '2026-10-02', '2026-10-02')).toBe('Ends today');
    expect(contingencyStateWords({ state: 'open' }, '2026-09-30', '2026-10-02')).toBe(
      'Ended Sep 30, nothing recorded',
    );
    expect(
      contingencyStateWords(
        { state: 'waived', resolvedOn: '2026-09-28' },
        '2026-10-03',
        '2026-10-02',
      ),
    ).toBe('Waived Sep 28');
    expect(contingencyStateWords({ state: 'open' }, null, '2026-10-02')).toBe(
      'End date not entered',
    );
    expect(contingencyMeaning('financing', 'buyer')).toBe('Time for your loan to be approved.');
    expect(contingencyMeaning('financing', 'listing')).toBe(
      'Time for the buyer’s loan to be approved.',
    );
    expect(contingencyOfKey('hoa_review_end')).toBe('hoa');
    expect(contingencyOfKey('closing')).toBeNull();
  });
});

const duty = (over: Partial<HealthDuty> = {}): HealthDuty => ({
  id: randomUUID(),
  key: 'B-20',
  title: 'Attend inspection',
  status: 'not_started',
  materiality: 'standard',
  dueAt: null,
  dueDate: null,
  dueState: 'none',
  needsDates: [],
  accountableRole: 'agent',
  accountableUserId: randomUUID(),
  blocker: null,
  ...over,
});
const base = (over: Partial<HealthInput>): HealthInput => ({
  duties: [],
  keyDates: {},
  conflicts: [],
  dateProblems: [],
  now: Date.parse('2026-10-02T15:00:00Z'),
  today: '2026-10-02',
  ...over,
});
const codes = (i: HealthInput) => healthOf(i).reasons.map((r) => `${r.level}:${r.code}`);

describe('round four’s health reasons', () => {
  it('reds a contingency past its end, yellows one ending, and counts read values waiting', () => {
    expect(
      codes(
        base({
          contingencies: [
            { id: randomUUID(), label: 'Financing', end: '2026-10-01' },
            { id: randomUUID(), label: 'Inspection', end: '2026-10-05' },
            { id: randomUUID(), label: 'Appraisal', end: '2026-10-20' },
            { id: randomUUID(), label: 'Title review', end: null },
          ],
          readsWaiting: 3,
        }),
      ),
    ).toEqual(['red:contingency_passed', 'yellow:contingency_ending', 'yellow:read_waiting']);
    const h = healthOf(base({ readsWaiting: 1 }));
    expect(h.reasons[0]!.words).toBe(
      '1 value read from the deal’s contracts waits to be confirmed.',
    );
  });

  it('says what a duty due soon waits on, red when that one is overdue', () => {
    const first = duty({
      title: 'Repairs done',
      dueAt: '2026-10-05T04:59:00Z',
      dueDate: '2026-10-04',
    });
    const late = duty({
      title: 'Repairs done',
      dueAt: '2026-10-01T04:59:00Z',
      dueDate: '2026-09-30',
    });
    const walk = duty({
      title: 'Final walkthrough',
      dueAt: '2026-10-06T22:00:00Z',
      dueDate: '2026-10-06',
    });
    const far = duty({ title: 'Closing', dueAt: '2026-10-20T22:00:00Z', dueDate: '2026-10-20' });
    const one = healthOf(
      base({
        duties: [first, walk, far],
        waits: [
          { dutyId: walk.id, dependsOnId: first.id },
          { dutyId: far.id, dependsOnId: first.id },
        ],
      }),
    );
    expect(one.reasons.map((r) => [r.level, r.code, r.words])).toEqual([
      [
        'yellow',
        'prerequisite_open',
        '“Final walkthrough” is due Tue, Oct 6 and waits on “Repairs done”, which is still open.',
      ],
    ]);
    expect(
      codes(base({ duties: [late, walk], waits: [{ dutyId: walk.id, dependsOnId: late.id }] })),
    ).toContain('red:prerequisite_open');
    // Done first: nothing to say.
    expect(
      codes(
        base({
          duties: [{ ...first, status: 'completed' }, walk],
          waits: [{ dutyId: walk.id, dependsOnId: first.id }],
        }),
      ),
    ).toEqual([]);
  });

  it('yellows a wait past the day to chase, and reds what a linked deal breaks', () => {
    expect(
      codes(
        base({
          duties: [
            duty({
              status: 'waiting_external',
              waitingOn: 'the HOA',
              chaseAt: '2026-10-01T15:00:00Z',
            }),
            duty({ status: 'waiting_external', chaseAt: '2026-10-05T15:00:00Z' }),
          ],
          linked: [
            {
              words: 'This purchase closes before the sale.',
              next: 'Move one.',
              keys: ['closing'],
            },
          ],
        }),
      ),
    ).toEqual(['red:linked_conflict', 'yellow:waiting_long']);
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
let jamie: string;
let today: string;

async function fileOn(name: string) {
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
  return up.output.fileId as string;
}

async function signIn(personId: string): Promise<CustomerActor> {
  const scope = { type: 'system' as const, workspaceId: ws, organizationId: org };
  const { accessId } = (
    await executeCommand(
      api(),
      portalAccessGive,
      { workspaceId: ws, personId },
      human(owner),
      meta(),
    )
  ).output;
  const sent = (
    await executeCommand(worker(), portalSendCode, { workspaceId: ws, accessId }, scope, meta())
  ).output;
  const hit = (
    await executeCommand(
      worker(),
      portalCheckCode,
      {
        workspaceId: ws,
        accessId,
        code: sent.code,
        tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      },
      scope,
      meta(),
    )
  ).output;
  return {
    type: 'customer',
    workspaceId: ws,
    organizationId: org,
    personId,
    sessionId: hit.sessionId!,
  };
}

const listOf = async () =>
  Object.fromEntries(
    (await ask(agent, 'realestate.contingencies', { dealId: deal })).contingencies.map((c: Any) => [
      c.label,
      c,
    ]),
  );

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rco-owner'),
    createTestUser('rco-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Contingency Realty');
  const [w] = await rows<{ org: string; tz: string }>(
    admin(),
    sql`select organization_id as org, timezone as tz from app.workspaces where id = ${ws}`,
  );
  org = w!.org;
  today = localDateOf(Date.now(), w!.tz);
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  jamie = (
    await executeCommand(
      api(),
      personCreate,
      {
        workspaceId: ws,
        firstName: 'Jamie',
        lastName: 'Smith',
        email: `jamie-${randomUUID().slice(0, 6)}@example.com`,
      },
      human(agent),
      meta(),
    )
  ).output.personId;
  deal = (
    await run(agent, 'realestate.deal.open', {
      side: 'buyer',
      name: 'Smith purchase',
      stage: 'under_contract',
      clientPersonId: jamie,
    })
  ).dealId;
}, 90_000);

afterAll(closeTestDbs);

describe('A deal’s contingencies', () => {
  it('are tracked as soon as their end dates are entered, and the agent adds one the contract names', async () => {
    await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'inspection_end',
      date: addDays(today, 20),
    });
    await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'financing_end',
      date: addDays(today, -1),
      source: 'contract',
    });
    await run(agent, 'realestate.contingency.add', {
      dealId: deal,
      kind: 'other',
      label: 'Septic inspection',
      endsOn: addDays(today, 30),
    });
    // Appraisal, with its date entered along with it.
    await run(agent, 'realestate.contingency.add', {
      dealId: deal,
      kind: 'appraisal',
      date: addDays(today, 25),
    });
    const by = await listOf();
    expect(Object.keys(by).sort()).toEqual([
      'Appraisal',
      'Financing',
      'Inspection',
      'Septic inspection',
    ]);
    expect(by['Inspection']).toMatchObject({
      source: 'typed',
      state: 'open',
      clock: 'open',
      endConfirmed: true,
    });
    expect(by['Financing']).toMatchObject({ source: 'contract', clock: 'passed' });
    expect(by['Financing'].stateWords).toContain('nothing recorded');
    expect(by['Appraisal'].endsOn).toBe(addDays(today, 25));
    expect(by['Septic inspection']).toMatchObject({ kind: 'other', endKey: null });
    expect(
      (
        await refused(
          run(agent, 'realestate.contingency.add', { dealId: deal, kind: 'inspection' }),
        )
      ).rule,
    ).toBe('realestate_contingency_exists');
    // The one past its end turns the deal red.
    const risks = await ask(agent, 'realestate.deal.risks', { dealId: deal });
    expect(risks.reasons.map((r: Any) => r.code)).toContain('contingency_passed');
  });

  it('records how one ended with the signed form, or by an owner with a reason', async () => {
    const by = await listOf();
    const noForm = await refused(
      run(agent, 'realestate.contingency.resolve', {
        contingencyId: by['Inspection'].id,
        how: 'waived',
      }),
    );
    expect(noForm.rule).toBe('realestate_contingency_needs_form');
    expect(noForm.message).toContain('Add it under Documents and pick it');
    // A member can't skip the form, even with a reason.
    expect(
      (
        await refused(
          run(agent, 'realestate.contingency.resolve', {
            contingencyId: by['Inspection'].id,
            how: 'waived',
            reason: 'Signed on paper',
          }),
        )
      ).rule,
    ).toBe('realestate_contingency_exception_permission');
    const form = await run(agent, 'realestate.document.add', {
      dealId: deal,
      fileId: await fileOn('option-removal.pdf'),
      kind: 'other',
      title: 'Option removal, signed',
    });
    await run(agent, 'realestate.contingency.resolve', {
      contingencyId: by['Inspection'].id,
      how: 'waived',
      documentId: form.documentId,
      note: 'No repairs asked.',
    });
    await run(owner, 'realestate.contingency.resolve', {
      contingencyId: by['Financing'].id,
      how: 'satisfied',
      reason: 'Loan approval letter is in the lender’s portal.',
    });
    const after = await listOf();
    expect(after['Inspection']).toMatchObject({
      state: 'waived',
      document: { id: form.documentId, title: 'Option removal, signed' },
      note: 'No repairs asked.',
      resolvedByName: 'Dana Reyes',
    });
    expect(after['Financing']).toMatchObject({
      state: 'satisfied',
      document: null,
      overrideReason: 'Loan approval letter is in the lender’s portal.',
    });
    expect(
      (
        await refused(
          run(agent, 'realestate.contingency.resolve', {
            contingencyId: by['Inspection'].id,
            how: 'expired',
            documentId: form.documentId,
          }),
        )
      ).rule,
    ).toBe('realestate_contingency_ended');
    // Past its end no longer: the deal isn't red for it.
    const risks = await ask(agent, 'realestate.deal.risks', { dealId: deal });
    expect(risks.reasons.map((r: Any) => r.code)).not.toContain('contingency_passed');
    const history = await rows<{ what: string }>(
      admin(),
      sql`select what from addon_realestate.deal_history where deal_record_id = ${deal}
          and what like 'contingency_%' order by at`,
    );
    expect(history.filter((h) => h.what === 'contingency_resolved')).toHaveLength(2);
  });

  it('puts one past its end on the sweep, for the agent to record', async () => {
    await run(agent, 'realestate.contingency.add', {
      dealId: deal,
      kind: 'hoa',
      date: addDays(today, -2),
    });
    const { output }: { output: Any } = await executeCommand(
      worker(),
      op('realestate.sweep') as CommandDef,
      { workspaceId: ws },
      { type: 'system', workspaceId: ws, organizationId: org },
      { correlationId: randomUUID(), channel: 'worker' },
    );
    const hoa = (await listOf())['HOA documents'];
    expect(output.risks).toEqual([
      expect.objectContaining({
        dealId: deal,
        key: `contingency:${hoa.id}`,
        severity: 'at_risk',
        title: 'Smith purchase: the HOA documents contingency ended with nothing recorded',
        href: `/a/realestate/deals/${deal}/contingencies`,
        assigneeUserId: agent.id,
      }),
    ]);
  });

  it('shows the client each one and how it ended, never the agent’s note', async () => {
    const client = await signIn(jamie);
    const view: Any = await executeQuery(
      worker(),
      op('realestate.portal.deal') as QueryDef,
      { workspaceId: ws, dealId: deal },
      client,
      { correlationId: randomUUID(), channel: 'portal' },
    );
    const by = Object.fromEntries(view.contingencies.map((c: Any) => [c.label, c]));
    expect(by['Inspection']).toMatchObject({
      state: 'waived',
      meaning: 'Time to have the home inspected and decide whether to go ahead.',
    });
    expect(by['Inspection'].words).toMatch(/^Waived /);
    expect(by['Appraisal']).toMatchObject({ state: 'open', endsOn: addDays(today, 25) });
    expect(JSON.stringify(view)).not.toContain('No repairs asked.');
    expect(JSON.stringify(view)).not.toContain('lender’s portal');
  });
});
