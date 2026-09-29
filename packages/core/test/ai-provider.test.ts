/**
 * Which AI answers (20261013000900): a staff admin keeps it on Claude or on OpenAI, or lets the worker's checks
 * choose (auto), and the Health page says who is answering and why. Nobody else can press the switch — not a
 * support lead who can see the page, and not anyone calling the function or writing the row directly.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { HumanActor, RequestMeta } from '../src/kernel/types';
import { aiProviderSetMode, platformAiProviderGet } from '../src/server';

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
let lead: TestUser;
let agent: TestUser;
/** The one row is shared by everything that runs against this database, so it goes back as it was found. */
let found: Record<string, unknown>;
let letGo: () => Promise<void>;

/**
 * `pnpm test` runs every package's tests at once against one database, and the worker's switch the same row: whoever
 * holds this lock has it to themselves. Held on a connection of its own, since the lock belongs to the connection.
 */
async function holdTheRow(): Promise<() => Promise<void>> {
  const conn = await testDbs().admin.client.reserve();
  await conn`select pg_advisory_lock(hashtext('platform.ai_provider'))`;
  return async () => {
    await conn`select pg_advisory_unlock(hashtext('platform.ai_provider'))`;
    conn.release();
  };
}

const beStaff = (u: TestUser, role: 'admin' | 'lead' | 'agent') =>
  admin().execute(
    sql`insert into platform.staff (user_id, role) values (${u.id}, ${role})
        on conflict (user_id) do update set role = ${role}, status = 'active'`,
  );

const press = (who: TestUser, mode: 'auto' | 'claude' | 'openai') =>
  executeCommand(api(), aiProviderSetMode, { mode }, human(who), meta());
const look = (who: TestUser) => executeQuery(api(), platformAiProviderGet, {}, human(who), meta());

async function mode(): Promise<string | undefined> {
  const [row] = await rows<{ mode: string }>(admin(), sql`select mode from platform.ai_provider`);
  return row?.mode;
}

/** The database's reason for refusing, however deep the driver wrapped it. */
function refusal(e: unknown): string | undefined {
  let err = e as { detail?: string; cause?: unknown } | undefined;
  while (err && !err.detail && err.cause) err = err.cause as typeof err;
  return err?.detail;
}

const changes = async () =>
  rows<{ payload: { was: string; mode: string } }>(
    admin(),
    sql`select payload from app.events where event_type = 'ai_provider.mode_changed' and actor_id = ${staffAdmin.id}
        order by created_at`,
  );

beforeAll(async () => {
  [staffAdmin, lead, agent] = await Promise.all([
    createTestUser('ai-provider-staff-admin'),
    createTestUser('ai-provider-staff-lead'),
    createTestUser('ai-provider-staff-agent'),
  ]);
  await Promise.all([beStaff(staffAdmin, 'admin'), beStaff(lead, 'lead'), beStaff(agent, 'agent')]);
  letGo = await holdTheRow();
  const [row] = await rows<{ row: Record<string, unknown> }>(
    admin(),
    sql`select to_jsonb(p) as row from platform.ai_provider p`,
  );
  found = row!.row;
  await admin().execute(
    sql`update platform.ai_provider set mode = 'auto', active = 'claude', reason = null, good_checks = 0`,
  );
});
afterAll(async () => {
  await admin().execute(
    sql`update platform.ai_provider p set
          mode = r.mode, active = r.active, reason = r.reason, claude_status = r.claude_status,
          good_checks = r.good_checks, checked_at = r.checked_at, switched_at = r.switched_at,
          mode_set_by = r.mode_set_by, mode_set_at = r.mode_set_at
        from jsonb_populate_record(null::platform.ai_provider, ${JSON.stringify(found)}::jsonb) r`,
  );
  await letGo();
  await closeTestDbs();
});

describe('a staff admin', () => {
  it('keeps it on OpenAI, and the Health page says OpenAI is answering and who chose it', async () => {
    const { output } = await press(staffAdmin, 'openai');
    expect(output).toEqual({ was: 'auto', mode: 'openai', changed: true });
    expect(await mode()).toBe('openai');
    const now = await look(staffAdmin);
    expect(now).toMatchObject({
      mode: 'openai',
      active: 'claude',
      answering: 'openai',
      modeSetBy: staffAdmin.fullName,
    });
    expect(now.modeSetAt).not.toBeNull();
    expect((await changes()).map((c) => c.payload)).toEqual([{ was: 'auto', mode: 'openai' }]);
  });

  it('counts the same press once, and puts it back on auto', async () => {
    const again = await press(staffAdmin, 'openai');
    expect(again.output).toEqual({ was: 'openai', mode: 'openai', changed: false });
    const back = await press(staffAdmin, 'auto');
    expect(back.output).toEqual({ was: 'openai', mode: 'auto', changed: true });
    expect(await mode()).toBe('auto');
    expect(await changes()).toHaveLength(2);
  });
});

describe('the Health page', () => {
  it('answers with whoever the checks chose on auto, and the one support kept it on otherwise', async () => {
    // What the worker writes when Claude's status page reports an outage.
    await admin().execute(
      sql`update platform.ai_provider set active = 'openai', reason = 'status', claude_status = 'major_outage',
            good_checks = 1, checked_at = now(), switched_at = now()`,
    );
    const onAuto = await look(lead);
    expect(onAuto).toMatchObject({
      mode: 'auto',
      active: 'openai',
      answering: 'openai',
      reason: 'status',
      claudeStatus: 'major_outage',
      goodChecks: 1,
    });
    expect(onAuto.checkedAt).not.toBeNull();
    expect(onAuto.switchedAt).not.toBeNull();

    await press(staffAdmin, 'claude');
    expect(await look(lead)).toMatchObject({
      mode: 'claude',
      active: 'openai',
      answering: 'claude',
    });
    await press(staffAdmin, 'auto');
  });
});

describe('everybody else', () => {
  it('refuses a support lead and an agent the switch, and an agent the page', async () => {
    await expect(press(lead, 'openai')).rejects.toBeInstanceOf(HfosError);
    await expect(press(agent, 'openai')).rejects.toBeInstanceOf(HfosError);
    await expect(look(agent)).rejects.toBeInstanceOf(HfosError);
    expect(await mode()).toBe('auto');
  });

  it('refuses a support lead writing the row directly, and the function too', async () => {
    await expect(
      asUser(api(), lead.claims, (tx) =>
        rows(tx, sql`update platform.ai_provider set mode = 'openai'`),
      ),
    ).rejects.toThrow();
    const viaFunction = await asUser(api(), lead.claims, (tx) =>
      rows(tx, sql`select * from private.set_ai_provider_mode('openai')`),
    ).catch((e: unknown) => e);
    expect(refusal(viaFunction)).toBe('ai_provider_is_ours');
    expect(await mode()).toBe('auto');
  });

  it('refuses a mode that isn’t one of the three', async () => {
    await expect(
      executeCommand(api(), aiProviderSetMode, { mode: 'gemini' }, human(staffAdmin), meta()),
    ).rejects.toBeInstanceOf(HfosError);
  });
});
