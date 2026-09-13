import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { organizationMemberships, workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

/** Org A's owner (also workspace A's owner). */
let owner: TestUser;
let orgAdmin: TestUser;
/** Workspace A's own owner, not in the organization. */
let bizOwner: TestUser;
let member: TestUser;
let outsider: TestUser;
let wsA: string;
let orgA: string;
let wsB: string;
let orgB: string;

const worker = (ws: string, org: string) => asService({ workspaceId: ws, organizationId: org });
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;

beforeAll(async () => {
  [owner, orgAdmin, bizOwner, member, outsider] = await Promise.all([
    createTestUser('kb-owner'),
    createTestUser('kb-org-admin'),
    createTestUser('kb-biz-owner'),
    createTestUser('kb-member'),
    createTestUser('kb-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Knowledge Org A', 'Knowledge A');
  wsA = a.wsId;
  orgA = a.orgId;
  const b = await bootstrapOrganization(outsider, 'Knowledge Org B', 'Knowledge B');
  wsB = b.wsId;
  orgB = b.orgId;
  await dbs.admin.db
    .insert(organizationMemberships)
    .values([{ organizationId: orgA, userId: orgAdmin.id, role: 'admin' }]);
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: wsA, userId: bizOwner.id, role: 'owner' },
    { workspaceId: wsA, userId: member.id, role: 'member' },
  ]);
});
afterAll(closeAll);

/** An item written by `user` (an owner or admin), as knowledge_item.create would. */
async function item(user: TestUser, title: string, useCount = 0) {
  const [i] = await as(user)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.knowledge_items (workspace_id, kind, title, body, created_by, updated_by, use_count)
          values (${wsA}, 'fact', ${title}, 'We cover Travis and Williamson counties.', ${user.id}, ${user.id}, ${useCount})
          returning id`,
    ),
  );
  return i!.id;
}

async function suggestion(reason = 'scan', groupKey: string | null = null) {
  const [s] = await worker(
    wsA,
    orgA,
  )((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.knowledge_suggestions (workspace_id, kind, proposed, reason, group_key, source)
          values (${wsA}, 'faq', '{"title": "Do you offer financing?", "body": ""}',
            ${reason}::app.knowledge_suggestion_reason, ${groupKey}, '{"url": "https://example.com/faq"}')
          returning id`,
    ),
  );
  return s!.id;
}

describe('knowledge base: who reads and who writes', () => {
  it('everyone in the workspace reads the profile, items and suggestions; outsiders see none', async () => {
    await as(bizOwner)((tx) =>
      tx.execute(sql`insert into app.knowledge_profiles (workspace_id, profile, updated_by)
        values (${wsA}, '{"description": "Heating and air in Austin", "tone": "friendly"}', ${bizOwner.id})`),
    );
    const itemId = await item(bizOwner, 'Service area');
    const suggestionId = await suggestion();
    const seen = (user: TestUser) =>
      as(user)((tx) =>
        rows<{ n: number }>(
          tx,
          sql`select (select count(*) from app.knowledge_profiles where workspace_id = ${wsA})
                + (select count(*) from app.knowledge_items where id = ${itemId})
                + (select count(*) from app.knowledge_suggestions where id = ${suggestionId}) as n`,
        ),
      ).then((r) => Number(r[0]!.n));
    expect(await seen(member)).toBe(3);
    expect(await seen(owner)).toBe(3);
    expect(await seen(outsider)).toBe(0);
  });

  it('members cannot edit; owners and admins can, saying who changed it; use counts are the system’s', async () => {
    expect(await code(() => item(member, 'Hours'))).toBe('42501');
    const id = await item(bizOwner, 'Hours');
    const touched = await as(member)((tx) =>
      rows(tx, sql`update app.knowledge_items set title = 'Mine' where id = ${id} returning id`),
    );
    expect(touched).toHaveLength(0);
    // Another manager's edit must name them.
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.knowledge_items set title = 'Opening hours' where id = ${id}`),
        ),
      ),
    ).toBe('42501');
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.knowledge_items set title = 'Opening hours', status = 'published', updated_by = ${owner.id}
            where id = ${id}`,
      ),
    );
    expect(
      await code(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.knowledge_items set use_count = 99 where id = ${id}`),
        ),
      ),
    ).toBe('42501');
    expect(await code(() => item(bizOwner, 'Warranty', 5))).toBe('42501');
    // knowledge_item.record_use, as the system.
    await worker(
      wsA,
      orgA,
    )((tx) =>
      tx.execute(
        sql`update app.knowledge_items set use_count = use_count + 1, last_used_at = now() where id = ${id}`,
      ),
    );
    const [row] = await rows<{ use_count: number; updated_by: string }>(
      dbs.admin.db,
      sql`select use_count, updated_by from app.knowledge_items where id = ${id}`,
    );
    expect(row).toEqual({ use_count: 1, updated_by: owner.id });
  });

  it('only the system proposes; a manager decides a suggestion once', async () => {
    expect(
      await code(() =>
        as(bizOwner)((tx) =>
          tx.execute(sql`insert into app.knowledge_suggestions (workspace_id, kind, proposed, reason)
            values (${wsA}, 'faq', '{}', 'scan')`),
        ),
      ),
    ).toBe('42501');
    const id = await suggestion();
    const accepted = await item(bizOwner, 'Do you offer financing?');
    const decide = (user: TestUser) =>
      as(user)((tx) =>
        rows(
          tx,
          sql`update app.knowledge_suggestions
              set status = 'accepted', item_id = ${accepted}, decided_by = ${user.id}, decided_at = now()
              where id = ${id} and status = 'pending' returning id`,
        ),
      );
    expect(await decide(member)).toHaveLength(0);
    expect(await decide(bizOwner)).toHaveLength(1);
    expect(await decide(owner)).toHaveLength(0);
  });

  it('groups knowledge gaps: a repeat question raises the pending suggestion’s count', async () => {
    const groupKey = `do you offer financing ${uniq()}`;
    await suggestion('gap', groupKey);
    expect(await code(() => suggestion('gap', groupKey))).toBe('23505');
    const [upserted] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ similar_count: number }>(
        tx,
        sql`insert into app.knowledge_suggestions (workspace_id, kind, proposed, reason, group_key)
            values (${wsA}, 'faq', '{"title": "Can I pay monthly?"}', 'gap', ${groupKey})
            on conflict (workspace_id, group_key) where status = 'pending' and group_key is not null
            do update set similar_count = app.knowledge_suggestions.similar_count + 1
            returning similar_count`,
      ),
    );
    expect(upserted?.similar_count).toBe(2);
  });

  it('scans one website at a time, queued by a manager', async () => {
    const [source] = await as(bizOwner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.knowledge_sources (workspace_id, url, created_by)
            values (${wsA}, 'https://lonestar.example', ${bizOwner.id}) returning id`,
      ),
    );
    const queue = (user: TestUser, status = 'queued') =>
      as(user)((tx) =>
        tx.execute(sql`insert into app.knowledge_scans (workspace_id, source_id, status, started_by)
          values (${wsA}, ${source!.id}, ${status}::app.knowledge_scan_status, ${user.id})`),
      );
    expect(await code(() => queue(member))).toBe('42501');
    // Progress is the worker's.
    expect(await code(() => queue(bizOwner, 'running'))).toBe('42501');
    await queue(bizOwner);
    expect(await code(() => queue(owner))).toBe('23505');
    // Websites are https only.
    expect(
      await code(() =>
        as(bizOwner)((tx) =>
          tx.execute(
            sql`update app.knowledge_sources set url = 'http://lonestar.example' where id = ${source!.id}`,
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('keeps the worker inside its workspace', async () => {
    const id = await item(bizOwner, 'Emergency service');
    const fromB = await worker(
      wsB,
      orgB,
    )((tx) => rows(tx, sql`select id from app.knowledge_items where id = ${id}`));
    expect(fromB).toHaveLength(0);
    expect(
      await code(() =>
        worker(
          wsB,
          orgB,
        )((tx) =>
          tx.execute(sql`insert into app.knowledge_items (workspace_id, kind, title)
            values (${wsA}, 'fact', 'Planted')`),
        ),
      ),
    ).toBe('42501');
  });

  it('packs are visible only to the organization’s owners and admins', async () => {
    const [pack] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.knowledge_packs (organization_id, name, items, created_by)
            values (${orgA}, 'HVAC FAQs', '[{"kind": "faq", "title": "How often should I change my filter?"}]', ${owner.id})
            returning id`,
      ),
    );
    const sees = (user: TestUser) =>
      as(user)((tx) =>
        rows(tx, sql`select id from app.knowledge_packs where id = ${pack!.id}`),
      ).then((r) => r.length);
    expect(await sees(owner)).toBe(1);
    expect(await sees(orgAdmin)).toBe(1);
    for (const user of [bizOwner, member, outsider]) expect(await sees(user)).toBe(0);
    const byScope = (ws: string, org: string) =>
      worker(
        ws,
        org,
      )((tx) => rows(tx, sql`select id from app.knowledge_packs where id = ${pack!.id}`));
    expect(await byScope(wsA, orgA)).toHaveLength(1);
    expect(await byScope(wsB, orgB)).toHaveLength(0);
  });
});

describe('knowledge base: search', () => {
  it('matches "financing" and ranks a title match above a match in the answer', async () => {
    await worker(
      wsA,
      orgA,
    )((tx) =>
      tx.execute(sql`insert into app.knowledge_items (workspace_id, kind, title, body, tags, status) values
        (${wsA}, 'faq', 'Which payment methods do you take?', 'Cash, cards, and financing through our lender.', '{payments}', 'published'),
        (${wsA}, 'faq', 'Do you offer financing?', 'Yes: twelve months same as cash.', '{payments}', 'published'),
        (${wsA}, 'faq', 'Do you service heat pumps?', 'Yes, every major brand.', '{}', 'published')`),
    );
    const hits = await as(member)((tx) =>
      rows<{ title: string; rank: number }>(
        tx,
        sql`select i.title, ts_rank(i.search, q) as rank
            from app.knowledge_items i, websearch_to_tsquery('english', 'financing') q
            where i.workspace_id = ${wsA} and i.status = 'published' and i.search @@ q
            order by rank desc`,
      ),
    );
    expect(hits.map((h) => h.title)).toEqual([
      'Do you offer financing?',
      'Which payment methods do you take?',
    ]);
    expect(hits[0]!.rank).toBeGreaterThan(hits[1]!.rank);
  });
});

describe('permissions', () => {
  it('gives knowledge.manage to owners and admins', async () => {
    const roles = await rows<{ role: string }>(
      dbs.admin.db,
      sql`select role from app.role_permissions where permission = 'knowledge.manage' order by role`,
    );
    expect(roles.map((r) => r.role)).toEqual(['admin', 'owner']);
  });
});
