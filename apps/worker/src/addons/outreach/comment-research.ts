/**
 * The comment research summed up (docs/outreach.md, decision 166): a research started queues its end, when its days
 * are over; one that's full, or stopped with enough kept, is summed up now (`outreach.comment_research.changed`).
 * The job counts how the kept comments are written in code, asks the AI for the patterns and real examples by kind of
 * post, checks every example is a comment really kept, and saves what it found (`outreach.comment_research.sum`).
 * With too few comments to learn from, the research is only stopped; with no answer from the AI, the counts alone are
 * kept. Core holds what the model is asked and what may come of it
 * (packages/core/src/addons/outreach/comment-research.ts).
 */
import {
  checkedFindings,
  COMMENT_RESEARCH_SCHEMA,
  COMMENT_RESEARCH_SYSTEM,
  CommentResearchAnswer,
  commentResearchPrompt,
  commentStats,
  isCopied,
  RESEARCH_MIN_TO_SUM,
  researchEnds,
  type CommentFindings,
  type CommentSample,
  type ResearchState,
} from '@hfos/core/addons/outreach/comment-research';
import { commentResearchSum } from '@hfos/core/addons/outreach/ops/comment-research';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext } from '../types';

export const SUM_COMMENT_RESEARCH_JOB = 'outreach.sum_comment_research';
const HOUR = 3_600_000;

/**
 * `outreach.comment_research.changed`: one that started reading is summed up when its days end; one that's read is
 * summed up now.
 */
export async function commentResearchChanged(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { id?: string; state?: ResearchState };
  if (!p.id || (p.state !== 'reading' && p.state !== 'summing')) return;
  const id = p.id;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [run] = await rows<{ started_at: Date | string; days: number; state: ResearchState }>(
      tx,
      sql`select started_at, days, state from addon_outreach.comment_research
          where workspace_id = ${ctx.scope.workspaceId} and id = ${id}`,
    );
    if (!run || (run.state !== 'reading' && run.state !== 'summing')) return;
    const runAt =
      run.state === 'summing'
        ? new Date()
        : researchEnds({ days: run.days, startedAt: new Date(run.started_at) });
    await scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: SUM_COMMENT_RESEARCH_JOB,
        dedupeKey: `${SUM_COMMENT_RESEARCH_JOB}:${id}`,
        runAt,
        payload: { researchId: id },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    );
  });
}

/** `outreach.sum_comment_research`: what the research's comments show, kept with the guide made from it. */
export async function sumCommentResearchJob(ctx: AddonJobContext): Promise<JobResult> {
  const id = (ctx.job.payload as { researchId?: string } | null)?.researchId;
  if (!id) return;
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => ({
    run: (
      await rows<{ started_at: Date | string; days: number; state: ResearchState }>(
        tx,
        sql`select started_at, days, state from addon_outreach.comment_research
            where workspace_id = ${ctx.scope.workspaceId} and id = ${id}`,
      )
    )[0],
    samples: await rows<{ words: string; topic: string; seen: number }>(
      tx,
      sql`select words, topic, seen from addon_outreach.comment_samples
          where workspace_id = ${ctx.scope.workspaceId} and research_id = ${id}
          order by seen desc, id limit 6000`,
    ),
  }));
  const run = found.run;
  if (!run || (run.state !== 'reading' && run.state !== 'summing')) return;
  // Still reading with days left: it's summed up when they end.
  const ends = researchEnds({ days: run.days, startedAt: new Date(run.started_at) });
  if (run.state === 'reading' && ctx.now < ends.getTime()) return { rescheduleAt: ends };

  const samples: readonly CommentSample[] = found.samples;
  const learned = samples.filter((s) => !isCopied(s)).reduce((n, s) => n + s.seen, 0);
  let findings: CommentFindings | null = null;
  if (learned >= RESEARCH_MIN_TO_SUM) {
    const stats = commentStats(samples);
    let answer: CommentResearchAnswer | null = null;
    try {
      answer = (
        await askStructured(ctx, ctx.scope, {
          system: COMMENT_RESEARCH_SYSTEM,
          messages: [{ role: 'user', content: commentResearchPrompt(stats, samples) }],
          schema: COMMENT_RESEARCH_SCHEMA,
          zod: CommentResearchAnswer,
          maxTokens: 2_400,
          usage: { source: 'addon', addonId: ctx.manifest.id },
        })
      ).value;
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      // The day's limit or an empty balance: it waits a few hours. A passing fault is tried again.
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        return { rescheduleAt: new Date(ctx.now + 6 * HOUR) };
      if (e.retryable) {
        if (ctx.attempt < 3) throw e;
        return { rescheduleAt: new Date(ctx.now + HOUR) };
      }
      // Not set up, or an answer it can't use: the counts alone are kept.
      answer = null;
    }
    findings = checkedFindings(stats, answer, samples);
  }
  await executeCommand(
    ctx.db,
    commentResearchSum,
    { workspaceId: ctx.scope.workspaceId, id, findings },
    ctx.actor,
    ctx.meta,
  );
}
