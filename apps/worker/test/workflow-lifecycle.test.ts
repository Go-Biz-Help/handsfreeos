/**
 * Pause, resume, archive and stop. Pausing holds runs at their next step and ignores triggers that arrive
 * meanwhile (not queued); Resume releases held runs and their overdue waits run then. Archiving stops the
 * runs still going and cancels their approvals and jobs (people can't cancel those); stopping one run does
 * the same for that run.
 */
import {
  leadCreate,
  workflowArchive,
  workflowEnrol,
  workflowPause,
  workflowResume,
  workflowStopRun,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { retentionJobKey } from '../src/workflows/index';
import {
  addWorkflow,
  admin,
  customerNamed,
  drain,
  flowWorld,
  jobRow,
  run,
  runDue,
  runJob,
  runJobAt,
  runOf,
  runsOf,
  sid,
  stepsOf,
  type World,
} from './workflow-world';

let w: World;
beforeAll(async () => {
  w = await flowWorld('wflife');
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

const note = (id: string, body: string) => ({
  id,
  type: 'action' as const,
  action: 'add_note' as const,
  config: { body },
});

async function notesOf(personId: string): Promise<string[]> {
  const list = await rows<{ body: string }>(
    admin(),
    sql`select body from app.activities where person_id = ${personId} and kind = 'note' order by created_at`,
  );
  return list.map((n) => n.body);
}

async function approvalsOf(runId: string) {
  return rows<{ status: string; via: string | null }>(
    admin(),
    sql`select status::text as status, via from app.workflow_approvals where run_id = ${runId}`,
  );
}

const ref = (workflowId: string) => ({ workspaceId: w.workspaceId, workflowId });

describe('pause and resume', () => {
  it('holds runs at their next step, ignores triggers while paused, and releases them on Resume', async () => {
    const wf = await addWorkflow(w, 'Pausable', {
      version: 1,
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [
        {
          id: sid('pwait'),
          type: 'wait',
          until: { kind: 'duration', duration: { amount: 1, unit: 'hours' } },
        },
        note(sid('pnote'), 'After the wait: {{lead.title}}'),
      ],
    });
    const p = await customerNamed(w, 'Paula');
    await run(w, leadCreate, {
      workspaceId: w.workspaceId,
      personId: p.id,
      title: 'Duct cleaning',
    });
    await drain(w);
    const [r] = await runsOf(wf.id);
    expect(r!.status).toBe('waiting');

    await run(w, workflowPause, ref(wf.id));
    await drain(w);
    // The wait ends while paused: the run is held there, with no job left to run it.
    await runJob(w, r!.id);
    expect((await runOf(r!.id)).status).toBe('held');
    expect(await runJobAt(r!.id)).toBeNull();
    expect(await notesOf(p.id)).toEqual([]);

    // A trigger while paused is ignored, not queued.
    const q = await customerNamed(w, 'Quentin');
    await run(w, leadCreate, { workspaceId: w.workspaceId, personId: q.id, title: 'Thermostat' });
    await drain(w);
    expect(await runsOf(wf.id)).toHaveLength(1);

    await run(w, workflowResume, ref(wf.id));
    await drain(w);
    // Released: its start is spread over the minute, and the overdue wait runs then.
    await runJob(w, r!.id);
    expect((await runOf(r!.id)).status).toBe('completed');
    expect(await notesOf(p.id)).toEqual(['After the wait: Duct cleaning']);
    expect(await runsOf(wf.id)).toHaveLength(1);
  });
});

describe('archive and stop', () => {
  const approvalFlow = () => ({
    version: 1 as const,
    trigger: { kind: 'manual' as const },
    steps: [
      { id: sid('xappr'), type: 'approval' as const, message: 'OK to go on?' },
      note(sid('xnote'), 'Went on'),
    ],
  });

  async function awaitingApproval(workflowId: string, first: string) {
    const p = await customerNamed(w, first);
    await run(w, workflowEnrol, { workspaceId: w.workspaceId, workflowId, personId: p.id });
    await drain(w);
    const r = (await runsOf(workflowId)).find((x) => x.person_id === p.id)!;
    expect(r.status).toBe('awaiting_approval');
    expect(await approvalsOf(r.id)).toEqual([{ status: 'pending', via: null }]);
    expect(await runJobAt(r.id)).not.toBeNull();
    return { p, runId: r.id };
  }

  it('archiving stops the runs still going and cancels their approvals and jobs', async () => {
    const wf = await addWorkflow(w, 'Archivable', approvalFlow());
    const a = await awaitingApproval(wf.id, 'Arch');
    const b = await awaitingApproval(wf.id, 'Bea');
    await run(w, workflowArchive, ref(wf.id));
    await drain(w);
    for (const x of [a, b]) {
      expect(await runOf(x.runId)).toMatchObject({
        status: 'stopped',
        end_reason: 'workflow_archived',
      });
      expect(await approvalsOf(x.runId)).toEqual([{ status: 'cancelled', via: 'system' }]);
      expect(await runJobAt(x.runId)).toBeNull();
      expect(await notesOf(x.p.id)).toEqual([]);
    }
  });

  it('stopping one run cancels its approval and its job', async () => {
    const wf = await addWorkflow(w, 'Stoppable', approvalFlow());
    const { p, runId } = await awaitingApproval(wf.id, 'Stu');
    await run(w, workflowStopRun, { workspaceId: w.workspaceId, runId });
    await drain(w);
    expect(await runOf(runId)).toMatchObject({
      status: 'stopped',
      end_reason: 'stopped_by_person',
    });
    expect(await approvalsOf(runId)).toEqual([{ status: 'cancelled', via: 'system' }]);
    expect(await runJobAt(runId)).toBeNull();
    expect(await notesOf(p.id)).toEqual([]);
  });
});

describe('retention', () => {
  it('deletes the step logs of runs that ended over 180 days ago and keeps the rest', async () => {
    const wf = await addWorkflow(w, 'Kept a while', {
      version: 1,
      trigger: { kind: 'manual' },
      steps: [note(sid('keepnt'), 'Logged')],
    });
    const ids: string[] = [];
    for (const first of ['Olden', 'Newton']) {
      const p = await customerNamed(w, first);
      await run(w, workflowEnrol, {
        workspaceId: w.workspaceId,
        workflowId: wf.id,
        personId: p.id,
      });
      await drain(w);
      ids.push((await runsOf(wf.id)).find((r) => r.person_id === p.id)!.id);
    }
    const [old, recent] = ids as [string, string];
    // The first run ended 181 days ago (written as the engine: only it may change how a run ended).
    await admin().transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.system_scope.workspace_id', ${w.workspaceId}, true)`,
      );
      await tx.execute(
        sql`update app.workflow_runs
            set started_at = now() - interval '182 days', ended_at = now() - interval '181 days'
            where id = ${old}`,
      );
    });
    await runDue(w, [retentionJobKey(w.workspaceId)]);
    expect(await stepsOf(old)).toEqual([]);
    expect(await stepsOf(recent)).toHaveLength(1);
    expect((await runOf(old)).status).toBe('completed');
    // It comes back when the next run's log is due.
    const next = (await jobRow(retentionJobKey(w.workspaceId)))!;
    expect(next.status).toBe('pending');
    expect(new Date(next.run_at).getTime()).toBeGreaterThan(Date.now() + 180 * 86_400_000);
  });
});
