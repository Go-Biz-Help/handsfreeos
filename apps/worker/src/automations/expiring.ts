/**
 * Automations' "Approvals about to expire": two hours before a workflow approval or an AI teammate draft runs
 * out, whoever can decide it gets another push ("Expires in 2 h"), and its card on Home turns urgent (the
 * `ai_approval` detector). A short-lived one — a draft that lives two hours from the start — gets only the push it
 * got when it was made: a second one straight after the first says nothing new.
 */
import { automationSettingsOf, scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { approvalPushOf, draftPushOf } from '../push/moments';
import { queuePush } from '../push/queue';
import { tenantOf } from '../services';

export const EXPIRING_JOB = 'automations.expiring';
export const expiringJobKey = (source: 'workflow' | 'teammate', id: string): string =>
  `expiring:${source}:${id}`;
/** How long before it expires. */
export const EXPIRING_WARN_MS = 2 * 60 * 60_000;
/** The warning must come at least this long after the first push. */
const MIN_GAP_MS = 60 * 60_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

async function switchOn(tx: Tx, workspaceId: string): Promise<boolean> {
  const [ws] = await rows<{ settings: Record<string, unknown> | null }>(
    tx,
    sql`select settings from app.workspaces where id = ${workspaceId}`,
  );
  return automationSettingsOf(ws?.settings).switches.approvalExpiry;
}

/** workflow.approval_requested and ai_teammate.drafted: the warning, two hours before it expires. */
export const onExpiringArm: EventHandler = async (ctx) => {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const source = ctx.event.eventType === 'ai_teammate.drafted' ? 'teammate' : 'workflow';
  const id =
    (source === 'teammate' ? str(p['draftId']) : str(p['approvalId'])) ?? ctx.event.entityId;
  if (!id) return;
  const scope = tenantOf(ctx.scope);
  const [row] = await rows<{ created_at: Date; expires_at: Date | null; status: string }>(
    ctx.tx,
    source === 'teammate'
      ? sql`select created_at, expires_at, status::text as status from app.ai_teammate_drafts
            where id = ${id} and workspace_id = ${scope.workspaceId}`
      : sql`select created_at, expires_at, status::text as status from app.workflow_approvals
            where id = ${id} and workspace_id = ${scope.workspaceId}`,
  );
  if (!row?.expires_at || row.status !== 'pending') return;
  const warnAt = new Date(row.expires_at).getTime() - EXPIRING_WARN_MS;
  if (warnAt < new Date(row.created_at).getTime() + MIN_GAP_MS) return;
  if (!(await switchOn(ctx.tx, scope.workspaceId))) return;
  await scheduleJob(ctx.tx, {
    kind: EXPIRING_JOB,
    dedupeKey: expiringJobKey(source, id),
    runAt: new Date(warnAt),
    payload: { source, id },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
};

export const expiringJob: JobHandler = async (ctx) => {
  const p = (ctx.job.payload ?? {}) as Record<string, unknown>;
  const id = str(p['id']);
  const source = p['source'] === 'teammate' ? 'teammate' : 'workflow';
  if (!id) return;
  const scope = tenantOf(ctx.scope);
  await asWorker(ctx.db, scope, async (tx) => {
    if (!(await switchOn(tx, scope.workspaceId))) return;
    // Still waiting (the push builders say null once it's decided, expired or cancelled).
    const moment =
      source === 'teammate'
        ? await draftPushOf(tx, scope, id)
        : await approvalPushOf(tx, scope, id);
    if (!moment) return;
    await queuePush(tx, scope, {
      ...moment,
      key: expiringJobKey(source, id),
      title: moment.title.replace(/^Approval/, 'Expires in 2 h'),
    });
  });
};
