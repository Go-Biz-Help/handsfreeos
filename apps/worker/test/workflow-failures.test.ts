/**
 * When steps fail. A passing failure (an outgoing webhook's address answering 503) is retried by rescheduling
 * the run's own job; after five tries the step is dead, the run failed, and the business's own owners and admins
 * are emailed a link to the run (the organization's only when the business has none of its own; otherwise the
 * agency reads it in the daily digest). Retry and Skip revive it. A rule refusal (moving a lead that was
 * archived meanwhile) isn't retried: the step's onError stops the run or carries on.
 */
import {
  leadArchive,
  leadCreate,
  workflowEnrol,
  workflowRetryStep,
  workflowSkipStep,
  workspaceCreate,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workspaceManagers } from '../src/handlers/telephony';
import {
  addWorkflow,
  admin,
  CHI,
  customerNamed,
  drain,
  fixtureSite,
  flowWorld,
  mailTo,
  run,
  runJob,
  runJobAt,
  runOf,
  runsOf,
  sid,
  stepOf,
  waitForMail,
  type World,
} from './workflow-world';

let w: World;
let site: Awaited<ReturnType<typeof fixtureSite>>;
/** An admin of the organization (the agency) who isn't a member of the business. */
let agencyAdmin: TestUser;
beforeAll(async () => {
  site = await fixtureSite();
  w = await flowWorld('wffail', { fetchUrl: site.fetchUrl });
  agencyAdmin = await createTestUser('wffail-agency', { fullName: 'Ann Agency' });
  await rows(
    admin(),
    sql`insert into app.organization_memberships (organization_id, user_id, role)
        values (${w.organizationId}, ${agencyAdmin.id}, 'admin')`,
  );
});

/** No email to `to` whose subject starts with `subject` (after a moment for Mailpit to take one in). */
async function noMail(to: string, subject: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  expect((await mailTo(to)).filter((m) => m.Subject.startsWith(subject))).toEqual([]);
}
afterAll(async () => {
  await w.app.close();
  await site.close();
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

describe('a step that keeps failing', () => {
  const hookId = sid('fhook');
  let wfId: string;
  beforeAll(async () => {
    wfId = (
      await addWorkflow(w, 'Flaky hook', {
        version: 1,
        trigger: { kind: 'manual' },
        steps: [
          {
            id: hookId,
            type: 'action',
            action: 'webhook_out',
            config: { url: 'https://hooks.fixture.test/crm', include: ['person'] },
          },
          note(sid('fnote'), 'After the webhook'),
        ],
      })
    ).id;
  });

  async function start(first: string) {
    const p = await customerNamed(w, first);
    await run(w, workflowEnrol, { workspaceId: w.workspaceId, workflowId: wfId, personId: p.id });
    await drain(w);
    return { p, runId: (await runsOf(wfId)).find((r) => r.person_id === p.id)!.id };
  }

  it('is retried with backoff, then dead after five tries; the owners hear; Retry finishes it', async () => {
    site.status = 503;
    const { p, runId } = await start('Fay');
    let step = (await stepOf(runId, hookId))!;
    expect(step).toMatchObject({ status: 'failed', attempt: 1 });
    expect(step.error).toMatchObject({ code: 'transient' });
    expect(await runOf(runId)).toMatchObject({ status: 'running' });
    // The run's own job comes back after the backoff (5 s, give or take the jitter).
    const next = (await runJobAt(runId))!;
    expect(next).toBeGreaterThan(Date.now() + 2_000);
    expect(next).toBeLessThan(Date.now() + 8_000);

    for (let i = 2; i <= 5; i++) await runJob(w, runId);
    step = (await stepOf(runId, hookId))!;
    expect(step).toMatchObject({ status: 'dead', attempt: 5 });
    expect(await runOf(runId)).toMatchObject({ status: 'failed', end_reason: 'step_failed' });
    expect(await runJobAt(runId)).toBeNull();
    const mail = await waitForMail(w.owner.email, 'A workflow stopped: Flaky hook');
    expect(mail.text).toContain(`/app/w/${w.workspaceId}/workflows/runs/${runId}`);
    expect(mail.text).toContain('Send a webhook');
    // The business has an owner of its own: the agency's admin reads about it in the daily digest instead.
    await noMail(agencyAdmin.email, 'A workflow stopped');

    // The address is fixed; Retry revives the run and the step goes through.
    site.status = 200;
    await run(w, workflowRetryStep, { workspaceId: w.workspaceId, runId, stepKey: `${hookId}#1` });
    await drain(w);
    expect(await runOf(runId)).toMatchObject({ status: 'completed', end_reason: 'finished' });
    expect((await stepOf(runId, hookId))!).toMatchObject({ status: 'done', attempt: 6 });
    expect(await notesOf(p.id)).toEqual(['After the webhook']);
  });

  it('can be skipped instead, and the run carries on', async () => {
    site.status = 503;
    const { p, runId } = await start('Sid');
    expect((await stepOf(runId, hookId))!.status).toBe('failed');
    await run(w, workflowSkipStep, { workspaceId: w.workspaceId, runId, stepKey: `${hookId}#1` });
    await drain(w);
    expect((await stepOf(runId, hookId))!.status).toBe('skipped');
    expect(await runOf(runId)).toMatchObject({ status: 'completed' });
    expect(await notesOf(p.id)).toEqual(['After the webhook']);
    site.status = 200;
  });
});

describe('a rule refusal', () => {
  it('isn’t retried: onError stops the run, or carries on past the step', async () => {
    const [stage] = await rows<{ pipeline_id: string; stage_id: string }>(
      admin(),
      sql`select p.id as pipeline_id, s.id as stage_id from app.pipelines p
          join app.pipeline_stages s on s.pipeline_id = p.id
          where p.workspace_id = ${w.workspaceId} and s.kind = 'open'
          order by p.position, s.position offset 1 limit 1`,
    );
    const moveId = sid('rmove');
    const flow = (onError: 'stop' | 'continue') => ({
      version: 1 as const,
      trigger: { kind: 'event' as const, event: 'lead.created' as const },
      steps: [
        {
          id: sid('rwait'),
          type: 'wait' as const,
          until: { kind: 'duration' as const, duration: { amount: 1, unit: 'hours' as const } },
        },
        {
          id: moveId,
          type: 'action' as const,
          action: 'move_lead_stage' as const,
          config: { pipelineId: stage!.pipeline_id, stageId: stage!.stage_id },
          onError,
        },
        note(sid('rnote'), 'Moved {{lead.title}}'),
      ],
    });
    const stops = await addWorkflow(w, 'Move, or stop', flow('stop'));
    const goesOn = await addWorkflow(w, 'Move, or go on', flow('continue'));
    const p = await customerNamed(w, 'Lou');
    const { leadId } = await run(w, leadCreate, {
      workspaceId: w.workspaceId,
      personId: p.id,
      title: 'Heat pump',
    });
    await drain(w);
    // The lead is archived while the runs wait.
    await run(w, leadArchive, { workspaceId: w.workspaceId, leadId });
    const [stopped] = await runsOf(stops.id);
    const [carried] = await runsOf(goesOn.id);
    await runJob(w, stopped!.id);
    await runJob(w, carried!.id);

    expect(await runOf(stopped!.id)).toMatchObject({
      status: 'failed',
      end_reason: 'lead_archived',
    });
    const refused = (await stepOf(stopped!.id, moveId))!;
    expect(refused).toMatchObject({ status: 'failed', attempt: 1 });
    expect(refused.error).toMatchObject({ rule: 'lead_archived' });
    expect(await runJobAt(stopped!.id)).toBeNull();

    expect(await runOf(carried!.id)).toMatchObject({ status: 'completed' });
    const skipped = (await stepOf(carried!.id, moveId))!;
    expect(skipped).toMatchObject({ status: 'skipped' });
    expect(skipped.output).toMatchObject({ skipped: 'refused', rule: 'lead_archived' });
    expect(await notesOf(p.id)).toEqual(['Moved Heat pump']);
  });
});

describe('a business with no owner or admin of its own', () => {
  it('emails the organization’s owners and admins instead, so someone hears straight away', async () => {
    // The agency adds a business for a client; nobody is a member of it yet.
    const { workspaceId } = await run(w, workspaceCreate, {
      organizationId: w.organizationId,
      name: 'Fallback Plumbing Test',
      timezone: CHI,
    });
    const bare: World = { ...w, workspaceId };
    const managersOf = async (ws: string) =>
      (
        await asWorker(w.s.db, { workspaceId: ws, organizationId: w.organizationId }, (tx) =>
          workspaceManagers(tx, ws),
        )
      )
        .map((u) => u.id)
        .sort();
    expect(await managersOf(w.workspaceId)).toEqual([w.owner.id]);
    expect(await managersOf(workspaceId)).toEqual([w.owner.id, agencyAdmin.id].sort());

    const hookId = sid('bhook');
    const wf = await addWorkflow(bare, 'Bare hook', {
      version: 1,
      trigger: { kind: 'manual' },
      steps: [
        {
          id: hookId,
          type: 'action',
          action: 'webhook_out',
          config: { url: 'https://hooks.fixture.test/bare', include: ['person'] },
        },
      ],
    });
    site.status = 503;
    const p = await customerNamed(bare, 'Bo');
    await run(bare, workflowEnrol, { workspaceId, workflowId: wf.id, personId: p.id });
    await drain(bare);
    const runId = (await runsOf(wf.id)).find((r) => r.person_id === p.id)!.id;
    for (let i = 2; i <= 5; i++) await runJob(bare, runId);
    site.status = 200;
    expect((await stepOf(runId, hookId))!).toMatchObject({ status: 'dead', attempt: 5 });
    const mail = await waitForMail(agencyAdmin.email, 'A workflow stopped: Bare hook');
    expect(mail.text).toContain(`/app/w/${workspaceId}/workflows/runs/${runId}`);
    await waitForMail(w.owner.email, 'A workflow stopped: Bare hook');
  });
});
