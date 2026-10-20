/**
 * Who sees what in a search (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Who can see what"), on the local database,
 * for the kinds search has so far; Search 3 adds the inbox, calendar, notes and files cases.
 *
 *   - A staff view-as: nobody holds a permission there, so the gates are skipped and row security alone decides;
 *     the bin needs Delete for good in the database too, so it comes back empty.
 *   - A teammate view: the teammate's own permissions, and Only mine is theirs.
 *   - A money member finds only the bills of jobs they're on, by number and by amount.
 *   - A private deal is found by its team and nobody else.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand, executeQuery } from '../../src/kernel/execute';
import type { RequestMeta } from '../../src/kernel/types';
import {
  permissionSetMember,
  platformViewAsEnd,
  platformViewAsStart,
  searchEverything,
  searchKind,
  teammateViewEnd,
  teammateViewStart,
} from '../../src/server';
import { installRealestate } from '../addons/realestate-fixture';
import { human } from '../calendar-helpers';
import { admin, everything, groupOf, run, searchWorld, titles, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await searchWorld('search-seen');
});
afterAll(closeTestDbs);

const meta = (viewAs?: string): RequestMeta => ({
  correlationId: randomUUID(),
  channel: 'test',
  ...(viewAs ? { viewAs } : {}),
});

describe('a staff view-as', () => {
  let staff: TestUser;
  beforeAll(async () => {
    staff = await createTestUser('search-seen-staff');
    await rows(
      admin(),
      sql`insert into platform.staff (user_id, role) values (${staff.id}, 'agent')
          on conflict (user_id) do update set role = 'agent', status = 'active'`,
    );
    await executeCommand(
      testDbs().api.db,
      platformViewAsStart,
      { workspaceId: w.wsId, reason: 'Checking why search finds nothing for them', minutes: 15 },
      human(staff),
      meta(),
    );
  });
  afterAll(async () => {
    await executeCommand(testDbs().api.db, platformViewAsEnd, {}, human(staff), meta());
  });

  it('skips the gates, so row security alone decides, and the bin comes back empty', async () => {
    const ask = (q: string) =>
      executeQuery(
        testDbs().api.db,
        searchEverything,
        { workspaceId: w.wsId, q },
        human(staff),
        meta(),
      );
    const a = await ask('smith');
    expect(titles(groupOf(a, 'contacts')).length).toBeGreaterThan(0);
    expect(titles(groupOf(a, 'record.pets'))).toEqual(['Rex Smith']);
    expect(a.bin).toBeNull();
    const bin = await executeQuery(
      testDbs().api.db,
      searchKind,
      { workspaceId: w.wsId, q: 'smith', kind: 'bin' },
      human(staff),
      meta(),
    );
    expect(bin.group.items).toEqual([]);
  });
});

describe('a teammate view', () => {
  it('searches with the teammate’s own permissions, and Only mine is theirs', async () => {
    await run(
      permissionSetMember,
      { workspaceId: w.wsId, userId: w.member.id, permission: 'money.read', allowed: false },
      w.owner,
    );
    const { view } = await run(
      teammateViewStart,
      { workspaceId: w.wsId, userId: w.member.id },
      w.owner,
    );
    try {
      const asMember = (q: string, more: Record<string, unknown> = {}) =>
        executeQuery(
          testDbs().api.db,
          searchEverything,
          { workspaceId: w.wsId, q, ...more },
          human(w.owner),
          meta(view.id),
        );
      expect(groupOf(await asMember('LS-0042'), 'money')).toBeUndefined();
      expect(groupOf(await everything(w, w.owner, 'LS-0042'), 'money')).toBeDefined();
      const mine = await asMember('smith', { onlyMine: true });
      expect(titles(groupOf(mine, 'contacts'))).toEqual(['Dana Smith']);
    } finally {
      await run(teammateViewEnd, { viewId: view.id }, w.owner);
      await run(
        permissionSetMember,
        { workspaceId: w.wsId, userId: w.member.id, permission: 'money.read', allowed: null },
        w.owner,
      );
    }
  });
});

describe('a money member', () => {
  it('finds only the bills of jobs they’re on, by number and by amount', async () => {
    // The member is Dana's owner, so Dana's bills are theirs; Marcus's aren't.
    expect(groupOf(await everything(w, w.member, '2026-1042'), 'money')).toBeUndefined();
    expect(groupOf(await everything(w, w.member, '$1,280'), 'money')).toBeUndefined();
    expect(titles(groupOf(await everything(w, w.member, 'LS-0042'), 'money'))).toEqual([
      'Estimate #LS-0042',
    ]);
    expect(titles(groupOf(await everything(w, w.member, '$999'), 'money'))).toEqual([
      'Estimate #LS-0042',
    ]);
    expect(titles(groupOf(await everything(w, w.owner, '2026-1042'), 'money'))[0]).toBe(
      'Invoice #2026-1042',
    );
    // A member who isn't on any of these jobs finds no money at all.
    expect(groupOf(await everything(w, w.marco, 'smith'), 'money')).toBeUndefined();
  });
});

describe('a private deal', () => {
  it('is found by its team, and by nobody off it', async () => {
    await installRealestate(w.wsId);
    await rows(
      admin(),
      sql`insert into app.custom_records (workspace_id, type_id, name, kept_to_team, owner_user_id, team_user_ids)
          select ${w.wsId}, t.id, 'Pelican Court purchase', true, ${w.priya.id}, array[${w.marco.id}]::uuid[]
          from app.custom_record_types t where t.workspace_id = ${w.wsId} and t.key = 'realestate_deal'`,
    );
    for (const u of [w.priya, w.marco])
      expect(titles(groupOf(await everything(w, u, 'pelican'), 'record.realestate_deal'))).toEqual([
        'Pelican Court purchase',
      ]);
    expect((await everything(w, w.member, 'pelican')).groups).toEqual([]);
    expect(titles(groupOf(await everything(w, w.member, 'pelcian'), 'close'))).toEqual([]);
  });
});
