/**
 * Real Estate's screens on the phone run core's view functions over the phone's copy (round six, step 13). Each test
 * here builds deals through the add-on's commands, reads back the rows a phone would be sent (through row security,
 * which `packages/db/test/sync-streams.test.ts` holds the sync streams to, as text the way PowerSync stores them), and
 * checks the view answers what the server's query answers, for each person and each of the screen's filters.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import { dealListOfCopy, type DealListFilter } from '../../src/addons/realestate/views/deal-list';
import { dutyListOfCopy, type DutyListFilter } from '../../src/addons/realestate/views/duty-list';
import { phoneCopy } from './realestate-phone-fixture';
import { dealPageOfCopy, dealRisksOfCopy } from '../../src/addons/realestate/views/deal-page';
import { clientUpdateOfCopy } from '../../src/addons/realestate/views/drafts';
import {
  exceptionsOfCopy,
  todayOfCopy,
  waitingRoomOfCopy,
  workloadOfCopy,
  type CoordinateFilter,
} from '../../src/addons/realestate/views/coordinate';
import { documentsOfCopy, signingsOfCopy } from '../../src/addons/realestate/views/documents';
import {
  dutySheetOfCopy,
  proofChecklistOfCopy,
} from '../../src/addons/realestate/views/duty-sheet';
import { historyOfCopy } from '../../src/addons/realestate/views/history';
import { dutyVendorsOfCopy, vendorListOfCopy } from '../../src/addons/realestate/views/vendors';
import {
  companyCreate,
  executeCommand,
  fileBeginUpload,
  executeQuery,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
  type SystemActor,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

const api = () => testDbs().api.db;
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
const run = (name: string, input: Record<string, unknown>, as: TestUser): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(as),
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>, as: TestUser): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(as), meta());
/** The add-on's worker, as the system acting for it. */
const system = async (name: string, input: Record<string, unknown>): Promise<Any> => {
  const [w] = await rows<{ org: string }>(
    admin(),
    sql`select organization_id as org from app.workspaces where id = ${ws}`,
  );
  const actor: SystemActor = {
    type: 'system',
    workspaceId: ws,
    organizationId: w!.org,
    onBehalfOf: null,
  };
  return executeCommand(
    testDbs().worker.db,
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    actor,
    meta(),
  ).then((r) => r.output);
};

let owner: TestUser;
let agent: TestUser;
let mate: TestUser;
let ws: string;
let today: string;
let nguyen: string;
let dutyIds: string[] = [];
let inspectDuty: string;
let draftId: string;
let agreementId: string;

beforeAll(async () => {
  [owner, agent, mate] = await Promise.all([
    createTestUser('rpv-owner', { fullName: 'Rosa Owens' }),
    createTestUser('rpv-agent', { fullName: 'Dana Reyes' }),
    createTestUser('rpv-mate', { fullName: '' }),
  ]);
  ws = await realestateBusiness(owner, 'Phone Views Realty');
  await admin()
    .insert(workspaceMemberships)
    .values([
      { workspaceId: ws, userId: agent.id, role: 'member' },
      { workspaceId: ws, userId: mate.id, role: 'member' },
    ]);
  const [t] = await rows<{ today: string }>(
    admin(),
    sql`select (now() at time zone w.timezone)::date::text as today from app.workspaces w where w.id = ${ws}`,
  );
  today = t!.today;
  const person = async (firstName: string, lastName: string, email?: string) =>
    (
      await executeCommand(
        api(),
        personCreate,
        { workspaceId: ws, firstName, lastName, ...(email ? { email } : {}) },
        human(agent),
        meta(),
      )
    ).output.personId as string;
  const linh = await person('Linh', 'Nguyen', 'linh@example.com');
  const ann = await person('Ann', 'Smith');
  const day = (n: number) =>
    new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  nguyen = (
    await run(
      'realestate.deal.open',
      {
        side: 'buyer',
        name: 'Nguyen purchase',
        clientPersonId: linh,
        stage: 'under_contract',
        newPropertyAddress: '2207 Juniper Trail',
      },
      agent,
    )
  ).dealId;
  await run('realestate.term.enter', { dealId: nguyen, key: 'closing', date: day(12) }, agent);
  await run(
    'realestate.term.enter',
    { dealId: nguyen, key: 'price', cents: 41_500_000, confirm: false },
    agent,
  );
  // One duty waiting on the lender, another blocked until a review date.
  const { duties } = await ask(
    'realestate.duty.list',
    { dealId: nguyen, mine: false, status: 'open' },
    agent,
  );
  const open = (duties as { dutyId: string; status: string }[])
    .filter((d) => d.status === 'not_started')
    .map((d) => ({ id: d.dutyId }));
  await run(
    'realestate.duty.set_status',
    {
      dealId: nguyen,
      dutyId: open[0]!.id,
      status: 'waiting_external',
      waitingOn: 'Hill Country Lending',
    },
    agent,
  );
  await run(
    'realestate.duty.set_status',
    {
      dealId: nguyen,
      dutyId: open[1]!.id,
      status: 'blocked',
      blocker: {
        what: 'Survey not ordered',
        owner: 'Title company',
        impact: 'Closing',
        reviewAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      },
    },
    agent,
  );

  const lender = (
    await executeCommand(
      api(),
      companyCreate,
      { workspaceId: ws, name: 'Hill Country Lending' },
      human(agent),
      meta(),
    )
  ).output.companyId as string;
  await run(
    'realestate.party.add',
    { dealId: nguyen, role: 'lender', companyId: lender, note: 'Rate locked to Oct 13' },
    agent,
  );
  await run('realestate.party.add', { dealId: nguyen, role: 'client', personId: ann }, agent);
  await run(
    'realestate.duty.add_evidence',
    { dutyId: open[2]!.id, kind: 'note', body: 'Called the lender; binder on its way.' },
    agent,
  );
  // One waits on another, added by hand.
  await run('realestate.duty.link', { dutyId: open[3]!.id, waitsOnId: open[2]!.id }, agent);
  dutyIds = open.slice(0, 4).map((d) => d.id);
  // Vendors: two inspectors (one approved, working in Austin) and a photographer; one inspector on a duty.
  const vendor = async (name: string, services: string[], areas: string[], approve: boolean) => {
    const v = (await run('realestate.vendor.save', { name, services, areas }, owner))
      .vendorId as string;
    if (approve) await run('realestate.vendor.approve', { vendorId: v, approved: true }, owner);
    return v;
  };
  const lone = await vendor('Lone Star Inspections', ['inspection'], ['Austin'], true);
  await vendor('Bluebonnet Home Inspectors', ['inspection'], ['Dallas'], true);
  await vendor('Lens & Light', ['photos'], [], false);
  const inspect = (
    await ask('realestate.duty.list', { dealId: nguyen, mine: false, status: 'open' }, agent)
  ).duties.find((d: { title: string }) => /inspect/i.test(d.title));
  inspectDuty = inspect?.dutyId ?? open[0]!.id;
  const pick = (
    await run(
      'realestate.duty.pick_vendor',
      { dutyId: inspectDuty, vendorId: lone, service: 'inspection', note: 'Can do Thursday' },
      agent,
    )
  ).pickId;
  await run('realestate.duty.vendor_quote', { pickId: pick, cents: 45_000 }, agent);

  // A contingency past its end, and a blocker past its day to look again.
  await run(
    'realestate.contingency.add',
    { dealId: nguyen, kind: 'other', label: 'Sale of the buyers’ condo', endsOn: day(-3) },
    agent,
  );
  await rows(
    admin(),
    sql`update addon_realestate.duties set blocker_review_at = now() - interval '1 hour'
        where id = ${open[1]!.id}`,
  );
  // The business is closed the day after tomorrow.
  await rows(
    admin(),
    sql`update app.addon_installations
        set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('closedDays',
              jsonb_build_object(${day(2)}::text, 'Staff day'))
        where workspace_id = ${ws} and addon_id = 'realestate'`,
  );
  // Documents: an agreement, and a disclosure in two versions.
  const fileOn = async (name: string) => {
    const up = await executeCommand(
      api(),
      fileBeginUpload,
      {
        workspaceId: ws,
        recordType: 'custom_record',
        recordId: nguyen,
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
  };
  agreementId = (
    await run(
      'realestate.document.add',
      { dealId: nguyen, fileId: await fileOn('Buyer agreement.pdf'), kind: 'buyer_agreement' },
      agent,
    )
  ).documentId;
  // The agreement out for signing in DocuSign: one of two signed (board 81).
  await rows(
    admin(),
    sql`insert into addon_realestate.esign_envelopes
          (workspace_id, deal_record_id, document_id, provider, state, subject, signers, sent_at)
        values (${ws}, ${nguyen}, ${agreementId}, 'docusign', 'sent', 'Please sign',
          ${JSON.stringify([
            {
              name: 'Linh Nguyen',
              email: 'linh@example.com',
              order: 1,
              state: 'signed',
              signedAt: new Date().toISOString(),
            },
            {
              name: 'Ann Smith',
              email: 'ann@example.com',
              order: 2,
              state: 'sent',
              signedAt: null,
            },
          ])}::jsonb, now())`,
  );
  // A client update, written by the AI (board 81).
  draftId = (await run('realestate.status_email.request', { dealId: nguyen }, agent)).draftId;
  await system('realestate.status_email.drafted', {
    draftId,
    subject: 'Your inspection is in',
    body: 'Hi Linh, the inspection report is in. More tomorrow.',
    model: 'scripted',
    checks: [],
  });
  const first = (
    await run(
      'realestate.document.add',
      { dealId: nguyen, fileId: await fileOn('Disclosure.pdf'), kind: 'seller_disclosure' },
      agent,
    )
  ).documentId;
  await run(
    'realestate.document.add',
    {
      dealId: nguyen,
      fileId: await fileOn('Disclosure v2.pdf'),
      kind: 'seller_disclosure',
      supersedesId: first,
      title: 'Seller’s disclosure, corrected',
    },
    agent,
  );

  const smith = (
    await run(
      'realestate.deal.open',
      {
        side: 'listing',
        name: 'Smith listing',
        clientPersonId: ann,
        newPropertyAddress: '418 Maple Ave',
      },
      agent,
    )
  ).dealId;
  await run('realestate.deal.add_person', { dealId: smith, userId: mate.id }, agent);
  await run('realestate.deal.open', { side: 'buyer', name: 'Owens purchase' }, owner);
  const lost = (await run('realestate.deal.open', { side: 'buyer', name: 'Lee search' }, agent))
    .dealId;
  await run(
    'realestate.deal.end',
    { dealId: lost, how: 'lost', reason: 'Bought elsewhere' },
    agent,
  );
  const old = (await run('realestate.deal.open', { side: 'buyer', name: 'Park search' }, agent))
    .dealId;
  await run('realestate.deal.archive', { dealId: old }, owner);
}, 180_000);

afterAll(closeTestDbs);

describe('the Deals list on the phone', () => {
  const FILTERS: DealListFilter[] = [
    {},
    { status: 'all' },
    { status: 'closed' },
    { status: 'ended' },
    { status: 'archived' },
    { side: 'listing' },
    { side: 'buyer', status: 'all' },
    { mine: true },
    { search: 'juniper' },
    { search: 'LINH' },
    { search: 'Smith' },
    { closingWithinDays: 30 },
    { closingWithinDays: 5 },
    { waitingOn: 'either' },
    { waitingOn: 'outside' },
    { waitingOn: 'blocked' },
    { stage: 'under_contract' },
    { status: 'all', limit: 2 },
  ];

  it('answers what the server answers, for an agent, a teammate and an owner who sees every deal', async () => {
    for (const u of [agent, mate, owner]) {
      const copy = await phoneCopy(u, ws);
      for (const f of [...FILTERS, { agentUserId: agent.id, status: 'all' as const }]) {
        const server = (await ask('realestate.deal.list', f, u)).deals;
        const phone = dealListOfCopy(copy, f, { userId: u.id, now: Date.now(), today });
        expect(phone, `${u.email} ${JSON.stringify(f)}`).toEqual(server);
      }
    }
  });

  it('isn’t equal by being empty: the deal has its client, home, dates, duties and what it waits on', async () => {
    const [deal] = dealListOfCopy(
      await phoneCopy(agent, ws),
      { search: 'juniper' },
      { userId: agent.id, now: Date.now(), today },
    );
    expect(deal).toMatchObject({
      name: 'Nguyen purchase',
      stageLabel: 'Under contract',
      client: { name: 'Linh Nguyen' },
      property: { address: '2207 Juniper Trail' },
      mainAgent: { name: 'Dana Reyes' },
      mine: true,
      datesToConfirm: 1,
      waiting: { title: expect.any(String), who: expect.any(String) },
    });
    expect(deal!.openDuties).toBeGreaterThan(0);
    expect(deal!.nextDue).not.toBeNull();
    expect(deal!.closing).not.toBeNull();
    // The teammate sees the listing they're on, and not the agent's purchase.
    const mates = dealListOfCopy(
      await phoneCopy(mate, ws),
      { status: 'all' },
      {
        userId: mate.id,
        now: Date.now(),
        today,
      },
    );
    expect(mates.map((d) => d.name)).toEqual(['Smith listing']);
  });
});

describe('My duties on the phone', () => {
  const FILTERS: DutyListFilter[] = [
    {},
    { mine: false },
    { mine: false, status: 'all' },
    { mine: false, status: 'overdue' },
    { mine: false, status: 'drafts' },
    { status: 'all' },
    { mine: false, limit: 5 },
  ];

  it('answers what the server answers, for each person and filter, on every deal and on one', async () => {
    const [deal] = (await ask('realestate.deal.list', { search: 'juniper' }, agent)).deals;
    for (const u of [agent, mate, owner]) {
      const copy = await phoneCopy(u, ws);
      for (const f of [...FILTERS, { mine: false, dealId: deal.dealId as string }]) {
        const server = (await ask('realestate.duty.list', f, u)).duties;
        const phone = dutyListOfCopy(copy, f, { userId: u.id, now: Date.now() });
        expect(phone, `${u.email} ${JSON.stringify(f)}`).toEqual(server);
      }
    }
    // Not equal by being empty.
    expect(
      dutyListOfCopy(await phoneCopy(agent, ws), {}, { userId: agent.id, now: Date.now() }).length,
    ).toBeGreaterThan(0);
  });
});

describe('a deal’s page on the phone', () => {
  it('answers what the server answers about the deal, its team, home, people, terms and duties', async () => {
    for (const u of [agent, owner]) {
      const server = await ask('realestate.deal.get', { dealId: nguyen }, u);
      const page = dealPageOfCopy(await phoneCopy(u, ws), nguyen, {
        userId: u.id,
        now: Date.now(),
      });
      expect(page, u.email).not.toBeNull();
      const { full, ...shown } = page!;
      const want = {
        deal: server.deal,
        team: server.team,
        property: server.property,
        parties: server.parties,
        terms: server.terms,
        duties: server.duties,
      };
      if (u === agent) {
        expect(full).toBe(true);
        expect(shown).toEqual(want);
      } else {
        // Whoever sees every deal keeps another agent's deal as its summary: proof waits for signal.
        expect(full).toBe(false);
        expect(shown).toEqual({
          ...want,
          duties: want.duties.map((t: { proofMissing: string }) => ({ ...t, proofMissing: '' })),
        });
      }
    }
  });

  it('isn’t equal by being empty', async () => {
    const page = dealPageOfCopy(await phoneCopy(agent, ws), nguyen, {
      userId: agent.id,
      now: Date.now(),
    })!;
    expect(page.parties.map((p) => [p.label, p.name, p.note])).toEqual(
      expect.arrayContaining([
        ['Lender', 'Hill Country Lending', 'Rate locked to Oct 13'],
        ['Client', 'Linh Nguyen', null],
        ['Client', 'Ann Smith', null],
      ]),
    );
    expect(page.terms.map((t) => t.key)).toEqual(expect.arrayContaining(['closing', 'price']));
    expect(page.duties.some((t) => t.proofMissing !== '')).toBe(true);
    expect(page.duties.some((t) => t.proof !== '')).toBe(true);
    expect(page.team).toEqual([
      { userId: agent.id, name: 'Dana Reyes', role: 'agent', main: true },
    ]);
  });
});

describe('one duty on the phone', () => {
  it('answers what the server answers: the duty, its proof, what it waits on and its log', async () => {
    for (const u of [agent, owner]) {
      const copy = await phoneCopy(u, ws);
      for (const dutyId of dutyIds) {
        const { can: _can, ...server } = await ask('realestate.duty.get', { dutyId }, u);
        const sheet = dutySheetOfCopy(copy, dutyId, { userId: u.id, now: Date.now() });
        expect(sheet, `${u.email} ${dutyId}`).not.toBeNull();
        const { full, ...shown } = sheet!;
        if (u === agent) {
          expect(full).toBe(true);
          expect(shown, dutyId).toEqual(server);
        } else {
          // Kept as a summary: the duty itself, and its proof, waits and log with signal.
          expect(full).toBe(false);
          expect(shown, dutyId).toEqual({
            ...server,
            waitsOn: [],
            waitingOnThis: [],
            ifItSlips: { waiting: [], sameDate: [] },
            proof: { ...server.proof, missing: '' },
            evidence: [],
            log: [],
          });
        }
      }
    }
  });

  it('isn’t equal by being empty', async () => {
    const copy = await phoneCopy(agent, ws);
    const proved = dutySheetOfCopy(copy, dutyIds[2]!, { userId: agent.id, now: Date.now() })!;
    expect(proved.evidence.map((e) => [e.kind, e.label, e.body])).toEqual([
      ['note', 'Note', 'Called the lender; binder on its way.'],
    ]);
    expect(proved.log.length).toBeGreaterThan(0);
    // The one added by hand, beside any the catalog builds in.
    expect(proved.waitingOnThis.map((w) => w.addedByName)).toContain('Dana Reyes');
    const waiting = dutySheetOfCopy(copy, dutyIds[3]!, { userId: agent.id, now: Date.now() })!;
    expect(waiting.waitsOn.map((w) => w.dutyId)).toEqual([dutyIds[2]]);
    const blocked = dutySheetOfCopy(copy, dutyIds[1]!, { userId: agent.id, now: Date.now() })!;
    expect(blocked.duty.blocker).toMatchObject({
      what: 'Survey not ordered',
      owner: 'Title company',
    });
  });
});

describe('a deal’s documents and history on the phone', () => {
  it('answer what the server answers for the deal’s agent, and wait for signal on a summary', async () => {
    for (const u of [agent, owner]) {
      const copy = await phoneCopy(u, ws);
      const docs = (await ask('realestate.document.list', { dealId: nguyen }, u)).documents;
      const lines = (await ask('realestate.deal.history', { dealId: nguyen }, u)).lines;
      if (u === agent) {
        expect(docs.length).toBe(3);
        expect(documentsOfCopy(copy, nguyen)).toEqual(docs);
        expect(lines.length).toBeGreaterThan(3);
        expect(historyOfCopy(copy, nguyen)).toEqual(lines);
        const some = (await ask('realestate.deal.history', { dealId: nguyen, limit: 3 }, u)).lines;
        expect(historyOfCopy(copy, nguyen, { limit: 3 })).toEqual(some);
        const older = (
          await ask('realestate.deal.history', { dealId: nguyen, before: some[2].at }, u)
        ).lines;
        expect(historyOfCopy(copy, nguyen, { before: some[2].at })).toEqual(older);
      } else {
        expect(documentsOfCopy(copy, nguyen)).toEqual([]);
        expect(historyOfCopy(copy, nguyen)).toEqual([]);
      }
    }
  });
});

describe('Coordinate on the phone', () => {
  const FILTERS: CoordinateFilter[] = [{}, { mine: true }];

  it('answers Today, Exceptions and the Waiting room as the server does', async () => {
    for (const u of [agent, owner]) {
      const copy = await phoneCopy(u, ws);
      expect(copy.settings).toMatchObject({ closedDays: expect.any(Object) });
      for (const f of [...FILTERS, { agentUserId: agent.id }]) {
        const ctx = { userId: u.id, now: Date.now(), today };
        const label = `${u.email} ${JSON.stringify(f)}`;
        expect(todayOfCopy(copy, f, ctx), label).toEqual(await ask('realestate.today', f, u));
        expect(waitingRoomOfCopy(copy, f, ctx), label).toEqual(
          await ask('realestate.waiting_room', f, u),
        );
        const server = await ask('realestate.exceptions', f, u);
        const { partial, ...phone } = exceptionsOfCopy(copy, f, ctx);
        if (u === agent) {
          expect(partial, label).toBe(false);
          expect(phone, label).toEqual(server);
        } else {
          // The owner keeps the agent's deals as summaries: proof, contingencies and reads only for their own.
          const own = new Set(
            (await ask('realestate.deal.list', { mine: true }, u)).deals.map(
              (d: { dealId: string }) => d.dealId,
            ),
          );
          const mineOnly = <T extends { dealId: string }>(xs: T[]) =>
            xs.filter((x) => own.has(x.dealId));
          expect(partial, label).toBe(true);
          expect(phone, label).toEqual({
            ...server,
            reads: mineOnly(server.reads),
            noProof: mineOnly(server.noProof),
            contingencies: mineOnly(server.contingencies),
          });
        }
      }
    }
  });

  it('answers Team workload as the server does, for whoever sees every deal, and holds no team for the rest', async () => {
    for (const f of [{}, { mine: true }, { agentUserId: agent.id }] as CoordinateFilter[]) {
      const copy = await phoneCopy(owner, ws);
      const phone = workloadOfCopy(copy, f, {
        userId: owner.id,
        now: Date.now(),
        today,
        seesEveryDeal: true,
      });
      expect(phone, JSON.stringify(f)).toEqual(await ask('realestate.workload', f, owner));
      expect(phone!.people.map((p) => p.name)).toEqual(
        expect.arrayContaining(['Dana Reyes', 'Rosa Owens']),
      );
    }
    // The agent may not see it: the server refuses, and their phone holds nobody's permissions.
    const agentCopy = await phoneCopy(agent, ws);
    expect(agentCopy.team).toEqual([]);
    expect(
      workloadOfCopy(
        agentCopy,
        {},
        { userId: agent.id, now: Date.now(), today, seesEveryDeal: false },
      ),
    ).toBeNull();
  });

  it('isn’t equal by being empty', async () => {
    const copy = await phoneCopy(agent, ws);
    const ctx = { userId: agent.id, now: Date.now(), today };
    const ex = exceptionsOfCopy(copy, {}, ctx);
    expect(ex.contingencies.map((c) => c.label)).toEqual(['Sale of the buyers’ condo']);
    expect(ex.blocked.map((b) => b.blocker)).toEqual(['Survey not ordered']);
    expect(waitingRoomOfCopy(copy, {}, ctx).items.length).toBe(2);
  });
});

describe('vendors on the phone', () => {
  it('answer what the server answers: the directory, and a duty’s vendors', async () => {
    for (const u of [agent, owner]) {
      const copy = await phoneCopy(u, ws);
      for (const f of [{}, { service: 'inspection' as const }, { includeArchived: true }]) {
        const server = (await ask('realestate.vendor.list', f, u)).vendors;
        const { vendors, partial } = vendorListOfCopy(copy, f, { userId: u.id });
        if (u === agent) {
          expect(partial).toBe(false);
          expect(vendors, JSON.stringify(f)).toEqual(server);
        } else {
          // How often each was used counts only the deals the phone holds whole, until signal.
          expect(partial).toBe(true);
          expect(vendors.map(({ uses: _u, lastUsedAt: _l, ...v }) => v)).toEqual(
            server.map(
              ({ uses: _u, lastUsedAt: _l, ...v }: { uses: number; lastUsedAt: string }) => v,
            ),
          );
        }
      }
    }
    const server = await ask('realestate.duty.vendors', { dutyId: inspectDuty }, agent);
    const phone = dutyVendorsOfCopy(await phoneCopy(agent, ws), inspectDuty, { userId: agent.id });
    expect(phone).toEqual(server);
    // Neither works where 2207 Juniper Trail is (no town in its address): by name.
    expect(phone!.fits.map((v) => v.name)).toEqual([
      'Bluebonnet Home Inspectors',
      'Lone Star Inspections',
    ]);
    expect(phone!.picks.map((p) => [p.vendor.name, p.quoteWords])).toEqual([
      ['Lone Star Inspections', '$450'],
    ]);
    // Not on the deal: the owner's phone keeps its summary, and the duty's vendors wait for signal.
    expect(
      dutyVendorsOfCopy(await phoneCopy(owner, ws), inspectDuty, { userId: owner.id }),
    ).toBeNull();
  });
});

describe('what could stop a deal closing, on the phone', () => {
  it('answers what the server answers about its health and every reason, for its agent and an owner', async () => {
    // The phone has the health as last worked out, at a change or the sweep; the server works it out as it's asked.
    // The setup moved a blocker's review and the closed days by hand, so let the sweep see them first.
    await system('realestate.sweep', {});
    for (const u of [agent, owner]) {
      const server = await ask('realestate.deal.risks', { dealId: nguyen }, u);
      const phone = dealRisksOfCopy(await phoneCopy(u, ws), nguyen)!;
      // The same reasons; the server's two ways to them list duties in different orders, so by their words.
      const sorted = (list: readonly unknown[]) =>
        [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      expect({ ...phone, reasons: sorted(phone.reasons) }, u.email).toEqual({
        dealId: server.dealId,
        name: server.name,
        health: server.health,
        reasons: sorted(server.reasons),
      });
      // Reds first.
      const levels = phone.reasons.map((r) => r.level);
      expect(levels).toEqual([...levels].sort((a, b) => (a === b ? 0 : a === 'red' ? -1 : 1)));
    }
    // Not equal by being empty: the blocked duty and the passed contingency are among them.
    const phone = dealRisksOfCopy(await phoneCopy(agent, ws), nguyen)!;
    expect(phone.reasons.length).toBeGreaterThan(0);
    expect(phone.health).not.toBe('green');
  });
});

describe('a duty’s proof checklist on the phone', () => {
  it('ticks what’s there, leaving what the server says is missing', async () => {
    const copy = await phoneCopy(agent, ws);
    for (const dutyId of [...dutyIds, inspectDuty]) {
      const sheet = dutySheetOfCopy(copy, dutyId, { userId: agent.id, now: Date.now() })!;
      const list = proofChecklistOfCopy(copy, dutyId, { userId: agent.id })!;
      expect(list.full).toBe(true);
      expect(list.complete, dutyId).toBe(sheet.proof.missing === '');
      if (list.mode === 'all' && !list.complete)
        expect(
          list.items
            .filter((i) => !i.met)
            .map((i) => i.words.toLowerCase())
            .every((w) => sheet.proof.missing.toLowerCase().includes(w.split(' “')[0]!)),
          dutyId,
        ).toBe(true);
    }
    // Kept as a summary: nothing is ticked, and nothing is said to be complete that needs proof.
    const owners = await phoneCopy(owner, ws);
    for (const dutyId of dutyIds) {
      const list = proofChecklistOfCopy(owners, dutyId, { userId: owner.id })!;
      expect(list.full).toBe(false);
      expect(list.items.some((i) => i.met)).toBe(false);
    }
  });
});

describe('a deal’s signings and client updates on the phone', () => {
  it('answer what the server answers', async () => {
    const copy = await phoneCopy(agent, ws);
    const { envelopes } = await ask('realestate.esign.list', { dealId: nguyen }, agent);
    expect(signingsOfCopy(copy, nguyen)).toEqual(
      envelopes.map((e: Any) => ({
        id: e.id,
        documentId: e.documentId,
        provider: e.provider,
        providerLabel: e.providerLabel,
        state: e.state,
        stateLabel: e.stateLabel,
        signers: e.signers,
        signersWords: e.signersWords,
        sentAt: e.sentAt,
        completedAt: e.completedAt,
        signedDocumentId: e.signedDocumentId,
        next: 'Ann Smith',
      })),
    );
    expect(envelopes.length).toBe(1);
    const { draft } = await ask('realestate.status_email.get', { draftId }, agent);
    const { failure: _f, requestedAt: _r, ...shown } = draft;
    expect(clientUpdateOfCopy(copy, nguyen, draftId, { userId: agent.id })).toEqual({
      ...shown,
      editedAt: null,
      acknowledged: false,
    });
    expect(shown).toMatchObject({ status: 'ready', subject: 'Your inspection is in' });
    // Kept as a summary: it waits for signal.
    const owners = await phoneCopy(owner, ws);
    expect(signingsOfCopy(owners, nguyen)).toEqual([]);
    expect(clientUpdateOfCopy(owners, nguyen, draftId, { userId: owner.id })).toBeNull();
  });
});
