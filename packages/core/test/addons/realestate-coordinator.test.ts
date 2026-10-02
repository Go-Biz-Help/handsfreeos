/**
 * Real Estate Agent, round four, steps 6 and 7: a linked sale and purchase, and the coordinator's views
 * (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round four"). The pure checks first (what a linked deal breaks,
 * from each side), then on the database: only the other deal's key dates, health and agent crossing the link, even to
 * someone not on it; the warning on both deals; and Today, Exceptions, the Waiting room, Workload and the Deals
 * filters.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkedProblems } from '../../src/addons/realestate/dates/linked';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import { addDays } from '../../src/calendar/engine/zoned';
import {
  executeCommand,
  executeQuery,
  localDateOf,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

describe('what a linked sale and purchase break', () => {
  const sale = { closing: { date: '2026-11-21' } };
  const purchase = {
    closing: { date: '2026-11-20' },
    home_sale_end: { date: '2026-11-18' },
    rate_lock_expiry: { date: '2026-11-19' },
  };
  const other = (side: 'buyer' | 'listing', keyDates: object) => ({
    name: side === 'listing' ? 'Alvarez listing' : 'Alvarez purchase',
    side,
    kind: 'sale_and_purchase' as const,
    agentName: 'Sam Ortiz',
    keyDates: keyDates as Record<string, { date: string }>,
  });

  it('says it from the purchase’s side, leaving the closing order to its own date checks', () => {
    const said = linkedProblems({ side: 'buyer', keyDates: purchase }, other('listing', sale));
    expect(said.map((p) => p.words)).toEqual([
      'The home-sale contingency here ends Wed, Nov 18, before their sale closes (Sat, Nov 21).',
      'The rate lock here ends Thu, Nov 19, before their sale closes (Sat, Nov 21).',
    ]);
  });

  it('says it from the sale’s side, the closing order first, naming the other agent', () => {
    const said = linkedProblems({ side: 'listing', keyDates: sale }, other('buyer', purchase));
    expect(said[0]).toEqual({
      words:
        'Their purchase, Alvarez purchase, closes Fri, Nov 20, before this sale closes (Sat, Nov 21).',
      next: 'Move this closing to Fri, Nov 20 or earlier, or ask Sam Ortiz to move theirs.',
      keys: ['closing'],
    });
    expect(said).toHaveLength(3);
  });

  it('counts the days with nowhere to live, and says nothing for two sides of one home', () => {
    const said = linkedProblems(
      { side: 'buyer', keyDates: { closing: { date: '2026-11-25' } } },
      other('listing', { closing: { date: '2026-11-20' }, possession: { date: '2026-11-20' } }),
    );
    expect(said.map((p) => p.words)).toEqual([
      'The client hands over the home they’re selling on Fri, Nov 20 but gets the one they’re buying on Wed, Nov 25: 5 days with nowhere to live.',
    ]);
    expect(
      linkedProblems(
        { side: 'buyer', keyDates: purchase },
        { ...other('listing', sale), kind: 'same_home' },
      ),
    ).toEqual([]);
  });
});

// ---------- on the database ----------

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
const run = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(who),
    meta(),
  ).then((r) => r.output);
const ask = (who: TestUser, name: string, input: Record<string, unknown> = {}): Promise<Any> =>
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
let sam: TestUser;
let dana: TestUser;
let ws: string;
let today: string;
let sale: string;
let purchase: string;

const dutyOf = async (deal: string, key: string) => {
  const [d] = await rows<{ id: string }>(
    admin(),
    sql`select id from addon_realestate.duties where deal_record_id = ${deal} and duty_key = ${key}
        order by pass desc limit 1`,
  );
  if (!d) throw new Error(`no ${key}`);
  return d.id;
};

beforeAll(async () => {
  [owner, sam, dana] = await Promise.all([
    createTestUser('rcd-owner', { fullName: 'Priya Shah' }),
    createTestUser('rcd-sam', { fullName: 'Sam Ortiz' }),
    createTestUser('rcd-dana', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Coordinate Realty');
  const [w] = await rows<{ tz: string }>(
    admin(),
    sql`select timezone as tz from app.workspaces where id = ${ws}`,
  );
  today = localDateOf(Date.now(), w!.tz);
  await admin()
    .insert(workspaceMemberships)
    .values([sam, dana].map((u) => ({ workspaceId: ws, userId: u.id, role: 'member' as const })));
  // Sam has their sale; Dana has their purchase. Neither is on the other's deal.
  sale = (
    await run(sam, 'realestate.deal.open', {
      side: 'listing',
      name: 'Alvarez listing',
      stage: 'under_contract',
    })
  ).dealId;
  purchase = (
    await run(dana, 'realestate.deal.open', {
      side: 'buyer',
      name: 'Alvarez purchase',
      stage: 'under_contract',
    })
  ).dealId;
  await run(sam, 'realestate.term.enter', {
    dealId: sale,
    key: 'closing',
    date: addDays(today, 50),
  });
  await run(dana, 'realestate.term.enter', {
    dealId: purchase,
    key: 'closing',
    date: addDays(today, 49),
  });
  await run(dana, 'realestate.term.enter', {
    dealId: purchase,
    key: 'home_sale_end',
    date: addDays(today, 47),
  });
}, 90_000);

afterAll(closeTestDbs);

describe('A linked sale and purchase', () => {
  it('is linked by someone who sees both, and is proof the seller’s next home is coordinated', async () => {
    expect((await refused(ask(dana, 'realestate.deal.get', { dealId: sale }))).rule).toBe(
      'not_found',
    );
    await run(owner, 'realestate.deal.link', {
      dealId: purchase,
      otherDealId: sale,
      kind: 'sale_and_purchase',
    });
    const proof = await rows<{ duty_key: string }>(
      admin(),
      sql`select d.duty_key from addon_realestate.duty_evidence e
          join addon_realestate.duties d on d.id = e.duty_id
          where e.deal_record_id = ${sale} and e.ref_kind = 'deal_link'`,
    );
    expect(proof.map((p) => p.duty_key)).toEqual(['X-35']);
  });

  it('shows each side only the other’s key dates, health and agent, even to someone not on it', async () => {
    const got = await ask(dana, 'realestate.deal.get', { dealId: purchase });
    expect(got.links).toEqual([
      expect.objectContaining({
        otherDealId: sale,
        name: 'Alvarez listing',
        side: 'listing',
        agentName: 'Sam Ortiz',
        canOpen: false,
        keyDates: [{ key: 'closing', label: 'Closing', date: addDays(today, 50), confirmed: true }],
      }),
    ]);
    // The purchase's own checks: it closes before the sale; the home-sale contingency ends first.
    expect(got.dateProblems.map((p: Any) => p.check)).toContain('linked_sale_after_purchase');
    expect(got.linkedProblems.map((p: Any) => p.words)).toEqual([
      expect.stringMatching(/^The home-sale contingency here ends .+, before their sale closes/),
    ]);
    // Still nothing else of the sale: Dana can't open it.
    expect((await refused(ask(dana, 'realestate.deal.get', { dealId: sale }))).rule).toBe(
      'not_found',
    );
    const saleSide = await ask(sam, 'realestate.deal.get', { dealId: sale });
    expect(saleSide.links[0]).toMatchObject({ agentName: 'Dana Reyes', canOpen: false });
    expect(saleSide.linkedProblems[0].words).toMatch(/^Their purchase, Alvarez purchase, closes /);
  });

  it('turns both deals red and puts a card up on each, for its own agent', async () => {
    for (const [who, deal] of [
      [sam, sale],
      [dana, purchase],
    ] as const) {
      const risks = await ask(who, 'realestate.deal.risks', { dealId: deal });
      expect(risks.reasons.map((r: Any) => r.code)).toContain('linked_conflict');
    }
    const [w] = await rows<{ org: string }>(
      admin(),
      sql`select organization_id as org from app.workspaces where id = ${ws}`,
    );
    const { output }: { output: Any } = await executeCommand(
      testDbs().worker.db,
      op('realestate.sweep') as CommandDef,
      { workspaceId: ws },
      { type: 'system', workspaceId: ws, organizationId: w!.org },
      { correlationId: randomUUID(), channel: 'worker' },
    );
    const linked = output.risks.filter((r: Any) => r.key.startsWith('linked:'));
    expect(linked.map((r: Any) => [r.dealId, r.key, r.assigneeUserId]).sort()).toEqual(
      [
        [sale, `linked:${purchase}`, sam.id],
        [purchase, `linked:${sale}`, dana.id],
      ].sort(),
    );
  });
});

describe('The coordinator’s views', () => {
  it('lists Today: at risk first, then overdue and due today', async () => {
    const late = (
      await run(dana, 'realestate.duty.add', {
        dealId: purchase,
        title: 'Send the earnest money receipt',
        materiality: 'material',
        dueDate: addDays(today, -2),
      })
    ).dutyId;
    const due = (
      await run(dana, 'realestate.duty.add', {
        dealId: purchase,
        title: 'Order the survey',
        dueDate: today,
        dueTime: '23:59',
      })
    ).dutyId;
    const view = await ask(dana, 'realestate.today');
    expect(view.today).toBe(today);
    expect(view.overdue.map((d: Any) => d.dutyId)).toContain(late);
    expect(view.dueToday.map((d: Any) => d.dutyId)).toContain(due);
    expect(view.atRisk.some((r: Any) => r.dealId === purchase && r.level === 'red')).toBe(true);
    // Dana's views are Dana's deals: nothing of Sam's sale.
    expect(JSON.stringify(view)).not.toContain(sale);
    // The owner sees every deal.
    const all = await ask(owner, 'realestate.today');
    expect(all.atRisk.some((r: Any) => r.dealId === sale)).toBe(true);
  });

  it('lists Exceptions: what disagrees, nobody answers for, or passed', async () => {
    const vendor = await dutyOf(purchase, 'B-18');
    await rows(
      admin(),
      sql`update addon_realestate.duties set accountable_user_id = null where id = ${vendor}`,
    );
    await run(dana, 'realestate.contingency.add', {
      dealId: purchase,
      kind: 'other',
      label: 'Septic inspection',
      endsOn: addDays(today, -1),
    });
    const view = await ask(dana, 'realestate.exceptions');
    expect(view.disagree.some((d: Any) => d.linked)).toBe(true);
    expect(view.nobodyAccountable.map((d: Any) => d.dutyId)).toContain(vendor);
    expect(view.contingencies.map((c: Any) => c.label)).toContain('Septic inspection');
  });

  it('lists the Waiting room, past its day to chase first', async () => {
    const insurance = await dutyOf(purchase, 'X-07');
    await run(dana, 'realestate.duty.set_status', {
      dutyId: insurance,
      status: 'waiting_external',
      waitingOn: 'Lone Star Insurance',
    });
    await rows(
      admin(),
      sql`update addon_realestate.duties set chase_at = now() - interval '1 hour' where id = ${insurance}`,
    );
    const view = await ask(dana, 'realestate.waiting_room');
    expect(view.items[0]).toMatchObject({
      dutyId: insurance,
      waitingOn: 'Lone Star Insurance',
      status: 'waiting_external',
      past: true,
    });
  });

  it('shows Team workload only to someone who sees every deal', async () => {
    expect((await refused(ask(dana, 'realestate.workload'))).rule).toBe(
      'realestate_workload_permission',
    );
    const view = await ask(owner, 'realestate.workload');
    const byName = Object.fromEntries(view.people.map((p: Any) => [p.name, p]));
    expect(byName['Dana Reyes']).toMatchObject({ deals: 1 });
    expect(byName['Dana Reyes'].overdue).toBeGreaterThan(0);
    expect(byName['Sam Ortiz']).toMatchObject({ deals: 1, atRiskDeals: 1 });
  });

  it('filters Deals by agent, closing within some days, and who a deal waits on', async () => {
    const names = async (input: Record<string, unknown>) =>
      (await ask(owner, 'realestate.deal.list', input)).deals.map((d: Any) => d.name).sort();
    expect(await names({ agentUserId: sam.id })).toEqual(['Alvarez listing']);
    expect(await names({ closingWithinDays: 49 })).toEqual(['Alvarez purchase']);
    expect(await names({ closingWithinDays: 60 })).toEqual(['Alvarez listing', 'Alvarez purchase']);
    expect(await names({ waitingOn: 'outside' })).toEqual(['Alvarez purchase']);
    expect(await names({ waitingOn: 'blocked' })).toEqual([]);
    const row = (await ask(owner, 'realestate.deal.list', { waitingOn: 'outside' })).deals[0];
    expect(row.waiting).toEqual({
      title: 'Homeowners insurance concierge',
      who: 'Lone Star Insurance',
    });
  });
});
