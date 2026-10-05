/**
 * Real Estate Agent's duty editor and settings (step 12), on the database: only owners and admins edit; drafts change
 * nothing until published; a published version is what new deals take while open deals keep theirs; "apply to this
 * deal" shows, then makes, the changes; the business's own duties follow the catalog's rules; and its settings
 * (closed days, the alert person) are checked and used.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  commands,
  executeCommand,
  executeQuery,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const op = (name: string) =>
  [...realestateAddonServer.commands!, ...realestateAddonServer.queries!, ...commands].find(
    (x) => x.name === name,
  )!;
const run = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(api(), op(name) as CommandDef, { workspaceId: ws, ...input }, human(who), {
    correlationId: randomUUID(),
    channel: 'test',
  }).then((r) => r.output);
const ask = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(who), {
    correlationId: randomUUID(),
    channel: 'test',
  });
async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { rule?: string; code?: string };
    return err.rule ?? err.code ?? String(e);
  }
  throw new Error('It was allowed.');
}
const keysOn = async (dealId: string, status?: string) =>
  (
    await rows<{ duty_key: string; status: string }>(
      admin(),
      sql`select duty_key, status from addon_realestate.duties where deal_record_id = ${dealId}
          order by duty_key`,
    )
  )
    .filter((d) => !status || d.status === status)
    .map((d) => d.duty_key);
const dueOf = async (dealId: string, key: string) =>
  (
    await rows<{ due_date: string }>(
      admin(),
      sql`select due_date::text from addon_realestate.duties
          where deal_record_id = ${dealId} and duty_key = ${key} and status <> 'cancelled'`,
    )
  )[0]?.due_date;

let owner: TestUser;
let agent: TestUser;
let ws: string;

const open = (input: Record<string, unknown>) =>
  run(agent, 'realestate.deal.open', input).then((o) => o.dealId as string);

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('red-ed-owner'),
    createTestUser('red-ed-agent'),
  ]);
  ws = await realestateBusiness(owner, 'Summit Realty');
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
}, 90_000);

afterAll(closeTestDbs);

describe('The duty editor', () => {
  let before: string;

  it('is for owners and admins', async () => {
    expect(
      await refused(
        run(agent, 'realestate.template.set_override', { dutyKey: 'B-31', enabled: false }),
      ),
    ).toBe('forbidden');
    expect(await refused(ask(agent, 'realestate.template.list', {}))).toBe('forbidden');
  });

  it('changes nothing until published, then new deals take the version and open ones keep theirs', async () => {
    before = await open({ side: 'buyer', name: 'Before purchase', stage: 'under_contract' });
    await run(agent, 'realestate.term.enter', {
      dealId: before,
      key: 'closing',
      date: '2026-11-20',
    });
    expect(await keysOn(before)).toContain('B-31');
    await run(owner, 'realestate.template.set_override', { dutyKey: 'B-31', enabled: false });
    await run(owner, 'realestate.template.set_override', {
      dutyKey: 'X-03',
      patch: { due: { kind: 'relative', to: 'closing', days: -5 } },
    });
    const listed = await ask(owner, 'realestate.template.list', {});
    expect(listed.unpublished).toBe(true);
    expect(listed.published).toBeNull();
    expect(listed.items.find((i: Any) => i.key === 'X-03').changed).toEqual(['when it’s due']);
    expect(listed.items.find((i: Any) => i.key === 'B-31').enabled).toBe(false);
    // Drafts alone change nothing.
    expect(await keysOn(await open({ side: 'buyer', name: 'Draft-time purchase' }))).toContain(
      'B-31',
    );
    const v1 = await run(owner, 'realestate.template.publish', { note: 'No intake survey' });
    expect(v1.version).toBe(1);
    expect(await refused(run(owner, 'realestate.template.publish', {}))).toBe(
      'realestate_nothing_to_publish',
    );
    const after = await open({ side: 'buyer', name: 'After purchase' });
    expect(await keysOn(after)).toEqual(['X-43']);
    expect((await ask(agent, 'realestate.deal.get', { dealId: after })).deal.templateSetId).toBe(
      v1.templateSetId,
    );
    // The open deal keeps its list.
    expect(await dueOf(before, 'X-03')).toBe('2026-11-10');
  });

  it('shows, then makes, the changes a version brings to an open deal', async () => {
    const diff = await ask(owner, 'realestate.template.diff', { dealId: before });
    expect(diff.toVersion).toBe(1);
    expect(diff.changes.cancel.map((c: Any) => c.title)).toEqual([
      'Represent, advise, reassure, and exercise judgment',
    ]);
    expect(diff.changes.redefine).toEqual([
      expect.objectContaining({ changes: ['when it’s due'] }),
    ]);
    expect(
      await refused(run(agent, 'realestate.deal.apply_template_version', { dealId: before })),
    ).toBe('forbidden');
    const applied = await run(owner, 'realestate.deal.apply_template_version', { dealId: before });
    expect(applied.version).toBe(1);
    expect(await keysOn(before, 'cancelled')).toContain('B-31');
    expect(await dueOf(before, 'X-03')).toBe('2026-11-15');
    const versions = await ask(owner, 'realestate.template.versions', {});
    // The deal applied just now and the one opened after publishing; the one opened before keeps the catalog.
    expect(versions.versions[0]).toMatchObject({ version: 1, openDeals: 2 });
  });

  it('takes the business’s own duties, held to the catalog’s rules', async () => {
    expect(
      await refused(
        run(owner, 'realestate.template.save_custom', {
          duty: {
            side: 'buyer',
            title: 'Send the welcome packet',
            tracker: 'LEAD',
            trigger: { on: 'stage', stage: 'active' },
            due: { kind: 'after_start', days: 2 },
            proof: null,
            accountable: 'agent',
            automation: 'A0',
            materiality: 'standard',
          },
        }),
      ),
    ).toBe('validation');
    const saved = await run(owner, 'realestate.template.save_custom', {
      duty: {
        side: 'buyer',
        title: 'Send the welcome packet',
        tracker: 'LEAD',
        trigger: { on: 'stage', stage: 'lead' },
        due: { kind: 'after_start', days: 2 },
        proof: { mode: 'all', items: [{ kind: 'message' }] },
        accountable: 'agent',
        automation: 'A0',
        materiality: 'standard',
      },
    });
    expect(saved.dutyKey).toBe('C-01');
    await run(owner, 'realestate.template.publish', {});
    // A deal already past the lead stage gains it when the new version is applied.
    const searching = (await ask(agent, 'realestate.deal.list', { search: 'After purchase' }))
      .deals[0].dealId;
    await run(agent, 'realestate.deal.move_stage', { dealId: searching, stage: 'searching' });
    const diff = await ask(owner, 'realestate.template.diff', { dealId: searching });
    expect(diff.changes.add).toEqual([{ key: 'C-01', title: 'Send the welcome packet' }]);
    await run(owner, 'realestate.deal.apply_template_version', { dealId: searching });
    expect(await keysOn(searching, 'not_started')).toContain('C-01');
    // A new deal gets it from the start.
    expect(await keysOn(await open({ side: 'buyer', name: 'Newest purchase' }))).toEqual([
      'C-01',
      'X-43',
    ]);
  });
});

describe('Settings', () => {
  it('are checked on save, and the business’s closed days count', async () => {
    const save = (settings: Record<string, unknown>) =>
      run(owner, 'addon.save_settings', { addonId: 'realestate', settings });
    expect(await refused(save({ closedDays: { 'not-a-date': 'x' } }))).toBe('validation');
    expect(
      await refused(
        run(agent, 'addon.save_settings', { addonId: 'realestate', settings: { closedDays: {} } }),
      ),
    ).toBe('forbidden');
    await save({ closedDays: { '2026-12-24': 'Christmas Eve' }, alertPersonUserIds: [owner.id] });
    const deal = await open({ side: 'listing', name: 'Closed-day listing', stage: 'active' });
    const added = await run(agent, 'realestate.duty.add', {
      dealId: deal,
      title: 'Holiday open house',
      dueDate: '2026-12-24',
    });
    const got = await ask(agent, 'realestate.duty.get', { dutyId: added.dutyId });
    expect(got.duty.dueDate).toBe('2026-12-24');
    await run(agent, 'realestate.duty.set_due', {
      dutyId: added.dutyId,
      date: '2026-12-24',
      time: '10:00',
      reason: 'Earlier',
    });
    expect(
      (await ask(agent, 'realestate.duty.get', { dutyId: added.dutyId })).duty.warnings,
    ).toEqual([
      expect.objectContaining({
        code: 'not_a_business_day',
        off: { reason: 'closed', name: 'Christmas Eve' },
      }),
    ]);
  });
});
