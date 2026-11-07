/**
 * Trying the AI teammate as a customer, by asking (test_ai_teammate), on the real database with the scripted model:
 * what AI teammate → Test console does, through the same worker code with the saved settings. It needs someone who
 * manages the teammate; what it would reply and do comes back in words; and nothing is sent, booked or stored but the
 * test run, marked a test.
 */
import { randomUUID } from 'node:crypto';
import { ADDON_CATALOG, assistantToolByName, type HumanActor } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolsFor } from '../src/assistant/context';
import type { ToolContext } from '../src/assistant/runtime';
import { createToolExecutor, executorFor } from '../src/assistant/tools-write';
import {
  admin,
  appointmentsOf,
  newCustomer,
  teammateWorld,
  textsTo,
  type TeammateWorld,
} from './ai-team-world';

let w: TeammateWorld;
let member: TestUser;

const actor = (u: Pick<TestUser, 'id' | 'email' | 'claims'>): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const ctxFor = (u: Pick<TestUser, 'id' | 'email' | 'claims'>): ToolContext => ({
  actor: actor(u),
  workspaceId: w.workspaceId,
  organizationId: w.organizationId,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
});
const tool = assistantToolByName.get('test_ai_teammate')!;
/** As the runtime hands it over: the arguments checked against the tool's input, its defaults filled in. */
const tryIt = (
  args: Record<string, unknown>,
  u: Pick<TestUser, 'id' | 'email' | 'claims'> = w.owner,
) =>
  createToolExecutor(testDbs().worker.db, null, null, '', ADDON_CATALOG, { services: w.s }).run(
    tool,
    tool.input.parse(args) as Record<string, unknown>,
    ctxFor(u),
  ) as Promise<{ result: Record<string, unknown>; card?: Record<string, unknown> | null }>;
const says = (text: string) => ({ messages: [{ from: 'customer', text }] });

beforeAll(async () => {
  w = await teammateWorld('tmassist', {
    preset: 'appointment_coordinator',
    calendar: 'Tune-ups',
    status: 'automatic',
  });
  member = await createTestUser('tmassist-member', { fullName: 'Marco Member' });
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${w.workspaceId}, ${member.id}, 'member')`,
  );
}, 60_000);
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

describe('trying the AI teammate by asking', () => {
  it('is offered only to someone who manages it, runs on its own, and has an executor', () => {
    expect(tool.autonomy).toBe('auto');
    expect(tool.permission).toBe('ai_team.manage');
    expect(executorFor('test_ai_teammate')).toBeTruthy();
    // A phone call is tried live in the console, never by asking.
    expect(() => tool.input.parse({ ...says('Hi'), channel: 'phone' })).toThrow();
  });

  it('says what it would reply and do, as someone in Contacts, and sends, books and stores nothing but the test run', async () => {
    const c = await newCustomer(w, 'Ken');
    const { result, card } = await tryIt({
      personId: c.id,
      ...says('Can you book me in for Thursday?'),
    });
    expect(result['tried']).toMatchObject({
      teammate: 'Ava',
      as: expect.stringMatching(/^Ken /),
      by: 'text',
      at: 'now',
    });
    expect(result['outcome']).toBe('It replied');
    expect(result['reply']).toEqual({
      ai_teammate_wrote: expect.stringMatching(/You're booked for Thu/),
    });
    expect(result['waitsForAnOk']).toBeUndefined();
    expect(result['wouldDo']).toContainEqual(expect.stringMatching(/^booked Thu/));
    expect((result['lookedUp'] as string[]).length).toBeGreaterThan(0);
    expect(result['safetyCheck']).toMatchObject({ passed: true });
    expect(result['note']).toMatch(/^Nothing was sent, booked or changed/);
    expect(card).toMatchObject({ type: 'list', title: 'How Ava would answer' });

    // Nothing happened for real: the run is a test's, with no conversation.
    expect(await appointmentsOf(c.id)).toHaveLength(0);
    expect(textsTo(w, c.phone)).toHaveLength(0);
    const [r] = await rows<{ is_test: boolean; conversation_id: string | null; outcome: string }>(
      admin(),
      sql`select is_test, conversation_id, outcome from app.ai_teammate_runs
          where id = ${result['runId'] as string}`,
    );
    expect(r).toEqual({ is_test: true, conversation_id: null, outcome: 'replied' });
  });

  it('tries the website chat as a stranger', async () => {
    const { result } = await tryIt({ channel: 'chat', ...says('Do you fix furnaces?') });
    expect(result['tried']).toMatchObject({
      as: 'Someone not in Contacts yet',
      by: 'the website chat',
    });
    expect(result['outcome']).toEqual(expect.any(String));
    expect(result['runId']).toEqual(expect.any(String));
  });

  it('refuses someone who doesn’t manage the teammate, and a test that doesn’t end with the customer', async () => {
    await expect(tryIt(says('Hi'), member)).rejects.toMatchObject({ code: 'forbidden' });
    expect(toolsFor((p) => p !== 'ai_team.manage').some((t) => t.name === 'test_ai_teammate')).toBe(
      false,
    );
    await expect(
      tryIt({
        messages: [
          { from: 'customer', text: 'Hi' },
          { from: 'teammate', text: 'Hi! How can I help?' },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('end the conversation with what the customer says next'),
      details: [{ path: 'messages.1', message: 'End with the customer’s new message.' }],
    });
    // A worker without its AI services says where to try it instead.
    await expect(
      createToolExecutor(testDbs().worker.db).run(
        tool,
        tool.input.parse(says('Hi')) as Record<string, unknown>,
        ctxFor(w.owner),
      ),
    ).rejects.toMatchObject({
      rule: 'ai_not_configured',
      message: expect.stringContaining('AI teammate → Test console'),
    });
  });
});
