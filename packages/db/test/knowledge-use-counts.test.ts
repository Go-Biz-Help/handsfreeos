import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  type TestUser,
} from './harness';

/** 0026: counting an item's use (knowledge_item.record_use) doesn't move its updated_at. */

let owner: TestUser;
let ws: string;
let org: string;

beforeAll(async () => {
  owner = await createTestUser('kb-use-counts');
  const b = await bootstrapOrganization(owner, 'Use Counts Org', 'Use Counts');
  ws = b.wsId;
  org = b.orgId;
});
afterAll(closeAll);

const system = () => asService({ workspaceId: ws, organizationId: org });

/** A published fact last changed three days ago (inserted directly: inserts don't run the update trigger). */
async function oldItem(title: string): Promise<{ id: string; updatedAt: string }> {
  const [row] = await rows<{ id: string; updated_at: string }>(
    dbs.admin.db,
    sql`insert into app.knowledge_items (workspace_id, kind, title, body, status, created_by, updated_by,
          created_at, updated_at)
        values (${ws}, 'fact', ${title}, 'Monday to Friday, 7 AM to 6 PM.', 'published', ${owner.id}, ${owner.id},
          now() - interval '3 days', now() - interval '3 days')
        returning id, updated_at::text`,
  );
  return { id: row!.id, updatedAt: row!.updated_at };
}

const current = async (id: string) =>
  (
    await rows<{ updated_at: string; use_count: number; recent: boolean; last_used: boolean }>(
      dbs.admin.db,
      sql`select updated_at::text, use_count, updated_at > now() - interval '1 minute' as recent,
            last_used_at is not null as last_used
          from app.knowledge_items where id = ${id}`,
    )
  )[0]!;

describe('knowledge items: counting use is not a change', () => {
  it('keeps updated_at when only use_count and last_used_at change', async () => {
    const item = await oldItem('Office hours');
    // What knowledge_item.record_use does, as the system.
    for (let i = 0; i < 2; i++)
      await system()((tx) =>
        tx.execute(
          sql`update app.knowledge_items set use_count = use_count + 1, last_used_at = now() where id = ${item.id}`,
        ),
      );
    expect(await current(item.id)).toMatchObject({
      updated_at: item.updatedAt,
      use_count: 2,
      last_used: true,
      recent: false,
    });
  });

  it('still stamps updated_at for any other change, alone or alongside a use count', async () => {
    const edited = await oldItem('Service area');
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.knowledge_items set title = 'Where we work', updated_by = ${owner.id} where id = ${edited.id}`,
      ),
    );
    expect(await current(edited.id)).toMatchObject({ recent: true, use_count: 0 });

    const mixed = await oldItem('Warranty');
    await system()((tx) =>
      tx.execute(
        sql`update app.knowledge_items set use_count = use_count + 1, tags = '{warranty}' where id = ${mixed.id}`,
      ),
    );
    expect(await current(mixed.id)).toMatchObject({ recent: true, use_count: 1 });
  });

  it('keeps the list order (newest change first) when the AI uses an older item', async () => {
    const older = await oldItem('Payment options');
    const [newer] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.knowledge_items (workspace_id, kind, title, body, status, created_by, updated_by)
          values (${ws}, 'fact', 'Financing', 'Yes, with approved credit.', 'published', ${owner.id}, ${owner.id})
          returning id`,
    );
    await system()((tx) =>
      tx.execute(
        sql`update app.knowledge_items set use_count = use_count + 1, last_used_at = now() where id = ${older.id}`,
      ),
    );
    const order = await rows<{ id: string }>(
      dbs.admin.db,
      sql`select id from app.knowledge_items where id in (${older.id}, ${newer!.id}) order by updated_at desc`,
    );
    expect(order.map((r) => r.id)).toEqual([newer!.id, older.id]);
  });
});
