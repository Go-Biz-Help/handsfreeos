/**
 * Agency templates on the local database: a template's draft saves like a workflow's (a base revision, a bad
 * op's index, org owners and admins only); the engine's install turns a push into a draft with its template
 * origin (a business that already has its copy keeps it); and applying an update keeps the business's own
 * changes on top of the new version, as a draft revision.
 */
import { and, eq } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import { events, workflows, workflowTemplateInstalls } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  executeCommand,
  organizationCreate,
  pipelineList,
  planTemplateUpdate,
  workflowCreate,
  workflowGet,
  workflowList,
  workflowSaveDraft,
  workflowTemplateApplyUpdate,
  workflowTemplateCreateFromWorkflow,
  workflowTemplateInstall,
  workflowTemplatePublish,
  workflowTemplatePush,
  workflowTemplateSaveDraft,
  type CommandDef,
} from '../src/server';
import { admin, ask, expectHfos, meta, run, system, type Scope } from './calendar-helpers';

let owner: TestUser, member: TestUser;
let scope: Scope;
let orgId: string, wsId: string, estimateStage: string, sourceId: string, templateId: string;

const WAIT1 = 's_efuwait1';
const TASK1 = 's_efutask1';

/** A command as the engine, bound to the business. */
const asSystem = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
) =>
  executeCommand(testDbs().worker.db, cmd, input, system(scope), meta('worker')).then(
    (r) => r.output,
  );
const waitOf = (d: Record<string, unknown>, id: string) =>
  JSON.stringify((d['steps'] as { id: string; until?: unknown }[]).find((s) => s.id === id)?.until);
const taskTitle = (d: Record<string, unknown>) =>
  (d['steps'] as { id: string; config?: { title?: string } }[]).find((s) => s.id === TASK1)?.config
    ?.title;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('wft-owner', { fullName: 'Chris Agency' }),
    createTestUser('wft-member', { fullName: 'Mike Member' }),
  ]);
  const org = await run(organizationCreate, { businessName: 'Template Co HVAC' }, owner);
  orgId = org.organizationId;
  wsId = org.workspaceId;
  scope = { workspaceId: wsId, organizationId: orgId };
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
  const { pipelines } = await ask(pipelineList, { workspaceId: wsId }, owner);
  estimateStage = pipelines[0]!.stages.find((s) => s.name === 'Estimate sent')!.id;
  sourceId = (
    await run(
      workflowCreate,
      {
        workspaceId: wsId,
        name: 'Estimate follow-up',
        from: 'recipe',
        recipeKey: 'estimate_follow_up',
        mapping: { estimate_stage: estimateStage },
      },
      owner,
    )
  ).workflowId;
  templateId = (
    await run(
      workflowTemplateCreateFromWorkflow,
      { organizationId: orgId, workflowId: sourceId, name: 'Estimate follow-up (home services)' },
      owner,
    )
  ).templateId;
});
afterAll(closeTestDbs);

describe('a template’s draft', () => {
  const ref = () => ({ organizationId: orgId, templateId });
  const longerWait = {
    op: 'update_step',
    stepId: WAIT1,
    patch: { until: { kind: 'duration', duration: { amount: 3, unit: 'days' } } },
  };

  it('saves ops against a base revision, and says what changed', async () => {
    const out = await run(
      workflowTemplateSaveDraft,
      { ...ref(), baseRevision: 1, ops: [longerWait] },
      owner,
    );
    expect(out).toMatchObject({ templateId, revision: 2, changed: true });
    expect(out.changes.join(' ')).toMatch(/3 days/);
    // Its placeholder is what a template is made of, not a problem.
    expect(out.issues.map((i) => i.code)).not.toContain('placeholder_unmapped');
    const [ev] = await admin()
      .select({ payload: events.payload, actorId: events.actorId })
      .from(events)
      .where(
        and(eq(events.entityId, templateId), eq(events.eventType, 'workflow_template.draft_saved')),
      );
    expect(ev).toMatchObject({ actorId: owner.id, payload: { revision: 2, opCount: 1 } });

    // The same change again changes nothing, and makes no revision.
    expect(
      await run(workflowTemplateSaveDraft, { ...ref(), baseRevision: 2, ops: [longerWait] }, owner),
    ).toMatchObject({ revision: 2, changed: false, changes: [] });
  });

  it('refuses a stale base revision and names a bad op', async () => {
    const stale = await expectHfos(
      () => run(workflowTemplateSaveDraft, { ...ref(), baseRevision: 1, ops: [longerWait] }, owner),
      'revision_conflict',
      409,
    );
    expect(stale.details).toEqual({ revision: 2 });
    const bad = await expectHfos(
      () =>
        run(
          workflowTemplateSaveDraft,
          {
            ...ref(),
            baseRevision: 2,
            ops: [longerWait, { op: 'delete_step', stepId: 's_nothere0' }],
          },
          owner,
        ),
      'workflow_op_invalid',
      400,
    );
    expect(bad.details).toMatchObject({ opIndex: 1, code: 'step_not_found' });
  });

  it('belongs to the agency: a business’s member can’t reach it', async () => {
    await expectHfos(
      () => run(workflowTemplateSaveDraft, { ...ref(), baseRevision: 2, ops: [] }, member),
      'not_found',
    );
  });
});

describe('installs and updates (the engine’s side)', () => {
  let installId: string, copyId: string;

  it('turns a push into a draft with its template origin, once', async () => {
    await run(workflowTemplatePublish, { organizationId: orgId, templateId }, owner);
    const pushed = await run(
      workflowTemplatePush,
      {
        organizationId: orgId,
        templateId,
        workspaceIds: [wsId],
        mappings: { [wsId]: { stage_estimate_sent: estimateStage } },
      },
      owner,
    );
    installId = pushed.installIds[0]!;
    const out = await asSystem(workflowTemplateInstall, { workspaceId: wsId, installId });
    expect(out).toMatchObject({ status: 'installed', version: 1, created: true, unmapped: [] });
    copyId = out.workflowId!;
    const [copy] = await admin().select().from(workflows).where(eq(workflows.id, copyId));
    expect(copy).toMatchObject({
      status: 'draft',
      templateId,
      templateVersion: 1,
      installedRevision: 1,
      createdBy: owner.id,
    });
    expect(JSON.stringify(copy!.definition)).toContain(estimateStage);
    const [install] = await admin()
      .select()
      .from(workflowTemplateInstalls)
      .where(eq(workflowTemplateInstalls.id, installId));
    expect(install).toMatchObject({ status: 'installed', workflowId: copyId, installedVersion: 1 });

    // Pushed again, the business keeps the copy it has.
    await run(
      workflowTemplatePush,
      { organizationId: orgId, templateId, workspaceIds: [wsId] },
      owner,
    );
    expect(await asSystem(workflowTemplateInstall, { workspaceId: wsId, installId })).toMatchObject(
      {
        created: false,
        workflowId: copyId,
      },
    );
  });

  it('applies a newer version as a draft revision, keeping the business’s own changes', async () => {
    // The business rewords its task; the agency lengthens the first wait and publishes version 2.
    const got = await ask(workflowGet, { workspaceId: wsId, workflowId: copyId }, owner);
    const edited = await run(
      workflowSaveDraft,
      {
        workspaceId: wsId,
        workflowId: copyId,
        baseRevision: got.workflow.revision,
        ops: [
          { op: 'update_step', stepId: TASK1, patch: { config: { title: 'Call them today' } } },
        ],
      },
      owner,
    );
    const t = await ask(workflowGet, { workspaceId: wsId, workflowId: copyId }, owner);
    expect(t.workflow.changedSinceInstall).toBe(true);
    await run(
      workflowTemplateSaveDraft,
      {
        organizationId: orgId,
        templateId,
        baseRevision: 2,
        ops: [
          {
            op: 'update_step',
            stepId: WAIT1,
            patch: { until: { kind: 'duration', duration: { amount: 4, unit: 'days' } } },
          },
        ],
      },
      owner,
    );
    expect(
      (await run(workflowTemplatePublish, { organizationId: orgId, templateId }, owner)).version,
    ).toBe(2);
    const listed = await ask(workflowList, { workspaceId: wsId }, member);
    expect(listed.items.find((w) => w.id === copyId)!.source.template).toMatchObject({
      installedVersion: 1,
      latestVersion: 2,
      updateAvailable: true,
    });

    // What the business reads first.
    const plan = await asWorker(testDbs().worker.db, scope, (tx) =>
      planTemplateUpdate(tx, wsId, copyId),
    );
    expect(plan).toMatchObject({ updateAvailable: true, changedSinceInstall: true });
    expect(plan.templateChanges.join(' ')).toMatch(/4 days/);
    expect(plan.yourChanges.join(' ')).toMatch(/Call them today/);
    expect(plan.kept).toHaveLength(1);

    // A stale revision is refused; the current one applies.
    await expectHfos(
      () =>
        asSystem(workflowTemplateApplyUpdate, {
          workspaceId: wsId,
          workflowId: copyId,
          baseRevision: edited.revision - 1,
        }),
      'revision_conflict',
      409,
    );
    const applied = await asSystem(workflowTemplateApplyUpdate, {
      workspaceId: wsId,
      workflowId: copyId,
      baseRevision: edited.revision,
    });
    expect(applied).toMatchObject({ version: 2, changed: true, revision: edited.revision + 1 });
    expect(applied.kept.join(' ')).toMatch(/Call them today/);
    const after = await ask(workflowGet, { workspaceId: wsId, workflowId: copyId }, owner);
    expect(waitOf(after.workflow.definition, WAIT1)).toContain('"amount":4');
    expect(taskTitle(after.workflow.definition)).toBe('Call them today');
    expect(after.workflow).toMatchObject({ status: 'draft', tested: false });
    expect(after.workflow.source.template).toMatchObject({
      installedVersion: 2,
      updateAvailable: false,
    });
    // Its own change is still there, so it still counts as changed since install.
    expect(after.workflow.changedSinceInstall).toBe(true);
    const [install] = await admin()
      .select({ installedVersion: workflowTemplateInstalls.installedVersion })
      .from(workflowTemplateInstalls)
      .where(eq(workflowTemplateInstalls.id, installId));
    expect(install!.installedVersion).toBe(2);

    await expectHfos(
      () =>
        asSystem(workflowTemplateApplyUpdate, {
          workspaceId: wsId,
          workflowId: copyId,
          baseRevision: applied.revision,
        }),
      'template_current',
      409,
    );
  });

  it('refuses a workflow that didn’t come from a template', async () => {
    await expectHfos(
      () =>
        asSystem(workflowTemplateApplyUpdate, {
          workspaceId: wsId,
          workflowId: sourceId,
          baseRevision: 1,
        }),
      'not_from_template',
      409,
    );
  });
});
