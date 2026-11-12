/**
 * The AI's estimate drafts as rows (docs/contractor.md, "The AI helpers"): reading one for the builder, and marking
 * it used when a person saves an estimate from it. Kept apart from ./drafts.ts so ./estimates.ts can read a draft
 * without the two files importing each other. Server-only.
 */
import { and, desc, eq } from 'drizzle-orm';
import { users } from '@hfos/db/schema';
import { userIdOf } from '../../../kernel/actor';
import type { CommandContext } from '../../../kernel/types';
import { guessedLines } from '../estimate-draft';
import type { EstimateDraft } from '../schemas';
import { estimateDrafts } from '../tables';
import type { Ctx } from './common';

type DraftRow = typeof estimateDrafts.$inferSelect & { readonly askedByName: string | null };

const picked = {
  id: estimateDrafts.id,
  workspaceId: estimateDrafts.workspaceId,
  recordId: estimateDrafts.recordId,
  askedBy: estimateDrafts.askedBy,
  brief: estimateDrafts.brief,
  draft: estimateDrafts.draft,
  notesRead: estimateDrafts.notesRead,
  photosRead: estimateDrafts.photosRead,
  state: estimateDrafts.state,
  estimateId: estimateDrafts.estimateId,
  settledBy: estimateDrafts.settledBy,
  settledAt: estimateDrafts.settledAt,
  createdAt: estimateDrafts.createdAt,
  updatedAt: estimateDrafts.updatedAt,
  askedByName: users.fullName,
};

/** A draft as the screens read it: what it's for, how big it is, and every line. */
export const draftOut = (d: DraftRow): EstimateDraft => ({
  id: d.id,
  jobId: d.recordId,
  state: d.state,
  title: d.draft.title ?? null,
  brief: d.brief,
  askedBy: d.askedByName?.trim() || null,
  createdAt: d.createdAt.toISOString(),
  notesRead: d.notesRead,
  photosRead: d.photosRead,
  optionCount: d.draft.options.length,
  lines: d.draft.options.reduce((n, o) => n + o.lines.length, 0),
  guessed: guessedLines(d.draft),
  questions: d.draft.questions.length,
  estimateId: d.estimateId,
  draft: {
    title: d.draft.title ?? null,
    options: d.draft.options.map((o) => ({ name: o.name, lines: o.lines.map((l) => ({ ...l })) })),
    assumptions: [...d.draft.assumptions],
    questions: [...d.draft.questions],
  },
});

/** One draft of this business, by its id or by the estimate saved from it; null when there's none. */
export async function draftBy(
  ctx: Ctx,
  by: { readonly draftId: string } | { readonly estimateId: string },
): Promise<DraftRow | null> {
  const [d] = await ctx.tx
    .select(picked)
    .from(estimateDrafts)
    .leftJoin(users, eq(users.id, estimateDrafts.askedBy))
    .where(
      and(
        eq(estimateDrafts.workspaceId, ctx.scope.workspaceId!),
        'draftId' in by
          ? eq(estimateDrafts.id, by.draftId)
          : eq(estimateDrafts.estimateId, by.estimateId),
      ),
    )
    .orderBy(desc(estimateDrafts.createdAt))
    .limit(1);
  return d ?? null;
}

/** A job's drafts still waiting for someone, the newest first. */
export async function waitingDrafts(ctx: Ctx, jobId: string): Promise<DraftRow[]> {
  return ctx.tx
    .select(picked)
    .from(estimateDrafts)
    .leftJoin(users, eq(users.id, estimateDrafts.askedBy))
    .where(
      and(
        eq(estimateDrafts.workspaceId, ctx.scope.workspaceId!),
        eq(estimateDrafts.recordId, jobId),
        eq(estimateDrafts.state, 'ready'),
      ),
    )
    .orderBy(desc(estimateDrafts.createdAt), desc(estimateDrafts.id));
}

/**
 * A person saved an estimate from a draft: the draft is used, and points at the estimate. A draft that was already
 * used or set aside, or belongs to another job, is left as it is (the estimate is theirs either way). Answers
 * whether it was marked.
 */
export async function markDraftUsed(
  ctx: CommandContext,
  draftId: string,
  estimateId: string,
  jobId: string | null,
): Promise<boolean> {
  const marked = await ctx.tx
    .update(estimateDrafts)
    .set({
      state: 'used',
      estimateId,
      settledBy: userIdOf(ctx.actor),
      settledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(estimateDrafts.id, draftId),
        eq(estimateDrafts.workspaceId, ctx.scope.workspaceId!),
        eq(estimateDrafts.state, 'ready'),
        ...(jobId ? [eq(estimateDrafts.recordId, jobId)] : []),
      ),
    )
    .returning({ id: estimateDrafts.id });
  return marked.length > 0;
}
