import type { AiUsage } from '@hfos/ai';
import {
  aiLimitReached,
  aiUsageKey,
  assistantUsageKey,
  DEFAULT_AI_DAILY_LIMIT_CENTS,
  walletRoom,
  WALLET_REFUSALS,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';
import { chargeAi } from '../money/usage-capture';
import type { WalletDeps } from '../money/wallet';
import type { TenantScope } from '../services';

/** Where AI tokens outside the Assistant's runs were spent (app.ai_usage.source). */
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
  | 'lead_intake'
  // Drafting a funnel for the AI teammate from a description (teammate funnels).
  | 'funnel'
  // The Assistant reading its instructions ahead of a question, while the person types (its runs keep the rest).
  | 'assistant';

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
  funnel: 'AI drafting a funnel',
  // Reading ahead while the person types: on the balance like the questions themselves (20261027012500).
  assistant: 'Ask HandsFreeOS getting ready',
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
 * One Ask HandsFreeOS question, charged once when its run ends: everything its model calls came to, as one line
 * on the statement. Failed and stopped runs are charged too: the tokens were spent all the same. Ask HandsFreeOS
 * runs on Claude Opus, which `chargeAi` prices from its own lines.
 */
export async function chargeAssistantRun(
  deps: { readonly wallet: WalletDeps },
  scope: TenantScope,
  input: { readonly runId: string; readonly model: string; readonly usage: AiUsage },
): Promise<void> {
  const u = input.usage;
  if (u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens <= 0) return;
  await chargeAi(deps.wallet, scope, {
    tokens: u,
    idempotencyKey: assistantUsageKey(input.runId),
    subject: 'Ask HandsFreeOS answering a question',
    entityType: 'assistant_run',
    entityId: input.runId,
    known: true,
    model: input.model,
  });
}

/** Today's AI against the business's own daily AI limit, in cents priced as it's charged. */
export interface AiToday {
  readonly limitCents: number;
  readonly spentCents: number;
  /** One teammate's part of `spentCents`, when one was asked about. */
  readonly teammateCents: number;
}

/**
 * Everything the business's AI came to since midnight where it is (the Assistant's runs plus app.ai_usage),
 * priced from the live card, beside the limit it set: private.ai_spend_today, which the API's pages read too.
 */
async function aiToday(db: Db, scope: TenantScope, teammateId: string | null): Promise<AiToday> {
  const [row] = await asWorker(db, scope, (tx) =>
    rows<{
      limit_cents: string | number | null;
      spent_cents: string | number | null;
      teammate_cents: string | number | null;
    }>(
      tx,
      sql`select limit_cents, spent_cents, teammate_cents
          from private.ai_spend_today(${scope.workspaceId}::uuid, ${teammateId}::uuid)`,
    ),
  );
  return {
    limitCents: Number(row?.limit_cents ?? DEFAULT_AI_DAILY_LIMIT_CENTS),
    spentCents: Number(row?.spent_cents ?? 0),
    teammateCents: Number(row?.teammate_cents ?? 0),
  };
}

/** Why there's no room for another AI call, and the words that say so. */
export interface AiNoRoom {
  readonly code: 'budget_reached' | 'wallet_empty';
  readonly message: string;
}

/**
 * The one daily AI limit per business, which it sets itself in dollars (Settings → Usage & balance): the
 * Assistant, the AI teammate, workflow AI steps, the builders, the knowledge base and add-ons all draw on it.
 * The teammate may use only its share (its settings' dailySharePercent, 60% by default), so strangers writing
 * in never use up what the Assistant and workflows need. Checked before each model call, so the last call of
 * the day can go a little over.
 */
export const aiBudget = {
  /** Today's AI and the limit. */
  today(db: Db, scope: TenantScope): Promise<AiToday> {
    return aiToday(db, scope, null);
  },

  /**
   * Null while there's room for another AI call; once today's AI has reached the limit, the words that say so,
   * with the amount and where to raise it.
   */
  async reached(db: Db, scope: TenantScope): Promise<string | null> {
    const t = await aiToday(db, scope, null);
    return t.spentCents >= t.limitCents ? aiLimitReached(t.limitCents) : null;
  },

  /**
   * The limit and the balance together, for a caller that only asks once: null while there's room; otherwise
   * which ran out first, today's AI limit or, for a business Stopped at zero, its balance.
   */
  async noRoom(db: Db, scope: TenantScope, log?: Logger): Promise<AiNoRoom | null> {
    const reached = await aiBudget.reached(db, scope);
    if (reached) return { code: 'budget_reached', message: reached };
    const room = await asWorker(db, scope, (tx) =>
      walletRoom(tx, scope.workspaceId, 'ai', (m, e) => log?.error({ err: e }, m)),
    );
    return room.allowed ? null : { code: 'wallet_empty', message: WALLET_REFUSALS.ai };
  },

  /** Whether the teammate may make another model call: the business is under its limit, and it under its share. */
  async teammateHasRoom(
    db: Db,
    scope: TenantScope,
    input: { readonly teammateId: string; readonly sharePercent: number },
  ): Promise<boolean> {
    const t = await aiToday(db, scope, input.teammateId);
    return (
      t.spentCents < t.limitCents && t.teammateCents < (t.limitCents * input.sharePercent) / 100
    );
  },
};
