/**
 * The gaps row security leaves, and how search closes each (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Who can see
 * what"), on the local database as different people. One case per gap, for the kinds search has so far; Search 3
 * adds the messages, notes, files, tasks and calendar cases as those kinds arrive.
 *
 *   1. A permission the business takes away closes its kind, though row security alone would still show its rows.
 *   6. A turned-off add-on's kinds of records hide with it, and come back when it's on.
 *   7. Customers in the bin, erased names and merged shells never show, nor lead anywhere; one found in the bin by
 *      name is listed there, with no close match over them.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionSetMember, personDelete } from '../../src/server';
import { installRealestate } from '../addons/realestate-fixture';
import {
  admin,
  allTitles,
  everything,
  expectHfos,
  groupOf,
  oneKind,
  run,
  searchWorld,
  titles,
  type World,
} from './helpers';

let w: World;
beforeAll(async () => {
  w = await searchWorld('search-gaps');
});
afterAll(closeTestDbs);

describe('1. a permission the business takes away', () => {
  it('closes its kind for that person, and search.kind refuses it with search_kind_not_allowed', async () => {
    expect(groupOf(await everything(w, w.member, 'LS-0042'), 'money')).toBeDefined();
    await run(
      permissionSetMember,
      { workspaceId: w.wsId, userId: w.member.id, permission: 'money.read', allowed: false },
      w.owner,
    );
    try {
      const a = await everything(w, w.member, 'smith');
      expect(groupOf(a, 'money')).toBeUndefined();
      expect(groupOf(a, 'contacts')).toBeDefined();
      const e = await expectHfos(
        () => oneKind(w, w.member, 'smith', 'money'),
        'search_kind_not_allowed',
        403,
      );
      expect(e.message).toMatch(
        /You need the “.+” permission for that\. An owner of this business can turn it on/,
      );
      // A chip asked for by name is still gated.
      expect((await everything(w, w.member, 'smith', { kinds: ['money'] })).groups).toEqual([]);
    } finally {
      await run(
        permissionSetMember,
        { workspaceId: w.wsId, userId: w.member.id, permission: 'money.read', allowed: null },
        w.owner,
      );
    }
  });
});

describe('6. a turned-off add-on', () => {
  it('hides its kinds of records, and they come back when it’s on; nothing errors', async () => {
    await installRealestate(w.wsId);
    await rows(
      admin(),
      sql`insert into app.custom_records (workspace_id, type_id, name)
          select ${w.wsId}, t.id, '77 Bayou Road' from app.custom_record_types t
          where t.workspace_id = ${w.wsId} and t.key = 'realestate_property'`,
    );
    const on = await everything(w, w.owner, 'bayou road');
    expect(titles(groupOf(on, 'record.realestate_property'))).toEqual(['77 Bayou Road']);
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled'
          where workspace_id = ${w.wsId} and addon_id = 'realestate'`,
    );
    try {
      const off = await everything(w, w.owner, 'bayou road');
      expect(off.groups).toEqual([]);
      expect(allTitles(off)).toEqual([]);
      await expectHfos(
        () => oneKind(w, w.owner, 'bayou road', 'record.realestate_property'),
        'search_kind_gone',
        404,
      );
      // Not even a close match leads to it.
      expect(allTitles(await everything(w, w.owner, 'bayuo raod'))).toEqual([]);
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled'
            where workspace_id = ${w.wsId} and addon_id = 'realestate'`,
      );
    }
    const back = await everything(w, w.owner, 'bayou road');
    expect(titles(groupOf(back, 'record.realestate_property'))).toEqual(['77 Bayou Road']);
  });
});

describe('7. customers in the bin, erased names and merged shells', () => {
  let binned: string;
  let merged: string;
  let erased: string;
  let invoice: string;

  beforeAll(async () => {
    const add = async (first: string, last: string, archived = false) => {
      const [p] = await rows<{ id: string }>(
        admin(),
        sql`insert into app.people (workspace_id, first_name, last_name, phone_e164, company_id, archived_at)
            values (${w.wsId}, ${first}, ${last}, '+15045557777', ${w.ids.smithfield},
              ${archived ? sql`now()` : sql`null`}) returning id`,
      );
      return p!.id;
    };
    // Archived before it was deleted: in the bin, it's under neither.
    binned = await add('Quentin', 'Fairweather', true);
    merged = await add('Quentin', 'Mergedshell');
    erased = await add('Quentin', 'Erasedname');
    const [inv] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.invoices (workspace_id, person_id, title, total_cents, subtotal_cents, public_ref)
          values (${w.wsId}, ${binned}, 'Gutter cleaning', 30000, 30000,
            ${randomUUID().replace(/-/g, '').slice(0, 8)}) returning id`,
    );
    invoice = inv!.id;
    await run(personDelete, { workspaceId: w.wsId, personIds: [binned] }, w.owner);
    await rows(
      admin(),
      sql`update app.people set merged_into_id = ${w.ids.dana}, merged_at = now() where id = ${merged}`,
    );
    await rows(admin(), sql`update app.people set erased_at = now() where id = ${erased}`);
  });

  it('shows none of them in Contacts or Archived, by name or by phone', async () => {
    for (const u of [w.owner, w.member])
      for (const q of ['quentin', 'fairweather', 'mergedshell', 'erasedname', '(504) 555-7777']) {
        const a = await everything(w, u, q);
        expect(titles(groupOf(a, 'contacts')), q).toEqual([]);
        expect(titles(a.archived), q).toEqual([]);
        expect(titles((await oneKind(w, u, q, 'contacts')).group), q).toEqual([]);
        expect(titles((await oneKind(w, u, q, 'archived')).group), q).toEqual([]);
      }
  });

  it('gives no close match to a misspelt name of a customer in the bin', async () => {
    for (const u of [w.owner, w.member]) {
      const a = await everything(w, u, 'fiarweather');
      expect(titles(groupOf(a, 'close'))).toEqual([]);
    }
  });

  it('leaves them out of a company’s people count', async () => {
    const company = groupOf(await everything(w, w.owner, 'smithfield'), 'companies')!.items[0]!;
    expect(company.facts.people).toBe(1);
  });

  it('finds an invoice of a customer in the bin by the name it keeps, with no way to call or text them', async () => {
    const money = groupOf(await everything(w, w.owner, 'fairweather'), 'money')!;
    expect(money.items[0]).toMatchObject({
      id: invoice,
      facts: { customer: 'Quentin Fairweather' },
    });
    expect(money.items[0]!.contact).toBeNull();
  });

  it('lists a customer in the bin found by name with no close matches over them, and nobody active', async () => {
    const add = async (last: string) => {
      const [p] = await rows<{ id: string }>(
        admin(),
        sql`insert into app.people (workspace_id, first_name, last_name)
            values (${w.wsId}, 'Ottoline', ${last}) returning id`,
      );
      return p!.id;
    };
    await add('Brackenbery');
    const gone = await add('Brackenbury');
    await run(personDelete, { workspaceId: w.wsId, personIds: [gone] }, w.owner);
    const owner = await everything(w, w.owner, 'ottoline brackenbury');
    expect(owner).toMatchObject({ close: false, noneActive: true, total: 0, groups: [] });
    expect(titles(owner.bin)).toEqual(['Ottoline Brackenbury']);
    // A member can't open the bin, so nothing matched for them, and the live near-namesake is the close match.
    const member = await everything(w, w.member, 'ottoline brackenbury');
    expect(member).toMatchObject({ close: true, noneActive: false, bin: null });
    expect(titles(groupOf(member, 'close'))).toEqual(['Ottoline Brackenbery']);
  });

  it('shows the Deleted bin, by name, to the owner, not a member, and to a member given Delete for good', async () => {
    const owner = await everything(w, w.owner, 'fairweather');
    expect(titles(owner.bin)).toEqual(['Quentin Fairweather']);
    expect(owner.bin!.items[0]!.href).toContain('/settings/deleted-bin?item=');
    expect((await everything(w, w.member, 'fairweather')).bin).toBeNull();
    await expectHfos(
      () => oneKind(w, w.member, 'fairweather', 'bin'),
      'search_kind_not_allowed',
      403,
    );
    // Delete for good takes Archive and restore with it.
    for (const permission of ['records.archive', 'records.delete'])
      await run(
        permissionSetMember,
        { workspaceId: w.wsId, userId: w.member.id, permission, allowed: true },
        w.owner,
      );
    try {
      expect(titles((await everything(w, w.member, 'fairweather')).bin)).toEqual([
        'Quentin Fairweather',
      ]);
      expect(titles((await oneKind(w, w.member, 'fairweather', 'bin')).group)).toEqual([
        'Quentin Fairweather',
      ]);
    } finally {
      for (const permission of ['records.delete', 'records.archive'])
        await run(
          permissionSetMember,
          { workspaceId: w.wsId, userId: w.member.id, permission, allowed: null },
          w.owner,
        );
    }
  });
});
