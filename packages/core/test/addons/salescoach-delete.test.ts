/**
 * Deleting a coached call for good (Chris, 2026-10-16): owners only until an owner gives `salescoach.delete`; it
 * takes its cards with it; and a call the coach is still hearing can't be deleted yet.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { salescoachAddon } from '../../src/addons/salescoach/manifest';
import { callDelete } from '../../src/addons/salescoach/ops/calls';
import { executeCommand, organizationCreate, type HumanActor } from '../../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'went through',
    (e: { rule?: string; code?: string }) => e.rule ?? e.code,
  );

let owner: TestUser;
let manager: TestUser;
let ws: string;

/** A coached call the rep had, in a state, with one card. */
async function coached(state: string): Promise<string> {
  const [call] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.calls (workspace_id, direction, status, placed_by, to_e164, provider_sid)
        values (${ws}, 'outbound', 'completed', ${manager.id}, '+17135550142', ${`CA${randomUUID().slice(0, 12)}`})
        returning id`,
  );
  const [c] = await rows<{ id: string }>(
    admin(),
    sql`insert into addon_salescoach.calls (workspace_id, call_id, user_id, state, ended_at)
        values (${ws}, ${call!.id}, ${manager.id}, ${state}, ${state === 'live' ? null : sql`now()`})
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into addon_salescoach.cards (workspace_id, coached_call_id, user_id, kind, title, say)
        values (${ws}, ${c!.id}, ${manager.id}, 'objection', 'Price', 'I hear you.')`,
  );
  return c!.id;
}

const remove = (u: TestUser, coachedCallId: string) =>
  executeCommand(api(), callDelete, { workspaceId: ws, coachedCallId }, human(u), meta());

const left = async (id: string) =>
  (
    await rows<{ calls: number; cards: number }>(
      admin(),
      sql`select (select count(*)::int from addon_salescoach.calls where id = ${id}) as calls,
                 (select count(*)::int from addon_salescoach.cards where coached_call_id = ${id}) as cards`,
    )
  )[0];

beforeAll(async () => {
  [owner, manager] = await Promise.all([
    createTestUser('coach-delete-owner'),
    createTestUser('coach-delete-admin'),
  ]);
  ws = (
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Tidy Cooling Co' },
      human(owner),
      meta(),
    )
  ).output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${manager.id}, 'admin')`,
  );
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, 'salescoach', 'enabled', ${salescoachAddon.version})`,
  );
}, 60_000);
afterAll(closeTestDbs);

describe('deleting a coached call', () => {
  it('is an owner’s: an admin who sees every call can’t, until given it', async () => {
    const id = await coached('done');
    expect(await refused(remove(manager, id))).toBe('forbidden');
    expect(await left(id)).toEqual({ calls: 1, cards: 1 });
  });

  it('takes the call and its cards, for good', async () => {
    const id = await coached('done');
    expect((await remove(owner, id)).output).toEqual({ deleted: true });
    expect(await left(id)).toEqual({ calls: 0, cards: 0 });
    // Gone means gone: asking again finds nothing.
    expect(await refused(remove(owner, id))).toBe('not_found');
  });

  it('waits while the coach is still on the call', async () => {
    const id = await coached('live');
    expect(await refused(remove(owner, id))).toBe('salescoach_call_in_progress');
    expect(await left(id)).toEqual({ calls: 1, cards: 1 });
  });
});
