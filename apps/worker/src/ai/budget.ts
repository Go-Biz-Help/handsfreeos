import type { AiUsage } from '@hfos/ai';
import { aiUsageKey } from '@hfos/core/server';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';
import { chargeAi } from '../money/usage-capture';
import type { WalletDeps } from '../money/wallet';
import type { TenantScope } from '../services';

/** Where AI tokens outside the Assistant were spent (app.ai_usage.source). */
export type AiUsageSource =
  | 'workflow'
  | 'builder'
  | 'knowledge'
  | 'teammate'
  | 'automations'
  | 'addon'
  // A recorded call's summary and suggestions.
  | 'meetings'
  // Building and scoring the business's main offer.
  | 'main_offer'
  // Adding the texting section to the business's own privacy policy or terms.
  | 'texting_policy'
  // Reading an applicant Indeed emailed the business about (funnels).
  | 'lead_intake';

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
  /** An add-on's own use (source addon): which add-on. */
  readonly addonId?: string | null;
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
): Promise<string | null> {
  const [row] = await rows<{ id: string }>(
    tx,
    sql`insert into app.ai_usage (workspace_id, source, user_id, workflow_id, run_id, step_key,
      teammate_id, teammate_run_id, addon_id, model, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens)
    values (private.system_scope_workspace(), ${input.source}::app.ai_usage_source, ${input.userId ?? null},
      ${input.workflowId ?? null}, ${input.runId ?? null}, ${input.stepKey ? input.stepKey.slice(0, 100) : null},
      ${input.teammateId ?? null}, ${input.teammateRunId ?? null},
      ${input.source === 'addon' ? (input.addonId ?? null) : null},
      ${input.model.slice(0, 100) || 'unknown'}, ${count(input.usage.inputTokens)}, ${count(input.usage.outputTokens)},
      ${count(input.usage.cacheReadTokens)}, ${count(input.usage.cacheWriteTokens)})
    returning id`,
  );
  return row?.id ?? null;
}

/** What an AI request is called on a business's statement. Never a model name: "AI replies" is what it bought. */
const AI_SUBJECTS: Readonly<Record<AiUsageSource, string>> = {
  workflow: 'AI in a workflow',
  builder: 'AI while building',
  knowledge: 'AI reading your knowledge',
  teammate: 'An AI teammate reply',
  automations: 'AI reading customer messages',
  addon: 'AI in an add-on',
  meetings: 'AI reading a call transcript',
  main_offer: 'AI building your main offer',
  texting_policy: 'AI updating your privacy policy or terms',
  lead_intake: 'AI reading a job applicant’s email',
};

/**
 * Record an AI call's tokens **and** charge for them (M16, step 3). The two are one act everywhere else in the
 * worker, so they are one call here — five places used to write the tokens and none of them charged.
 *
 * The charge is a second transaction on purpose, after the tokens are safely recorded. Joining the first would
 * be neater, but a wallet that cannot be written must never take the token record down with it, and in Postgres
 * an error inside a transaction poisons the whole of it.
 */
export async function recordAndChargeAi(
  deps: { readonly db: Db; readonly log: Logger; readonly wallet: WalletDeps },
  scope: TenantScope,
  input: AiUsageRef & { readonly model: string; readonly usage: AiUsage },
): Promise<void> {
  const id = await asWorker(deps.db, scope, (tx) => recordAiUsage(tx, input));
  if (!id) return;
  await chargeAi(deps.wallet, scope, {
    tokens: input.usage,
    idempotencyKey: aiUsageKey(id),
    subject: AI_SUBJECTS[input.source],
    entityType: 'ai_usage',
    entityId: id,
    // Every model we run today is on the card. One that is not bills at `ai.unknown.mtok`, which is dear on
    // purpose so that somebody notices and prices it properly.
    known: true,
    model: input.model,
  });
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
