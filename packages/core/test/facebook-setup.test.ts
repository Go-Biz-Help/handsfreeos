/**
 * The guided Facebook & Instagram setup (the owner, 24 Nov 2026: F1 a, F2 a, F3 a, F4 a): its own logic
 * (guided-setup/facebook.ts) with no database (where the answers start, which questions are asked, what is wrong with
 * one, what Connect with Facebook saves, the lines beside the questions and on Settings → Facebook & Instagram), then
 * on the local database: Connect with Facebook's save (facebook_setup.save) setting each channel's rules for someone
 * new and spending the answers, lead ads only once a sign-in may read them, nothing changing when an answer is wrong,
 * and the live test (meta_account.test_messages) turning a Page green once a message lands.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { guidedSetupDrafts, metaConnections } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  FACEBOOK_SETUP_WORDS as W,
  facebookIgStepsLine,
  facebookSettingsLines,
  facebookSetupAnswersOf,
  facebookSetupContextFrom,
  facebookSetupFirstProblem,
  facebookSetupIntakeFields,
  facebookSetupLines,
  facebookSetupProblems,
  facebookSetupQuestionOf,
  facebookSetupQuestions,
  facebookSetupStart,
  facebookSignInSteps,
  GUIDED_SETUPS,
  type FacebookSetupContext,
  type FacebookSetupPipeline,
} from '../src';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  facebookSetupSave,
  guidedSetupSaveDraft,
  intakeList,
  metaAccountConnect,
  metaAccountTestMessages,
  metaConnectionActivate,
  metaConnectionConnect,
  metaMessageReceive,
  organizationCreate,
} from '../src/server';

const SALES: FacebookSetupPipeline = {
  id: '0d3f1e3a-6a1b-4c55-9a52-1b2c3d4e5f60',
  name: 'Sales',
  stages: [
    { id: '1d3f1e3a-6a1b-4c55-9a52-1b2c3d4e5f61', name: 'New lead', kind: 'open' },
    { id: '2d3f1e3a-6a1b-4c55-9a52-1b2c3d4e5f62', name: 'Quoted', kind: 'open' },
    { id: '3d3f1e3a-6a1b-4c55-9a52-1b2c3d4e5f63', name: 'Won', kind: 'won' },
  ],
};
const JOBS: FacebookSetupPipeline = {
  id: '4d3f1e3a-6a1b-4c55-9a52-1b2c3d4e5f64',
  name: 'Big jobs',
  stages: [{ id: '5d3f1e3a-6a1b-4c55-9a52-1b2c3d4e5f65', name: 'Site visit', kind: 'open' }],
};

const ctxOf = (over: Partial<Parameters<typeof facebookSetupContextFrom>[0]> = {}) =>
  facebookSetupContextFrom({
    accounts: [],
    connections: [],
    sources: [],
    pipelines: [SALES, JOBS],
    ...over,
  });
const PAGE_ROW = {
  id: '6d3f1e3a-6a1b-4c55-9a52-1b2c3d4e5f66',
  platform: 'facebook' as const,
  name: 'Lone Star HVAC',
  username: null,
  status: 'active' as const,
};
const IG_ROW = {
  id: '7d3f1e3a-6a1b-4c55-9a52-1b2c3d4e5f67',
  platform: 'instagram' as const,
  name: 'Lone Star HVAC',
  username: 'lonestarhvac',
  status: 'active' as const,
};

describe('where the answers start', () => {
  it('starts a business with nothing connected from what most pick: Instagram too, a lead, ads read', () => {
    const ctx = ctxOf();
    expect(ctx.mode).toBe('new');
    expect(facebookSetupStart(ctx)).toEqual({
      instagram: true,
      igProfessional: false,
      igLinked: false,
      igAccess: false,
      createLead: true,
      pipelineId: null,
      stageId: null,
      adsChat: true,
      leadAds: false,
    });
  });

  it('starts a business with a Page from what is connected and set now', () => {
    const ctx = ctxOf({
      accounts: [PAGE_ROW, { ...IG_ROW, status: 'disconnected' }],
      connections: [{ readsAds: false, readsLeads: true }],
      sources: [
        {
          kind: 'messenger',
          active: true,
          createLead: false,
          pipelineId: JOBS.id,
          stageId: null,
        },
        {
          kind: 'facebook_lead_ad',
          active: false,
          createLead: true,
          pipelineId: null,
          stageId: null,
        },
      ],
    });
    expect(ctx.mode).toBe('again');
    expect(ctx.accounts.map((a) => a.platform)).toEqual(['facebook']);
    expect(facebookSetupStart(ctx)).toMatchObject({
      instagram: false,
      igAccess: false,
      createLead: false,
      pipelineId: JOBS.id,
      adsChat: false,
      leadAds: false,
    });
  });

  it('reads saved answers back a field at a time, leaving one that no longer fits at its start', () => {
    const start = facebookSetupStart(ctxOf());
    expect(
      facebookSetupAnswersOf(
        { instagram: false, createLead: 'yes', pipelineId: 'not-an-id', igLinked: true },
        start,
      ),
    ).toEqual({ ...start, instagram: false, igLinked: true });
    expect(facebookSetupAnswersOf(null, start)).toEqual(start);
  });

  it('is saved under its own name, for whoever manages the business’s channels', () => {
    expect(GUIDED_SETUPS.facebook.permission).toBe('channels.manage');
  });
});

describe('which questions, and what stops Next', () => {
  const ctx = ctxOf();
  const a = facebookSetupStart(ctx);

  it('asks Instagram’s steps only with Instagram picked', () => {
    expect(facebookSetupQuestions(a)).toEqual(['inbox', 'instagram', 'leads', 'ads']);
    expect(facebookSetupQuestions({ instagram: false })).toEqual(['inbox', 'leads', 'ads']);
  });

  it('lets good answers through, and never stops on Instagram’s steps', () => {
    expect(facebookSetupFirstProblem(a, ctx)).toBeNull();
    expect(facebookSetupProblems('instagram', a, ctx)).toEqual([]);
  });

  it('says what is wrong in plain words: a pipeline or stage that is gone, lead ads before Meta approves', () => {
    expect(
      facebookSetupProblems('leads', { ...a, pipelineId: randomUUID() }, ctx).map((p) => p.path),
    ).toEqual(['pipelineId']);
    // A stage of another pipeline.
    expect(
      facebookSetupProblems(
        'leads',
        { ...a, pipelineId: JOBS.id, stageId: SALES.stages[1]!.id },
        ctx,
      ),
    ).toEqual([{ path: 'stageId', message: W.problems.stage }]);
    // A closed stage isn't somewhere a lead opens.
    expect(
      facebookSetupProblems('leads', { ...a, stageId: SALES.stages[2]!.id }, ctx).map(
        (p) => p.path,
      ),
    ).toEqual(['stageId']);
    // A customer only doesn't care where leads land.
    expect(
      facebookSetupProblems('leads', { ...a, createLead: false, pipelineId: randomUUID() }, ctx),
    ).toEqual([]);
    expect(facebookSetupProblems('ads', { ...a, leadAds: true }, ctx)).toEqual([
      { path: 'leadAds', message: W.problems.leadAds },
    ]);
    expect(
      facebookSetupProblems('ads', { ...a, leadAds: true }, { ...ctx, readsLeads: true }),
    ).toEqual([]);
    expect(facebookSetupFirstProblem({ ...a, leadAds: true }, ctx)).toBe('ads');
  });

  it('finds the question a refusal is about, from the setup’s path or a channel’s own', () => {
    expect(facebookSetupQuestionOf('answers.leadAds')).toEqual({
      question: 'ads',
      field: 'leadAds',
    });
    expect(facebookSetupQuestionOf('stageId')).toEqual({ question: 'leads', field: 'stageId' });
    expect(facebookSetupQuestionOf('kind')).toBeNull();
  });
});

describe('what Connect with Facebook saves', () => {
  it('turns the channel on with the lead, pipeline and stage picked, or a customer only', () => {
    const a = facebookSetupStart(ctxOf());
    expect(facebookSetupIntakeFields(a)).toEqual({
      active: true,
      createLead: true,
      pipelineId: null,
    });
    expect(
      facebookSetupIntakeFields({ ...a, pipelineId: SALES.id, stageId: SALES.stages[1]!.id }),
    ).toEqual({
      active: true,
      createLead: true,
      pipelineId: SALES.id,
      stageId: SALES.stages[1]!.id,
    });
    expect(facebookSetupIntakeFields({ ...a, createLead: false, pipelineId: JOBS.id })).toEqual({
      active: true,
      createLead: false,
    });
  });

  it('says on Check it over what Facebook’s screens ask', () => {
    expect(facebookSignInSteps({ instagram: true, adsChat: true })).toEqual([
      W.review.pickBoth,
      W.review.permsAds,
      W.review.comesBack,
    ]);
    expect(facebookSignInSteps({ instagram: false, adsChat: false })).toEqual([
      W.review.pickPage,
      W.review.perms,
      W.review.comesBack,
    ]);
  });
});

describe('the lines', () => {
  it('says each answer in a line, for the list and Check it over', () => {
    const ctx = ctxOf({ connections: [{ readsAds: true, readsLeads: true }] });
    const a = {
      ...facebookSetupStart(ctx),
      igProfessional: true,
      igLinked: true,
      stageId: SALES.stages[1]!.id,
      leadAds: true,
    };
    expect(facebookSetupLines(a, ctx).map((l) => [l.key, l.value])).toEqual([
      ['inbox', 'Messenger and Instagram DMs'],
      ['instagram', '2 of 3 steps ticked. Allow access to messages isn’t ticked yet.'],
      ['leads', 'A customer and a lead, in Sales at Quoted'],
      ['ads', 'Ads that start a chat, and lead ads. HandsFreeOS reads your ads.'],
    ]);
    expect(
      facebookSetupLines(
        { ...a, instagram: false, createLead: false, adsChat: false, leadAds: false },
        ctx,
      ).map((l) => l.value),
    ).toEqual(['Messenger only', 'A customer only', 'No ads right now']);
    expect(facebookIgStepsLine({ igProfessional: true, igLinked: true, igAccess: true })).toBe(
      'All 3 steps ticked',
    );
  });

  it('reads Settings’ answers from what is connected and set now', () => {
    const ctx = ctxOf({
      accounts: [PAGE_ROW, IG_ROW],
      connections: [{ readsAds: false, readsLeads: false }],
      sources: [
        { kind: 'messenger', active: true, createLead: true, pipelineId: JOBS.id, stageId: null },
      ],
    });
    expect(facebookSettingsLines(ctx).map((l) => [l.key, l.value])).toEqual([
      ['inbox', 'Messenger and Instagram DMs'],
      ['leads', 'A customer and a lead, in Big jobs at Site visit'],
      ['ads', W.lines.adsNotRead],
    ]);
  });
});

// ---------- on the local database ----------

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (channel: RequestMeta['channel'] = 'test'): RequestMeta => ({
  correlationId: randomUUID(),
  channel,
});
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

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code']) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).code).toBe(code);
    return e as HfosError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

describe('Connect with Facebook, and the live test', () => {
  let owner: TestUser;
  let member: TestUser;
  let wsId: string;
  let orgId: string;
  let connectionId: string;
  let pageId: string;
  let instagramId: string;
  const PAGE = String(4_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
  const INSTAGRAM = String(5_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
  const system = (): SystemActor => ({ type: 'system', workspaceId: wsId, organizationId: orgId });
  const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
    executeCommand(worker(), cmd, input, system(), meta('worker')).then((r) => r.output);
  const ctxNow = async (): Promise<FacebookSetupContext> => {
    const intake = await ask(intakeList, { workspaceId: wsId }, owner);
    return facebookSetupContextFrom({
      accounts: [],
      connections: [],
      sources: intake.sources,
      pipelines: intake.pipelines,
    });
  };
  const source = async (kind: string) =>
    (await ask(intakeList, { workspaceId: wsId }, owner)).sources.find((s) => s.kind === kind)!;

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('facebook-setup-owner', { fullName: 'Dale Owner' }),
      createTestUser('facebook-setup-member', { fullName: 'Marco Member' }),
    ]);
    const org = await run(organizationCreate, { businessName: 'Facebook Setup HVAC' }, owner);
    wsId = org.workspaceId;
    orgId = org.organizationId;
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${wsId}, ${member.id}, 'member')`,
    );
    connectionId = (await run(metaConnectionConnect, { workspaceId: wsId }, owner)).connectionId;
    await sys(metaConnectionActivate, {
      workspaceId: wsId,
      connectionId,
      facebookUserId: '2001',
      facebookUserName: 'Dale Owner',
      scopes: ['pages_messaging', 'instagram_manage_messages', 'ads_read'],
      tokenEnc: 'sealed:user-token-for-tests',
      tokenKeyId: 'test',
      tokenExpiresAt: null,
    });
    const connect = (platform: 'facebook' | 'instagram', externalId: string) =>
      sys(metaAccountConnect, {
        workspaceId: wsId,
        connectionId,
        platform,
        externalId,
        pageId: PAGE,
        name: 'Facebook Setup HVAC',
        ...(platform === 'instagram' ? { username: 'fbsetuphvac' } : {}),
        tokenEnc: 'sealed:page-token-for-tests',
        tokenKeyId: 'test',
        subscribed: true,
      }).then((r) => r.accountId);
    pageId = await connect('facebook', PAGE);
    instagramId = await connect('instagram', INSTAGRAM);
  });
  afterAll(closeTestDbs);

  it('keeps the answers as they’re given, for whoever manages the business’s channels', async () => {
    const answers = facebookSetupStart(await ctxNow());
    await run(guidedSetupSaveDraft, { workspaceId: wsId, setup: 'facebook', answers }, owner);
    await expectHfos(
      () => run(guidedSetupSaveDraft, { workspaceId: wsId, setup: 'facebook', answers }, member),
      'forbidden',
    );
  });

  it('refuses lead ads before a sign-in may read them, in the setup’s words, and changes nothing', async () => {
    const before = await source('messenger');
    const answers = { ...facebookSetupStart(await ctxNow()), createLead: false, leadAds: true };
    const err = await expectHfos(
      () => run(facebookSetupSave, { workspaceId: wsId, answers }, owner),
      'validation',
    );
    expect(err.details).toEqual([{ path: 'answers.leadAds', message: W.problems.leadAds }]);
    expect(await source('messenger')).toEqual(before);
  });

  it('leaves out someone who can’t change the business’s channels', async () => {
    const answers = facebookSetupStart(await ctxNow());
    await expectHfos(
      () => run(facebookSetupSave, { workspaceId: wsId, answers }, member),
      'forbidden',
    );
  });

  it('sets Messenger’s and Instagram’s rules for someone new, and spends the answers', async () => {
    const ctx = await ctxNow();
    const pipeline = ctx.pipelines[0]!;
    const stage = pipeline.stages.filter((s) => s.kind === 'open')[1] ?? pipeline.stages[0]!;
    const answers = {
      ...facebookSetupStart(ctx),
      pipelineId: pipeline.id,
      stageId: stage.id,
    };
    const out = await run(facebookSetupSave, { workspaceId: wsId, answers }, owner);
    expect(out.changed).toEqual(['messenger', 'instagram']);
    for (const kind of ['messenger', 'instagram'])
      expect(await source(kind)).toMatchObject({
        active: true,
        createLead: true,
        pipelineId: pipeline.id,
        stageId: stage.id,
      });
    const left = await admin()
      .select()
      .from(guidedSetupDrafts)
      .where(and(eq(guidedSetupDrafts.workspaceId, wsId), eq(guidedSetupDrafts.setup, 'facebook')));
    expect(left).toHaveLength(0);

    // A customer only, Messenger alone: Instagram's rules stay as they were.
    const again = await run(
      facebookSetupSave,
      { workspaceId: wsId, answers: { ...answers, instagram: false, createLead: false } },
      owner,
    );
    expect(again.changed).toEqual(['messenger']);
    expect(await source('messenger')).toMatchObject({ createLead: false, pipelineId: pipeline.id });
    expect(await source('instagram')).toMatchObject({ createLead: true });
  });

  it('turns lead ads on or off once a sign-in may read them', async () => {
    await admin()
      .update(metaConnections)
      .set({ scopes: ['pages_messaging', 'ads_read', 'leads_retrieval'] })
      .where(eq(metaConnections.id, connectionId));
    const answers = { ...facebookSetupStart(await ctxNow()), leadAds: false };
    const off = await run(facebookSetupSave, { workspaceId: wsId, answers }, owner);
    expect(off.changed).toContain('facebook_lead_ad');
    expect((await source('facebook_lead_ad')).active).toBe(false);
    await run(
      facebookSetupSave,
      { workspaceId: wsId, answers: { ...answers, leadAds: true } },
      owner,
    );
    expect((await source('facebook_lead_ad')).active).toBe(true);
  });

  it('turns a Page green on the live test once a message lands, and only counts ones since it began', async () => {
    const receive = (accountId: string, text: string, occurredAt: string) => {
      const mid = `m_${randomUUID()}`;
      return sys(metaMessageReceive, {
        workspaceId: wsId,
        accountId,
        kind: 'message',
        scopedId: `psid-${randomUUID()}`,
        mid,
        eventKey: `evt:${mid}`,
        text,
        occurredAt,
      });
    };
    await receive(pageId, 'An old question', new Date(Date.now() - 60 * 60_000).toISOString());
    const since = new Date(Date.now() - 60_000).toISOString();
    const before = await ask(metaAccountTestMessages, { workspaceId: wsId, since }, owner);
    expect(before.accounts.map((a) => [a.accountId, a.gotAt])).toEqual([
      [pageId, null],
      [instagramId, null],
    ]);
    await receive(pageId, '  Testing   1 2 3  ', new Date().toISOString());
    const after = await ask(metaAccountTestMessages, { workspaceId: wsId, since }, owner);
    expect(after.accounts.find((a) => a.accountId === pageId)).toMatchObject({
      platform: 'facebook',
      preview: 'Testing 1 2 3',
      gotAt: expect.any(String),
    });
    expect(after.accounts.find((a) => a.accountId === instagramId)?.gotAt).toBeNull();
    await expectHfos(
      () => ask(metaAccountTestMessages, { workspaceId: wsId, since }, member),
      'forbidden',
    );
  });
});
