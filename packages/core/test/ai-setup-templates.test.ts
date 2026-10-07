/**
 * An agency's saved answers for quick setup on the local database (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md
 * §9):
 * - **Saving** keeps the answers one of its businesses was set up with, only those that aren't about it, for the
 *   agency's owners and admins; a name once per agency.
 * - **Starting from them**: a business without a teammate starts from the ones picked on the first screen, else
 *   from the newest saved for its kind; picking others picks those answers again, and ones removed leave our picks.
 * - **Renaming and removing** them is the agency's, and changes no business.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AiSetupAnswers, startingJobs } from '../src/ai-setup/index';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  aiSetupFinish,
  aiSetupGet,
  aiSetupSave,
  aiSetupTemplateDelete,
  aiSetupTemplateList,
  aiSetupTemplateRename,
  aiSetupTemplateSave,
  organizationCreate,
  workspaceCreate,
} from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());
const get = (u: TestUser, workspaceId: string) => ask(aiSetupGet, { workspaceId }, u);

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect({ code: err.code, rule: err.rule }).toMatchObject({ code, ...(rule ? { rule } : {}) });
    return err;
  }
  throw new Error(`expected ${code}${rule ? ` (${rule})` : ''}, but the call succeeded`);
}

const QUESTION = {
  id: 'tank',
  question: 'Is the water heater gas or electric?',
  kind: 'choice' as const,
  options: ['Gas', 'Electric', 'Not sure'],
};

/** Agency owner. */
let rita: TestUser;
/** Agency admin. */
let alex: TestUser;
/** Cool Air's own owner, not in the agency. */
let carl: TestUser;
/** Another agency's owner. */
let olga: TestUser;
let org: string;
/** Pipes Plumbing: set up, so its answers can be saved. */
let pipes: string;
/** Cool Air HVAC: home services, like Pipes. */
let cool: string;
/** Bright Smiles Dental: another kind. */
let smiles: string;
let saved: string;

beforeAll(async () => {
  [rita, alex, carl, olga] = await Promise.all([
    createTestUser('setups-agency-owner', { fullName: 'Rita Agency' }),
    createTestUser('setups-agency-admin', { fullName: 'Alex Agency' }),
    createTestUser('setups-client-owner', { fullName: 'Carl Client' }),
    createTestUser('setups-other-agency', { fullName: 'Olga Other' }),
  ]);
  const made = await run(
    organizationCreate,
    { businessName: 'Pipes Plumbing', industry: 'plumbing' },
    rita,
  );
  org = made.organizationId;
  pipes = made.workspaceId;
  cool = (
    await run(
      workspaceCreate,
      { organizationId: org, name: 'Cool Air HVAC', industry: 'hvac' },
      rita,
    )
  ).workspaceId;
  smiles = (
    await run(
      workspaceCreate,
      { organizationId: org, name: 'Bright Smiles Dental', industry: 'dental' },
      rita,
    )
  ).workspaceId;
  await run(organizationCreate, { businessName: 'Olga Salon', industry: 'hair_salon' }, olga);
  await rows(
    admin(),
    sql`insert into app.organization_memberships (organization_id, user_id, role) values (${org}, ${alex.id}, 'admin')`,
  );
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${cool}, ${carl.id}, 'owner')`,
  );

  // Pipes Plumbing is set up the way the agency likes it.
  const { answers } = await get(rita, pipes);
  await run(
    aiSetupFinish,
    {
      workspaceId: pipes,
      baseRevision: null,
      answers: AiSetupAnswers.parse({
        ...answers,
        jobs: ['reply', 'answer', 'qualify', 'follow_up'],
        description: 'Pipes, drains and water heaters in Katy.',
        name: 'Max',
        tone: 'professional',
        disclosure: 'when_asked',
        answerWhen: 'after_hours',
        allowPrices: true,
        questions: [QUESTION],
      }),
    },
    rita,
  );
});
afterAll(closeTestDbs);

describe('ai_setup_template.save', () => {
  it('keeps the answers a business was set up with, only those that aren’t about it', async () => {
    const out = await run(
      aiSetupTemplateSave,
      { organizationId: org, workspaceId: pipes, name: 'Plumbers' },
      alex,
    );
    saved = out.templateId;
    expect(out).toMatchObject({ name: 'Plumbers', kind: 'home' });
    const [row] = await rows<{
      kind: string;
      answers: Record<string, unknown>;
      from_workspace_id: string;
      created_by: string;
    }>(
      admin(),
      sql`select kind, answers, from_workspace_id, created_by from app.ai_setup_templates where id = ${saved}`,
    );
    expect(row).toMatchObject({ kind: 'home', from_workspace_id: pipes, created_by: alex.id });
    expect(Object.keys(row!.answers).sort()).toEqual(
      [
        'allowPrices',
        'answerWhen',
        'customHours',
        'disclosure',
        'jobs',
        'name',
        // The open hours too, for the onboarding setup (the owner's 54A); a business's own come first.
        'openHours',
        'questions',
        'tone',
      ].sort(),
    );
    expect(row!.answers).toMatchObject({
      jobs: ['reply', 'answer', 'qualify', 'follow_up'],
      name: 'Max',
      tone: 'professional',
      disclosure: 'when_asked',
      answerWhen: 'after_hours',
      allowPrices: true,
      questions: [expect.objectContaining({ question: QUESTION.question })],
    });
    const [ev] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where event_type = 'ai_setup_template.saved' and entity_id = ${saved} and organization_id = ${org}`,
    );
    expect(ev!.n).toBe(1);
  });

  it('keeps a name once per agency', async () => {
    const err = await expectHfos(
      () =>
        run(
          aiSetupTemplateSave,
          { organizationId: org, workspaceId: pipes, name: ' plumbers ' },
          rita,
        ),
      'conflict',
      'name_taken',
    );
    expect(err.message).toContain('“plumbers”');
  });

  it('needs a business that’s set up', async () => {
    const err = await expectHfos(
      () =>
        run(
          aiSetupTemplateSave,
          { organizationId: org, workspaceId: smiles, name: 'Dentists' },
          rita,
        ),
      'rule_violation',
      'no_teammate',
    );
    expect(err.message).toContain('Bright Smiles Dental hasn’t set up its AI teammate yet');
  });

  it('is for the agency’s owners and admins, from its own businesses', async () => {
    // Someone who runs one of its businesses isn't part of the agency.
    await expectHfos(
      () =>
        run(aiSetupTemplateSave, { organizationId: org, workspaceId: pipes, name: 'Mine' }, carl),
      'not_found',
    );
    await expectHfos(() => ask(aiSetupTemplateList, { organizationId: org }, carl), 'not_found');
    const [olgaOrg] = await rows<{ id: string }>(
      admin(),
      sql`select organization_id as id from app.organization_memberships where user_id = ${olga.id}`,
    );
    await expectHfos(
      () =>
        run(
          aiSetupTemplateSave,
          { organizationId: olgaOrg!.id, workspaceId: pipes, name: 'Taken' },
          olga,
        ),
      'not_found',
    );
  });
});

describe('ai_setup_template.list', () => {
  it('lists them by name, with what each sets and where it came from', async () => {
    const { items } = await ask(aiSetupTemplateList, { organizationId: org }, rita);
    expect(items).toEqual([
      expect.objectContaining({
        id: saved,
        name: 'Plumbers',
        kind: 'home',
        about:
          'Max · Professional · Replies to new leads, answers questions, asks qualifying questions, follows up',
        from: { workspaceId: pipes, name: 'Pipes Plumbing' },
      }),
    ]);
  });
});

describe('starting quick setup from them', () => {
  it('starts a business of the same kind from the newest saved for it', async () => {
    const r = await get(carl, cool);
    expect(r.templates).toEqual([
      expect.objectContaining({ id: saved, name: 'Plumbers', kind: 'home' }),
    ]);
    expect(r).toMatchObject({ templateId: saved, templatePicked: false, saveTo: null });
    expect(r.starting).toMatchObject({
      jobs: ['reply', 'answer', 'qualify', 'follow_up'],
      name: 'Max',
      tone: 'professional',
      disclosure: 'when_asked',
      answerWhen: 'after_hours',
      allowPrices: true,
      questions: [expect.objectContaining({ question: QUESTION.question })],
    });
    expect(r.answers).toEqual(r.starting);
    // What's about the business itself isn't carried over.
    expect(r.starting.description).toBe('');
  });

  it('starts a business of another kind from our picks, unless they’re picked', async () => {
    const r = await get(rita, smiles);
    expect(r).toMatchObject({ templateId: null, templatePicked: false });
    expect(r.starting.name).toBe('Ava');
    // The agency's owners and admins may save these answers for its other businesses.
    expect(r.saveTo).toEqual({ organizationId: org, name: expect.any(String) });

    await run(
      aiSetupSave,
      { workspaceId: smiles, step: 'business', answers: r.answers, templateId: saved },
      rita,
    );
    const after = await get(rita, smiles);
    expect(after).toMatchObject({ templateId: saved, templatePicked: true, reached: 'business' });
    expect(after.answers).toMatchObject({ name: 'Max', tone: 'professional' });
  });

  it('picks those answers again when where they start from changes', async () => {
    const r = await get(carl, cool);
    await run(aiSetupSave, { workspaceId: cool, step: 'business', answers: r.answers }, carl);
    await run(
      aiSetupSave,
      { workspaceId: cool, step: 'jobs', answers: { ...r.answers, jobs: ['answer'] } },
      carl,
    );
    expect((await get(carl, cool)).answers.jobs).toEqual(['answer']);

    // Back on the first screen, "Our picks for this kind of business".
    const back = await get(carl, cool);
    await run(
      aiSetupSave,
      { workspaceId: cool, step: 'business', answers: back.answers, templateId: null },
      carl,
    );
    const now = await get(carl, cool);
    expect(now).toMatchObject({ templateId: null, templatePicked: true, reached: 'jobs' });
    expect(now.answers).toMatchObject({
      jobs: startingJobs(null, 'home'),
      name: 'Ava',
      disclosure: 'first_message',
      allowPrices: false,
    });
  });

  it('refuses ones that aren’t there, and a pick after the first screen', async () => {
    const { answers } = await get(carl, cool);
    await expectHfos(
      () =>
        run(
          aiSetupSave,
          { workspaceId: cool, step: 'business', answers, templateId: randomUUID() },
          carl,
        ),
      'rule_violation',
      'template_gone',
    );
    await expectHfos(
      () => run(aiSetupSave, { workspaceId: cool, step: 'jobs', answers, templateId: saved }, carl),
      'validation',
    );
  });

  it('offers none to a business that’s set up', async () => {
    const r = await get(rita, pipes);
    expect(r).toMatchObject({ templates: [], templateId: null });
    expect(r.starting.name).toBe('Max');
  });
});

describe('renaming and removing them', () => {
  it('renames them, once per agency, for its owners and admins', async () => {
    await expect(
      run(
        aiSetupTemplateRename,
        { organizationId: org, templateId: saved, name: 'Home services' },
        alex,
      ),
    ).resolves.toEqual({ templateId: saved, name: 'Home services' });
    await expectHfos(
      () =>
        run(aiSetupTemplateRename, { organizationId: org, templateId: saved, name: 'Mine' }, carl),
      'not_found',
    );
    const second = await run(
      aiSetupTemplateSave,
      { organizationId: org, workspaceId: pipes, name: 'Plumbers' },
      rita,
    );
    await expectHfos(
      () =>
        run(
          aiSetupTemplateRename,
          { organizationId: org, templateId: second.templateId, name: 'HOME SERVICES' },
          rita,
        ),
      'conflict',
      'name_taken',
    );
    await run(aiSetupTemplateDelete, { organizationId: org, templateId: second.templateId }, rita);
  });

  it('removes them, and a business that picked them starts from our picks', async () => {
    await expectHfos(
      () => run(aiSetupTemplateDelete, { organizationId: org, templateId: saved }, carl),
      'not_found',
    );
    await expect(
      run(aiSetupTemplateDelete, { organizationId: org, templateId: saved }, alex),
    ).resolves.toEqual({ templateId: saved });
    await expectHfos(
      () => run(aiSetupTemplateDelete, { organizationId: org, templateId: saved }, alex),
      'not_found',
    );
    const r = await get(rita, smiles);
    expect(r).toMatchObject({ templates: [], templateId: null, templatePicked: true });
    expect(r.starting.name).toBe('Ava');
    expect((await ask(aiSetupTemplateList, { organizationId: org }, rita)).items).toEqual([]);
  });
});
