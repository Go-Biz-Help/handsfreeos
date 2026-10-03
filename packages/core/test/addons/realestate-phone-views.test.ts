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
import {
  realestateCopyOf,
  type RealestateCopy,
  type RealestateSource,
} from '../../src/addons/realestate/views/synced';
import { dealPageOfCopy } from '../../src/addons/realestate/views/deal-page';
import {
  companyCreate,
  executeCommand,
  executeQuery,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
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

let owner: TestUser;
let agent: TestUser;
let mate: TestUser;
let ws: string;
let today: string;
let nguyen: string;

/** A cell as the phone keeps it: text, 0/1, or nothing; arrays and JSON as JSON text; times as PowerSync writes them. */
function cell(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().replace('T', ' ');
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number;
}
const cells = <T extends Record<string, unknown>>(list: T[]) =>
  list.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)])));

/** What `u`'s phone holds of Real Estate, read the way its screens read it. */
async function phoneCopy(u: TestUser): Promise<RealestateCopy> {
  return realestateCopyOf(await phoneRows(u));
}

async function phoneRows(u: TestUser): Promise<RealestateSource> {
  return asUser(api(), u.claims, async (tx) => ({
    records: cells(
      await rows(
        tx,
        sql`select r.id, r.name, r.notes, r.archived_at, r.owner_user_id, r.team_user_ids, r.updated_at
            from app.custom_records r join app.custom_record_types t on t.id = r.type_id
            where r.workspace_id = ${ws} and t.key = 'realestate_deal' and r.sync_window`,
      ),
    ),
    rows: cells(
      await rows(
        tx,
        sql`select id, source, record_id, data from app.addon_phone_rows
            where workspace_id = ${ws} and addon_id = 'realestate' and sync_window`,
      ),
    ),
    links: cells(
      await rows(
        tx,
        sql`select l.id, t.addon_id, t.addon_key, t.position, l.a_person_id, l.a_company_id, l.a_custom_record_id,
              l.b_custom_record_id, l.note, l.created_at
            from app.relationships l join app.relationship_types t on t.id = l.type_id
            where l.workspace_id = ${ws}`,
      ),
    ),
    people: cells(
      await rows(
        tx,
        sql`select id, first_name, last_name, email from app.people where workspace_id = ${ws}`,
      ),
    ),
    companies: cells(
      await rows(tx, sql`select id, name from app.companies where workspace_id = ${ws}`),
    ),
    users: cells(await rows(tx, sql`select id, full_name, email from app.users`)),
    recordNames: cells(
      await rows(tx, sql`select id, name from app.custom_records where workspace_id = ${ws}`),
    ),
  })) as unknown as Promise<RealestateSource>;
}

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
  const person = async (firstName: string, lastName: string) =>
    (
      await executeCommand(
        api(),
        personCreate,
        { workspaceId: ws, firstName, lastName },
        human(agent),
        meta(),
      )
    ).output.personId as string;
  const linh = await person('Linh', 'Nguyen');
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
      const copy = await phoneCopy(u);
      for (const f of [...FILTERS, { agentUserId: agent.id, status: 'all' as const }]) {
        const server = (await ask('realestate.deal.list', f, u)).deals;
        const phone = dealListOfCopy(copy, f, { userId: u.id, now: Date.now(), today });
        expect(phone, `${u.email} ${JSON.stringify(f)}`).toEqual(server);
      }
    }
  });

  it('isn’t equal by being empty: the deal has its client, home, dates, duties and what it waits on', async () => {
    const [deal] = dealListOfCopy(
      await phoneCopy(agent),
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
      await phoneCopy(mate),
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
      const copy = await phoneCopy(u);
      for (const f of [...FILTERS, { mine: false, dealId: deal.dealId as string }]) {
        const server = (await ask('realestate.duty.list', f, u)).duties;
        const phone = dutyListOfCopy(copy, f, { userId: u.id, now: Date.now() });
        expect(phone, `${u.email} ${JSON.stringify(f)}`).toEqual(server);
      }
    }
    // Not equal by being empty.
    expect(
      dutyListOfCopy(await phoneCopy(agent), {}, { userId: agent.id, now: Date.now() }).length,
    ).toBeGreaterThan(0);
  });
});

describe('a deal’s page on the phone', () => {
  it('answers what the server answers about the deal, its team, home, people, terms and duties', async () => {
    for (const u of [agent, owner]) {
      const server = await ask('realestate.deal.get', { dealId: nguyen }, u);
      const page = dealPageOfCopy(await phoneCopy(u), nguyen, { userId: u.id, now: Date.now() });
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
    const page = dealPageOfCopy(await phoneCopy(agent), nguyen, {
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
