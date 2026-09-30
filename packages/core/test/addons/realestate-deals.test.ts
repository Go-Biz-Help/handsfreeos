/**
 * Real Estate Agent's deals, terms and duties (step 8), on the database: opening a deal from a lead with its client
 * and property; the duties each stage brings, a jump bringing every stage it passes; the named moves back; contract
 * dates keeping their duties as drafts until they're confirmed, a disagreeing date waiting for a person, an
 * amendment moving due times; facts bringing and taking away duties; the team and duties following roles; linked
 * deals; closing, ending and reopening; commission; archiving; and all of it kept to the people on the deal.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddonManifest } from '../../src/addons/manifest';
import { realestateAddon } from '../../src/addons/realestate/manifest';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  executeCommand,
  executeQuery,
  leadCreate,
  organizationCreate,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '../../src/server';

const manifest: AddonManifest = realestateAddon;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

const cmd = (name: string) => {
  const c = realestateAddonServer.commands!.find((x) => x.name === name);
  if (!c) throw new Error(`no ${name}`);
  return c as CommandDef;
};
const query = (name: string) => {
  const q = realestateAddonServer.queries!.find((x) => x.name === name);
  if (!q) throw new Error(`no ${name}`);
  return q as QueryDef;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const run = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(api(), cmd(name), { workspaceId: ws, ...input }, human(who), meta()).then(
    (r) => r.output,
  );
const ask = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), query(name), { workspaceId: ws, ...input }, human(who), meta());
async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { rule?: string; code?: string };
    return err.rule ?? err.code ?? String(e);
  }
  throw new Error('It was allowed.');
}

let owner: TestUser;
let agent: TestUser;
let helper: TestUser;
let other: TestUser;
let ws: string;
let client: string;

/** A business with the add-on on, set up as the worker sets it up (kinds and relationship types from the manifest). */
async function business(u: TestUser, name: string) {
  const made = await executeCommand(
    api(),
    organizationCreate,
    { businessName: name },
    human(u),
    meta(),
  );
  const id = made.output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${id}, 'realestate', 'enabled', ${realestateAddon.version})`,
  );
  const kinds = new Map<string, string>();
  for (const [i, k] of (manifest.recordKinds ?? []).entries()) {
    const [row] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, name_label, icon, position,
            addon_id, write_permission, kept_to_team, see_all_permission)
          values (${id}, ${k.key}, ${k.singular}, ${k.plural}, ${k.nameLabel ?? 'Name'}, ${k.icon ?? 'box'},
            ${900 + i}, 'realestate', ${k.writePermission}, ${k.keptToTeam !== undefined},
            ${k.keptToTeam?.seeAllPermission ?? null})
          returning id`,
    );
    kinds.set(k.key, row!.id);
  }
  for (const [i, t] of (manifest.relationshipTypes ?? []).entries()) {
    const end = (e: typeof t.a) =>
      e.kind === 'record'
        ? { end: 'custom_record', kind: kinds.get(e.recordKind)! }
        : { end: e.kind, kind: null };
    const a = end(t.a);
    const b = end(t.b);
    await rows(
      admin(),
      sql`insert into app.relationship_types (workspace_id, a_end, a_record_type_id, a_label, b_end,
            b_record_type_id, b_label, cardinality, position, addon_id, addon_key)
          values (${id}, ${a.end}::app.relationship_end, ${a.kind}, ${t.aLabel}, ${b.end}::app.relationship_end,
            ${b.kind}, ${t.bLabel}, ${t.cardinality ?? 'many_to_many'}::app.relationship_cardinality, ${900 + i},
            'realestate', ${t.key})`,
    );
  }
  return id;
}

const dutiesOf = (dealId: string) =>
  rows<{
    duty_key: string;
    pass: number;
    status: string;
    accountable_user_id: string | null;
    accountable_role: string;
    due_state: string;
    due_date: string | null;
    due_time: string | null;
    needs_dates: string[];
    started_by: string;
  }>(
    admin(),
    sql`select duty_key, pass, status, accountable_user_id, accountable_role, due_state, due_date::text,
          due_time, needs_dates, started_by
        from addon_realestate.duties where deal_record_id = ${dealId} order by duty_key, pass`,
  );
const duty = async (dealId: string, key: string, pass = 1) =>
  (await dutiesOf(dealId)).find((d) => d.duty_key === key && d.pass === pass);
const keys = async (dealId: string, status?: string) =>
  (await dutiesOf(dealId))
    .filter((d) => !status || d.status === status)
    .map((d) => (d.pass > 1 ? `${d.duty_key}#${d.pass}` : d.duty_key));

const open = (who: TestUser, input: Record<string, unknown>) =>
  run(who, 'realestate.deal.open', input).then((o) => o.dealId as string);

beforeAll(async () => {
  [owner, agent, helper, other] = await Promise.all([
    createTestUser('red-owner'),
    createTestUser('red-agent'),
    createTestUser('red-helper'),
    createTestUser('red-other'),
  ]);
  ws = await business(owner, 'Prairie Realty');
  await admin()
    .insert(workspaceMemberships)
    .values(
      [agent, helper, other].map((u) => ({
        workspaceId: ws,
        userId: u.id,
        role: 'member' as const,
      })),
    );
  client = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Dana', lastName: 'Moreno' },
      human(agent),
      meta(),
    )
  ).output.personId;
}, 90_000);

afterAll(closeTestDbs);

describe('Opening a deal', () => {
  it('makes a private deal from a lead, with its client, a new property and its first stage’s duties', async () => {
    const lead = (
      await executeCommand(
        api(),
        leadCreate,
        { workspaceId: ws, title: 'Moreno home search', personId: client },
        human(agent),
        meta(),
      )
    ).output.leadId;
    const out = await run(agent, 'realestate.deal.open', {
      side: 'buyer',
      name: 'Moreno purchase',
      leadId: lead,
      newPropertyAddress: '14 Lake Rd',
    });
    expect(out.dutiesCreated).toBeGreaterThan(0);
    const got = await ask(agent, 'realestate.deal.get', { dealId: out.dealId });
    expect(got.deal).toMatchObject({ side: 'buyer', stage: 'lead', leadId: lead });
    expect(got.team).toEqual([
      expect.objectContaining({ userId: agent.id, role: 'agent', main: true }),
    ]);
    expect(got.property).toMatchObject({ address: '14 Lake Rd' });
    expect(got.parties).toEqual([
      expect.objectContaining({ role: 'client', personId: client, name: 'Dana Moreno' }),
    ]);
    // The lead stage's duties, each answered for by the main agent (or the brokerage).
    expect(await keys(out.dealId)).toEqual(['B-31', 'X-43']);
    for (const d of await dutiesOf(out.dealId))
      expect(d.accountable_role === 'broker' ? null : agent.id).toBe(d.accountable_user_id);
    // Only the people on it see it, and the line on the client's timeline goes with it.
    expect(await refused(ask(other, 'realestate.deal.get', { dealId: out.dealId }))).toBe(
      'not_found',
    );
    const line = (u: TestUser) =>
      asUser(api(), u.claims, (tx) =>
        rows(
          tx,
          sql`select id from app.activities where person_id = ${client} and subtype = 'addon_line'
                and custom_record_id = ${out.dealId}`,
        ),
      );
    expect(await line(agent)).toHaveLength(1);
    expect(await line(other)).toHaveLength(0);
    expect((await ask(owner, 'realestate.deal.for', { personId: client })).deals).toHaveLength(1);
    expect((await ask(other, 'realestate.deal.for', { personId: client })).deals).toHaveLength(0);
  });

  it('refuses a stage its side doesn’t have, and one after closing', async () => {
    expect(
      await refused(
        run(agent, 'realestate.deal.open', { side: 'buyer', name: 'X', stage: 'active' }),
      ),
    ).toBe('realestate_bad_stage');
    expect(
      await refused(
        run(agent, 'realestate.deal.open', { side: 'buyer', name: 'X', stage: 'possession' }),
      ),
    ).toBe('realestate_close_first');
  });

  it('opens a deal for someone else only for owners and admins', async () => {
    expect(
      await refused(
        run(agent, 'realestate.deal.open', {
          side: 'buyer',
          name: 'X',
          mainAgentUserId: helper.id,
        }),
      ),
    ).toBe('record_team_not_yours');
    const deal = await open(owner, { side: 'buyer', name: 'Assigned', mainAgentUserId: helper.id });
    expect((await ask(helper, 'realestate.deal.get', { dealId: deal })).team[0].userId).toBe(
      helper.id,
    );
  });
});

describe('Stages', () => {
  it('bring every stage’s duties on a jump, and move back only through what happened', async () => {
    const deal = await open(agent, {
      side: 'buyer',
      name: 'Okafor purchase',
      clientPersonId: client,
    });
    const moved = await run(agent, 'realestate.deal.move_stage', {
      dealId: deal,
      stage: 'searching',
    });
    expect(moved.dutiesCreated).toBe(5); // onboarding (B-30, X-47), representation (X-01), searching (B-03, B-04)
    expect(await keys(deal)).toEqual(['B-03', 'B-04', 'B-30', 'B-31', 'X-01', 'X-43', 'X-47']);
    expect(
      await refused(run(agent, 'realestate.deal.move_stage', { dealId: deal, stage: 'lead' })),
    ).toBe('realestate_stage_back');
    expect(
      await refused(
        run(agent, 'realestate.deal.move_stage', { dealId: deal, stage: 'possession' }),
      ),
    ).toBe('realestate_close_first');
    const lines = (await ask(agent, 'realestate.deal.history', { dealId: deal })).lines;
    expect(lines[0]).toMatchObject({
      what: 'stage',
      actorType: 'person',
      before: { stage: 'lead' },
      after: { stage: 'searching' },
    });
  });

  it('bring a later offer’s duties after an offer is lost, and set the lost one’s aside', async () => {
    const deal = await open(agent, { side: 'buyer', name: 'Lee purchase', stage: 'offer' });
    expect(await keys(deal, 'not_started')).toEqual(
      expect.arrayContaining(['B-09', 'B-10', 'B-11']),
    );
    const lost = await run(agent, 'realestate.deal.record_offer_lost', {
      dealId: deal,
      reason: 'Seller took another offer',
    });
    expect(lost.stage).toBe('touring');
    expect(await keys(deal, 'cancelled')).toEqual(['B-09', 'B-10', 'B-11']);
    expect(await keys(deal, 'not_started')).toEqual(
      expect.arrayContaining(['B-13', 'B-14', 'B-29']),
    );
    await run(agent, 'realestate.deal.move_stage', { dealId: deal, stage: 'offer' });
    const now = await keys(deal, 'not_started');
    expect(now).toEqual(expect.arrayContaining(['B-15', 'B-16']));
    expect(now).not.toContain('B-10');
    const early = await open(agent, { side: 'buyer', name: 'Early buyer' });
    expect(
      await refused(
        run(agent, 'realestate.deal.record_offer_lost', { dealId: early, reason: 'none out' }),
      ),
    ).toBe('realestate_no_offer');
  });
});

describe('Key dates and contract duties', () => {
  let deal: string;

  beforeAll(async () => {
    deal = await open(agent, { side: 'buyer', name: 'Silva purchase', stage: 'under_contract' });
  });

  it('keep a contract date’s duties as drafts until the date is confirmed', async () => {
    expect(await duty(deal, 'X-03')).toMatchObject({
      status: 'draft',
      due_state: 'waiting',
      needs_dates: ['closing'],
    });
    const entered = await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'closing',
      date: '2026-11-20',
      source: 'contract',
      sourceRef: '§4',
      confirm: false,
    });
    expect(entered.conflict).toBe(false);
    expect(await duty(deal, 'X-03')).toMatchObject({
      status: 'draft',
      due_state: 'due',
      due_date: '2026-11-10',
      due_time: '23:59',
      needs_dates: ['closing'],
    });
    expect(await duty(deal, 'X-24')).toBeUndefined();
    const confirmed = await run(agent, 'realestate.term.confirm', {
      dealId: deal,
      entryId: entered.entryId,
    });
    expect(confirmed.dutiesActivated).toBe(4); // X-02, X-03, X-07, X-09
    expect(await duty(deal, 'X-03')).toMatchObject({ status: 'not_started', needs_dates: [] });
    // Confirming the closing brings its own duties.
    expect(await duty(deal, 'X-24')).toMatchObject({
      status: 'not_started',
      due_date: '2026-11-19',
    });
    // The brokerage answers for X-02: nobody by name.
    expect((await duty(deal, 'X-02'))!.accountable_user_id).toBeNull();
  });

  it('keep two closing dates that disagree until a person chooses', async () => {
    const before = (await ask(agent, 'realestate.deal.get', { dealId: deal })).terms.find(
      (t: Any) => t.key === 'closing',
    );
    const second = await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'closing',
      date: '2026-11-25',
      source: 'lender',
    });
    expect(second.conflict).toBe(true);
    const got = await ask(agent, 'realestate.deal.get', { dealId: deal });
    const closing = got.terms.find((t: Any) => t.key === 'closing');
    expect(closing).toMatchObject({ conflict: true, confirmed: false });
    expect(closing.entries.map((e: Any) => e.date)).toEqual(['2026-11-25', '2026-11-20']);
    expect((await duty(deal, 'X-03'))!.needs_dates).toEqual(['closing']);
    expect(
      await refused(
        run(agent, 'realestate.term.resolve_conflict', {
          dealId: deal,
          key: 'acceptance',
          keepEntryId: before.entries[0].entryId,
          reason: 'x',
        }),
      ),
    ).toBe('validation');
    const settled = await run(agent, 'realestate.term.resolve_conflict', {
      dealId: deal,
      key: 'closing',
      keepEntryId: before.entries[0].entryId,
      reason: 'The contract governs; the lender had it wrong.',
    });
    expect(settled.dutiesRedated).toBeGreaterThan(0);
    expect(await duty(deal, 'X-03')).toMatchObject({ due_date: '2026-11-10', needs_dates: [] });
    const history = (await ask(agent, 'realestate.term.history', { dealId: deal, key: 'closing' }))
      .entries;
    expect(history.map((e: Any) => [e.date, e.live])).toEqual([
      ['2026-11-25', false],
      ['2026-11-20', true],
    ]);
  });

  it('move every due time resting on a date an amendment changes, and bring the amendment’s duties', async () => {
    const got = await ask(agent, 'realestate.deal.get', { dealId: deal });
    const current = got.terms.find((t: Any) => t.key === 'closing').entries[0].entryId;
    const amended = await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'closing',
      date: '2026-12-01',
      source: 'amendment',
      replaces: current,
    });
    expect(amended.conflict).toBe(false);
    expect(await duty(deal, 'X-03')).toMatchObject({ due_date: '2026-11-21' });
    expect(await duty(deal, 'X-16')).toMatchObject({
      status: 'not_started',
      started_by: 'event:amendment',
    });
    // What was entered stays as it was.
    expect(
      await refused(
        asUser(api(), agent.claims, (tx) =>
          rows(
            tx,
            sql`update addon_realestate.term_entries set value_date = '2026-12-02' where id = ${current}`,
          ),
        ),
      ),
    ).toMatch(/.+/);
  });

  it('check dates across the deal', async () => {
    await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'acceptance',
      date: '2026-12-05',
      source: 'contract',
    });
    const got = await ask(agent, 'realestate.deal.get', { dealId: deal });
    expect(got.dateProblems.map((p: Any) => p.check)).toContain('closing_before_acceptance');
  });

  it('refuse a term the side doesn’t have, and a value of the wrong kind', async () => {
    expect(
      await refused(
        run(agent, 'realestate.term.enter', { dealId: deal, key: 'list_price', cents: 100 }),
      ),
    ).toBe('realestate_term_not_here');
    expect(
      await refused(
        run(agent, 'realestate.term.enter', { dealId: deal, key: 'price', date: '2026-10-01' }),
      ),
    ).toBe('validation');
  });

  it('are set aside when the contract is terminated, with its unfinished duties', async () => {
    const out = await run(agent, 'realestate.deal.terminate', {
      dealId: deal,
      reason: 'Buyer’s financing fell through',
    });
    expect(out.stage).toBe('searching');
    expect(await duty(deal, 'X-03')).toMatchObject({ status: 'cancelled' });
    expect(await duty(deal, 'X-24')).toMatchObject({ status: 'cancelled' });
    expect(await keys(deal, 'not_started')).toEqual(expect.arrayContaining(['B-26', 'B-29']));
    const live = await rows(
      admin(),
      sql`select id from addon_realestate.term_entries
          where deal_record_id = ${deal} and superseded_at is null and rejected_at is null`,
    );
    expect(live).toEqual([]);
    // The next contract's closing brings its duties again.
    await run(agent, 'realestate.deal.move_stage', { dealId: deal, stage: 'under_contract' });
    expect(await duty(deal, 'X-03', 2)).toMatchObject({ status: 'draft' });
    await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'closing',
      date: '2027-01-15',
      source: 'contract',
    });
    expect(await duty(deal, 'X-24', 2)).toMatchObject({
      status: 'not_started',
      due_date: '2027-01-14',
    });
  });
});

describe('Facts', () => {
  it('bring the duties they call for at stages already passed, and cancel ones no longer needed', async () => {
    const deal = await open(agent, {
      side: 'buyer',
      name: 'Nakamura purchase',
      stage: 'searching',
    });
    expect(await keys(deal)).not.toContain('B-02');
    const set = await run(agent, 'realestate.deal.set_facts', {
      dealId: deal,
      facts: ['financed', 'first_time_buyer'],
    });
    expect(set.dutiesCreated).toBe(2);
    expect(await keys(deal, 'not_started')).toEqual(expect.arrayContaining(['B-01', 'B-02']));
    const off = await run(agent, 'realestate.deal.set_facts', {
      dealId: deal,
      facts: ['first_time_buyer'],
    });
    expect(off.dutiesCancelled).toBe(1);
    expect(await duty(deal, 'B-02')).toMatchObject({ status: 'cancelled' });
  });
});

describe('The team', () => {
  it('hands the coordinator’s duties to a coordinator, and back when they leave', async () => {
    const deal = await open(agent, {
      side: 'buyer',
      name: 'Rossi purchase',
      stage: 'under_contract',
    });
    await run(agent, 'realestate.term.enter', { dealId: deal, key: 'closing', date: '2026-11-30' });
    expect((await duty(deal, 'X-26'))!.accountable_user_id).toBe(agent.id);
    const added = await run(agent, 'realestate.deal.add_person', {
      dealId: deal,
      userId: helper.id,
      role: 'coordinator',
    });
    expect(added.team.map((t: Any) => [t.userId, t.role])).toEqual([
      [agent.id, 'agent'],
      [helper.id, 'coordinator'],
    ]);
    expect(added.dutiesHandedOver).toBeGreaterThan(0);
    expect((await duty(deal, 'X-26'))!.accountable_user_id).toBe(helper.id);
    expect((await duty(deal, 'X-24'))!.accountable_user_id).toBe(agent.id);
    // Someone on the team who isn't its main agent doesn't change who's on it.
    expect(
      await refused(run(helper, 'realestate.deal.add_person', { dealId: deal, userId: other.id })),
    ).toBe('record_team_not_yours');
    // Nor does someone who isn't on it: to them it isn't there.
    expect(
      await refused(run(other, 'realestate.deal.add_person', { dealId: deal, userId: other.id })),
    ).toBe('not_found');
    const removed = await run(agent, 'realestate.deal.remove_person', {
      dealId: deal,
      userId: helper.id,
    });
    expect(removed.team).toHaveLength(1);
    expect((await duty(deal, 'X-26'))!.accountable_user_id).toBe(agent.id);
  });

  it('lets only owners and admins choose the main agent', async () => {
    const deal = await open(agent, { side: 'listing', name: 'Park listing' });
    await run(agent, 'realestate.deal.add_person', { dealId: deal, userId: helper.id });
    expect(
      await refused(
        run(agent, 'realestate.deal.set_role', { dealId: deal, userId: helper.id, role: 'agent' }),
      ),
    ).toBe('record_team_not_yours');
    const out = await run(owner, 'realestate.deal.set_role', {
      dealId: deal,
      userId: helper.id,
      role: 'agent',
    });
    expect(out.team.map((t: Any) => [t.userId, t.role])).toEqual([
      [helper.id, 'agent'],
      [agent.id, 'co_agent'],
    ]);
    expect((await duty(deal, 'S-01'))!.accountable_user_id).toBe(helper.id);
  });
});

describe('Linked deals', () => {
  it('put both sides of one home on its property, and refuse two of the same side', async () => {
    const listing = await open(agent, {
      side: 'listing',
      name: 'Grant listing',
      stage: 'active',
      newPropertyAddress: '9 Elm St',
    });
    const buyer = await open(agent, { side: 'buyer', name: 'Grant buyer side' });
    const other2 = await open(agent, { side: 'buyer', name: 'Another buyer' });
    expect(
      await refused(
        run(agent, 'realestate.deal.link', {
          dealId: buyer,
          otherDealId: other2,
          kind: 'same_home',
        }),
      ),
    ).toBe('realestate_link_sides');
    const out = await run(agent, 'realestate.deal.link', {
      dealId: buyer,
      otherDealId: listing,
      kind: 'same_home',
    });
    expect(out.changed).toBe(true);
    const got = await ask(agent, 'realestate.deal.get', { dealId: buyer });
    expect(got.property).toMatchObject({ address: '9 Elm St' });
    expect(got.links).toEqual([
      expect.objectContaining({ otherDealId: listing, kind: 'same_home' }),
    ]);
    expect((await ask(agent, 'realestate.deal.get', { dealId: listing })).links).toHaveLength(1);
  });

  it('mark a client’s sale and purchase as tied, and bring what that calls for', async () => {
    const sale = await open(agent, { side: 'listing', name: 'Hale sale', stage: 'under_contract' });
    const purchase = await open(agent, { side: 'buyer', name: 'Hale purchase' });
    await run(agent, 'realestate.deal.link', {
      dealId: purchase,
      otherDealId: sale,
      kind: 'sale_and_purchase',
    });
    expect((await ask(agent, 'realestate.deal.get', { dealId: sale })).deal.facts).toContain(
      'linked_sale',
    );
    expect(await keys(sale)).toContain('X-35');
    await run(agent, 'realestate.term.enter', { dealId: sale, key: 'closing', date: '2026-12-10' });
    await run(agent, 'realestate.term.enter', {
      dealId: purchase,
      key: 'closing',
      date: '2026-12-01',
    });
    const got = await ask(agent, 'realestate.deal.get', { dealId: purchase });
    expect(got.dateProblems.map((p: Any) => p.check)).toContain('linked_sale_after_purchase');
    await run(agent, 'realestate.deal.unlink', {
      dealId: sale,
      otherDealId: purchase,
      kind: 'sale_and_purchase',
    });
    expect((await ask(agent, 'realestate.deal.get', { dealId: sale })).deal.facts).not.toContain(
      'linked_sale',
    );
  });
});

describe('Recorded moments', () => {
  it('bring their duties on the side that has them', async () => {
    const listing = await open(agent, { side: 'listing', name: 'Ortiz listing', stage: 'active' });
    const out = await run(agent, 'realestate.deal.record_event', {
      dealId: listing,
      event: 'offer_received',
    });
    expect(out.dutiesCreated).toBe(5); // S-40, S-41, S-43, S-44, S-45 (S-42 waits for more than one offer)
    const buyer = await open(agent, { side: 'buyer', name: 'Ortiz buyer' });
    expect(
      await refused(
        run(agent, 'realestate.deal.record_event', { dealId: buyer, event: 'offer_received' }),
      ),
    ).toBe('realestate_event_not_here');
  });
});

describe('Closing, ending and reopening', () => {
  it('closes a deal at Closing, marks its lead won, and leaves the final commission to owners and admins', async () => {
    const lead = (
      await executeCommand(
        api(),
        leadCreate,
        { workspaceId: ws, title: 'Brooks purchase', personId: client },
        human(agent),
        meta(),
      )
    ).output.leadId;
    const deal = await open(agent, {
      side: 'buyer',
      name: 'Brooks purchase',
      stage: 'under_contract',
      leadId: lead,
    });
    const commission = await run(agent, 'realestate.deal.set_commission', {
      dealId: deal,
      rateBp: 300,
      flatCents: null,
      creditCents: 100_000,
      splitBp: 7000,
    });
    expect(commission.commission).toMatchObject({ grossCents: null, expectedCents: null });
    await run(agent, 'realestate.term.enter', { dealId: deal, key: 'price', cents: 40_000_000 });
    const got = await ask(agent, 'realestate.deal.get', { dealId: deal });
    expect(got.commission).toMatchObject({
      grossCents: 1_200_000,
      expectedCents: 1_100_000,
      agentShareCents: 770_000,
    });
    expect(await refused(run(agent, 'realestate.deal.close', { dealId: deal }))).toBe(
      'realestate_not_closing',
    );
    await run(agent, 'realestate.deal.move_stage', { dealId: deal, stage: 'closing' });
    const closed = await run(agent, 'realestate.deal.close', { dealId: deal, markLeadWon: true });
    expect(closed).toMatchObject({ stage: 'possession', leadWon: true });
    expect(await keys(deal, 'not_started')).toEqual(
      expect.arrayContaining(['X-32', 'X-33', 'X-34', 'B-28']),
    );
    const [l] = await rows<{ status: string }>(
      admin(),
      sql`select status from app.leads where id = ${lead}`,
    );
    expect(l!.status).toBe('won');
    expect(
      await refused(
        run(agent, 'realestate.deal.set_final_commission', { dealId: deal, cents: 1_050_000 }),
      ),
    ).toBe('forbidden');
    const final = await run(owner, 'realestate.deal.set_final_commission', {
      dealId: deal,
      cents: 1_050_000,
    });
    expect(final.commission.finalCents).toBe(1_050_000);
    // Closed stays closed, but it moves on to Past client.
    expect(
      await refused(run(agent, 'realestate.deal.reopen', { dealId: deal, reason: 'oops' })),
    ).toBe('realestate_deal_closed');
    await run(agent, 'realestate.deal.move_stage', { dealId: deal, stage: 'past_client' });
  });

  it('ends a listing, cancelling its duties, and puts it back on the market', async () => {
    const deal = await open(agent, { side: 'listing', name: 'Young listing', stage: 'active' });
    const ended = await run(agent, 'realestate.deal.end', {
      dealId: deal,
      how: 'withdrawn',
      reason: 'Sellers decided to stay',
    });
    expect(ended.stage).toBe('withdrawn');
    expect(ended.dutiesCancelled).toBeGreaterThan(10);
    expect(await keys(deal, 'not_started')).toEqual(['X-37', 'X-42']);
    expect(
      await refused(run(agent, 'realestate.deal.move_stage', { dealId: deal, stage: 'showings' })),
    ).toBe('realestate_deal_finished');
    const back = await run(agent, 'realestate.deal.reopen', {
      dealId: deal,
      reason: 'Back on the market',
    });
    expect(back.stage).toBe('active');
    expect(await duty(deal, 'S-22', 2)).toMatchObject({ status: 'not_started' });
    const list = await ask(agent, 'realestate.deal.list', { search: 'Young' });
    expect(list.deals).toEqual([
      expect.objectContaining({ dealId: deal, stage: 'active', outcome: null }),
    ]);
  });
});

describe('Archiving and the lists', () => {
  it('archives only for owners and admins, and keeps an archived deal as it was', async () => {
    const deal = await open(agent, { side: 'buyer', name: 'Kim purchase' });
    expect(await refused(run(agent, 'realestate.deal.archive', { dealId: deal }))).toBe(
      'realestate_archive_forbidden',
    );
    await run(owner, 'realestate.deal.archive', { dealId: deal });
    expect(
      await refused(run(agent, 'realestate.deal.move_stage', { dealId: deal, stage: 'searching' })),
    ).toBe('realestate_deal_archived');
    const archived = await ask(agent, 'realestate.deal.list', { status: 'archived' });
    expect(archived.deals.map((d: Any) => d.dealId)).toContain(deal);
    await run(owner, 'realestate.deal.restore', { dealId: deal });
  });

  it('shows each person only the deals they see', async () => {
    const mine = await ask(helper, 'realestate.deal.list', { mine: true });
    expect(mine.deals.map((d: Any) => d.name).sort()).toEqual(['Assigned', 'Park listing']);
    expect((await ask(other, 'realestate.deal.list', {})).deals).toEqual([]);
    const everyone = await ask(owner, 'realestate.deal.list', { status: 'all', limit: 200 });
    expect(everyone.deals.length).toBeGreaterThan(10);
    const overview = await ask(agent, 'realestate.overview', {});
    expect(overview.myOpenDeals).toBeGreaterThan(0);
  });
});
