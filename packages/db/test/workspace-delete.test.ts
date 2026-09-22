/**
 * 0093: deleting a business, and everything in it.
 *
 * **Needs the stack up.** Both functions run past every policy, so the rules worth testing are their own:
 *
 *   - only an owner can ask (an admin, a member and somebody from another business cannot), and nobody can set
 *     the mark by updating the row themselves;
 *   - once asked, the business is gone for everybody on it at once, before the worker has done anything;
 *   - the purge refuses a business nobody asked to delete, and nobody but the worker can call it;
 *   - it takes everything — the history the event and audit logs keep append-only, a system timeline entry, the
 *     usage ledger, the last owner — and leaves the other business in the organization exactly as it was;
 *   - it can be run again;
 *   - and the files in Storage are listed for the worker only while the business is marked.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let outsider: TestUser;
let org: string;
let doomed: string;
let kept: string;
const admin$ = dbs.admin.db;

const randomE164 = (): string =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

const ask = (ws: string, who: TestUser) =>
  as(who)((tx) =>
    rows<{ at: string }>(tx, sql`select private.request_workspace_deletion(${ws}) as at`),
  );
const purge = (ws: string) =>
  asService({ workspaceId: ws, organizationId: org })((tx) =>
    rows(tx, sql`select private.purge_workspace(${ws})`),
  );
const exists = async (ws: string): Promise<boolean> => {
  const [row] = await rows<{ n: number }>(
    admin$,
    sql`select count(*)::int as n from app.workspaces where id = ${ws}`,
  );
  return row!.n === 1;
};

/** Every row in every table that names the business, by table. */
async function leftIn(ws: string): Promise<Record<string, number>> {
  const tables = await rows<{ t: string }>(
    admin$,
    sql`select format('%I.%I', c.table_schema, c.table_name) as t
        from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.column_name = 'workspace_id' and t.table_type = 'BASE TABLE'
          and c.table_schema in ('app', 'platform', 'private')`,
  );
  const out: Record<string, number> = {};
  for (const { t } of tables) {
    const [row] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from ${sql.raw(t)} where workspace_id = ${ws}`,
    );
    if (row!.n > 0) out[t] = row!.n;
  }
  return out;
}

/** A business with a little of everything the purge has to get past. */
async function fill(ws: string): Promise<void> {
  const worker = asService({ workspaceId: ws, organizationId: org });
  const [person] = await worker((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.people (workspace_id, first_name, last_name, phone_e164)
          values (${ws}, 'Casey', 'Customer', ${randomE164()}) returning id`,
    ),
  );
  const [thread] = await worker((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id)
          values (${ws}, 'sms', ${randomE164()}, ${person!.id}) returning id`,
    ),
  );
  await worker((tx) =>
    rows(
      tx,
      sql`insert into app.messages (workspace_id, conversation_id, direction, channel, body_text, status)
          values (${ws}, ${thread!.id}, 'inbound', 'sms', 'Is Thursday still good?', 'received')`,
    ),
  );
  // History: an event and its audit row (append-only), and a system timeline entry (immutable).
  const eventId = randomUUID();
  await worker(async (tx) => {
    await rows(
      tx,
      sql`insert into app.events (id, organization_id, workspace_id, event_type, actor_type, entity_type, entity_id, correlation_id)
          values (${eventId}, ${org}, ${ws}, 'person.created', 'system', 'person', ${person!.id}, ${randomUUID()})`,
    );
    await rows(
      tx,
      sql`insert into app.audit_logs (event_id, organization_id, workspace_id, actor_type, action, entity_type, entity_id, correlation_id)
          values (${eventId}, ${org}, ${ws}, 'system', 'person.create', 'person', ${person!.id}, ${randomUUID()})`,
    );
  });
  await rows(
    admin$,
    sql`insert into app.activities (workspace_id, kind, person_id, event_id, body)
        values (${ws}, 'system', ${person!.id}, ${eventId}, 'Added')`,
  );
  // The usage ledger (append-only; only HandsFreeOS writes it).
  await worker((tx) =>
    rows(
      tx,
      sql`insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, idempotency_key)
          values (${ws}, ${org}, 'credit', 500, ${'test-' + randomUUID()})`,
    ),
  );
  // A stored file.
  await rows(
    admin$,
    sql`insert into storage.objects (bucket_id, name) values ('attachments', ${`${ws}/people/${person!.id}/note.txt`})`,
  );
}

beforeAll(async () => {
  [owner, admin, member, outsider] = await Promise.all([
    createTestUser('ws-del-owner'),
    createTestUser('ws-del-admin'),
    createTestUser('ws-del-member'),
    createTestUser('ws-del-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Workspace Delete Org', 'Going Away Plumbing');
  org = a.orgId;
  doomed = a.wsId;
  await bootstrapOrganization(outsider, 'Somebody Else', 'Somebody Else');
  const [second] = await rows<{ id: string }>(
    admin$,
    sql`insert into app.workspaces (organization_id, name, slug)
        values (${org}, 'Staying Roofing', ${'staying-' + randomUUID().slice(0, 6)}) returning id`,
  );
  kept = second!.id;
  for (const [u, role] of [
    [admin, 'admin'],
    [member, 'member'],
  ] as const)
    for (const ws of [doomed, kept])
      await rows(
        admin$,
        sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${u.id}, ${role})`,
      );
  await fill(doomed);
  await fill(kept);
}, 60_000);

afterAll(closeAll);

describe('asking', () => {
  it('is an owner’s alone', async () => {
    for (const who of [admin, member, outsider])
      expect((await expectPgError(() => ask(doomed, who))).detail).toMatch(
        /workspace_delete_forbidden/,
      );
  });

  it('cannot be done by writing the mark directly', async () => {
    const err = await expectPgError(() =>
      as(owner)((tx) =>
        rows(tx, sql`update app.workspaces set deletion_requested_at = now() where id = ${doomed}`),
      ),
    );
    expect(err.detail).toBe('workspace_deletion_mark');
  });

  it('refuses a purge nobody asked for, and nobody but the worker may purge', async () => {
    expect((await expectPgError(() => purge(doomed))).detail).toBe('workspace_not_marked');
    const err = await expectPgError(() =>
      as(owner)((tx) => rows(tx, sql`select private.purge_workspace(${doomed})`)),
    );
    expect(err.message).toMatch(/permission denied/);
    expect(await exists(doomed)).toBe(true);
  });

  it('lists nothing in Storage for a business nobody asked to delete', async () => {
    const objects = await asService({ workspaceId: doomed, organizationId: org })((tx) =>
      rows(tx, sql`select * from private.workspace_stored_objects(${doomed})`),
    );
    expect(objects).toHaveLength(0);
  });

  it('hides the business from everybody on it at once', async () => {
    const [marked] = await ask(doomed, owner);
    expect(marked!.at).toBeTruthy();
    for (const who of [owner, admin, member]) {
      const seen = await as(who)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`select id from app.workspaces where id in (${doomed}, ${kept})`,
        ),
      );
      expect(seen.map((r) => r.id)).not.toContain(doomed);
      // The organization's owner still sees the other business, and the people on it still do.
      expect(seen.map((r) => r.id)).toContain(kept);
      const people = await as(who)((tx) =>
        rows(tx, sql`select 1 from app.people where workspace_id = ${doomed}`),
      );
      expect(people).toHaveLength(0);
    }
    // And nobody can ask again: there is nothing of it left to reach.
    expect((await expectPgError(() => ask(doomed, owner))).detail).toBe(
      'workspace_delete_forbidden',
    );
  });

  it('lists its files for the worker once it is marked', async () => {
    const objects = await asService({ workspaceId: doomed, organizationId: org })((tx) =>
      rows<{ bucket: string; name: string }>(
        tx,
        sql`select * from private.workspace_stored_objects(${doomed})`,
      ),
    );
    expect(objects).toHaveLength(1);
    expect(objects[0]!.bucket).toBe('attachments');
    expect(objects[0]!.name.startsWith(`${doomed}/`)).toBe(true);
  });
});

describe('the purge', () => {
  it('takes everything, history included, and leaves the other business as it was', async () => {
    const before = await leftIn(kept);
    expect(Object.keys(await leftIn(doomed)).length).toBeGreaterThan(5);
    await purge(doomed);
    expect(await exists(doomed)).toBe(false);
    expect(await leftIn(doomed)).toEqual({});
    expect(await leftIn(kept)).toEqual(before);
    // The organization, and the other business's owner, are where they were.
    const [o] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from app.organizations where id = ${org}`,
    );
    expect(o!.n).toBe(1);
  });

  it('can be run again', async () => {
    await purge(doomed);
    expect(await exists(doomed)).toBe(false);
  });

  it('leaves the append-only rules in force everywhere else', async () => {
    const err = await expectPgError(() =>
      rows(admin$, sql`delete from app.events where workspace_id = ${kept}`),
    );
    expect(err.message).toMatch(/append-only/);
  });
});
