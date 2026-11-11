/**
 * A job heading over its budget (docs/contractor.md, "The AI helpers"). Whenever something that costs money changes
 * on a job (time, materials, other costs, its budget, how far along it is), its budget is looked at a moment later,
 * once the burst has settled. The rule and the alert's words are core's (`contractor.budget.check`): plain
 * arithmetic, so the warning never waits on the AI.
 *
 * - **Who's told.** Only people who may see job costs (the alert's permission is `contractor.costs`), on Home and
 *   their phones and by email. Its title carries no amount, since a title goes on history; its detail has the costs
 *   and the profit the job is now heading for, as the owner asked.
 * - **When.** The first time a job crosses a line, when it crosses a worse one, and each further 10 points over.
 *   Getting better is never news. The alert comes down when the job is back within its plan, finished or archived.
 * - **The AI's part** comes after the alert and never holds it up: a sentence or two on what's driving it, and up
 *   to three things the business could do, kept for the job's Costs so far card. Suggestions only (the owner's
 *   rule). When the AI is busy, off or out of budget, the warning simply goes without them.
 */
import {
  BUDGET_ADVICE_SCHEMA,
  BUDGET_ADVICE_SYSTEM,
  BudgetAdviceAnswer,
  checkedBudgetAdvice,
} from '@hfos/core/addons/contractor/budget-watch';
import { budgetAdvise, budgetCheck } from '@hfos/core/addons/contractor/ops/budget';
import { executeCommand } from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import type { JobResult } from '../../jobs';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext } from '../types';
import { usageOf } from './ai';

export const BUDGET_CHECK = 'contractor.budget_check';

const keyOf = (jobId: string) => `budget:${jobId}`;
/** A burst of changes (a crew ticking Done, costs being stamped) is looked at once, after it settles. */
const SETTLE_MS = 2 * 60_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Something that costs money, or how far along the job is, changed: its budget is looked at in a moment. */
export async function costsChanged(ctx: AddonEventContext): Promise<void> {
  const payload = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const jobId = str(payload['jobId']) ?? ctx.event.entityId;
  if (!jobId) return;
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: BUDGET_CHECK,
        dedupeKey: keyOf(jobId),
        runAt: new Date(Date.now() + SETTLE_MS),
        payload: { jobId },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

/** `contractor.budget_check`: where one job's budget stands, and the alert that follows it. */
export async function budgetCheckJob(ctx: AddonJobContext): Promise<JobResult> {
  const jobId = str(ctx.job.payload['jobId']);
  if (!jobId) return;
  const workspaceId = ctx.scope.workspaceId;
  const { output: out } = await executeCommand(
    ctx.db,
    budgetCheck,
    { workspaceId, jobId },
    ctx.actor,
    ctx.meta,
  );
  if (!out) {
    await clearAddonAlert(ctx, keyOf(jobId), 'gone');
    return;
  }
  if (out.clear) {
    await clearAddonAlert(ctx, keyOf(jobId), 'done');
    return;
  }
  if (!out.alert) return;
  await raiseAddonAlert(ctx, {
    key: keyOf(jobId),
    severity: out.level === 'over' ? 'attention' : 'at_risk',
    title: out.alert.title,
    detail: out.alert.detail,
    href: `/a/contractor/jobs/${jobId}`,
    // Only people who may see job costs: its detail names amounts (the owner's decision 11).
    permission: 'contractor.costs',
    customRecordId: jobId,
  });
  if (!out.ask) return;
  try {
    const { value } = await askStructured(ctx, ctx.scope, {
      system: BUDGET_ADVICE_SYSTEM,
      messages: [{ role: 'user', content: out.ask }],
      schema: BUDGET_ADVICE_SCHEMA,
      zod: BudgetAdviceAnswer,
      maxTokens: 800,
      usage: usageOf(ctx),
    });
    const advice = checkedBudgetAdvice(value);
    if (advice)
      await executeCommand(
        ctx.db,
        budgetAdvise,
        { workspaceId, jobId, why: advice.why, suggestions: [...advice.suggestions] },
        ctx.actor,
        ctx.meta,
      );
  } catch (e) {
    // The people were told already. The AI's sentence is a nicety: without it the card shows the numbers alone.
    if (!(e instanceof AiAskError)) throw e;
    ctx.log.info({ code: e.code, jobId }, 'a budget warning went without the AI’s advice');
  }
}
