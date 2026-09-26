/**
 * The model a business's calls think with (the phone model): a staff admin picks it for one business in /admin,
 * and nobody else can — not support agents, and not the business itself, whether through the command or by
 * writing the column directly.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { HumanActor, RequestMeta } from '../src/kernel/types';
import { organizationCreate, phoneModelSet, platformBusinessGet } from '../src/server';

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

const pick = (who: TestUser, model: 'claude-haiku-4-5' | null) =>
  executeCommand(api(), phoneModelSet, { workspaceId, model }, human(who), meta());

async function phoneModel(): Promise<string | null> {
  const [w] = await rows<{ phone_model: string | null }>(
    admin(),
    sql`select phone_model from app.workspaces where id = ${workspaceId}`,
  );
  return w?.phone_model ?? null;
}

/** The database's reason for refusing, however deep the driver wrapped it. */
function refusal(e: unknown): string | undefined {
  let err = e as { detail?: string; cause?: unknown } | undefined;
  while (err && !err.detail && err.cause) err = err.cause as typeof err;
  return err?.detail;
}

const changes = async () =>
  rows<{ payload: { was: string | null; model: string | null } }>(
    admin(),
    sql`select payload from app.events where event_type = 'phone_model.changed' and entity_id = ${workspaceId}
        order by created_at`,
  );

beforeAll(async () => {
  [staffAdmin, agent, owner] = await Promise.all([
    createTestUser('phone-model-staff-admin'),
    createTestUser('phone-model-staff-agent'),
    createTestUser('phone-model-owner'),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Faster Calls Plumbing' },
    human(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  await Promise.all([beStaff(staffAdmin, 'admin'), beStaff(agent, 'agent')]);
});
afterAll(closeTestDbs);

describe('a staff admin', () => {
  it('picks a model for a business’s calls, and the business page shows it', async () => {
    const { output } = await pick(staffAdmin, 'claude-haiku-4-5');
    expect(output).toEqual({ workspaceId, was: null, model: 'claude-haiku-4-5', changed: true });
    expect(await phoneModel()).toBe('claude-haiku-4-5');
    const page = await executeQuery(
      api(),
      platformBusinessGet,
      { workspaceId },
      human(staffAdmin),
      meta(),
    );
    expect(page.phoneModel).toBe('claude-haiku-4-5');
    expect((await changes()).map((c) => c.payload)).toEqual([
      { workspaceId, was: null, model: 'claude-haiku-4-5' },
    ]);
  });

  it('counts the same pick once, and puts it back on the default', async () => {
    const again = await pick(staffAdmin, 'claude-haiku-4-5');
    expect(again.output.changed).toBe(false);
    const back = await pick(staffAdmin, null);
    expect(back.output).toMatchObject({ was: 'claude-haiku-4-5', model: null, changed: true });
    expect(await phoneModel()).toBeNull();
    expect(await changes()).toHaveLength(2);
  });
});

describe('everybody else', () => {
  it('refuses a support agent and the business’s own owner', async () => {
    await expect(pick(agent, 'claude-haiku-4-5')).rejects.toBeInstanceOf(HfosError);
    await expect(pick(owner, 'claude-haiku-4-5')).rejects.toBeInstanceOf(HfosError);
    expect(await phoneModel()).toBeNull();
  });

  it('refuses the owner writing the column directly, and the function too', async () => {
    const direct = await asUser(api(), owner.claims, (tx) =>
      rows(
        tx,
        sql`update app.workspaces set phone_model = 'claude-haiku-4-5' where id = ${workspaceId}`,
      ),
    ).catch((e: unknown) => e);
    expect(refusal(direct)).toBe('phone_model_is_ours');
    const viaFunction = await asUser(api(), owner.claims, (tx) =>
      rows(
        tx,
        sql`select * from private.set_phone_model(${workspaceId}::uuid, 'claude-haiku-4-5')`,
      ),
    ).catch((e: unknown) => e);
    expect(refusal(viaFunction)).toBe('phone_model_is_ours');
    expect(await phoneModel()).toBeNull();
  });

  it('refuses a model that isn’t on the list', async () => {
    await expect(
      executeCommand(
        api(),
        phoneModelSet,
        { workspaceId, model: 'gpt-5' },
        human(staffAdmin),
        meta(),
      ),
    ).rejects.toBeInstanceOf(HfosError);
  });
});
