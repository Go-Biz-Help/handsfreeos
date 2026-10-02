import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  organizationCreate,
  platformViewAsEnd,
  platformViewAsStart,
  teammateViewStart,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { processOnce } from '../src/outbox';
import { testServices, type TestServices } from './helpers';

/**
 * Viewing the app as a teammate (20261018000100): when HandsFreeOS support, inside a look, views a business as one of
 * its people, the business is told in its own audit log, as it is of the look. The founder's view is not told.
 */
const WORKER_ID = `vitest-teammate-view-${process.pid}`;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let agent: TestUser;
let founder: TestUser;
let workspaceId: string;
let s: TestServices;

/** Runs the worker over this view's own event and nothing else. */
async function handle(viewId: string): Promise<void> {
  await rows(
    admin(),
    sql`update app.outbox o set locked_at = now(), locked_by = ${WORKER_ID}
        from app.events e
        where o.event_id = e.id and o.status = 'pending' and e.entity_id = ${viewId}
          and e.event_type = 'platform.teammate_view_started'`,
  );
  const pass = await processOnce({
    ...s,
    workerId: WORKER_ID,
    batchSize: 10,
    reservedOnly: true,
    handlers,
  });
  expect(pass.failed + pass.retried).toBe(0);
}

const toldTheBusiness = (viewId: string) =>
  rows<{ actor_type: string; after: { who: string; person: string; readOnly: boolean } }>(
    admin(),
    sql`select actor_type, after from app.audit_logs
        where workspace_id = ${workspaceId} and action = 'platform.teammate_view.started'
          and entity_id = ${viewId}`,
  );

beforeAll(async () => {
  s = testServices();
  [owner, agent, founder] = await Promise.all([
    createTestUser('tv-worker-owner'),
    createTestUser('tv-worker-agent'),
    createTestUser('tv-worker-founder'),
  ]);
  await rows(admin(), sql`update auth.users set raw_user_meta_data = '{}' where id = ${owner.id}`);
  await rows(admin(), sql`update app.users set full_name = 'Dana Reed' where id = ${owner.id}`);
  workspaceId = (
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Told Tree Care' },
      actor(owner),
      meta(),
    )
  ).output.workspaceId;
  await admin().execute(sql`update platform.staff set founder = false where founder`);
  await admin().execute(
    sql`insert into platform.staff (user_id, role, display_name, founder)
        values (${agent.id}, 'agent', 'Sam at HandsFreeOS', false), (${founder.id}, 'agent', '', true)`,
  );
});
afterAll(async () => {
  await admin().execute(
    sql`delete from platform.staff where user_id in (${agent.id}, ${founder.id})`,
  );
  await closeTestDbs();
});

describe('HandsFreeOS viewing a business as one of its people', () => {
  it('support’s view goes into the business’s own audit log, who and as whom', async () => {
    await executeCommand(
      api(),
      platformViewAsStart,
      { workspaceId, reason: 'Their invoices page looks empty', minutes: 15 },
      actor(agent),
      meta(),
    );
    const { view } = (
      await executeCommand(
        api(),
        teammateViewStart,
        { workspaceId, userId: owner.id },
        actor(agent),
        meta(),
      )
    ).output;
    await handle(view.id);
    const told = await toldTheBusiness(view.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      actor_type: 'system',
      after: {
        who: 'Sam at HandsFreeOS (HandsFreeOS support)',
        person: 'Dana Reed',
        readOnly: true,
      },
    });
    await executeCommand(api(), platformViewAsEnd, {}, actor(agent), meta());
  });

  it('the founder’s is not', async () => {
    await executeCommand(api(), platformViewAsStart, { workspaceId }, actor(founder), meta());
    const { view } = (
      await executeCommand(
        api(),
        teammateViewStart,
        { workspaceId, userId: owner.id },
        actor(founder),
        meta(),
      )
    ).output;
    await handle(view.id);
    expect(await toldTheBusiness(view.id)).toEqual([]);
    await executeCommand(api(), platformViewAsEnd, {}, actor(founder), meta());
  });
});
