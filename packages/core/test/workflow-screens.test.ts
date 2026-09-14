/**
 * What the web's workflow screens read (M6 step 8), on the local database: the audit log names a workflow
 * that did something; the list shows each workflow's newest real run; run_list filters tests and dates; the
 * list's tiles (workflow.stats); and the website and review link workflows put in texts, which
 * workspace.update checks are links.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../src/kernel/execute';
import type { WorkflowActor } from '../src/kernel/types';
import {
  activityLog,
  auditList,
  organizationCreate,
  personCreate,
  workflowCreate,
  workflowList,
  workflowPublish,
  workflowRunList,
  workflowSaveDraft,
  workflowStats,
  workspaceGet,
  workspaceUpdate,
} from '../src/server';
import { admin, ask, meta, run } from './calendar-helpers';

const HOUR = 3_600_000;
let owner: TestUser;
let wsId: string, orgId: string, workflowId: string, versionId: string, personId: string;

beforeAll(async () => {
  owner = await createTestUser('wfs-owner', { fullName: 'Dale Owner' });
  const org = await run(organizationCreate, { businessName: 'Workflow Screens Co' }, owner);
  wsId = org.workspaceId;
  orgId = org.organizationId;
  const created = await run(
    workflowCreate,
    { workspaceId: wsId, name: 'Welcome note', from: 'blank', trigger: { kind: 'manual' } },
    owner,
  );
  workflowId = created.workflowId;
  const saved = await run(
    workflowSaveDraft,
    {
      workspaceId: wsId,
      workflowId,
      baseRevision: created.revision,
      ops: [
        {
          op: 'add_step',
          parentId: null,
          branchId: null,
          index: null,
          step: { id: 's_note0001', type: 'action', action: 'add_note', config: { body: 'Hello' } },
        },
      ],
    },
    owner,
  );
  // What a passing test does (the engine's).
  await rows(
    admin(),
    sql`update app.workflows set tested_revision = revision where id = ${workflowId}`,
  );
  versionId = (
    await run(
      workflowPublish,
      { workspaceId: wsId, workflowId, baseRevision: saved.revision },
      owner,
    )
  ).versionId;
  personId = (
    await run(personCreate, { workspaceId: wsId, firstName: 'Mike', lastName: 'Johnson' }, owner)
  ).personId;
});

afterAll(closeTestDbs);

async function insertRun(o: {
  status: string;
  startedAt: Date;
  test?: boolean;
  endReason?: string;
}): Promise<string> {
  const ended = ['completed', 'stopped', 'failed'].includes(o.status);
  const [r] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, is_test, test_mode, test_revision,
          test_definition, person_id, dedupe_key, status, started_at, ended_at, end_reason)
        values (${wsId}, ${workflowId}, ${o.test ? null : versionId}, ${!!o.test},
          ${o.test ? 'simulate' : null}::app.workflow_test_mode, ${o.test ? 1 : null}::int,
          ${o.test ? JSON.stringify({ version: 1 }) : null}::jsonb, ${personId}, ${randomUUID()},
          ${o.status}::app.workflow_run_status, ${o.startedAt.toISOString()}::timestamptz,
          ${ended ? new Date(o.startedAt.getTime() + 60_000).toISOString() : null}::timestamptz,
          ${o.endReason ?? null})
        returning id`,
  );
  return r!.id;
}

describe('the workflow screens', () => {
  let oldest: string, failed: string, waiting: string, today: string, testRun: string;

  it('the list shows each workflow’s newest real run; run_list filters tests and dates', async () => {
    const now = Date.now();
    oldest = await insertRun({
      status: 'completed',
      startedAt: new Date(now - 72 * HOUR),
      endReason: 'finished',
    });
    failed = await insertRun({
      status: 'failed',
      startedAt: new Date(now - 3 * HOUR),
      endReason: 'lead_archived',
    });
    waiting = await insertRun({ status: 'waiting', startedAt: new Date(now - 2 * HOUR) });
    today = await insertRun({ status: 'running', startedAt: new Date(now - 60_000) });
    testRun = await insertRun({
      status: 'completed',
      startedAt: new Date(now),
      test: true,
      endReason: 'finished',
    });

    const { items } = await ask(workflowList, { workspaceId: wsId }, owner);
    const w = items.find((x) => x.id === workflowId)!;
    expect(w.lastRun).toMatchObject({
      id: today,
      status: 'running',
      endedAt: null,
      person: { id: personId, fullName: 'Mike Johnson' },
    });
    expect(w.runs30d).toBe(4);
    expect(w.activeRuns).toBe(2);

    const real = await ask(workflowRunList, { workspaceId: wsId, workflowId }, owner);
    expect(real.items.map((r) => r.id)).toEqual([today, waiting, failed, oldest]);
    const tests = await ask(
      workflowRunList,
      { workspaceId: wsId, workflowId, onlyTests: true },
      owner,
    );
    expect(tests.items.map((r) => r.id)).toEqual([testRun]);
    const lastDay = await ask(
      workflowRunList,
      { workspaceId: wsId, workflowId, startedAfter: new Date(now - 24 * HOUR).toISOString() },
      owner,
    );
    expect(lastDay.items.map((r) => r.id)).toEqual([today, waiting, failed]);
    const earlier = await ask(
      workflowRunList,
      { workspaceId: wsId, workflowId, startedBefore: new Date(now - 24 * HOUR).toISOString() },
      owner,
    );
    expect(earlier.items.map((r) => r.id)).toEqual([oldest]);
  });

  it('workflow.stats: runs today and going now, messages, quiet-hours holds, approvals, failures', async () => {
    // A text sent now, and another holding for quiet hours; an approval to decide.
    await rows(
      admin(),
      sql`insert into app.workflow_run_steps (workspace_id, run_id, step_key, status, attempt, output, started_at, finished_at)
          values (${wsId}, ${today}, 's_text0001#1', 'done', 1,
                  ${JSON.stringify({ channel: 'sms', messageId: randomUUID() })}::jsonb, now(), now()),
                 (${wsId}, ${waiting}, 's_text0002#1', 'waiting', 1,
                  ${JSON.stringify({ held: 'quiet_hours', until: new Date().toISOString() })}::jsonb, now(), null)`,
    );
    await rows(
      admin(),
      sql`insert into app.workflow_approvals (workspace_id, workflow_id, run_id, step_key, approvers, preview)
          values (${wsId}, ${workflowId}, ${waiting}, 's_appr0001#1', '{}'::uuid[], '{}'::jsonb)`,
    );
    const stats = await ask(workflowStats, { workspaceId: wsId }, owner);
    expect(stats).toMatchObject({
      liveRuns: 2,
      messagesToday: 1,
      quietHoursHeld: 1,
      approvalsPending: 1,
      approvalCustomers: ['Mike Johnson'],
      failedRuns: 1,
      failedWorkflow: { id: workflowId, name: 'Welcome note' },
      runs30d: { all: 4, waiting: 1, awaitingApproval: 0, failed: 1 },
    });
    // "Today" is the business's day, so only the run a minute old is certainly in it; tests never count.
    expect(stats.runsToday).toBeGreaterThanOrEqual(1);
    expect(stats.runsToday).toBeLessThanOrEqual(3);
  });

  it('audit.list names a workflow that did something, and finds what it did by its id', async () => {
    const actor: WorkflowActor = {
      type: 'workflow',
      workspaceId: wsId,
      organizationId: orgId,
      workflowId,
      versionId,
      runId: waiting,
      stepKey: 's_note0001#1',
      depth: 0,
      originRunId: null,
      workflowName: 'Welcome note',
      test: false,
    };
    await executeCommand(
      testDbs().worker.db,
      activityLog,
      { workspaceId: wsId, kind: 'note', body: 'Welcome aboard', personId },
      actor,
      meta('workflow'),
    );
    const { entries } = await ask(auditList, { workspaceId: wsId, limit: 20 }, owner);
    const byWorkflow = entries.find((e) => e.action === 'activity.log')!;
    expect(byWorkflow.actor).toEqual({
      type: 'workflow',
      userId: workflowId,
      fullName: null,
      role: 'workflow',
      workflow: { id: workflowId, name: 'Welcome note' },
    });
    const byPerson = entries.find((e) => e.action === 'workflow.publish')!;
    expect(byPerson.actor).toMatchObject({ type: 'human', fullName: 'Dale Owner', workflow: null });
    const its = await ask(auditList, { workspaceId: wsId, actorId: workflowId }, owner);
    expect(its.entries.map((e) => e.action)).toEqual(['activity.log']);
  });

  it('workspace.update keeps the website and review link, and refuses what isn’t a link', async () => {
    await expect(
      run(
        workspaceUpdate,
        {
          workspaceId: wsId,
          settings: { website: 'not a link', links: { review: 'javascript:alert(1)' } },
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      run(workspaceUpdate, { workspaceId: wsId, settings: { links: 'nope' } }, owner),
    ).rejects.toMatchObject({ code: 'validation' });

    await run(
      workspaceUpdate,
      {
        workspaceId: wsId,
        settings: {
          website: 'https://lonestarhvac.test',
          links: { review: 'https://g.page/r/lone-star/review' },
        },
      },
      owner,
    );
    const got = await ask(workspaceGet, { workspaceId: wsId }, owner);
    expect(got.workspace.settings).toMatchObject({
      website: 'https://lonestarhvac.test',
      links: { review: 'https://g.page/r/lone-star/review' },
    });
    // Emptying them clears them.
    await run(
      workspaceUpdate,
      { workspaceId: wsId, settings: { website: null, links: { review: null } } },
      owner,
    );
    const cleared = await ask(workspaceGet, { workspaceId: wsId }, owner);
    expect(cleared.workspace.settings).toMatchObject({ website: null, links: { review: null } });
  });
});
