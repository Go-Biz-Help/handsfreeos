/**
 * Watching a job's budget (docs/contractor.md, "The AI helpers"): the worker looks at a job whenever something that
 * costs money changes on it (time, materials, other costs, its budget, how far along it is), and tells the people
 * who may see job costs when it starts heading over, with the profit it's now heading for. The rule is in
 * ../budget-watch.ts and the numbers in ../job-costing.ts, the one copy of each.
 *
 * - **`contractor.budget.check`** (the worker's) works out where the job stands, remembers it, and answers the
 *   alert's words when it got worse. It emits nothing and writes no timeline line: where a job's money stands is
 *   for people who may see job costs only (the owner's decision 11), and the alert is how they're told.
 * - **`contractor.budget.advise`** (the worker's) keeps what the AI said is driving it and what the business could
 *   do. Suggestions only: nothing here changes a price, a budget or a job (the owner's rule).
 *
 * `budget_watch` is read only with `contractor.costs`.
 */
import { and, desc, eq } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { defineAddonCommand } from '../../server';
import { budgetAdviceAsk, budgetAlertWords, watchBudget, watchIsNews } from '../budget-watch';
import { contractorAddon } from '../manifest';
import {
  BudgetAdviseInput,
  BudgetAdviseOutput,
  BudgetCheckInput,
  BudgetCheckOutput,
} from '../schemas';
import { budgetWatch, otherCosts } from '../tables';
import { TRADE_NAMES } from '../trades';
import { inWorkspace, loadJob, settingsOf, type Job } from './common';
import { jobCostingOf } from './costing';
import { estimatingOf } from './estimates';

export const budgetCheck = defineAddonCommand(contractorAddon, {
  name: 'contractor.budget.check',
  description:
    'Worker: looks at where a job’s budget stands (within plan, heading over, heading under the lowest margin, or heading for a loss) and answers whether the people who may see job costs should be told.',
  risk: 0,
  input: BudgetCheckInput,
  output: BudgetCheckOutput,
  permission: 'contractor.costs',
  actors: ['system'],
  scope: inWorkspace,
  // Where a job's money stands stays off events (the owner's decision 11): the alert is the telling.
  emits: [],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    let job: Job;
    try {
      job = await loadJob(ctx, input.jobId, { lock: true });
    } catch (e) {
      // Deleted for good meanwhile: nothing to watch.
      if (e instanceof HfosError && e.status === 404) return null;
      throw e;
    }
    const [[before], settings, estimating, costing] = await Promise.all([
      ctx.tx
        .select()
        .from(budgetWatch)
        .where(and(eq(budgetWatch.recordId, job.recordId), eq(budgetWatch.workspaceId, ws)))
        .for('update'),
      settingsOf(ctx),
      estimatingOf(ctx),
      jobCostingOf(ctx, job.recordId),
    ]);
    if (!costing) return null;
    // An archived job, or warnings turned off: nothing is told, and any alert goes.
    const watched = !job.archived && settings.budgetWarnings;
    const watch = watched
      ? watchBudget(costing, estimating.minMarginBp)
      : ({ level: 'ok', overPercent: null, band: 0 } as const);
    const news = watchIsNews(watch, before ?? null);
    const now = new Date();
    if (before || watch.level !== 'ok') {
      const off = watch.level !== 'ok';
      const keep = {
        level: watch.level,
        band: watch.band,
        checkedAt: now,
        updatedAt: now,
        // What the AI said was about how things stood then: gone when it's back on plan, and asked again on news.
        ...(off && !news ? {} : { why: null, suggestions: [], advisedAt: null }),
        ...(news ? { warnedAt: now } : {}),
      };
      await ctx.tx
        .insert(budgetWatch)
        .values({ recordId: job.recordId, workspaceId: ws, ...keep })
        .onConflictDoUpdate({ target: budgetWatch.recordId, set: keep });
    }
    if (!news)
      return {
        jobId: job.recordId,
        level: watch.level,
        alert: null,
        clear: watch.level === 'ok',
        ask: null,
      };
    const others = await ctx.tx
      .select({ name: otherCosts.name, amountCents: otherCosts.amountCents })
      .from(otherCosts)
      .where(and(eq(otherCosts.recordId, job.recordId), eq(otherCosts.workspaceId, ws)))
      .orderBy(desc(otherCosts.amountCents))
      .limit(12);
    return {
      jobId: job.recordId,
      level: watch.level,
      alert: budgetAlertWords({
        job: job.name,
        costing,
        watch,
        percentDone: job.percentDone,
        minMarginBp: estimating.minMarginBp,
      }),
      clear: false,
      ask: budgetAdviceAsk({
        job: job.name,
        trade: job.trade ? TRADE_NAMES[job.trade] : null,
        percentDone: job.percentDone,
        costing,
        minMarginBp: estimating.minMarginBp,
        otherCosts: others.map((o) => ({ name: o.name, amountCents: Number(o.amountCents) })),
      }),
    };
  },
});

export const budgetAdvise = defineAddonCommand(contractorAddon, {
  name: 'contractor.budget.advise',
  description:
    'Worker: what the AI said is driving a job over its budget, and what the business could do about it, kept for the people who may see job costs. Suggestions only.',
  risk: 0,
  input: BudgetAdviseInput,
  output: BudgetAdviseOutput,
  permission: 'contractor.costs',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const kept = await ctx.tx
      .update(budgetWatch)
      .set({
        why: input.why,
        suggestions: [...input.suggestions],
        advisedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(budgetWatch.recordId, input.jobId),
          eq(budgetWatch.workspaceId, ctx.scope.workspaceId!),
        ),
      )
      .returning({ level: budgetWatch.level });
    // Back on plan by the time the AI answered: its words are about nothing now.
    if (kept[0]?.level === 'ok') {
      await ctx.tx
        .update(budgetWatch)
        .set({ why: null, suggestions: [], advisedAt: null })
        .where(eq(budgetWatch.recordId, input.jobId));
      return { jobId: input.jobId, kept: false };
    }
    return { jobId: input.jobId, kept: kept.length > 0 };
  },
});
