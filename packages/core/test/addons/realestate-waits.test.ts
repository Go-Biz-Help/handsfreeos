/**
 * Real Estate Agent, round four, steps 4 and 5: what a duty waits on, chasing someone outside, a blocker's review,
 * and escalation's clock (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round four"). The pure parts first (the
 * built-in order's ids and circles, a business day on), then on the database: the built-in order written once both
 * duties are on a deal, the agent's own, what the drawer shows, and the sweep's reminders.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG, catalogDuty } from '../../src/addons/realestate/catalog';
import { DUTY_ORDER, makesCircle } from '../../src/addons/realestate/catalog/order';
import { escalatesAt } from '../../src/addons/realestate/ops/health';
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

describe('the built-in order of duties', () => {
  it('names only real duties, each waiting on one that can be on the same deal', () => {
    for (const [key, firsts] of Object.entries(DUTY_ORDER)) {
      const d = catalogDuty(key)!;
      expect(d, key).toBeTruthy();
      for (const f of firsts!) {
        const first = catalogDuty(f)!;
        expect(first, `${key} waits on ${f}`).toBeTruthy();
        const sides = (x: typeof d) => (x.side === 'both' ? ['buyer', 'listing'] : [x.side]);
        expect(
          sides(d).some((s) => sides(first).includes(s)),
          `${key} and ${f} share a side`,
        ).toBe(true);
      }
    }
    expect(CATALOG.length).toBeGreaterThan(Object.keys(DUTY_ORDER).length);
  });

  it('never goes round in a circle', () => {
    const links = Object.entries(DUTY_ORDER).flatMap(([from, tos]) =>
      tos!.map((to) => ({ from, to })),
    );
    for (const l of links)
      expect(
        makesCircle(
          links.filter((x) => x !== l),
          l.from,
          l.to,
        ),
        `${l.from} → ${l.to}`,
      ).toBe(false);
    expect(
      makesCircle(
        [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
        'c',
        'a',
      ),
    ).toBe(true);
    expect(makesCircle([], 'a', 'a')).toBe(true);
  });
});

describe('escalation’s clock', () => {
  it('is the same time on the next business day where the business is', () => {
    // Fri, Oct 2, 3:00 PM Central → Mon, Oct 5, 3:00 PM Central.
    const fri = new Date('2026-10-02T20:00:00Z');
    expect(
      new Date(escalatesAt(fri, 'America/Chicago', { closedDays: new Map() })).toISOString(),
    ).toBe('2026-10-05T20:00:00.000Z');
    // Monday closed: Tuesday.
    expect(
      new Date(
        escalatesAt(fri, 'America/Chicago', { closedDays: new Map([['2026-10-05', 'Retreat']]) }),
      ).toISOString(),
    ).toBe('2026-10-06T20:00:00.000Z');
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
let today: string;

const dutyId = async (key: string) => {
  const [d] = await rows<{ id: string }>(
    admin(),
    sql`select id from addon_realestate.duties where deal_record_id = ${deal} and duty_key = ${key}
        order by pass desc limit 1`,
  );
  if (!d) throw new Error(`no ${key}`);
  return d.id;
};
const sweep = async (): Promise<Any> =>
  (
    await executeCommand(
      worker(),
      op('realestate.sweep') as CommandDef,
      { workspaceId: ws },
      { type: 'system', workspaceId: ws, organizationId: org },
      { correlationId: randomUUID(), channel: 'worker' },
    )
  ).output;

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rwa-owner'),
    createTestUser('rwa-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Waits Realty');
  const [w] = await rows<{ org: string; tz: string }>(
    admin(),
    sql`select organization_id as org, timezone as tz from app.workspaces where id = ${ws}`,
  );
  org = w!.org;
  today = localDateOf(Date.now(), w!.tz);
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
  await run(agent, 'realestate.term.enter', { dealId: deal, key: 'acceptance', date: today });
  await run(agent, 'realestate.term.enter', {
    dealId: deal,
    key: 'closing',
    date: addDays(today, 30),
  });
  await run(agent, 'realestate.term.enter', {
    dealId: deal,
    key: 'inspection_end',
    date: addDays(today, 2),
  });
}, 90_000);

afterAll(closeTestDbs);

describe('What a duty waits on', () => {
  it('is written from the built-in order once both duties are on the deal, and shown in the drawer', async () => {
    const attend = await dutyId('B-20'); // Attend inspection
    const schedule = await dutyId('B-19'); // Schedule inspections
    const got = await ask(agent, 'realestate.duty.get', { dutyId: attend });
    expect(got.waitsOn).toEqual([
      expect.objectContaining({ dutyId: schedule, builtIn: true, addedByName: null }),
    ]);
    const first = await ask(agent, 'realestate.duty.get', { dutyId: schedule });
    expect(first.waitingOnThis.map((w: Any) => w.dutyId)).toEqual([attend]);
    expect(first.ifItSlips.waiting).toEqual(['Attend inspection']);
    // The built-in order stays.
    expect(
      (await refused(run(agent, 'realestate.duty.unlink', { dutyId: attend, waitsOnId: schedule })))
        .rule,
    ).toBe('realestate_duty_link_built_in');
  });

  it('takes the agent’s own, never in a circle, and gives it back', async () => {
    const attend = await dutyId('B-20');
    const schedule = await dutyId('B-19');
    const vendors = await dutyId('B-18'); // Recommend inspectors and vendors
    await run(agent, 'realestate.duty.link', { dutyId: schedule, waitsOnId: vendors });
    const got = await ask(agent, 'realestate.duty.get', { dutyId: schedule });
    expect(got.waitsOn).toEqual([
      expect.objectContaining({ dutyId: vendors, builtIn: false, addedByName: 'Dana Reyes' }),
    ]);
    const circle = await refused(
      run(agent, 'realestate.duty.link', { dutyId: vendors, waitsOnId: attend }),
    );
    expect(circle.rule).toBe('realestate_duty_link_circle');
    expect(circle.message).toBe(
      '“Attend inspection” already waits on “Recommend inspectors and vendors”, so “Recommend inspectors and vendors” can’t wait on it too. Pick a different duty.',
    );
    await run(agent, 'realestate.duty.unlink', { dutyId: schedule, waitsOnId: vendors });
    expect((await ask(agent, 'realestate.duty.get', { dutyId: schedule })).waitsOn).toEqual([]);
  });

  it('yellows the deal when a duty due soon waits on one still open', async () => {
    const risks = await ask(agent, 'realestate.deal.risks', { dealId: deal });
    expect(risks.reasons.map((r: Any) => r.code)).toContain('prerequisite_open');
  });
});

describe('Waiting on someone outside, and a blocker', () => {
  it('has a day to chase them, moved on by saying you chased', async () => {
    const lender = await dutyId('X-07'); // Homeowners insurance concierge
    await run(agent, 'realestate.duty.set_status', {
      dutyId: lender,
      status: 'waiting_external',
      waitingOn: 'Lone Star Insurance',
      chaseOn: addDays(today, 3),
    });
    let got = await ask(agent, 'realestate.duty.get', { dutyId: lender });
    expect(got.duty.waitingSince).toBeTruthy();
    expect(localDateOf(Date.parse(got.duty.chaseAt), 'America/Chicago')).toBe(addDays(today, 3));
    // Past the day to chase: yellow, and a reminder on the sweep.
    await rows(
      admin(),
      sql`update addon_realestate.duties set chase_at = now() - interval '1 hour' where id = ${lender}`,
    );
    expect(
      (await ask(agent, 'realestate.deal.risks', { dealId: deal })).reasons.map((r: Any) => r.code),
    ).toContain('waiting_long');
    const out = await sweep();
    expect(out.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: `chase:${lender}`,
          title: 'Smith purchase: chase Lone Star Insurance about “Homeowners insurance concierge”',
        }),
      ]),
    );
    await run(agent, 'realestate.duty.chased', { dutyId: lender });
    got = await ask(agent, 'realestate.duty.get', { dutyId: lender });
    expect(Date.parse(got.duty.chaseAt)).toBeGreaterThan(Date.now());
    expect(got.log.map((l: Any) => l.what)).toContain('chased');
    // Not waiting on anyone: nothing to chase.
    await run(agent, 'realestate.duty.set_status', { dutyId: lender, status: 'in_progress' });
    expect((await refused(run(agent, 'realestate.duty.chased', { dutyId: lender }))).rule).toBe(
      'realestate_duty_not_waiting',
    );
    expect((await ask(agent, 'realestate.duty.get', { dutyId: lender })).duty.chaseAt).toBeNull();
  });

  it('reminds whoever answers for a blocked duty once its review time passes', async () => {
    const title = await dutyId('X-09'); // Title and escrow tracker
    await run(agent, 'realestate.duty.set_status', {
      dutyId: title,
      status: 'blocked',
      blocker: {
        what: 'Seller’s payoff letter',
        owner: 'the seller’s lender',
        impact: 'The title commitment',
        reviewAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect((await sweep()).risks.some((r: Any) => r.key === `blocker:${title}`)).toBe(false);
    await rows(
      admin(),
      sql`update addon_realestate.duties set blocker_review_at = now() - interval '1 hour' where id = ${title}`,
    );
    const out = await sweep();
    expect(out.risks.find((r: Any) => r.key === `blocker:${title}`)).toMatchObject({
      severity: 'attention',
      title: 'Smith purchase: look again at “Title and escrow tracker”',
      detail:
        'It’s blocked: Seller’s payoff letter (the seller’s lender to clear). Clear it, or set when to look again.',
    });
    void owner;
  });
});
