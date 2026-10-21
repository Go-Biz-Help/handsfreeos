/**
 * Who hears a business's callers (the phone listener): a staff admin picks Nova-3 or Flux for one business in
 * /admin, and nobody else can — not support agents, and not the business itself, whether through the command or
 * by writing the column directly.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { HumanActor, RequestMeta } from '../src/kernel/types';
import { organizationCreate, phoneListenerSet, platformBusinessGet } from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });

let staffAdmin: TestUser;
let agent: TestUser;
let owner: TestUser;
let workspaceId: string;

const beStaff = (u: TestUser, role: 'admin' | 'agent') =>
  admin().execute(
    sql`insert into platform.staff (user_id, role) values (${u.id}, ${role})
        on conflict (user_id) do update set role = ${role}, status = 'active'`,
  );

const pick = (who: TestUser, listener: 'nova-3' | 'flux' | null) =>
  executeCommand(api(), phoneListenerSet, { workspaceId, listener }, human(who), meta());

async function phoneListener(): Promise<string | null> {
  const [w] = await rows<{ phone_listener: string | null }>(
    admin(),
    sql`select phone_listener from app.workspaces where id = ${workspaceId}`,
  );
  return w?.phone_listener ?? null;
}

/** The database's reason for refusing, however deep the driver wrapped it. */
function refusal(e: unknown): string | undefined {
  let err = e as { detail?: string; cause?: unknown } | undefined;
  while (err && !err.detail && err.cause) err = err.cause as typeof err;
  return err?.detail;
}

const changes = async () =>
  rows<{ payload: { was: string | null; listener: string | null } }>(
    admin(),
    sql`select payload from app.events where event_type = 'phone_listener.changed' and entity_id = ${workspaceId}
        order by created_at`,
  );

beforeAll(async () => {
  [staffAdmin, agent, owner] = await Promise.all([
    createTestUser('phone-listener-staff-admin'),
    createTestUser('phone-listener-staff-agent'),
    createTestUser('phone-listener-owner'),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Patient Listening Plumbing' },
    human(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  await Promise.all([beStaff(staffAdmin, 'admin'), beStaff(agent, 'agent')]);
});
afterAll(closeTestDbs);

describe('a staff admin', () => {
  it('picks who hears a business’s callers, and the business page shows it', async () => {
    const { output } = await pick(staffAdmin, 'flux');
    expect(output).toEqual({ workspaceId, was: null, listener: 'flux', changed: true });
    expect(await phoneListener()).toBe('flux');
    const page = await executeQuery(
      api(),
      platformBusinessGet,
      { workspaceId },
      human(staffAdmin),
      meta(),
    );
    expect(page.phoneListener).toBe('flux');
    expect((await changes()).map((c) => c.payload)).toEqual([
      { workspaceId, was: null, listener: 'flux' },
    ]);
  });

  it('counts the same pick once, keeps Nova-3 when it’s picked, and puts it back on the default', async () => {
    const again = await pick(staffAdmin, 'flux');
    expect(again.output.changed).toBe(false);
    const nova = await pick(staffAdmin, 'nova-3');
    expect(nova.output).toMatchObject({ was: 'flux', listener: 'nova-3', changed: true });
    const back = await pick(staffAdmin, null);
    expect(back.output).toMatchObject({ was: 'nova-3', listener: null, changed: true });
    expect(await phoneListener()).toBeNull();
    expect(await changes()).toHaveLength(3);
  });
});

describe('everybody else', () => {
  it('refuses a support agent and the business’s own owner', async () => {
    await expect(pick(agent, 'flux')).rejects.toBeInstanceOf(HfosError);
    await expect(pick(owner, 'flux')).rejects.toBeInstanceOf(HfosError);
    expect(await phoneListener()).toBeNull();
  });

  it('refuses the owner writing the column directly, and the function too', async () => {
    const direct = await asUser(api(), owner.claims, (tx) =>
      rows(tx, sql`update app.workspaces set phone_listener = 'flux' where id = ${workspaceId}`),
    ).catch((e: unknown) => e);
    expect(refusal(direct)).toBe('phone_listener_is_ours');
    const viaFunction = await asUser(api(), owner.claims, (tx) =>
      rows(tx, sql`select * from private.set_phone_listener(${workspaceId}::uuid, 'flux')`),
    ).catch((e: unknown) => e);
    expect(refusal(viaFunction)).toBe('phone_listener_is_ours');
    expect(await phoneListener()).toBeNull();
  });

  it('refuses a listener that isn’t on the list', async () => {
    await expect(
      executeCommand(
        api(),
        phoneListenerSet,
        { workspaceId, listener: 'nova-2' },
        human(staffAdmin),
        meta(),
      ),
    ).rejects.toBeInstanceOf(HfosError);
  });
});
