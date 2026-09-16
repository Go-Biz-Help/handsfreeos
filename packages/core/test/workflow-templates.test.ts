/**
 * Agency templates on the local database: a template's draft saves like a workflow's (a base revision, a bad
 * op's index, org owners and admins only); the engine's install turns a push into a draft with its template
 * origin (a business that already has its copy keeps it); and applying an update keeps the business's own
 * changes on top of the new version, as a draft revision. Also: a blank template, renaming one (the businesses'
 * copies keep their names), and how each business is getting on with a knowledge pack.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  auditLogs,
  events,
  workflows,
  workflowTemplateInstalls,
  workflowTemplates,
} from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  executeCommand,
  knowledgePackCreate,
  knowledgePackList,
  knowledgePackUpdate,
  knowledgeSuggestionAccept,
  knowledgeSuggestionPropose,
  knowledgeSuggestionReject,
  organizationCreate,
  pipelineList,
  planTemplateUpdate,
  workflowCreate,
  workflowGet,
  workflowList,
  workflowSaveDraft,
  workflowTemplateApplyUpdate,
  workflowTemplateCreate,
  workflowTemplateCreateFromWorkflow,
  workflowTemplateGet,
  workflowTemplateInstall,
  workflowTemplatePublish,
  workflowTemplatePush,
  workflowTemplateRename,
  workflowTemplateSaveDraft,
  workspaceCreate,
  type CommandDef,
} from '../src/server';
import { admin, ask, expectHfos, human, meta, run, system, type Scope } from './calendar-helpers';

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
      },
      owner,
    )
  ).workflowId;
  // The recipe runs on the estimate going out now (M9) and names nothing of this business's own, so the
  // trigger is pointed at one of its stages here: a template has to swap a real id for a placeholder, and
  // that is what these tests are about.
  await run(
    workflowSaveDraft,
    {
      workspaceId: wsId,
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
              conditions: [{ field: 'trigger.to_stage_id', op: 'eq', value: estimateStage }],
            },
          },
        },
      ],
    },
    owner,
  );
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

/** A command as the engine in one of the organization's businesses. */
const asSystemIn = <I extends z.ZodType, O extends z.ZodType>(
  workspaceId: string,
  cmd: CommandDef<I, O>,
  input: unknown,
) =>
  executeCommand(
    testDbs().worker.db,
    cmd,
    input,
    system({ workspaceId, organizationId: orgId }),
    meta('worker'),
  ).then((r) => r.output);

describe('templates from scratch, renames, and a pack in each business', () => {
  let bizOwner: TestUser, orgAdmin: TestUser;
  const templatesNamed = (name: string) =>
    admin()
      .select({ id: workflowTemplates.id })
      .from(workflowTemplates)
      .where(and(eq(workflowTemplates.organizationId, orgId), eq(workflowTemplates.name, name)));
  /** How many renames the template has recorded, each an event with its audit entry. */
  const renameCount = async (id: string) =>
    (
      await admin()
        .select({ id: events.id })
        .from(events)
        .innerJoin(auditLogs, eq(auditLogs.eventId, events.id))
        .where(and(eq(events.entityId, id), eq(events.eventType, 'workflow_template.renamed')))
    ).length;
  /**
   * Renames the template as its owner, and reads back what that rename recorded: its event (by the id the command
   * hands back) with its audit entry. Two renames' timestamps are each transaction's reading of the database clock,
   * with a random id to break ties, so they don't reliably say which came first; no check here needs their order.
   */
  const rename = async (input: { name?: string; description?: string | null }) => {
    const { output, eventIds } = await executeCommand(
      testDbs().api.db,
      workflowTemplateRename,
      { organizationId: orgId, templateId, ...input },
      human(owner),
      meta(),
    );
    const recorded = await admin()
      .select({
        payload: events.payload,
        actorId: events.actorId,
        before: auditLogs.before,
        after: auditLogs.after,
      })
      .from(events)
      .innerJoin(auditLogs, eq(auditLogs.eventId, events.id))
      .where(inArray(events.id, [...eventIds]));
    return { output, recorded };
  };

  beforeAll(async () => {
    [bizOwner, orgAdmin] = await Promise.all([
      createTestUser('wft-bizowner', { fullName: 'Bea Business' }),
      createTestUser('wft-orgadmin', { fullName: 'Ada Admin' }),
    ]);
    // An owner of the business who isn't in the agency; an admin of the agency in no business.
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${bizOwner.id}, 'owner')`,
    );
    await rows(
      admin(),
      sql`insert into app.organization_memberships (organization_id, user_id, role) values (${orgId}, ${orgAdmin.id}, 'admin')`,
    );
  });

  describe('a blank template', () => {
    it('starts with its trigger (by hand) and no steps, at revision 1 with nothing published', async () => {
      const out = await run(
        workflowTemplateCreate,
        {
          organizationId: orgId,
          name: 'Seasonal tune-up',
          description: 'Spring and fall reminders',
        },
        owner,
      );
      expect(out).toEqual({ templateId: expect.any(String), revision: 1 });
      const got = await ask(
        workflowTemplateGet,
        { organizationId: orgId, templateId: out.templateId },
        owner,
      );
      expect(got.template).toMatchObject({
        name: 'Seasonal tune-up',
        description: 'Spring and fall reminders',
        revision: 1,
        latestVersion: null,
        placeholders: [],
        createdBy: { id: owner.id },
      });
      expect(got.template.definition).toMatchObject({ trigger: { kind: 'manual' }, steps: [] });
      expect(got.versions).toEqual([]);
      expect(got.installs).toEqual([]);
      const [ev] = await admin()
        .select({ payload: events.payload, actorId: events.actorId })
        .from(events)
        .where(
          and(
            eq(events.entityId, out.templateId),
            eq(events.eventType, 'workflow_template.created'),
          ),
        );
      expect(ev).toMatchObject({
        actorId: owner.id,
        payload: { templateId: out.templateId, from: 'blank', triggerKind: 'manual' },
      });
    });

    it('takes the trigger it starts with; an admin of the agency can make one', async () => {
      const out = await run(
        workflowTemplateCreate,
        {
          organizationId: orgId,
          name: 'New lead welcome',
          trigger: { kind: 'event', event: 'lead.created' },
        },
        orgAdmin,
      );
      const got = await ask(
        workflowTemplateGet,
        { organizationId: orgId, templateId: out.templateId },
        orgAdmin,
      );
      expect(got.template.definition).toMatchObject({
        trigger: { kind: 'event', event: 'lead.created' },
        steps: [],
      });
      expect(got.template.createdBy).toMatchObject({ id: orgAdmin.id });
    });

    it('is the agency’s: a member, a business owner outside it, or the engine can’t make one', async () => {
      const input = { organizationId: orgId, name: 'Not theirs' };
      await expectHfos(() => run(workflowTemplateCreate, input, member), 'not_found', 404);
      await expectHfos(() => run(workflowTemplateCreate, input, bizOwner), 'not_found', 404);
      await expectHfos(() => asSystem(workflowTemplateCreate, input), 'forbidden', 403);
      expect(await templatesNamed('Not theirs')).toEqual([]);
    });
  });

  describe('renaming a template', () => {
    it('renames it and says so; the businesses’ copies keep their own names', async () => {
      const named = await rename({ name: 'Estimate follow-up (HVAC)' });
      expect(named.output).toEqual({
        templateId,
        name: 'Estimate follow-up (HVAC)',
        description: null,
      });
      const got = await ask(workflowTemplateGet, { organizationId: orgId, templateId }, owner);
      expect(got.template.name).toBe('Estimate follow-up (HVAC)');
      expect(named.recorded).toMatchObject([
        {
          actorId: owner.id,
          payload: { templateId, fields: ['name'] },
          before: { name: 'Estimate follow-up (home services)' },
          after: { name: 'Estimate follow-up (HVAC)' },
        },
      ]);
      expect(await renameCount(templateId)).toBe(1);
      // The copy installed in the business (see above) keeps the name it came with.
      const copies = await admin()
        .select({ name: workflows.name })
        .from(workflows)
        .where(eq(workflows.templateId, templateId));
      expect(copies.map((c) => c.name)).toEqual(['Estimate follow-up (home services)']);

      // The description on its own.
      const described = await rename({ description: 'A text, an email, then a task' });
      expect(described.output).toEqual({
        templateId,
        name: 'Estimate follow-up (HVAC)',
        description: 'A text, an email, then a task',
      });
      expect(described.recorded).toMatchObject([
        {
          payload: { fields: ['description'] },
          before: { name: 'Estimate follow-up (HVAC)', description: null },
          after: {
            name: 'Estimate follow-up (HVAC)',
            description: 'A text, an email, then a task',
          },
        },
      ]);
      expect(await renameCount(templateId)).toBe(2);
    });

    it('changes nothing when nothing changed, and needs something to change', async () => {
      const before = await renameCount(templateId);
      expect(
        await run(
          workflowTemplateRename,
          {
            organizationId: orgId,
            templateId,
            name: 'Estimate follow-up (HVAC)',
            description: 'A text, an email, then a task',
          },
          owner,
        ),
      ).toEqual({
        templateId,
        name: 'Estimate follow-up (HVAC)',
        description: 'A text, an email, then a task',
      });
      expect(await renameCount(templateId)).toBe(before);
      await expectHfos(
        () => run(workflowTemplateRename, { organizationId: orgId, templateId }, owner),
        'validation',
        400,
      );
    });

    it('is refused outside the organization', async () => {
      const other = await createTestUser('wft-other', { fullName: 'Olive Other' });
      const otherOrg = (
        await run(organizationCreate, { businessName: 'Other Agency Roofing' }, other)
      ).organizationId;
      const rename = { templateId, name: 'Mine now' };
      // Another agency's owner, through their own organization or this one; this business's people.
      await expectHfos(
        () => run(workflowTemplateRename, { organizationId: otherOrg, ...rename }, other),
        'not_found',
        404,
      );
      await expectHfos(
        () => run(workflowTemplateRename, { organizationId: orgId, ...rename }, other),
        'not_found',
        404,
      );
      await expectHfos(
        () => run(workflowTemplateRename, { organizationId: orgId, ...rename }, member),
        'not_found',
        404,
      );
      await expectHfos(
        () => run(workflowTemplateRename, { organizationId: orgId, ...rename }, bizOwner),
        'not_found',
        404,
      );
      const got = await ask(workflowTemplateGet, { organizationId: orgId, templateId }, owner);
      expect(got.template.name).toBe('Estimate follow-up (HVAC)');
    });
  });

  describe('a pack in each business', () => {
    const item = (title: string) => ({ kind: 'faq' as const, title, body: 'Yes, all year.' });
    const faq = (question: string) => ({
      kind: 'faq' as const,
      question,
      answer: 'Yes, all year.',
      tags: [],
    });

    it('counts each business’s suggestions from the pack by status, any version', async () => {
      const pack = await run(
        knowledgePackCreate,
        {
          organizationId: orgId,
          name: 'HVAC FAQs',
          items: [
            item('Do you service heat pumps?'),
            item('Do you offer financing?'),
            item('Are you licensed?'),
          ],
        },
        owner,
      );
      const other = await run(
        knowledgePackCreate,
        { organizationId: orgId, name: 'Roofing FAQs', items: [item('Do you fix hail damage?')] },
        owner,
      );
      const progressOf = async (packId: string, u: TestUser = owner) =>
        (await ask(knowledgePackList, { organizationId: orgId }, u)).items.find(
          (p) => p.id === packId,
        )!.businesses;
      expect(await progressOf(pack.packId)).toEqual([]);

      const bayou = (
        await run(workspaceCreate, { organizationId: orgId, name: 'Bayou Plumbing Co.' }, owner)
      ).workspaceId;
      const deliver = (ws: string, packId: string, version: number, questions: string[]) =>
        asSystemIn(ws, knowledgeSuggestionPropose, {
          workspaceId: ws,
          suggestions: questions.map((q) => ({ reason: 'pack', content: faq(q), packId, version })),
        });
      // Version 1 here and in Bayou, then version 2's new item here; the other pack's item isn't counted.
      const v1 = await deliver(wsId, pack.packId, 1, [
        'Do you service heat pumps?',
        'Do you offer financing?',
        'Are you licensed?',
      ]);
      await deliver(bayou, pack.packId, 1, ['Do you service heat pumps?']);
      await run(
        knowledgePackUpdate,
        {
          organizationId: orgId,
          packId: pack.packId,
          items: [
            item('Do you service heat pumps?'),
            item('Do you offer financing?'),
            item('Are you licensed?'),
            item('Do you work weekends?'),
          ],
        },
        owner,
      );
      await deliver(wsId, pack.packId, 2, ['Do you work weekends?']);
      await deliver(wsId, other.packId, 1, ['Do you fix hail damage?']);
      await run(
        knowledgeSuggestionAccept,
        { workspaceId: wsId, suggestionId: v1.suggestionIds[0]! },
        owner,
      );
      await run(
        knowledgeSuggestionReject,
        { workspaceId: wsId, suggestionId: v1.suggestionIds[1]! },
        owner,
      );

      // An admin of the agency, in no business themselves, sees every business's progress, by name.
      expect(await progressOf(pack.packId, orgAdmin)).toEqual([
        { workspaceId: bayou, name: 'Bayou Plumbing Co.', pending: 1, accepted: 0, rejected: 0 },
        { workspaceId: wsId, name: 'Template Co HVAC', pending: 2, accepted: 1, rejected: 1 },
      ]);
      expect(await progressOf(other.packId, orgAdmin)).toEqual([
        { workspaceId: wsId, name: 'Template Co HVAC', pending: 1, accepted: 0, rejected: 0 },
      ]);
    });
  });
});
