/**
 * Approval steps, the engine's part: a run pauses for an approver's OK with the AI-written text to check (the
 * AI seam has no model yet, so the step's fallback text stands in), the approvers are emailed, and a live event
 * goes out. Approving with an edit sends the edited text; rejecting takes the rejected path; nobody deciding by
 * the expiry follows onExpire; a second decision is refused and the run goes on once.
 */
import {
  HfosError,
  workflowDecideApproval,
  workflowEnrol,
  type WorkflowDefinitionInput,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addWorkflow,
  admin,
  customerNamed,
  drain,
  eventsOf,
  flowWorld,
  mailTo,
  run,
  runJob,
  runOf,
  runsOf,
  sid,
  stepOf,
  waitForMail,
  type World,
} from './workflow-world';

let w: World;
/** An admin of the organization (the agency) who isn't a member of the business. */
let agencyAdmin: TestUser;
beforeAll(async () => {
  w = await flowWorld('wfappr');
  agencyAdmin = await createTestUser('wfappr-agency', { fullName: 'Ann Agency' });
  await rows(
    admin(),
    sql`insert into app.organization_memberships (organization_id, user_id, role)
        values (${w.organizationId}, ${agencyAdmin.id}, 'admin')`,
  );
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

const FALLBACK = 'Sorry the visit didn’t go well. Someone will call you today.';
const note = (id: string, body: string) => ({
  id,
  type: 'action' as const,
  action: 'add_note' as const,
  config: { body },
});

function approvalFlow(onExpire: 'approve' | 'reject' | 'end') {
  const aiId = sid('apwrit');
  const approvalId = sid('apappr');
  const def: WorkflowDefinitionInput = {
    version: 1,
    trigger: { kind: 'manual' },
    steps: [
      { id: aiId, type: 'ai', task: 'write', prompt: 'Write a short apology.', fallback: FALLBACK },
      {
        id: approvalId,
        type: 'approval',
        message: 'Check this reply before it goes out.',
        previewStepId: aiId,
        expiresAfter: { amount: 1, unit: 'hours' },
        onExpire,
        rejected: { steps: [note(sid('aprjct'), 'Rejected: {{person.first_name}}')] },
      },
      note(sid('apsent'), 'Sent: {{ai.message}}'),
    ],
  };
  return { def, aiId, approvalId };
}

async function notesOf(personId: string): Promise<string[]> {
  const list = await rows<{ body: string }>(
    admin(),
    sql`select body from app.activities where person_id = ${personId} and kind = 'note' order by created_at`,
  );
  return list.map((n) => n.body);
}

interface ApprovalRow {
  id: string;
  status: string;
  preview: Record<string, unknown>;
  expires_at: Date;
  via: string | null;
}

async function approvalOf(runId: string): Promise<ApprovalRow> {
  const [a] = await rows<ApprovalRow & Record<string, unknown>>(
    admin(),
    sql`select id, status::text as status, preview, expires_at, via from app.workflow_approvals where run_id = ${runId}`,
  );
  return a!;
}

async function start(workflowId: string, first: string) {
  const p = await customerNamed(w, first);
  await run(w, workflowEnrol, { workspaceId: w.workspaceId, workflowId, personId: p.id });
  await drain(w);
  const r = (await runsOf(workflowId)).find((x) => x.person_id === p.id)!;
  return { p, runId: r.id };
}

const decide = (
  approvalId: string,
  decision: 'approve' | 'reject',
  extra: Record<string, unknown> = {},
) => run(w, workflowDecideApproval, { workspaceId: w.workspaceId, approvalId, decision, ...extra });

describe('approval steps', () => {
  let flow: ReturnType<typeof approvalFlow>;
  let wfId: string;
  beforeAll(async () => {
    flow = approvalFlow('reject');
    wfId = (await addWorkflow(w, 'Check the apology', flow.def)).id;
  });

  it('waits for an approver, who can edit the AI-written text before it goes', async () => {
    const { p, runId } = await start(wfId, 'Amy');
    expect((await runOf(runId)).status).toBe('awaiting_approval');
    // No model behind the AI seam yet: the step's fallback text, and why.
    expect((await stepOf(runId, flow.aiId))!.output).toMatchObject({
      task: 'write',
      value: FALLBACK,
      fallback: true,
      reason: 'ai_unavailable',
    });
    const a = await approvalOf(runId);
    expect(a.status).toBe('pending');
    expect(a.preview).toMatchObject({
      message: 'Check this reply before it goes out.',
      fields: { message: FALLBACK },
      customer: 'Amy Customer',
    });
    expect(new Date(a.expires_at).getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect(await eventsOf('workflow.approval_requested', a.id)).toHaveLength(1);
    const mail = await waitForMail(w.owner.email, 'Approval needed: Check the apology');
    expect(mail.text).toContain(FALLBACK);
    expect(mail.text).toContain(`/app/w/${w.workspaceId}/workflows/approvals`);
    // The business has an owner of its own: the agency's admin reads about it in the daily digest instead.
    await new Promise((r) => setTimeout(r, 300));
    expect(
      (await mailTo(agencyAdmin.email)).filter((m) => m.Subject.startsWith('Approval needed')),
    ).toEqual([]);

    await decide(a.id, 'approve', {
      edits: { message: 'We’re so sorry, Amy. Dale will call you by noon.' },
    });
    await drain(w);
    expect(await runOf(runId)).toMatchObject({ status: 'completed', end_reason: 'finished' });
    expect((await stepOf(runId, flow.approvalId))!.output).toMatchObject({
      decision: 'approved',
      edited: true,
    });
    expect(await notesOf(p.id)).toEqual(['Sent: We’re so sorry, Amy. Dale will call you by noon.']);
  });

  it('takes the rejected path, then ends', async () => {
    const { p, runId } = await start(wfId, 'Rob');
    const a = await approvalOf(runId);
    await decide(a.id, 'reject', { reason: 'Too casual' });
    await drain(w);
    expect(await runOf(runId)).toMatchObject({ status: 'completed', end_reason: 'rejected' });
    expect((await stepOf(runId, flow.approvalId))!.output).toMatchObject({
      decision: 'rejected',
      reason: 'Too casual',
    });
    expect(await notesOf(p.id)).toEqual(['Rejected: Rob']);
  });

  it('decides once: a second decision is refused and the run goes on once', async () => {
    const { p, runId } = await start(wfId, 'Dot');
    const a = await approvalOf(runId);
    await decide(a.id, 'approve');
    const second = await decide(a.id, 'reject').catch((e: unknown) => e);
    expect(second).toBeInstanceOf(HfosError);
    expect((second as HfosError).rule).toBe('approval_decided');
    await drain(w);
    await drain(w);
    expect((await runOf(runId)).status).toBe('completed');
    expect(await notesOf(p.id)).toEqual([`Sent: ${FALLBACK}`]);
  });
});

describe('when nobody decides', () => {
  it('expires at its time and follows onExpire (reject)', async () => {
    const flow = approvalFlow('reject');
    const wf = await addWorkflow(w, 'Expires to reject', flow.def);
    const { p, runId } = await start(wf.id, 'Eve');
    await runJob(w, runId);
    const a = await approvalOf(runId);
    expect(a).toMatchObject({ status: 'expired', via: 'system' });
    expect(await eventsOf('workflow.approval_expired', a.id)).toHaveLength(1);
    expect(await runOf(runId)).toMatchObject({ status: 'completed', end_reason: 'rejected' });
    expect(await notesOf(p.id)).toEqual(['Rejected: Eve']);
    // Too late to decide now.
    const late = await decide(a.id, 'approve').catch((e: unknown) => e);
    expect((late as HfosError).rule).toBe('approval_decided');
  });

  it('expires and approves when that is the setting', async () => {
    const flow = approvalFlow('approve');
    const wf = await addWorkflow(w, 'Expires to approve', flow.def);
    const { p, runId } = await start(wf.id, 'Ann');
    await runJob(w, runId);
    expect((await approvalOf(runId)).status).toBe('expired');
    expect((await runOf(runId)).status).toBe('completed');
    expect(await notesOf(p.id)).toEqual([`Sent: ${FALLBACK}`]);
  });

  it('expires and ends the run when that is the setting', async () => {
    const flow = approvalFlow('end');
    const wf = await addWorkflow(w, 'Expires to end', flow.def);
    const { p, runId } = await start(wf.id, 'Ned');
    await runJob(w, runId);
    expect(await runOf(runId)).toMatchObject({
      status: 'completed',
      end_reason: 'approval_expired',
    });
    expect(await notesOf(p.id)).toEqual([]);
  });
});
