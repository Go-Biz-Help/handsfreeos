/**
 * The agency's pushes, end to end through the outbox and the jobs: a template pushed to two businesses
 * becomes a draft in each (an unmapped placeholder shows as an issue there, and a redelivered push adds
 * nothing); a newer version shows as an update, and applying it through the worker's route keeps the
 * business's own changes, flagged; a knowledge pack becomes suggestions once, however often the job runs.
 */
import { randomUUID } from 'node:crypto';
import {
  createTokenVerifier,
  executeQuery,
  knowledgeItemCreate,
  knowledgePackCreate,
  knowledgePackPush,
  knowledgeSuggestionList,
  pipelineList,
  workflowCreate,
  workflowGet,
  workflowList,
  workflowSaveDraft,
  workflowTemplateCreateFromWorkflow,
  workflowTemplateGet,
  workflowTemplatePublish,
  workflowTemplatePush,
  workflowTemplateSaveDraft,
  workspaceCreate,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { createTestUser, signInTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { packContent } from '../src/workflows/templates';
import { admin, api, CHI, flowWorld, run, type World } from './workflow-world';

let w: World;
let server: FastifyInstance;
let bayou: string;
let stageA: string;
let sourceId: string;
let templateId: string;
let copyA: string;
let copyB: string;
let member: TestUser;

const WAIT1 = 's_efuwait1';
const TASK1 = 's_efutask1';

const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser = w.owner,
) => executeQuery(api(), q, input, human(u), { correlationId: randomUUID(), channel: 'test' });

/** The outbox and jobs over this organization's work (its push events have no workspace), until idle. */
async function drainOrg(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const table of ['outbox', 'scheduled_jobs'])
      await rows(
        admin(),
        sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${w.workerId}
            where status = 'pending' and organization_id = ${w.organizationId}`,
      );
    const d = { ...w.s, workerId: w.workerId, batchSize: 200, reservedOnly: true };
    const passes = [await processOnce({ ...d, handlers }), await processJobs({ ...d, jobs })];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select kind as what, last_error from app.scheduled_jobs
              where organization_id = ${w.organizationId} and last_error is not null and status <> 'done'
            union all select event_type, last_error from app.outbox
              where organization_id = ${w.organizationId} and last_error is not null and status <> 'done'`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

async function copyIn(workspaceId: string): Promise<string[]> {
  return (
    await rows<{ id: string }>(
      admin(),
      sql`select id from app.workflows where workspace_id = ${workspaceId} and template_id = ${templateId}
          order by created_at`,
    )
  ).map((r) => r.id);
}

const post = (url: string, token: string, payload: unknown) =>
  server.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });

beforeAll(async () => {
  w = await flowWorld('wftpl');
  const env = testEnv();
  server = await buildHttpServer({
    ...w.s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  });
  // A second client business in the same agency.
  bayou = (
    await run(w, workspaceCreate, {
      organizationId: w.organizationId,
      name: 'Bayou Plumbing Test',
      timezone: CHI,
    })
  ).workspaceId;
  member = await createTestUser('wftpl-member', { fullName: 'Mike Member' });
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${w.workspaceId}, ${member.id}, 'member')`,
  );
  const { pipelines } = await ask(pipelineList, { workspaceId: w.workspaceId });
  stageA = pipelines[0]!.stages.find((s) => s.name === 'Estimate sent')!.id;
  sourceId = (
    await run(w, workflowCreate, {
      workspaceId: w.workspaceId,
      name: 'Estimate follow-up',
      from: 'recipe',
      recipeKey: 'estimate_follow_up',
    })
  ).workflowId;
  // The recipe runs on the estimate going out (M9) and names nothing of Lone Star's own, so its trigger is
  // pointed at one of their stages here. A template's whole job is swapping a real id for a placeholder and
  // back again, so the source workflow has to carry one.
  await run(w, workflowSaveDraft, {
    workspaceId: w.workspaceId,
    workflowId: sourceId,
    baseRevision: 1,
    ops: [
      {
        op: 'set_trigger',
        trigger: {
          kind: 'event',
          event: 'lead.stage_changed',
          filters: {
            match: 'all',
            conditions: [{ field: 'trigger.to_stage_id', op: 'eq', value: stageA }],
          },
        },
      },
    ],
  });
  templateId = (
    await run(w, workflowTemplateCreateFromWorkflow, {
      organizationId: w.organizationId,
      workflowId: sourceId,
      name: 'Estimate follow-up (home services)',
    })
  ).templateId;
  await run(w, workflowTemplatePublish, { organizationId: w.organizationId, templateId });
});
afterAll(async () => {
  await server?.close();
  await w?.app.close();
});

describe('a template push', () => {
  it('makes a draft in each of two businesses; an unmapped placeholder shows as an issue', async () => {
    const pushed = await run(w, workflowTemplatePush, {
      organizationId: w.organizationId,
      templateId,
      workspaceIds: [w.workspaceId, bayou],
      // Bayou's stage is left for Bayou to pick.
      mappings: {
        [w.workspaceId]: { stage_estimate_sent: stageA },
        [bayou]: { stage_estimate_sent: null },
      },
    });
    expect(pushed.installIds).toHaveLength(2);
    await drainOrg();

    expect(await copyIn(w.workspaceId)).toHaveLength(1);
    expect(await copyIn(bayou)).toHaveLength(1);
    copyA = (await copyIn(w.workspaceId))[0]!;
    copyB = (await copyIn(bayou))[0]!;
    const a = await ask(workflowGet, { workspaceId: w.workspaceId, workflowId: copyA });
    expect(a.workflow).toMatchObject({
      status: 'draft',
      tested: false,
      installedRevision: 1,
      source: { kind: 'template', template: { id: templateId, installedVersion: 1 } },
    });
    expect(JSON.stringify(a.workflow.definition)).toContain(stageA);
    expect(a.workflow.issues.map((i) => i.code)).not.toContain('placeholder_unmapped');

    const b = await ask(workflowGet, { workspaceId: bayou, workflowId: copyB });
    const issue = b.workflow.issues.find((i) => i.code === 'placeholder_unmapped');
    expect(issue).toMatchObject({ severity: 'error' });
    // With a Fix: Bayou has an "Estimate sent" stage of its own to use.
    expect(issue!.fixes.map((f) => f.id)).toEqual(
      expect.arrayContaining(['use_suggestion', 'remove_placeholder']),
    );

    const { installs, template } = await ask(workflowTemplateGet, {
      organizationId: w.organizationId,
      templateId,
    });
    expect(template.installs).toMatchObject({ total: 2, installed: 2, pending: 0, behind: 0 });
    expect(installs.find((i) => i.workspaceId === bayou)).toMatchObject({
      status: 'installed',
      workflowId: copyB,
      installedVersion: 1,
      mapping: { stage_estimate_sent: null },
    });
  });

  it('adds nothing when the push is delivered again', async () => {
    const [ev] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.events where entity_id = ${templateId} and event_type = 'workflow_template.pushed'
          order by created_at desc limit 1`,
    );
    await rows(
      admin(),
      sql`update app.outbox set status = 'pending', next_attempt_at = now() where event_id = ${ev!.id}`,
    );
    await drainOrg();
    expect(await copyIn(w.workspaceId)).toEqual([copyA]);
    expect(await copyIn(bayou)).toEqual([copyB]);
  });
});

describe('an update to the template', () => {
  let token: string;
  beforeAll(async () => {
    token = await signInTestUser(w.owner);
  });

  it('shows as available, and applying it keeps the business’s own changes, flagged', async () => {
    // Lone Star rewords its task; the agency lengthens the first wait and publishes version 2.
    const got = await ask(workflowGet, { workspaceId: w.workspaceId, workflowId: copyA });
    const edited = await run(w, workflowSaveDraft, {
      workspaceId: w.workspaceId,
      workflowId: copyA,
      baseRevision: got.workflow.revision,
      ops: [{ op: 'update_step', stepId: TASK1, patch: { config: { title: 'Call them today' } } }],
    });
    const { template: t } = await ask(workflowTemplateGet, {
      organizationId: w.organizationId,
      templateId,
    });
    await run(w, workflowTemplateSaveDraft, {
      organizationId: w.organizationId,
      templateId,
      baseRevision: t.revision,
      ops: [
        {
          op: 'update_step',
          stepId: WAIT1,
          patch: { until: { kind: 'duration', duration: { amount: 4, unit: 'days' } } },
        },
      ],
    });
    await run(w, workflowTemplatePublish, { organizationId: w.organizationId, templateId });

    const listed = await ask(workflowList, { workspaceId: w.workspaceId }, member);
    expect(listed.items.find((x) => x.id === copyA)!.source.template).toMatchObject({
      installedVersion: 1,
      latestVersion: 2,
      updateAvailable: true,
    });
    const behind = await ask(workflowTemplateGet, { organizationId: w.organizationId, templateId });
    expect(behind.template.installs.behind).toBe(2);

    // What Lone Star reads before applying.
    const ref = { workspaceId: w.workspaceId, workflowId: copyA };
    const preview = await post('/v1/workflows/template-update', token, ref);
    expect(preview.statusCode, preview.body).toBe(200);
    const p = preview.json() as Record<string, unknown>;
    expect(p).toMatchObject({
      installedVersion: 1,
      latestVersion: 2,
      updateAvailable: true,
      changedSinceInstall: true,
      revision: edited.revision,
    });
    expect((p['templateChanges'] as string[]).join(' ')).toMatch(/4 days/);
    expect((p['yourChanges'] as string[]).join(' ')).toMatch(/Call them today/);
    expect(p['kept']).toHaveLength(1);
    expect(p['dropped']).toEqual([]);

    // Only people who manage workflows there.
    const memberToken = await signInTestUser(member);
    expect((await post('/v1/workflows/template-update', memberToken, ref)).statusCode).toBe(403);
    expect(
      (await post('/v1/workflows/template-update', token, { ...ref, workspaceId: randomUUID() }))
        .statusCode,
    ).toBe(404);

    const stale = await post('/v1/workflows/template-update/apply', token, {
      ...ref,
      baseRevision: edited.revision - 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { rule: 'revision_conflict' } });

    const applied = await post('/v1/workflows/template-update/apply', token, {
      ...ref,
      baseRevision: edited.revision,
    });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toMatchObject({
      version: 2,
      changed: true,
      revision: edited.revision + 1,
      dropped: [],
    });
    expect((applied.json() as { kept: string[] }).kept.join(' ')).toMatch(/Call them today/);

    // A draft revision, never live: the template's change and Lone Star's own are both in it.
    const after = await ask(workflowGet, ref);
    const steps = after.workflow.definition['steps'] as {
      id: string;
      until?: { duration?: { amount?: number } };
      config?: { title?: string };
    }[];
    expect(steps.find((s) => s.id === WAIT1)!.until!.duration!.amount).toBe(4);
    expect(steps.find((s) => s.id === TASK1)!.config!.title).toBe('Call them today');
    expect(after.workflow).toMatchObject({
      status: 'draft',
      activeVersion: null,
      tested: false,
      changedSinceInstall: true,
      source: { template: { installedVersion: 2, updateAvailable: false } },
    });
    // The audit says the system did it for the person who asked.
    const [ev] = await rows<{ actor_type: string; payload: Record<string, unknown> }>(
      admin(),
      sql`select actor_type::text as actor_type, payload from app.events
          where entity_id = ${copyA} and event_type = 'workflow_template.updated'`,
    );
    expect(ev).toMatchObject({ actor_type: 'system', payload: { onBehalfOf: w.owner.id, to: 2 } });

    // The agency sees Lone Star caught up and Bayou still behind.
    const { installs } = await ask(workflowTemplateGet, {
      organizationId: w.organizationId,
      templateId,
    });
    expect(installs.find((i) => i.workspaceId === w.workspaceId)).toMatchObject({
      installedVersion: 2,
      behind: false,
    });
    expect(installs.find((i) => i.workspaceId === bayou)).toMatchObject({ behind: true });

    const again = await post('/v1/workflows/template-update/apply', token, {
      ...ref,
      baseRevision: edited.revision + 1,
    });
    expect(again.json()).toMatchObject({ error: { rule: 'template_current' } });
  });
});

describe('a knowledge pack push', () => {
  const items = [
    { kind: 'faq', title: 'Do you service heat pumps?', body: 'Yes, every major brand.' },
    { kind: 'article', title: 'How often to change a filter', body: 'Every one to three months.' },
    { kind: 'fact', title: 'Emergency line', body: 'Answered 24/7.' },
  ];
  const packSuggestions = async (workspaceId: string) =>
    (await ask(knowledgeSuggestionList, { workspaceId, reason: 'pack', status: 'pending' })).items;

  it('turns items into suggestions once, even when the job runs again', async () => {
    // Bayou already has one of the answers.
    await run(w, knowledgeItemCreate, {
      workspaceId: bayou,
      content: { kind: 'fact', title: 'Emergency line', body: 'Call anytime.' },
      status: 'published',
    });
    const pack = await run(w, knowledgePackCreate, {
      organizationId: w.organizationId,
      name: 'HVAC starter',
      items,
    });
    await run(w, knowledgePackPush, {
      organizationId: w.organizationId,
      packId: pack.packId,
      workspaceIds: [w.workspaceId, bayou],
    });
    await drainOrg();

    const a = await packSuggestions(w.workspaceId);
    expect(a.map((s) => s.proposed.title).sort()).toEqual(
      ['Do you service heat pumps?', 'Emergency line', 'How often to change a filter'].sort(),
    );
    expect(a[0]!.source).toMatchObject({ packId: pack.packId, version: 1 });
    expect(a.find((s) => s.kind === 'faq')!.proposed.body).toBe('Yes, every major brand.');
    expect((await packSuggestions(bayou)).map((s) => s.proposed.title).sort()).toEqual(
      ['Do you service heat pumps?', 'How often to change a filter'].sort(),
    );

    // The jobs again (a retry), and the push delivered again: nothing twice.
    await rows(
      admin(),
      sql`update app.scheduled_jobs set status = 'pending', run_at = now(), finished_at = null
          where kind = 'knowledge_pack.install' and organization_id = ${w.organizationId}`,
    );
    await drainOrg();
    await run(w, knowledgePackPush, {
      organizationId: w.organizationId,
      packId: pack.packId,
      workspaceIds: [w.workspaceId],
    });
    await drainOrg();
    expect(await packSuggestions(w.workspaceId)).toHaveLength(3);
    expect(await packSuggestions(bayou)).toHaveLength(2);
  });

  it('proposes items the way the knowledge base keeps them', () => {
    expect(packContent({ kind: 'faq', title: 'Q?', body: 'A.', tags: ['x'] })).toEqual({
      kind: 'faq',
      question: 'Q?',
      answer: 'A.',
      tags: ['x'],
    });
    // A fact longer than a fact can be doesn't fit.
    expect(packContent({ kind: 'fact', title: 'Long', body: 'x'.repeat(2001) })).toBeNull();
    expect(packContent({ kind: 'document', title: 'File', body: 'x' })).toBeNull();
  });
});
