import type { AiUsage } from '@hfos/ai';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import type { TenantScope } from '../services';

/** Where AI tokens outside the Assistant were spent (app.ai_usage.source). */
export type AiUsageSource = 'workflow' | 'builder' | 'knowledge' | 'teammate';

/** What an AI call was for, for app.ai_usage. */
export interface AiUsageRef {
  readonly source: AiUsageSource;
  /** The person who asked (the builder, Try it, a website scan); null for a workflow step. */
  readonly userId?: string | null;
  readonly workflowId?: string | null;
  readonly runId?: string | null;
  readonly stepKey?: string | null;
  /** The AI teammate's calls: the teammate (for its share of the limit) and its run. */
  readonly teammateId?: string | null;
  readonly teammateRunId?: string | null;
}

const count = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/**
 * One AI call's tokens, in the workspace the transaction is scoped to (open it with asWorker). The
 * Assistant's own runs keep their tokens on assistant_runs; everything else lands here, and the daily limit
 * counts both.
 */
export async function recordAiUsage(
  tx: Tx,
  input: AiUsageRef & { readonly model: string; readonly usage: AiUsage },
): Promise<void> {
  await tx.execute(sql`insert into app.ai_usage (workspace_id, source, user_id, workflow_id, run_id, step_key,
      teammate_id, teammate_run_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    values (private.system_scope_workspace(), ${input.source}::app.ai_usage_source, ${input.userId ?? null},
      ${input.workflowId ?? null}, ${input.runId ?? null}, ${input.stepKey ? input.stepKey.slice(0, 100) : null},
      ${input.teammateId ?? null}, ${input.teammateRunId ?? null},
      ${input.model.slice(0, 100) || 'unknown'}, ${count(input.usage.inputTokens)}, ${count(input.usage.outputTokens)},
      ${count(input.usage.cacheReadTokens)}, ${count(input.usage.cacheWriteTokens)})`);
}

/**
 * Tokens used today (since midnight in `timezone`, the workspace's own when missing), cache reads and writes
 * included: the whole workspace (the Assistant's runs plus app.ai_usage), and one teammate's share of it.
 */
async function usedSinceMidnight(
  db: Db,
  scope: TenantScope,
  timezone: string | null | undefined,
  teammateId: string | null,
): Promise<{ total: number; teammate: number }> {
  const [row] = await asWorker(db, scope, (tx) =>
    rows<{ total: string | number | null; teammate: string | number | null }>(
      tx,
      sql`with since as (
            select date_trunc('day', now() at time zone z.tz) at time zone z.tz as t
            from (select coalesce(${timezone ?? null}::text,
                    (select w.timezone from app.workspaces w where w.id = ${scope.workspaceId}), 'UTC') as tz) z
          )
          select
            coalesce((select sum(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens)
              from app.assistant_runs r, since
              where r.workspace_id = ${scope.workspaceId} and r.started_at >= since.t), 0)
            + coalesce((select sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens)
              from app.ai_usage u, since
              where u.workspace_id = ${scope.workspaceId} and u.created_at >= since.t), 0) as total,
            coalesce((select sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens)
              from app.ai_usage u, since
              where u.workspace_id = ${scope.workspaceId} and u.source = 'teammate'
                and u.teammate_id = ${teammateId}::uuid and u.created_at >= since.t), 0) as teammate`,
    ),
  );
  return { total: Number(row?.total ?? 0), teammate: Number(row?.teammate ?? 0) };
}

/**
 * The one daily AI limit per workspace: the Assistant, workflow AI steps, the AI builder, the knowledge base
 * and the AI teammate all draw on it. The teammate may use only its share (its settings' dailySharePercent,
 * 60% by default), so strangers writing in never use up what the Assistant and workflows need.
 */
export const aiBudget = {
  /**
   * Every token the workspace's AI used today, cache reads and writes included: the Assistant's runs plus
   * app.ai_usage, since midnight in `timezone` (the workspace's own when missing).
   */
  async usedToday(db: Db, scope: TenantScope, timezone?: string | null): Promise<number> {
    return (await usedSinceMidnight(db, scope, timezone, null)).total;
  },

  /** Whether the teammate may make another model call: the workspace is under its limit, and it under its share. */
  async teammateHasRoom(
    db: Db,
    scope: TenantScope,
    input: {
      readonly teammateId: string;
      readonly dailyTokens: number;
      readonly sharePercent: number;
      readonly timeZone?: string | null;
    },
  ): Promise<boolean> {
    const used = await usedSinceMidnight(db, scope, input.timeZone, input.teammateId);
    const share = Math.floor((input.dailyTokens * input.sharePercent) / 100);
    return used.total < input.dailyTokens && used.teammate < share;
  },
};
