/**
 * Approval steps, the engine's part (the Approvals page is the web's).
 *
 * Opening one: the run becomes awaiting_approval, a workflow_approvals row is written with what the approver
 * reads (the step's message and the AI-written text it previews, editable), the approvers are emailed a link
 * to the Approvals page, and a live event goes out. The run's cursor job waits for the expiry.
 *
 * The decision (workflow.decide_approval, claimed once) pulls the job forward. Approved: the approver's edits
 * replace the AI text they previewed, and the run goes on. Rejected: the rejected path, then the run ends.
 * Nobody decided by the expiry: the job marks it expired and follows onExpire.
 *
 * Test runs approve automatically, with a note.
 */
import {
  aiOutputKey,
  findStep,
  isWorkspaceUser,
  OUTPUT_KEY_RE,
  type ApprovalStep,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { managers } from '../handlers/telephony';
import { EARLY_MS } from './constants';
import { approvalRequestEmail } from './emails';
import { recordEngineEvent } from './events';
import type { ExecCtx, Json, Outcome, StepRow } from './types';
import { addDuration } from './waits';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function when(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(ms);
}

interface ApprovalRow {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  approvers: string[];
  preview: Json;
  edits: Json | null;
  reason: string | null;
  decided_by: string | null;
  via: string | null;
  expires_at: string | null;
}

async function loadApproval(ec: ExecCtx): Promise<ApprovalRow | null> {
  const [a] = await rows<ApprovalRow & Record<string, unknown>>(
    ec.tx,
    sql`select id, status::text as status, approvers, preview, edits, reason, decided_by, via, expires_at
        from app.workflow_approvals where run_id = ${ec.run.id} and step_key = ${ec.stepKey}`,
  );
  return a ?? null;
}

/** The knowledge items the previewed AI step used (its log's `items`), for the approver to see. */
async function usedItems(ec: ExecCtx, stepId: string): Promise<unknown[]> {
  const [row] = await rows<{ output: Json | null }>(
    ec.tx,
    sql`select output from app.workflow_run_steps
        where run_id = ${ec.run.id} and split_part(step_key, '#', 1) = ${stepId} and status = 'done'
        order by finished_at desc nulls last limit 1`,
  );
  const items = row?.output?.['items'];
  return Array.isArray(items) ? items.slice(0, 10) : [];
}

/** Reaching an approval step. */
export async function openApproval(ec: ExecCtx): Promise<Outcome> {
  const step = ec.step as ApprovalStep;
  if (ec.testMode)
    return {
      kind: 'done',
      walk: { approved: true },
      output: { autoApproved: true, note: 'Test run: approved automatically.' },
    };
  const ws = ec.scope.workspaceId;
  const named: string[] = [];
  if (step.approvers.kind === 'users')
    for (const ref of step.approvers.userIds)
      if (typeof ref === 'string' && (await isWorkspaceUser(ec.tx, ws, ref))) named.push(ref);

  const target = step.previewStepId ? (findStep(ec.def, step.previewStepId)?.step ?? null) : null;
  const fields: Record<string, string> = {};
  let channel: string | null = null;
  if (target?.type === 'ai') {
    const key = aiOutputKey(target);
    const ai = ec.context['ai'];
    const value = isRecord(ai) ? ai[key] : undefined;
    if (typeof value === 'string') fields[key] = value;
    if (target.task === 'write') channel = target.channel;
  }
  const person = await ec.data.person();
  const customer = person ? `${person.first_name} ${person.last_name}`.trim() || null : null;
  // What the approver weighs the text against: the customer's latest message and the knowledge it used.
  const asked = (await ec.data.conversation())?.last_message?.trim() || null;
  const preview: Json = {
    workflow: ec.workflow.name,
    stepId: step.id,
    message: step.message,
    previewStepId: step.previewStepId,
    fields,
    channel,
    customer,
    personId: ec.run.personId,
    asked: asked ? asked.slice(0, 1000) : null,
    items: target?.type === 'ai' ? await usedItems(ec, target.id) : [],
  };
  const expiresAt = addDuration(ec.now, step.expiresAfter, ec.timeZone);
  const [created] = await rows<{ id: string }>(
    ec.tx,
    sql`insert into app.workflow_approvals (workspace_id, workflow_id, run_id, step_key, approvers, preview, expires_at)
        values (${ws}, ${ec.run.workflowId}, ${ec.run.id}, ${ec.stepKey},
          ${sql`array[${sql.join(
            named.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]::uuid[]`}, ${JSON.stringify(preview)}::jsonb, ${new Date(expiresAt).toISOString()}::timestamptz)
        on conflict (run_id, step_key) do nothing
        returning id`,
  );
  const approvalId = created?.id ?? (await loadApproval(ec))!.id;
  const after: (() => Promise<void>)[] = [];
  if (created) {
    await recordEngineEvent(ec.tx, {
      type: 'workflow.approval_requested',
      action: 'workflow.request_approval',
      workspaceId: ws,
      organizationId: ec.scope.organizationId,
      entityType: 'workflow_approval',
      entityId: approvalId,
      actor: { type: 'workflow', workflowId: ec.run.workflowId },
      correlationId: ec.run.id,
      payload: {
        approvalId,
        runId: ec.run.id,
        workflowId: ec.run.workflowId,
        stepKey: ec.stepKey,
        approvers: named,
        expiresAt: new Date(expiresAt).toISOString(),
      },
      after: { workflow: ec.workflow.name, ...(customer ? { customer } : {}) },
    });
    const people = named.length
      ? await rows<{ email: string }>(
          ec.tx,
          sql`select email::text as email from app.users where id in (${sql.join(
            named.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        )
      : await managers(ec.tx, ws);
    const mail = approvalRequestEmail({
      workflow: ec.workflow.name,
      customer,
      message: step.message,
      preview: Object.values(fields)[0] ?? null,
      expiresAt: when(expiresAt, ec.timeZone),
      link: `${ec.s.webUrl}/app/w/${ws}/workflows/approvals`,
    });
    const { mailer, log } = ec.s;
    after.push(async () => {
      for (const p of people)
        try {
          await mailer.send({ to: p.email, ...mail });
        } catch (e) {
          log.warn({ err: e, approvalId }, 'could not email an approver');
        }
    });
  }
  return {
    kind: 'wait',
    until: expiresAt,
    runStatus: 'awaiting_approval',
    output: { approvalId, expiresAt: new Date(expiresAt).toISOString(), approvers: named },
    after,
  };
}

function expired(step: ApprovalStep, approvalId: string): Outcome {
  const output = { approvalId, decision: 'expired', onExpire: step.onExpire };
  if (step.onExpire === 'end') return { kind: 'end', reason: 'approval_expired', output };
  return { kind: 'done', walk: { approved: step.onExpire === 'approve' }, output };
}

/** The run's job came back to a waiting approval step: decided, expired, or not yet. */
export async function resumeApproval(ec: ExecCtx, row: StepRow): Promise<Outcome> {
  const step = ec.step as ApprovalStep;
  const a = await loadApproval(ec);
  if (!a) return openApproval(ec);
  const output = row.output ?? {};
  switch (a.status) {
    case 'pending': {
      const expiresAt = a.expires_at ? new Date(a.expires_at).getTime() : null;
      if (expiresAt === null || ec.now < expiresAt - EARLY_MS)
        return {
          kind: 'wait',
          until: expiresAt ?? ec.now + 86_400_000,
          runStatus: 'awaiting_approval',
          output,
        };
      // Claimed once: a decision that lands at the same moment wins, and this run goes round again.
      const [x] = await rows<{ id: string }>(
        ec.tx,
        sql`update app.workflow_approvals set status = 'expired', decided_at = now(), via = 'system'
            where id = ${a.id} and status = 'pending' returning id`,
      );
      if (!x) return { kind: 'wait', until: ec.now, runStatus: 'awaiting_approval', output };
      await recordEngineEvent(ec.tx, {
        type: 'workflow.approval_expired',
        action: 'workflow.expire_approval',
        workspaceId: ec.scope.workspaceId,
        organizationId: ec.scope.organizationId,
        entityType: 'workflow_approval',
        entityId: a.id,
        actor: { type: 'workflow', workflowId: ec.run.workflowId },
        correlationId: ec.run.id,
        payload: {
          approvalId: a.id,
          runId: ec.run.id,
          workflowId: ec.run.workflowId,
          stepKey: ec.stepKey,
          onExpire: step.onExpire,
        },
        before: { status: 'pending' },
        after: { workflow: ec.workflow.name, status: 'expired', then: step.onExpire },
      });
      return expired(step, a.id);
    }
    case 'expired':
      return expired(step, a.id);
    case 'approved': {
      const preview = isRecord(a.preview) ? a.preview : {};
      const allowed = isRecord(preview['fields']) ? Object.keys(preview['fields']) : [];
      const edits: Record<string, string> = {};
      if (isRecord(a.edits))
        for (const [k, v] of Object.entries(a.edits))
          if (
            typeof v === 'string' &&
            OUTPUT_KEY_RE.test(k) &&
            (allowed.length === 0 || allowed.includes(k))
          )
            edits[k] = v;
      const edited = Object.keys(edits).length > 0;
      return {
        kind: 'done',
        walk: { approved: true },
        output: {
          approvalId: a.id,
          decision: 'approved',
          decidedBy: a.decided_by,
          via: a.via,
          edited,
        },
        ...(edited ? { context: { ai: edits } } : {}),
      };
    }
    case 'rejected':
      return {
        kind: 'done',
        walk: { approved: false },
        output: {
          approvalId: a.id,
          decision: 'rejected',
          decidedBy: a.decided_by,
          via: a.via,
          reason: a.reason,
        },
      };
    case 'cancelled':
      return { kind: 'end', reason: 'approval_cancelled', output: { approvalId: a.id } };
  }
}
