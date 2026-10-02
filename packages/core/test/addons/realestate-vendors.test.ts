/**
 * Real Estate Agent, round five, step 9: the vendors directory.
 *
 * - A vendor is a company in Contacts with its services, areas and any disclosure; anyone working deals adds one,
 *   and only someone who runs the deal settings approves or archives it.
 * - On a duty, every approved vendor that does what it needs is offered, those working where the home is first; the
 *   picked one's disclosure is said on the deal, and their quote and appointment are kept with it.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import { inArea, serviceForDuty, servicesWords } from '../../src/addons/realestate/vendors';
import {
  executeCommand,
  executeQuery,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const op = (name: string) =>
  [...(realestateAddonServer.commands ?? []), ...(realestateAddonServer.queries ?? [])].find(
    (x) => x.name === name,
  )!;
const runAs = (u: TestUser, name: string, input: Record<string, unknown>): Promise<Any> => {
  const found = op(name);
  return found.kind === 'command'
    ? executeCommand(
        api(),
        found as CommandDef,
        { workspaceId: ws, ...input },
        human(u),
        meta(),
      ).then((r) => r.output)
    : executeQuery(api(), found as QueryDef, { workspaceId: ws, ...input }, human(u), meta());
};
const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'went through',
    (e: { rule?: string; code?: string }) => e.rule ?? e.code,
  );

let owner: TestUser;
let agent: TestUser;
let ws: string;
let deal: string;
let inspections: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rvn-owner'),
    createTestUser('rvn-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Vendor Realty');
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  deal = (
    await runAs(agent, 'realestate.deal.open', {
      side: 'buyer',
      name: 'Kim purchase',
      stage: 'under_contract',
      newPropertyAddress: '12 Oak St, Austin, TX 78704',
    })
  ).dealId;
  const [d] = await rows<{ id: string }>(
    admin(),
    sql`select id from addon_realestate.duties
        where deal_record_id = ${deal} and title = 'Recommend inspectors and vendors'
        order by title limit 1`,
  );
  inspections = d!.id;
}, 120_000);
afterAll(closeTestDbs);

describe('vendors, in words', () => {
  it('know a duty’s service from its title, and whether a vendor works where the home is', () => {
    expect(serviceForDuty('Schedule inspections')).toBe('inspection');
    expect(serviceForDuty('Book the photographer')).toBe('photos');
    expect(serviceForDuty('Order the insurance binder')).toBe('insurance');
    expect(serviceForDuty('Confirm the closing date')).toBeNull();
    expect(inArea(['Austin metro'], '12 Oak St, Austin, TX 78704')).toBe(true);
    expect(inArea(['Texas'], '12 Oak St, Austin, TX 78704')).toBe(true);
    expect(inArea(['Round Rock'], '12 Oak St, Austin, TX 78704')).toBe(false);
    expect(inArea([], '12 Oak St, Austin, TX 78704')).toBeNull();
    expect(servicesWords(['hvac', 'repairs'])).toBe('HVAC, repairs');
  });
});

describe('the directory', () => {
  it('takes a vendor from anyone working deals, as a company in Contacts, waiting for approval', async () => {
    const lone = await runAs(agent, 'realestate.vendor.save', {
      name: 'Lone Star Inspections',
      email: 'book@lonestar.example',
      services: ['inspection'],
      areas: ['Austin metro'],
    });
    ids['lone'] = lone.vendorId;
    expect(lone.approved).toBe(false);
    const [c] = await rows<{ name: string }>(
      admin(),
      sql`select name from app.companies where id = ${lone.companyId}`,
    );
    expect(c!.name).toBe('Lone Star Inspections');
    // The same company again is the same vendor.
    expect(
      await refused(
        runAs(agent, 'realestate.vendor.save', {
          name: 'lone star inspections',
          services: ['inspection'],
        }),
      ),
    ).toBe('realestate_vendor_exists');
    // Only someone who runs the deal settings approves.
    expect(
      await refused(
        runAs(agent, 'realestate.vendor.approve', { vendorId: lone.vendorId, approved: true }),
      ),
    ).toBe('forbidden');
    expect(
      (await runAs(owner, 'realestate.vendor.approve', { vendorId: lone.vendorId, approved: true }))
        .approved,
    ).toBe(true);
    const mortgage = await runAs(owner, 'realestate.vendor.save', {
      name: 'First Texas Mortgage',
      services: ['lender'],
      areas: ['Texas'],
      disclosure: 'owned in part by Dana Reyes',
    });
    ids['mortgage'] = mortgage.vendorId;
    await runAs(owner, 'realestate.vendor.approve', {
      vendorId: mortgage.vendorId,
      approved: true,
    });
    ids['cheap'] = (
      await runAs(agent, 'realestate.vendor.save', {
        name: 'Quick Look Inspect',
        services: ['inspection'],
        areas: ['Round Rock'],
      })
    ).vendorId;
    const list = (await runAs(agent, 'realestate.vendor.list', {})).vendors;
    expect(list.map((v: Any) => [v.name, v.approved])).toEqual([
      ['First Texas Mortgage', true],
      ['Lone Star Inspections', true],
      ['Quick Look Inspect', false],
    ]);
    expect(list[0].disclosureWords).toBe('Disclosure: owned in part by Dana Reyes');
  });
});

describe('a vendor on a duty', () => {
  it('offers every approved vendor that does it, those where the home is first, and picks one', async () => {
    const v = await runAs(agent, 'realestate.duty.vendors', { dutyId: inspections });
    expect(v).toMatchObject({ service: 'inspection', serviceLabel: 'Home inspection' });
    expect(v.fits.map((f: Any) => [f.name, f.inArea])).toEqual([['Lone Star Inspections', true]]);
    expect(
      await refused(
        runAs(agent, 'realestate.duty.pick_vendor', {
          dutyId: inspections,
          vendorId: ids['cheap'],
        }),
      ),
    ).toBe('realestate_vendor_not_approved');
    const pick = await runAs(agent, 'realestate.duty.pick_vendor', {
      dutyId: inspections,
      vendorId: ids['lone'],
    });
    expect(
      await refused(
        runAs(agent, 'realestate.duty.pick_vendor', { dutyId: inspections, vendorId: ids['lone'] }),
      ),
    ).toBe('realestate_vendor_picked');
    // A vendor for something they don't do is refused, saying so.
    expect(
      await refused(
        runAs(agent, 'realestate.duty.pick_vendor', {
          dutyId: inspections,
          vendorId: ids['mortgage'],
          service: 'inspection',
        }),
      ),
    ).toBe('validation');
    // Its quote and appointment stay with it.
    expect(
      await refused(
        runAs(agent, 'realestate.duty.vendor_quote', {
          pickId: pick.pickId,
          cents: 47_500,
          documentId: randomUUID(),
        }),
      ),
    ).toBe('not_found');
    await runAs(agent, 'realestate.duty.vendor_quote', { pickId: pick.pickId, cents: 47_500 });
    const after = await runAs(agent, 'realestate.duty.vendors', { dutyId: inspections });
    expect(after.picks).toEqual([
      expect.objectContaining({
        pickId: pick.pickId,
        service: 'inspection',
        quoteCents: 47_500,
        quoteWords: '$475',
        pickedByName: 'Dana Reyes',
        removedAt: null,
      }),
    ]);
  });

  it('says a vendor’s disclosure on the deal when they’re picked', async () => {
    await runAs(agent, 'realestate.duty.pick_vendor', {
      dutyId: inspections,
      vendorId: ids['mortgage'],
      service: 'lender',
    });
    const [line] = await rows<{ words: string; body: string | null }>(
      admin(),
      sql`select meta->>'words' as words, body from app.activities
          where custom_record_id = ${deal} and subtype = 'addon_line'
            and meta->>'words' like 'picked First Texas Mortgage%'`,
    );
    expect(line).toMatchObject({ body: 'Disclosure: owned in part by Dana Reyes' });
  });

  it('keeps what was picked when a vendor is taken off or archived', async () => {
    const pick = (
      await runAs(agent, 'realestate.duty.vendors', { dutyId: inspections })
    ).picks.find((p: Any) => p.vendor.name === 'First Texas Mortgage');
    await runAs(agent, 'realestate.duty.unpick_vendor', {
      pickId: pick.pickId,
      reason: 'They’re using their own lender.',
    });
    expect(
      await refused(runAs(agent, 'realestate.vendor.archive', { vendorId: ids['lone'] })),
    ).toBe('forbidden');
    await runAs(owner, 'realestate.vendor.archive', { vendorId: ids['lone'] });
    const v = await runAs(agent, 'realestate.duty.vendors', { dutyId: inspections });
    expect(v.fits).toEqual([]);
    expect(v.picks.map((p: Any) => [p.vendor.name, p.vendor.archived, p.removedReason])).toEqual(
      expect.arrayContaining([
        ['Lone Star Inspections', true, null],
        ['First Texas Mortgage', false, 'They’re using their own lender.'],
      ]),
    );
    expect(
      (await runAs(agent, 'realestate.vendor.list', {})).vendors.map((x: Any) => x.name),
    ).not.toContain('Lone Star Inspections');
  });
});
