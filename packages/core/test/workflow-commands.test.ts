/**
 * Workflow commands and queries on the local database: recipes with a mapping, draft saves (revision
 * conflicts, a bad op's index), the publish gate and the trigger index, versions that never change and
 * restore, pause and resume, taking a customer out, approvals decided once, permissions, proposals, test
 * requests, and the agency's templates and knowledge packs (organization owners and admins only).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  events,
  workflowApprovals,
  workflowRuns,
  workflows,
  workflowTemplateInstalls,
  workflowVersions,
} from '@hfos/db/schema';
import { closeTestDbs, createTestUser, expectPgError, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidArray } from '../src/calendar/load';
import {
  calendarCreate,
  knowledgePackCreate,
  knowledgePackList,
  knowledgePackPush,
  knowledgePackUpdate,
  organizationCreate,
  personCreate,
  pipelineList,
  workflowApprovalList,
  workflowArchive,
  workflowCatalogs,
  workflowCreate,
  workflowDecideApproval,
  workflowEnrol,
  workflowGet,
  workflowList,
  workflowPause,
  workflowProposalApply,
  workflowProposalGet,
  workflowPublish,
  workflowRemoveContact,
  workflowRestoreVersion,
  workflowResume,
  workflowRunGet,
  workflowRunList,
  workflowSaveDraft,
  workflowStopRun,
  workflowTemplateCreateFromWorkflow,
  workflowTemplateGet,
  workflowTemplateList,
  workflowTemplatePublish,
  workflowTemplatePush,
  workflowTest,
  workflowVersionGet,
} from '../src/server';
import { admin, ask, expectHfos, run } from './calendar-helpers';

let owner: TestUser, member: TestUser, outsider: TestUser;
let wsId: string, orgId: string, otherWsId: string, otherOrgId: string;
let estimateStage: string, calendarId: string, dale: string, rosa: string;

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('wfc-owner', { fullName: 'Dale Owner' }),
    createTestUser('wfc-member', { fullName: 'Mike Member' }),
    createTestUser('wfc-outsider'),
  ]);
  const org = await run(organizationCreate, { businessName: 'Workflow Commands Co' }, owner);
  orgId = org.organizationId;
  wsId = org.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
  const other = await run(organizationCreate, { businessName: 'Somebody Else Co' }, outsider);
  otherOrgId = other.organizationId;
  otherWsId = other.workspaceId;
  const { pipelines } = await ask(pipelineList, { workspaceId: wsId }, owner);
  estimateStage = pipelines[0]!.stages.find((s) => s.name === 'Estimate sent')!.id;
  calendarId = (
    await run(
      calendarCreate,
      { workspaceId: wsId, name: 'Service calls', preset: 'scratch' },
      owner,
    )
  ).calendarId;
  const person = async (firstName: string) =>
    (
      await run(
        personCreate,
        { workspaceId: wsId, firstName, lastName: 'Customer', ignoreDuplicates: true },
        owner,
      )
    ).personId;
  dale = await person('Dale');
  rosa = await person('Rosa');
});
afterAll(closeTestDbs);

// ---- Helpers ----

const task = (id: string, title = 'Call the customer') => ({
  id,
  type: 'action',
  action: 'create_task',
  config: { title },
});
const addStep = (step: Record<string, unknown>) => ({
  op: 'add_step',
  parentId: null,
  branchId: null,
  index: null,
  step,
});
const get = (workflowId: string, u: TestUser = owner) =>
  ask(workflowGet, { workspaceId: wsId, workflowId }, u);
/** A blank workflow with one task step (revision 2). */
async function blank(name: string, trigger: Record<string, unknown> = { kind: 'manual' }) {
  const c = await run(workflowCreate, { workspaceId: wsId, name, trigger }, owner);
  const s = await run(
    workflowSaveDraft,
    {
      workspaceId: wsId,
      workflowId: c.workflowId,
      baseRevision: 1,
      ops: [addStep(task('s_task0001'))],
    },
    owner,
  );
  return { id: c.workflowId, revision: s.revision };
}
/** What a passing test run does (the engine's, in step 4). */
const markTested = (workflowId: string) =>
  rows(admin(), sql`update app.workflows set tested_revision = revision where id = ${workflowId}`);
const eventsOf = (entityId: string, type: string) =>
  admin()
    .select({ payload: events.payload, actorId: events.actorId })
    .from(events)
    .where(and(eq(events.entityId, entityId), eq(events.eventType, type)));
async function insertRun(workflowId: string, versionId: string, personId: string, status: string) {
  const ended = ['completed', 'stopped', 'failed'].includes(status);
  const [r] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, person_id, dedupe_key, status, ended_at)
        values (${wsId}, ${workflowId}, ${versionId}, ${personId}, ${randomUUID()},
          ${status}::app.workflow_run_status, ${ended ? sql`now()` : sql`null`})
        returning id`,
  );
  return r!.id;
}
async function statuses(ids: string[]) {
  const list = await admin()
    .select({ id: workflowRuns.id, status: workflowRuns.status })
    .from(workflowRuns)
    .where(inArray(workflowRuns.id, ids));
  return ids.map((id) => list.find((r) => r.id === id)?.status);
}
async function insertApproval(
  runId: string,
  workflowId: string,
  stepKey: string,
  approvers: string[],
  expiresAt: Date | null = null,
) {
  const [a] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workflow_approvals (workspace_id, workflow_id, run_id, step_key, approvers, preview, expires_at)
        values (${wsId}, ${workflowId}, ${runId}, ${stepKey}, ${uuidArray(approvers)},
          ${JSON.stringify({ message: 'Hi Dale' })}::jsonb, ${expiresAt ? expiresAt.toISOString() : null}::timestamptz)
        returning id`,
  );
  return a!.id;
}
async function insertProposal(
  workflowId: string | null,
  baseRevision: number | null,
  ops: unknown[],
  summary: string | null = null,
) {
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workflow_proposals (workspace_id, workflow_id, base_revision, prompt, ops, summary, created_by)
        values (${wsId}, ${workflowId}, ${baseRevision}::int, 'Follow up with them', ${JSON.stringify(ops)}::jsonb,
          ${summary}, ${owner.id})
        returning id`,
  );
  return p!.id;
}

let estimateWorkflowId: string;
let brokenId: string;
let liveId: string;
let liveVersionId: string;

describe('creating', () => {
  it('creates from a recipe with a mapping; unmapped placeholders stay as issues', async () => {
    const mapped = await run(
      workflowCreate,
      {
        workspaceId: wsId,
        name: 'Estimate follow-up',
        from: 'recipe',
        recipeKey: 'estimate_follow_up',
        mapping: { estimate_stage: estimateStage },
      },
      owner,
    );
    estimateWorkflowId = mapped.workflowId;
    expect(mapped.revision).toBe(1);
    expect(mapped.placeholders).toEqual([]);
    expect(mapped.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const { workflow } = await get(mapped.workflowId, member);
    expect(workflow).toMatchObject({
      status: 'draft',
      revision: 1,
      tested: false,
      activeVersion: null,
      trigger: { kind: 'event', event: 'lead.stage_changed' },
      source: { kind: 'recipe', recipeKey: 'estimate_follow_up', recipeName: 'Estimate follow-up' },
    });
    expect(JSON.stringify(workflow.definition)).toContain(estimateStage);

    const unmapped = await run(
      workflowCreate,
      { workspaceId: wsId, name: 'Broken', from: 'recipe', recipeKey: 'estimate_follow_up' },
      owner,
    );
    brokenId = unmapped.workflowId;
    expect(unmapped.placeholders.map((p) => p.key)).toEqual(['estimate_stage']);
    expect(unmapped.issues.map((i) => i.code)).toContain('placeholder_unmapped');
    await expectHfos(
      () =>
        run(
          workflowCreate,
          {
            workspaceId: wsId,
            name: 'Nope',
            from: 'recipe',
            recipeKey: 'estimate_follow_up',
            mapping: { not_a_placeholder: estimateStage },
          },
          owner,
        ),
      'validation',
      400,
    );
  });

  it('indexes the trigger: its event, the calendars it names, or every calendar', async () => {
    const noShow = await run(
      workflowCreate,
      {
        workspaceId: wsId,
        name: 'No-show rebook',
        from: 'recipe',
        recipeKey: 'no_show_rebook',
        mapping: { calendar: calendarId },
      },
      owner,
    );
    const booked = await run(
      workflowCreate,
      {
        workspaceId: wsId,
        name: 'Booked',
        trigger: { kind: 'event', event: 'appointment.booked' },
      },
      owner,
    );
    const rowOf = async (id: string) =>
      (await admin().select().from(workflows).where(eq(workflows.id, id)))[0]!;
    expect(await rowOf(noShow.workflowId)).toMatchObject({
      triggerKind: 'event',
      triggerEvent: 'appointment.no_show',
      calendarIds: [calendarId],
      allCalendars: false,
      reentry: 'after_exit',
    });
    expect(await rowOf(booked.workflowId)).toMatchObject({
      triggerEvent: 'appointment.booked',
      calendarIds: [],
      allCalendars: true,
    });
    const forCalendar = await ask(workflowList, { workspaceId: wsId, calendarId }, member);
    const ids = forCalendar.items.map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining([noShow.workflowId, booked.workflowId]));
    expect(ids).not.toContain(estimateWorkflowId);
    const { catalogs } = await ask(workflowCatalogs, { workspaceId: wsId }, member);
    expect(catalogs.team.map((p) => p.userId)).toEqual(
      expect.arrayContaining([owner.id, member.id]),
    );
    expect(catalogs.calendars.map((c) => c.id)).toContain(calendarId);
    expect(catalogs.pipelines[0]!.stages.map((s) => s.id)).toContain(estimateStage);
  });
});

describe('drafts', () => {
  it('saves ops against a base revision; a stale base conflicts and a bad op names its index', async () => {
    const c = await run(workflowCreate, { workspaceId: wsId, name: 'Drafts' }, owner);
    const saved = await run(
      workflowSaveDraft,
      {
        workspaceId: wsId,
        workflowId: c.workflowId,
        baseRevision: 1,
        ops: [addStep(task('s_draft001'))],
      },
      owner,
    );
    expect(saved).toMatchObject({ revision: 2, changed: true });
    expect(saved.changes.length).toBeGreaterThan(0);
    const conflict = await expectHfos(
      () =>
        run(
          workflowSaveDraft,
          {
            workspaceId: wsId,
            workflowId: c.workflowId,
            baseRevision: 1,
            ops: [addStep(task('s_draft002'))],
          },
          owner,
        ),
      'revision_conflict',
      409,
    );
    expect(conflict.details).toEqual({ revision: 2 });
    const bad = await expectHfos(
      () =>
        run(
          workflowSaveDraft,
          {
            workspaceId: wsId,
            workflowId: c.workflowId,
            baseRevision: 2,
            ops: [addStep(task('s_draft002')), { op: 'delete_step', stepId: 's_nothere0' }],
          },
          owner,
        ),
      'workflow_op_invalid',
      400,
    );
    expect(bad.details).toMatchObject({ opIndex: 1, code: 'step_not_found', stepId: 's_nothere0' });
    // All or nothing: the good op before it didn't stick either.
    const { workflow } = await get(c.workflowId);
    expect(workflow.revision).toBe(2);
    expect(JSON.stringify(workflow.definition)).not.toContain('s_draft002');
    const same = await run(
      workflowSaveDraft,
      { workspaceId: wsId, workflowId: c.workflowId, baseRevision: 2, ops: [] },
      owner,
    );
    expect(same).toMatchObject({ revision: 2, changed: false });
    const [ev] = await eventsOf(c.workflowId, 'workflow.draft_saved');
    expect(ev!.payload).toMatchObject({ revision: 2, changes: saved.changes });
  });
});

describe('publishing', () => {
  it('needs no blocking issues (422) and a tested revision (409), then publishes version 1', async () => {
    await markTested(brokenId);
    const blocked = await expectHfos(
      () =>
        run(workflowPublish, { workspaceId: wsId, workflowId: brokenId, baseRevision: 1 }, owner),
      'workflow_issues',
      422,
    );
    expect((blocked.details as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain(
      'placeholder_unmapped',
    );

    const w = await blank('Speed to lead', { kind: 'event', event: 'lead.created' });
    liveId = w.id;
    await expectHfos(
      () =>
        run(
          workflowPublish,
          { workspaceId: wsId, workflowId: w.id, baseRevision: w.revision },
          owner,
        ),
      'not_tested',
      409,
    );
    await markTested(w.id);
    const v1 = await run(
      workflowPublish,
      { workspaceId: wsId, workflowId: w.id, baseRevision: w.revision },
      owner,
    );
    expect(v1).toMatchObject({ version: 1, status: 'active', changes: ['First version'] });
    const [row] = await admin().select().from(workflows).where(eq(workflows.id, w.id));
    expect(row).toMatchObject({
      status: 'active',
      activeVersionId: v1.versionId,
      triggerKind: 'event',
      triggerEvent: 'lead.created',
    });
    const versions = await admin()
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, w.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      revision: w.revision,
      publishedBy: owner.id,
      source: 'editor',
    });
    expect(await eventsOf(w.id, 'workflow.published')).toHaveLength(1);
  });

  it('follows what runs: a draft trigger change reaches the index only when published', async () => {
    const { workflow } = await get(liveId);
    const saved = await run(
      workflowSaveDraft,
      {
        workspaceId: wsId,
        workflowId: liveId,
        baseRevision: workflow.revision,
        ops: [{ op: 'set_trigger', trigger: { kind: 'event', event: 'person.created' } }],
      },
      owner,
    );
    const eventOf = async () =>
      (
        await admin()
          .select({ e: workflows.triggerEvent })
          .from(workflows)
          .where(eq(workflows.id, liveId))
      )[0]!.e;
    expect(await eventOf()).toBe('lead.created');
    await expectHfos(
      () =>
        run(
          workflowPublish,
          { workspaceId: wsId, workflowId: liveId, baseRevision: saved.revision },
          owner,
        ),
      'not_tested',
      409,
    );
    await markTested(liveId);
    const v2 = await run(
      workflowPublish,
      { workspaceId: wsId, workflowId: liveId, baseRevision: saved.revision },
      owner,
    );
    liveVersionId = v2.versionId;
    expect(v2.version).toBe(2);
    expect(v2.changes.join(' ')).toMatch(/trigger/i);
    expect(await eventOf()).toBe('person.created');
  });

  it('never changes a version, and restores one into the draft as a new revision', async () => {
    const pg = await expectPgError(() =>
      rows(
        admin(),
        sql`update app.workflow_versions set source = 'assistant' where workflow_id = ${liveId}`,
      ),
    );
    expect(pg.code).toBe('42501');
    const { workflow } = await get(liveId);
    const restored = await run(
      workflowRestoreVersion,
      { workspaceId: wsId, workflowId: liveId, version: 1, baseRevision: workflow.revision },
      owner,
    );
    expect(restored).toMatchObject({ revision: workflow.revision + 1, changed: true });
    expect(restored.changes[0]).toBe('Restored version 1');
    const after = await get(liveId);
    const { version } = await ask(
      workflowVersionGet,
      { workspaceId: wsId, workflowId: liveId, version: 1 },
      member,
    );
    expect(after.workflow.definition).toEqual(version.definition);
    expect(after.workflow.tested).toBe(false);
    expect(after.workflow.activeVersion).toEqual({ id: liveVersionId, version: 2 });
    expect(after.versions.map((v) => v.version)).toEqual([2, 1]);
    await expectHfos(
      () =>
        run(
          workflowRestoreVersion,
          {
            workspaceId: wsId,
            workflowId: liveId,
            version: 9,
            baseRevision: after.workflow.revision,
          },
          owner,
        ),
      'not_found',
    );
  });

  it('pauses and resumes; a paused workflow takes no one new', async () => {
    const ref = { workspaceId: wsId, workflowId: liveId };
    expect(await run(workflowPause, ref, owner)).toMatchObject({ status: 'paused', changed: true });
    expect((await run(workflowPause, ref, owner)).changed).toBe(false);
    await expectHfos(
      () => run(workflowEnrol, { ...ref, personId: dale }, owner),
      'workflow_not_active',
      409,
    );
    expect(await run(workflowResume, ref, owner)).toMatchObject({
      status: 'active',
      changed: true,
    });
    expect((await run(workflowResume, ref, owner)).changed).toBe(false);
    await expectHfos(
      () => run(workflowPause, { workspaceId: wsId, workflowId: brokenId }, owner),
      'workflow_not_active',
      409,
    );
    expect(await eventsOf(liveId, 'workflow.paused')).toHaveLength(1);
    expect(await eventsOf(liveId, 'workflow.resumed')).toHaveLength(1);
  });
});

describe('people and runs', () => {
  let doneRun: string, waitingRun: string, heldRun: string, rosaRun: string, approvalRun: string;

  it('removes a contact: owners stop their live runs now; a member’s removal goes to the engine', async () => {
    doneRun = await insertRun(liveId, liveVersionId, dale, 'completed');
    waitingRun = await insertRun(liveId, liveVersionId, dale, 'waiting');
    heldRun = await insertRun(liveId, liveVersionId, dale, 'held');
    rosaRun = await insertRun(liveId, liveVersionId, rosa, 'waiting');
    const out = await run(
      workflowRemoveContact,
      { workspaceId: wsId, workflowId: liveId, personId: dale },
      owner,
    );
    expect(out.pending).toBe(false);
    expect([...out.stoppedRunIds].sort()).toEqual([waitingRun, heldRun].sort());
    expect(await statuses([doneRun, waitingRun, heldRun, rosaRun])).toEqual([
      'completed',
      'stopped',
      'stopped',
      'waiting',
    ]);
    const [stopped] = await admin()
      .select({ endReason: workflowRuns.endReason })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, waitingRun));
    expect(stopped!.endReason).toBe('removed_from_workflow');

    const byMember = await run(
      workflowRemoveContact,
      { workspaceId: wsId, workflowId: liveId, personId: rosa },
      member,
    );
    expect(byMember).toMatchObject({ pending: true, stoppedRunIds: [] });
    expect(await statuses([rosaRun])).toEqual(['waiting']);
    const removals = await eventsOf(liveId, 'workflow.contact_removed');
    expect(removals.find((e) => e.actorId === member.id)!.payload).toMatchObject({
      personId: rosa,
      runIds: [rosaRun],
      pending: true,
    });
  });

  it('stops a live run once; members can’t', async () => {
    const ref = { workspaceId: wsId, runId: rosaRun };
    await expectHfos(() => run(workflowStopRun, ref, member), 'forbidden');
    expect(await run(workflowStopRun, ref, owner)).toEqual({
      runId: rosaRun,
      status: 'stopped',
      stopped: true,
    });
    expect(await run(workflowStopRun, ref, owner)).toEqual({
      runId: rosaRun,
      status: 'stopped',
      stopped: false,
    });
    expect(await eventsOf(rosaRun, 'workflow_run.stopped')).toHaveLength(1);
  });

  it('decides an approval once, by an owner or a named approver, before it expires', async () => {
    approvalRun = await insertRun(liveId, liveVersionId, dale, 'awaiting_approval');
    const adminsOnly = await insertApproval(approvalRun, liveId, 's_appr0001#1', []);
    const decide = (approvalId: string, extra: Record<string, unknown>, u: TestUser) =>
      run(workflowDecideApproval, { workspaceId: wsId, approvalId, ...extra }, u);
    await expectHfos(
      () => decide(adminsOnly, { decision: 'approve' }, member),
      'not_an_approver',
      403,
    );
    const edits = { message: 'Hi Dale, so sorry about today. We’ll call you shortly.' };
    expect(await decide(adminsOnly, { decision: 'approve', edits }, owner)).toEqual({
      approvalId: adminsOnly,
      runId: approvalRun,
      status: 'approved',
    });
    await expectHfos(
      () => decide(adminsOnly, { decision: 'reject' }, owner),
      'approval_decided',
      409,
    );
    const [row] = await admin()
      .select()
      .from(workflowApprovals)
      .where(eq(workflowApprovals.id, adminsOnly));
    expect(row).toMatchObject({ status: 'approved', decidedBy: owner.id, via: 'web', edits });
    const [ev] = await eventsOf(adminsOnly, 'workflow.approval_decided');
    expect(ev!.payload).toMatchObject({
      runId: approvalRun,
      workflowId: liveId,
      stepKey: 's_appr0001#1',
      decision: 'approved',
      edited: true,
    });

    const named = await insertApproval(approvalRun, liveId, 's_appr0002#1', [member.id]);
    expect((await decide(named, { decision: 'reject', reason: 'Not now' }, member)).status).toBe(
      'rejected',
    );
    const expired = await insertApproval(
      approvalRun,
      liveId,
      's_appr0003#1',
      [],
      new Date(Date.now() - 60_000),
    );
    await expectHfos(
      () => decide(expired, { decision: 'approve' }, owner),
      'approval_expired',
      409,
    );
    const pending = await ask(workflowApprovalList, { workspaceId: wsId }, owner);
    expect(pending.items.find((a) => a.id === expired)).toMatchObject({
      status: 'pending',
      canDecide: false,
      person: { id: dale },
    });
    expect(pending.items.some((a) => a.id === adminsOnly)).toBe(false);
  });

  it('lets members read and add people, but not create, edit, publish or pause', async () => {
    await expectHfos(
      () => run(workflowCreate, { workspaceId: wsId, name: 'Nope' }, member),
      'forbidden',
    );
    const { workflow } = await get(liveId, member);
    const ref = { workspaceId: wsId, workflowId: liveId };
    await expectHfos(
      () => run(workflowSaveDraft, { ...ref, baseRevision: workflow.revision, ops: [] }, member),
      'forbidden',
    );
    await expectHfos(
      () => run(workflowPublish, { ...ref, baseRevision: workflow.revision }, member),
      'forbidden',
    );
    await expectHfos(() => run(workflowPause, ref, member), 'forbidden');
    expect(await run(workflowEnrol, { ...ref, personId: rosa }, member)).toEqual({
      workflowId: liveId,
      personId: rosa,
      requested: true,
    });
    const requests = await eventsOf(liveId, 'workflow.enrol_requested');
    expect(requests.find((e) => e.actorId === member.id)!.payload).toMatchObject({
      workflowId: liveId,
      versionId: liveVersionId,
      personId: rosa,
      requestedBy: member.id,
    });
  });

  it('lists runs in keyset pages, sums them on the list, and shows one run with its steps', async () => {
    await rows(
      admin(),
      sql`insert into app.workflow_run_steps (workspace_id, run_id, step_key, status, output)
          values (${wsId}, ${waitingRun}, 's_task0001#1', 'done', '{"taskId": "t1"}'::jsonb)`,
    );
    const first = await ask(
      workflowRunList,
      { workspaceId: wsId, workflowId: liveId, personId: dale, limit: 2 },
      member,
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await ask(
      workflowRunList,
      {
        workspaceId: wsId,
        workflowId: liveId,
        personId: dale,
        limit: 2,
        cursor: first.nextCursor!,
      },
      member,
    );
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((r) => r.id).sort()).toEqual(
      [doneRun, waitingRun, heldRun, approvalRun].sort(),
    );
    const {
      run: detail,
      steps,
      definition,
    } = await ask(workflowRunGet, { workspaceId: wsId, runId: waitingRun }, member);
    expect(detail).toMatchObject({ status: 'stopped', version: 2, person: { id: dale } });
    expect(steps.map((s) => s.stepKey)).toEqual(['s_task0001#1']);
    expect(definition).not.toBeNull();
    const listed = await ask(workflowList, { workspaceId: wsId }, member);
    expect(listed.items.find((w) => w.id === liveId)).toMatchObject({ runs30d: 5, activeRuns: 1 });
  });

  it('archives: its live runs stop and the draft can’t change', async () => {
    const out = await run(workflowArchive, { workspaceId: wsId, workflowId: liveId }, owner);
    expect(out).toMatchObject({ status: 'archived', changed: true, stoppedRunIds: [approvalRun] });
    const { workflow } = await get(liveId);
    await expectHfos(
      () =>
        run(
          workflowSaveDraft,
          { workspaceId: wsId, workflowId: liveId, baseRevision: workflow.revision, ops: [] },
          owner,
        ),
      'workflow_archived',
      409,
    );
    expect(
      (await ask(workflowList, { workspaceId: wsId }, owner)).items.map((w) => w.id),
    ).not.toContain(liveId);
  });
});

describe('proposals and tests', () => {
  it('applies a proposal once, refuses a stale one, and creates a workflow from a new one', async () => {
    const w = await blank('Proposals');
    const proposalId = await insertProposal(w.id, w.revision, [
      addStep(task('s_prop0001', 'Follow up')),
    ]);
    const { proposal } = await ask(workflowProposalGet, { workspaceId: wsId, proposalId }, member);
    expect(proposal).toMatchObject({ stale: false, expired: false, appliedAt: null });
    expect(proposal.changes).toHaveLength(1);
    const applied = await run(
      workflowProposalApply,
      { workspaceId: wsId, proposalId, baseRevision: w.revision },
      owner,
    );
    expect(applied).toMatchObject({ workflowId: w.id, revision: w.revision + 1, created: false });
    await expectHfos(
      () =>
        run(
          workflowProposalApply,
          { workspaceId: wsId, proposalId, baseRevision: w.revision + 1 },
          owner,
        ),
      'proposal_applied',
      409,
    );
    const stale = await insertProposal(w.id, w.revision, [addStep(task('s_prop0002'))]);
    await expectHfos(
      () =>
        run(
          workflowProposalApply,
          { workspaceId: wsId, proposalId: stale, baseRevision: w.revision + 1 },
          owner,
        ),
      'proposal_stale',
      409,
    );
    const fresh = await insertProposal(
      null,
      null,
      [
        { op: 'set_trigger', trigger: { kind: 'event', event: 'lead.created' } },
        addStep(task('s_prop0003')),
      ],
      'Text new leads',
    );
    const made = await run(workflowProposalApply, { workspaceId: wsId, proposalId: fresh }, owner);
    expect(made.created).toBe(true);
    expect((await get(made.workflowId)).workflow).toMatchObject({
      name: 'Text new leads',
      status: 'draft',
      trigger: { kind: 'event', event: 'lead.created' },
    });
  });

  it('asks the engine for a test of the draft; a draft with problems is refused', async () => {
    const w = await blank('Tests');
    expect(
      await run(
        workflowTest,
        { workspaceId: wsId, workflowId: w.id, mode: 'simulate', personId: dale },
        owner,
      ),
    ).toEqual({ workflowId: w.id, revision: w.revision, mode: 'simulate', requested: true });
    const [ev] = await eventsOf(w.id, 'workflow.test_requested');
    expect(ev!.payload).toMatchObject({
      revision: w.revision,
      mode: 'simulate',
      personId: dale,
      requestedBy: owner.id,
    });
    await expectHfos(
      () => run(workflowTest, { workspaceId: wsId, workflowId: brokenId }, owner),
      'workflow_issues',
      422,
    );
  });
});

describe('the agency', () => {
  it('saves, publishes and pushes templates: organization owners and admins only', async () => {
    const created = await run(
      workflowTemplateCreateFromWorkflow,
      { organizationId: orgId, workflowId: estimateWorkflowId, name: 'Estimate follow-up' },
      owner,
    );
    const templateId = created.templateId;
    expect(created.placeholders).toEqual([
      expect.objectContaining({ key: 'stage_estimate_sent', kind: 'stage', id: estimateStage }),
    ]);
    const { template } = await ask(
      workflowTemplateGet,
      { organizationId: orgId, templateId },
      owner,
    );
    expect(template.placeholders.map((p) => p.key)).toEqual(['stage_estimate_sent']);
    expect(JSON.stringify(template.definition)).not.toContain(estimateStage);
    const ref = { organizationId: orgId, templateId };
    expect(await run(workflowTemplatePublish, ref, owner)).toEqual({
      templateId,
      version: 1,
      published: true,
    });
    expect(await run(workflowTemplatePublish, ref, owner)).toEqual({
      templateId,
      version: 1,
      published: false,
    });
    const pushed = await run(
      workflowTemplatePush,
      {
        ...ref,
        workspaceIds: [wsId],
        mappings: { [wsId]: { stage_estimate_sent: estimateStage } },
      },
      owner,
    );
    expect(pushed.installIds).toHaveLength(1);
    const [install] = await admin()
      .select()
      .from(workflowTemplateInstalls)
      .where(eq(workflowTemplateInstalls.id, pushed.installIds[0]!));
    expect(install).toMatchObject({
      status: 'pending',
      workspaceId: wsId,
      mapping: { stage_estimate_sent: estimateStage },
      pushedBy: owner.id,
    });
    const [ev] = await eventsOf(templateId, 'workflow_template.pushed');
    expect(ev!.payload).toMatchObject({ version: 1, workspaceIds: [wsId] });
    await expectHfos(
      () => run(workflowTemplatePush, { ...ref, workspaceIds: [otherWsId] }, owner),
      'validation',
      400,
    );
    const list = await ask(workflowTemplateList, { organizationId: orgId }, owner);
    expect(list.items.find((t) => t.id === templateId)!.installs).toMatchObject({
      total: 1,
      pending: 1,
    });

    // A business's member isn't the agency, and another agency can't reach this business.
    await expectHfos(
      () => ask(workflowTemplateList, { organizationId: orgId }, member),
      'not_found',
    );
    await expectHfos(
      () =>
        run(
          workflowTemplateCreateFromWorkflow,
          { organizationId: orgId, workflowId: estimateWorkflowId, name: 'Nope' },
          member,
        ),
      'not_found',
    );
    await expectHfos(
      () =>
        run(
          workflowTemplateCreateFromWorkflow,
          { organizationId: otherOrgId, workflowId: estimateWorkflowId, name: 'Nope' },
          outsider,
        ),
      'not_found',
    );

    // Once installed (the engine's part), a newer version shows as an update to the business.
    await rows(
      admin(),
      sql`update app.workflows set template_id = ${templateId}, template_version = 1, installed_revision = revision
          where id = ${estimateWorkflowId}`,
    );
    await rows(
      admin(),
      sql`update app.workflow_templates set definition = jsonb_set(definition, '{settings,maxRunDays}', '30')
          where id = ${templateId}`,
    );
    expect((await run(workflowTemplatePublish, ref, owner)).version).toBe(2);
    const listed = await ask(workflowList, { workspaceId: wsId }, member);
    expect(listed.items.find((w) => w.id === estimateWorkflowId)!.source).toMatchObject({
      kind: 'template',
      template: { id: templateId, installedVersion: 1, latestVersion: 2, updateAvailable: true },
    });
  });

  it('builds knowledge packs and pushes them to its own businesses', async () => {
    const pack = await run(
      knowledgePackCreate,
      {
        organizationId: orgId,
        name: 'HVAC FAQs',
        items: [
          { kind: 'faq', title: 'Do you service heat pumps?', body: 'Yes, all major brands.' },
        ],
      },
      owner,
    );
    expect(pack.version).toBe(1);
    expect(
      await run(
        knowledgePackUpdate,
        { organizationId: orgId, packId: pack.packId, name: 'HVAC starter FAQs' },
        owner,
      ),
    ).toMatchObject({ version: 2, updated: ['name'] });
    expect(
      await run(
        knowledgePackPush,
        { organizationId: orgId, packId: pack.packId, workspaceIds: [wsId] },
        owner,
      ),
    ).toEqual({ packId: pack.packId, version: 2, workspaceIds: [wsId] });
    await expectHfos(
      () =>
        run(
          knowledgePackPush,
          { organizationId: orgId, packId: pack.packId, workspaceIds: [otherWsId] },
          owner,
        ),
      'validation',
    );
    const packs = await ask(knowledgePackList, { organizationId: orgId }, owner);
    expect(packs.items.find((p) => p.id === pack.packId)).toMatchObject({
      name: 'HVAC starter FAQs',
      version: 2,
      items: [{ kind: 'faq', title: 'Do you service heat pumps?' }],
    });
    await expectHfos(() => ask(knowledgePackList, { organizationId: orgId }, member), 'not_found');
  });
});
