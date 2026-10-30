import { randomUUID } from 'node:crypto';
import {
  aiSetupGet,
  executeCommand,
  executeQuery,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/assistant/runtime';
import { allScreenActionTools } from '../src/assistant/tools-screen-actions';
import { createToolExecutor } from '../src/assistant/tools-write';

/**
 * The AI quick setup and the onboarding setup, by asking: each wizard's own commands as screen actions, a screen's
 * answers at a time, read from the wizard's own query and saved only on Confirm.
 */

const CHI = 'America/Chicago';
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
const mark = randomUUID().slice(0, 8);

const ctxFor = (u: TestUser): ToolContext => ({
  actor: actor(u),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});
const named = (name: string) => allScreenActionTools().find((t) => t.name === name);
const nameNow = async () =>
  (
    await rows<{ name: string }>(
      admin(),
      sql`select name from app.workspaces where id = ${workspaceId}`,
    )
  )[0]!.name;

beforeAll(async () => {
  owner = await createTestUser('awiz-dale', { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: `Wizard HVAC ${mark}`, timezone: CHI },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
}, 60_000);

afterAll(closeTestDbs);

describe('the setup wizards', () => {
  it('offers each wizard’s save and finish, warning where saving reaches people', () => {
    expect(named('do_ai_setup_save')!.permission).toBe('ai_team.manage');
    expect(named('do_ai_setup_finish')!.permission).toBe('ai_team.manage');
    expect(named('do_onboarding_setup_save')!.warning).toContain('invitations');
    expect(named('do_onboarding_setup_finish')!.warning).toContain('invitation');
  });

  it('saves the AI quick setup’s first screen, from its own answers, only on Confirm', async () => {
    const { answers } = await executeQuery(
      api(),
      aiSetupGet,
      { workspaceId },
      actor(owner),
      meta(),
    );
    const save = named('do_ai_setup_save')!;
    const args = { step: 'business', answers, business: { name: `Renamed HVAC ${mark}` } };
    const exec = createToolExecutor(api());

    const prepared = await exec.prepare(save, args, ctxFor(owner), randomUUID());
    expect(prepared.card?.type).toBe('confirm');
    expect(await nameNow()).toBe(`Wizard HVAC ${mark}`);

    await exec.commit(save, args, ctxFor(owner), { toolCallId: randomUUID() });
    expect(await nameNow()).toBe(`Renamed HVAC ${mark}`);
    const after = await executeQuery(api(), aiSetupGet, { workspaceId }, actor(owner), meta());
    expect(after.reached).toBe('business');
  });
});
