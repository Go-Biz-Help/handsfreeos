/**
 * Deleting for good, round two (20261027000700): a lead, a company, or a record of one of the business's own kinds
 * goes in the Deleted bin too, with what's only about it, and comes back from it.
 *   - Owners only, never the AI, a workflow or the system, as round one.
 *   - What an add-on keeps or manages stays, and the refusal names the add-on.
 *   - Something of another business the owner also runs isn't deleted through this one.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  binList,
  binPreview,
  binRestore,
  companyCreate,
  companyDelete,
  companyGet,
  customRecordCreate,
  customRecordDelete,
  customRecordGet,
  customRecordTypeCreate,
  leadCreate,
  leadDelete,
  leadGet,
  organizationCreate,
  personGet,
  taskCreate,
} from '../src/server';
import {
  admin,
  ask,
  CHI,
  customer,
  expectHfos,
  nextPhone,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;

beforeAll(async () => {
  t = await setupTeam('bin2');
});
afterAll(closeTestDbs);

const events = (type: string, entityId: string) =>
  rows<{ payload: Record<string, unknown> }>(
    admin(),
    sql`select payload from app.events where event_type = ${type} and entity_id = ${entityId} order by occurred_at`,
  );

const company = async (name: string, workspaceId = t.wsId) =>
  (await run(companyCreate, { workspaceId, name, ignoreDuplicates: true }, t.owner)).companyId;

describe('who may delete a lead, a company or a record', () => {
  it('is an owner, never a member unless given it, nor the system', async () => {
    const c = await company('Wes Supply');
    await expectHfos(
      () => run(companyDelete, { workspaceId: t.wsId, companyIds: [c] }, t.member),
      'forbidden',
      403,
    );
    await expectHfos(
      () => runSystem(companyDelete, { workspaceId: t.wsId, companyIds: [c] }, t.scope),
      'forbidden',
    );
    for (const command of [leadDelete, companyDelete, customRecordDelete])
      expect(command.risk).toBe(4);
  });
});

describe('deleting a lead', () => {
  it('takes its tasks, leaves its customer, and comes back', async () => {
    const dana = await customer(t, 'Dana', nextPhone());
    const { leadId } = await run(
      leadCreate,
      { workspaceId: t.wsId, title: 'Heat pump', personId: dana },
      t.owner,
    );
    await run(taskCreate, { workspaceId: t.wsId, title: 'Price it', leadId }, t.owner);

    const { items } = await ask(
      binPreview,
      { workspaceId: t.wsId, kind: 'lead', ids: [leadId] },
      t.owner,
    );
    expect(items).toEqual([
      {
        id: leadId,
        name: 'Heat pump',
        contents: expect.objectContaining({ tasks: 1, who: ['Dana Customer'] }),
        rule: null,
        message: null,
      },
    ]);

    const out = await run(leadDelete, { workspaceId: t.wsId, leadIds: [leadId] }, t.owner);
    expect(out.deleted).toEqual([{ id: leadId, binItemId: expect.any(String), name: 'Heat pump' }]);
    expect((await events('lead.deleted', leadId))[0]!.payload).toMatchObject({
      name: 'Heat pump',
      binItemId: out.deleted[0]!.binItemId,
    });
    await expectHfos(
      () => ask(leadGet, { workspaceId: t.wsId, leadId }, t.owner),
      'not_found',
      404,
    );
    expect((await ask(personGet, { workspaceId: t.wsId, personId: dana }, t.owner)).person.id).toBe(
      dana,
    );
    const bin = await ask(binList, { workspaceId: t.wsId }, t.owner);
    expect(bin.items.find((b) => b.recordId === leadId)).toMatchObject({
      kind: 'lead',
      name: 'Heat pump',
      contents: { tasks: 1, who: ['Dana Customer'] },
    });

    const back = await run(
      binRestore,
      { workspaceId: t.wsId, binItemId: out.deleted[0]!.binItemId },
      t.owner,
    );
    expect(back).toEqual({ kind: 'lead', recordId: leadId, name: 'Heat pump', joined: 0 });
    expect(
      (await ask(leadGet, { workspaceId: t.wsId, leadId }, t.owner)).lead.archivedAt,
    ).toBeNull();
  });
});

describe('deleting a company', () => {
  it('leaves its people, and comes back', async () => {
    const c = await company('Acme Plumbing');
    const sam = await customer(t, 'Sam', nextPhone());
    await rows(admin(), sql`update app.people set company_id = ${c} where id = ${sam}`);
    const { items } = await ask(
      binPreview,
      { workspaceId: t.wsId, kind: 'company', ids: [c] },
      t.owner,
    );
    expect(items[0]).toMatchObject({ name: 'Acme Plumbing', contents: { people: 1 }, rule: null });

    const out = await run(companyDelete, { workspaceId: t.wsId, companyIds: [c] }, t.owner);
    await expectHfos(
      () => ask(companyGet, { workspaceId: t.wsId, companyId: c }, t.owner),
      'not_found',
      404,
    );
    expect((await ask(personGet, { workspaceId: t.wsId, personId: sam }, t.owner)).person.id).toBe(
      sam,
    );
    expect((await events('company.deleted', c)).length).toBe(1);

    const back = await run(
      binRestore,
      { workspaceId: t.wsId, binItemId: out.deleted[0]!.binItemId },
      t.owner,
    );
    expect(back).toMatchObject({ kind: 'company', recordId: c, name: 'Acme Plumbing' });
    const again = await ask(companyGet, { workspaceId: t.wsId, companyId: c }, t.owner);
    expect(again.company.archivedAt).toBeNull();
  });

  it('stays while an add-on keeps it, and says which add-on', async () => {
    const c = await company('Pine Inspections');
    await rows(
      admin(),
      sql`insert into addon_realestate.vendors (workspace_id, company_id, services)
          values (${t.wsId}, ${c}, array['inspection'])`,
    );
    const said =
      'Pine Inspections is used by the Real Estate Agent add-on, so it has to stay. Archive it instead.';
    const { items } = await ask(
      binPreview,
      { workspaceId: t.wsId, kind: 'company', ids: [c] },
      t.owner,
    );
    expect(items[0]).toMatchObject({ rule: 'bin_addon_uses', message: said });
    const e = await expectHfos(
      () => run(companyDelete, { workspaceId: t.wsId, companyIds: [c] }, t.owner),
      'bin_addon_uses',
      409,
    );
    expect(e.message).toBe(said);
  });
});

describe('deleting a record of the business’s own kind', () => {
  it('takes it, and brings it back', async () => {
    const { customRecordTypeId } = await run(
      customRecordTypeCreate,
      { workspaceId: t.wsId, singular: 'Pet', plural: 'Pets' },
      t.owner,
    );
    const { customRecordId } = await run(
      customRecordCreate,
      { workspaceId: t.wsId, typeId: customRecordTypeId, name: 'Rex' },
      t.owner,
    );
    const out = await run(
      customRecordDelete,
      { workspaceId: t.wsId, customRecordIds: [customRecordId] },
      t.owner,
    );
    expect(out.deleted).toEqual([
      { id: customRecordId, binItemId: expect.any(String), name: 'Rex' },
    ]);
    await expectHfos(
      () => ask(customRecordGet, { workspaceId: t.wsId, customRecordId }, t.owner),
      'not_found',
      404,
    );
    const bin = await ask(binList, { workspaceId: t.wsId }, t.owner);
    expect(bin.items.find((b) => b.recordId === customRecordId)).toMatchObject({
      kind: 'custom_record',
      contents: { type: 'Pet' },
    });
    await run(binRestore, { workspaceId: t.wsId, binItemId: out.deleted[0]!.binItemId }, t.owner);
    expect(
      (await ask(customRecordGet, { workspaceId: t.wsId, customRecordId }, t.owner)).record.id,
    ).toBe(customRecordId);
  });

  it('refuses an add-on’s record, naming the add-on', async () => {
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${t.wsId}, 'realestate', 'enabled', '1.0.0')
          on conflict (workspace_id, addon_id) do update set state = 'enabled'`,
    );
    const [kind] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission)
          values (${t.wsId}, 'deal_bin', 'Deal', 'Deals', 'realestate', 'realestate.use') returning id`,
    );
    const [deal] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.custom_records (workspace_id, type_id, name) values (${t.wsId}, ${kind!.id}, '12 Elm St')
          returning id`,
    );
    const e = await expectHfos(
      () => run(customRecordDelete, { workspaceId: t.wsId, customRecordIds: [deal!.id] }, t.owner),
      'bin_record_addon',
      409,
    );
    expect(e.message).toBe(
      '12 Elm St belongs to the Real Estate Agent add-on, so it can only be archived.',
    );
  });
});

describe('another business the owner runs', () => {
  it('keeps its own: nothing of it is deleted through this one', async () => {
    const other = await run(
      organizationCreate,
      { businessName: 'bin2 Second Shop', timezone: CHI },
      t.owner,
    );
    const theirs = await company('Second Shop Supply', other.workspaceId);
    await expectHfos(
      () => run(companyDelete, { workspaceId: t.wsId, companyIds: [theirs] }, t.owner),
      'bin_record_gone',
      404,
    );
    expect(
      (await ask(companyGet, { workspaceId: other.workspaceId, companyId: theirs }, t.owner))
        .company.id,
    ).toBe(theirs);
    expect((await ask(binList, { workspaceId: other.workspaceId }, t.owner)).items).toEqual([]);
  });
});
