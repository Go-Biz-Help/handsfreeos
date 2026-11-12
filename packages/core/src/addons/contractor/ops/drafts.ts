/**
 * Estimates the AI drafts (docs/contractor.md, "The AI helpers"; the owner's decision 6: "An estimate the AI drafts
 * always waits for a person"). The worker asks the AI (apps/worker/src/addons/contractor/drafts.ts) and keeps what
 * comes back here as a **draft beside the job**. That's all the AI can do: a draft is never an estimate. A person
 * who may see job costs opens it in the builder, checks each line and saves, and only then is there an estimate,
 * written by that person through core's own commands like any other (./estimates.ts), and held to the lowest margin
 * like any other.
 *
 * - **What the AI reads** (`contractor.estimate_draft.source`, the worker's): the job, its property, the crew's
 *   notes with their words, the newest photos on them and on the checklists, the price list with what each item
 *   costs, and how the business prices labor.
 * - **Kept** (`contractor.estimate_draft.keep`, the worker's): a job keeps a few waiting drafts; a new one past
 *   that sets the oldest aside.
 * - **Set aside** by a person who doesn't want one. Nothing is deleted: it just stops being offered.
 *
 * A draft holds costs, so its table is read only with `contractor.costs` (the owner's decision 11), and its events
 * and timeline lines carry no amount.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { fmtAt } from '../../../calendar/when';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { DRAFT_LIMITS, guessedLines } from '../estimate-draft';
import { contractorAddon } from '../manifest';
import {
  EstimateDraftDismissInput,
  EstimateDraftDismissOutput,
  EstimateDraftKeepInput,
  EstimateDraftKeepOutput,
  EstimateDraftListInput,
  EstimateDraftListOutput,
  EstimateDraftSourceInput,
  EstimateDraftSourceOutput,
} from '../schemas';
import { estimateDrafts } from '../tables';
import { TRADE_NAMES } from '../trades';
import { CONTRACTOR_WORDS as W, JOB_KIND_WORDS, REFUSALS } from '../words';
import { inWorkspace, jobLine, loadJob, pairsOf, timeZoneOf } from './common';
import { draftBy, draftOut, waitingDrafts } from './draft-rows';
import { estimatingOf, itemCostRows } from './estimates';

const jobPath = (jobId: string) => `a/contractor/jobs/${jobId}`;
/** Where a waiting draft opens: the builder, new, for its job, starting from it. */
export const draftPath = (jobId: string, draftId: string) =>
  `a/contractor/estimates/new?jobId=${jobId}&draftId=${draftId}`;

// ------------------------------------------------------------------------------------------------ the worker's

export const estimateDraftSource = defineAddonQuery(contractorAddon, {
  name: 'contractor.estimate_draft.source',
  description:
    'Worker: what the AI reads to draft an estimate for a job: the job and its property, the crew’s notes, the newest photos, the price list with costs, and how the business prices labor.',
  input: EstimateDraftSourceInput,
  output: EstimateDraftSourceOutput,
  permission: 'contractor.costs',
  actors: ['system'],
  scope: inWorkspace,
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId);
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const ws = ctx.scope.workspaceId!;
    const [zone, pairs, items, estimating] = await Promise.all([
      timeZoneOf(ctx),
      pairsOf(ctx, job.recordId),
      itemCostRows(ctx, DRAFT_LIMITS.items),
      estimatingOf(ctx),
    ]);
    const [site] = pairs.site
      ? await rows<{ name: string }>(
          ctx.tx,
          sql`select name from app.custom_records where id = ${pairs.site.propertyId} and workspace_id = ${ws}`,
        )
      : [];
    const noted = await rows<{
      body: string | null;
      transcript: string | null;
      noted_at: Date;
      photo_file_ids: string[];
      by: string | null;
    }>(
      ctx.tx,
      sql`select n.body, n.transcript, n.noted_at, n.photo_file_ids,
            coalesce(nullif(btrim(u.full_name), ''), u.email::text) as by
          from addon_contractor.notes n
          left join app.users u on u.id = n.created_by
          where n.record_id = ${job.recordId} and n.workspace_id = ${ws}
          order by n.noted_at desc, n.id desc
          limit ${DRAFT_LIMITS.notes * 2}`,
    );
    // The checklists' photos too (a "before" photo is often the best look at the work), after the notes' own.
    const ticked = await rows<{ file_id: string }>(
      ctx.tx,
      sql`select i.file_id from addon_contractor.work_order_items i
          where i.record_id = ${job.recordId} and i.workspace_id = ${ws} and i.file_id is not null
          order by i.done_at desc nulls last, i.id
          limit ${DRAFT_LIMITS.photos * 2}`,
    );
    const photoFileIds = [
      ...new Set([
        ...noted.flatMap((n) => n.photo_file_ids ?? []),
        ...ticked.map((t) => t.file_id),
      ]),
    ].slice(0, DRAFT_LIMITS.photos * 3);
    return {
      job: {
        name: job.name,
        kind: JOB_KIND_WORDS[job.kind],
        trade: job.trade ? TRADE_NAMES[job.trade] : null,
        details: job.details,
        property: site?.name ?? null,
      },
      brief: input.brief?.trim() || null,
      notes: noted
        .map((n) => ({
          by: n.by,
          when: fmtAt(new Date(n.noted_at).getTime(), zone),
          text: (n.body ?? n.transcript ?? '').trim(),
          photos: (n.photo_file_ids ?? []).length,
        }))
        .filter((n) => n.text || n.photos)
        .slice(0, DRAFT_LIMITS.notes),
      photoFileIds,
      items: items.map((it) => ({
        productId: it.productId,
        name: it.name,
        description: it.description,
        unitLabel: it.unitLabel,
        unitPriceCents: it.unitPriceCents,
        taxable: it.taxable,
        kind: it.kind,
        costCents: it.costCents,
      })),
      estimating: {
        markupBp: estimating.markupBp,
        laborRateCents: estimating.laborRateCents,
        laborCostCents: estimating.laborCostCents,
      },
      options: input.options,
    };
  },
});

export const estimateDraftKeep = defineAddonCommand(contractorAddon, {
  name: 'contractor.estimate_draft.keep',
  description:
    'Worker: the AI’s draft of an estimate for a job, checked, kept beside the job until a person opens it in the builder and saves it.',
  risk: 0,
  input: EstimateDraftKeepInput,
  output: EstimateDraftKeepOutput,
  permission: 'contractor.costs',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['contractor.estimate_draft.ready'],
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const ws = ctx.scope.workspaceId!;
    const [made] = await ctx.tx
      .insert(estimateDrafts)
      .values({
        workspaceId: ws,
        recordId: job.recordId,
        // Who pressed Draft: the worker keeps it on their behalf.
        askedBy: userIdOf(ctx.actor),
        brief: input.brief?.trim() || null,
        draft: input.draft,
        notesRead: input.notesRead,
        photosRead: input.photosRead,
      })
      .returning({ id: estimateDrafts.id });
    // A job keeps a few waiting drafts: past that, the oldest are set aside.
    const waiting = await ctx.tx
      .select({ id: estimateDrafts.id })
      .from(estimateDrafts)
      .where(
        and(
          eq(estimateDrafts.workspaceId, ws),
          eq(estimateDrafts.recordId, job.recordId),
          eq(estimateDrafts.state, 'ready'),
        ),
      )
      .orderBy(asc(estimateDrafts.createdAt), asc(estimateDrafts.id));
    const extra = waiting.slice(0, Math.max(0, waiting.length - DRAFT_LIMITS.waiting));
    if (extra.length)
      await ctx.tx
        .update(estimateDrafts)
        .set({ state: 'dismissed', settledAt: new Date(), updatedAt: new Date() })
        .where(
          inArray(
            estimateDrafts.id,
            extra.map((d) => d.id),
          ),
        );
    const lines = input.draft.options.reduce((n, o) => n + o.lines.length, 0);
    const eventId = await ctx.emit({
      type: 'contractor.estimate_draft.ready',
      entityType: 'custom_record',
      entityId: job.recordId,
      // No amounts and no costs: an event is read by more people than may see them.
      payload: {
        draftId: made!.id,
        jobId: job.recordId,
        options: input.draft.options.length,
        lines,
      },
    });
    await jobLine(
      ctx,
      job.recordId,
      'had the AI draft an estimate for this job. It waits for someone to check it and save it',
      { eventId },
    );
    return {
      draftId: made!.id,
      jobId: job.recordId,
      optionCount: input.draft.options.length,
      lines,
      guessed: guessedLines(input.draft),
      questions: input.draft.questions.length,
    };
  },
});

// ------------------------------------------------------------------------------------------------ people's

export const estimateDraftList = defineAddonQuery(contractorAddon, {
  name: 'contractor.estimate_draft.list',
  description:
    'The estimates the AI drafted for a job that are still waiting for someone to open, check and save, the newest first. For people who may see job costs.',
  input: EstimateDraftListInput,
  output: EstimateDraftListOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_list_estimate_drafts',
    description:
      'The AI’s estimate drafts waiting on a job (by job id), the newest first: each with its draft id, title, who asked, when, how many notes and photos it was drawn from, its options and lines, how many lines carry a guessed cost, and how many questions the AI left. A draft isn’t an estimate: someone opens it in the estimate builder, checks it and saves it.',
    keywords: ['ai estimate', 'estimate draft', 'drafted estimate'],
  },
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId);
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const found = await waitingDrafts(ctx, job.recordId);
    return {
      jobId: job.recordId,
      drafts: found.map((d) => {
        const { draft: _lines, ...summary } = draftOut(d);
        return summary;
      }),
    };
  },
});

export const estimateDraftDismiss = defineAddonCommand(contractorAddon, {
  name: 'contractor.estimate_draft.dismiss',
  description:
    'Set one of the AI’s estimate drafts aside, so it stops being offered on its job. Nothing else changes: no estimate was made from it.',
  risk: 1,
  input: EstimateDraftDismissInput,
  output: EstimateDraftDismissOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_dismiss_estimate_draft',
    description:
      'Set one of the AI’s estimate drafts aside (by draft id, from contractor_list_estimate_drafts), so it’s no longer offered on its job. It touches no estimate.',
    keywords: ['dismiss draft', 'discard draft'],
    outcome: (output) => ({
      words: W.aiDraft.dismissed,
      path: jobPath(String((output as { jobId?: unknown }).jobId ?? '')),
    }),
  },
  emits: ['contractor.estimate_draft.dismissed'],
  async handler(ctx, input) {
    const d = await draftBy(ctx, { draftId: input.draftId });
    if (!d) throw HfosError.notFound(REFUSALS.draftGone);
    if (d.state !== 'ready') return { draftId: d.id, jobId: d.recordId, changed: false };
    await ctx.tx
      .update(estimateDrafts)
      .set({
        state: 'dismissed',
        settledBy: userIdOf(ctx.actor),
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(estimateDrafts.id, d.id), eq(estimateDrafts.workspaceId, d.workspaceId)));
    await ctx.emit({
      type: 'contractor.estimate_draft.dismissed',
      entityType: 'custom_record',
      entityId: d.recordId,
      payload: { draftId: d.id, jobId: d.recordId },
    });
    return { draftId: d.id, jobId: d.recordId, changed: true };
  },
});
