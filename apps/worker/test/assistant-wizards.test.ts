import { randomUUID } from 'node:crypto';
import {
  aiSetupGet,
  AssistantCard,
  executeCommand,
  executeQuery,
  onboardingSetupGet,
  organizationCreate,
  QUESTION_WORDS,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/assistant/runtime';
import { setupInput } from '../src/assistant/setup-screens';
import { allScreenActionTools } from '../src/assistant/tools-screen-actions';
import { allScreenReadTools } from '../src/assistant/tools-screen-reads';
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
const reader = (name: string) => allScreenReadTools().find((t) => t.name === name)!;
const setupNow = () =>
  executeQuery(api(), onboardingSetupGet, { workspaceId }, actor(owner), meta());
const REVIEW = 'https://g.page/r/wizard/review';
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

  it('saves only the answers it is given, on a card that says what will change', async () => {
    const before = await setupNow();
    const save = named('do_onboarding_setup_save')!;
    const exec = createToolExecutor(api());
    const goal = { screen: 'goal', answers: { goal: 'paid', teamSize: 'small' } };

    const prepared = await exec.prepare(save, goal, ctxFor(owner), randomUUID());
    const card = prepared.card;
    if (card?.type !== 'confirm') throw new Error('Expected a confirm card');
    expect(AssistantCard.safeParse(card).success).toBe(true);
    expect(card.title).toBe('Save “Your goal”?');
    expect(card.fields).toContainEqual({
      label: QUESTION_WORDS.goal,
      value: QUESTION_WORDS.goals.paid,
    });
    expect(card.fields).toContainEqual({
      label: QUESTION_WORDS.teamSize,
      value: QUESTION_WORDS.teams.small,
    });
    expect(prepared.result).toMatchObject({ answersChanged: ['goal', 'teamSize'] });
    // Nothing is kept before Confirm.
    expect((await setupNow()).reached).toBe(before.reached);
    await exec.commit(save, goal, ctxFor(owner), { toolCallId: randomUUID() });

    // The next screen gives only its own answer: the goal and team size just saved stay as they are.
    const paid = { screen: 'paid', answers: { reviewLink: REVIEW } };
    const second = await exec.prepare(save, paid, ctxFor(owner), randomUUID());
    if (second.card?.type !== 'confirm') throw new Error('Expected a confirm card');
    expect(second.card.title).toBe('Save “Payments and reviews”?');
    expect(second.card.body).toContain('• Thank-you texts send your Google review link');
    expect(second.result).toMatchObject({
      answersChanged: ['reviewLink'],
      willChange: ['Thank-you texts send your Google review link'],
    });
    const done = await exec.commit(save, paid, ctxFor(owner), { toolCallId: randomUUID() });
    expect(done.outcome).toBe('Saved. Thank-you texts send your Google review link.');

    const after = await setupNow();
    expect(after.reached).toBe('paid');
    expect(after.answers).toMatchObject({ goal: 'paid', teamSize: 'small', reviewLink: REVIEW });
    expect(after.answers.ai).toEqual(before.answers.ai);
    expect(after.state.reviewLink).toBe(REVIEW);
  });

  it('puts the page’s own address on finishing, never one the model gives', async () => {
    const finish = named('do_onboarding_setup_finish')!;
    expect(Object.keys(finish.input.shape)).not.toContain('pageOrigin');
    const filled = await setupInput(
      api(),
      ctxFor(owner),
      finish,
      { workspaceId, answers: { goal: 'booked' }, baseRevision: null },
      'https://app.hfos.test',
    );
    expect(filled?.input['pageOrigin']).toBe('https://app.hfos.test');
    // Over the answers kept: the review link saved before is still there.
    expect(filled?.input['answers']).toMatchObject({ goal: 'booked', reviewLink: REVIEW });
    // Any other command is left as it was given.
    expect(
      await setupInput(api(), ctxFor(owner), named('do_look_set')!, { workspaceId }, ''),
    ).toBeNull();
  });

  it('reads the setup in its screens’ words, where it’s up to first', async () => {
    const exec = createToolExecutor(api());
    const { result } = await exec.run(reader('read_onboarding_setup_get'), {}, ctxFor(owner));
    const data = (result as { data: Record<string, unknown> }).data;
    const keys = Object.keys(data);
    expect(keys[0]).toBe('reached');
    expect(keys.at(-1)).toBe('starting');
    expect(data).toMatchObject({ reached: 'paid', opensAt: expect.any(String) });
    expect(data['progress']).toMatch(/^\d+ of \d+ · /);
    expect(data['screens']).toEqual(
      expect.arrayContaining([{ screen: 'goal', stop: 'Your goal', title: QUESTION_WORDS.goal }]),
    );
    expect(Array.isArray(data['summary'])).toBe(true);
    const state = data['state'] as { teammate: unknown; facts: unknown[] };
    // The teammate's own settings are left out of it.
    expect(state.teammate === null || !('config' in (state.teammate as object))).toBe(true);
  });

  it('reads Getting started as Home’s card shows it, with where each button goes', async () => {
    const exec = createToolExecutor(api());
    const { result } = await exec.run(reader('read_onboarding_status'), {}, ctxFor(owner));
    const data = (result as { data: { steps: Record<string, unknown>[]; next: unknown } }).data;
    const email = data.steps.find((s) => s['key'] === 'email_chat');
    expect(email).toMatchObject({
      title: 'Email & website chat',
      state: 'todo',
      goesTo: 'Settings → Email',
    });
    expect(email!['line']).toEqual(expect.any(String));
    expect(email!['button']).toEqual(expect.any(String));
    const number = data.steps.find((s) => s['key'] === 'number');
    expect(number!['goesTo']).toBe('Its own setup step, which its button opens');
    expect(data.next).toEqual({ key: expect.any(String), title: expect.any(String) });
  });

  it('draws quick setup’s card from the answers it takes, never one it would drop', async () => {
    const save = named('do_ai_setup_save')!;
    // Quick setup's answers are the teammate's own: an `ai` part, as the guided setup has, isn't one of them.
    const args = { step: 'voice', answers: { allowPrices: true, ai: { name: 'Max' } } };
    const prepared = await createToolExecutor(api()).prepare(
      save,
      args,
      ctxFor(owner),
      randomUUID(),
    );
    const card = prepared.card;
    if (card?.type !== 'confirm') throw new Error('Expected a confirm card');
    expect(prepared.result).toMatchObject({ answersChanged: ['allowPrices'] });
    expect(card.fields).toContainEqual({ label: 'Can tell customers prices', value: 'Yes' });
    expect(card.fields.map((f) => f.label)).not.toContain('ai');
  });
});
