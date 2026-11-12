/**
 * An estimate drafted by the AI (docs/contractor.md, "The AI helpers"; the owner's decision 6: "An estimate the AI
 * drafts always waits for a person"). Someone who may see job costs presses Draft with AI on a job; this reads what
 * the job has, asks the model for lines, checks them against the business's own price list
 * (`checkedEstimateDraft`), and keeps the result as a draft beside the job.
 *
 * It never writes an estimate. A draft becomes one only when a person opens it in the builder, checks it and saves
 * it, as that person, through the same commands as any estimate, and held to the lowest margin like any other.
 */
import {
  checkedEstimateDraft,
  draftHasEnough,
  DRAFT_LIMITS,
  ESTIMATE_DRAFT_SCHEMA,
  ESTIMATE_DRAFT_SYSTEM,
  estimateDraftAsk,
  EstimateDraftAnswer,
  type DraftSource,
} from '@hfos/core/addons/contractor/estimate-draft';
import {
  draftPath,
  estimateDraftKeep,
  estimateDraftSource,
} from '@hfos/core/addons/contractor/ops/drafts';
import { REFUSALS } from '@hfos/core/addons/contractor/words';
import { executeCommand, executeQuery, HfosError } from '@hfos/core/server';
import { z } from 'zod';
import { AiAskError, askStructured } from '../../ai/ask';
import type { AddonWorkerAction } from '../types';
import { aiRefusal, photosForAi, usageOf } from './ai';

export const DRAFT_ACTION = 'contractor.estimate.draft';

const DraftInput = z.strictObject({
  jobId: z.uuid(),
  /** The work wanted, and measurements. */
  brief: z.string().trim().max(DRAFT_LIMITS.brief).optional(),
  /** One price, or good, better and best. */
  options: z.union([z.literal(1), z.literal(3)]).default(1),
});

/** Draft with AI, from a job's Estimates card. */
export const draftEstimate: AddonWorkerAction<z.output<typeof DraftInput>> = {
  permission: 'contractor.costs',
  ai: {
    tool: 'contractor_draft_estimate',
    description:
      'Have the AI draft an estimate for a job (jobId) from the job’s details, its crew’s notes and newest photos, and brief: what the person says the work is, with any measurements. options 3 drafts Good, Better and Best; otherwise one price. Lines come from the business’s price list at its own prices and costs, labor at its hourly price, and anything else at a guessed cost that’s marked as a guess. It makes a DRAFT kept beside the job, never an estimate: tell the person to open it (path), check every line and save it themselves. Answers the draft’s id, how many lines and guessed costs it has, what the AI assumed, and its questions for the person. For people who may see job costs.',
    autonomy: 'auto',
    keywords: ['draft estimate', 'ai estimate', 'quote from notes', 'estimate from photos'],
    whole: true,
  },
  input: DraftInput,
  async run(ctx, input) {
    const workspaceId = ctx.scope.workspaceId;
    // The worker does this for the person who pressed it: the draft says who asked.
    const actor = { ...ctx.actor, onBehalfOf: ctx.userId };
    const found = await executeQuery(
      ctx.db,
      estimateDraftSource,
      { workspaceId, jobId: input.jobId, brief: input.brief ?? null, options: input.options },
      actor,
      ctx.meta,
    );
    const photos = await photosForAi(ctx, found.photoFileIds, DRAFT_LIMITS.photos);
    const source: DraftSource = { ...found, photos: photos.length };
    if (!draftHasEnough(source))
      throw HfosError.rule('contractor_draft_nothing', 409, REFUSALS.draftNothing);
    let answer: EstimateDraftAnswer;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: ESTIMATE_DRAFT_SYSTEM,
        messages: [
          { role: 'user', content: [...photos, { type: 'text', text: estimateDraftAsk(source) }] },
        ],
        schema: ESTIMATE_DRAFT_SCHEMA,
        zod: EstimateDraftAnswer,
        maxTokens: 8000,
        usage: usageOf(ctx),
      });
      answer = value;
    } catch (e) {
      throw e instanceof AiAskError ? aiRefusal(e, 'The AI couldn’t draft that just now.') : e;
    }
    const draft = checkedEstimateDraft(answer, source);
    if (!draft) throw HfosError.rule('contractor_draft_no_lines', 409, REFUSALS.draftNoLines);
    const { output } = await executeCommand(
      ctx.db,
      estimateDraftKeep,
      {
        workspaceId,
        jobId: input.jobId,
        brief: input.brief ?? null,
        draft: {
          title: draft.title,
          options: draft.options.map((o) => ({
            name: o.name,
            lines: o.lines.map((l) => ({ ...l })),
          })),
          assumptions: [...draft.assumptions],
          questions: [...draft.questions],
        },
        notesRead: source.notes.length,
        photosRead: photos.length,
      },
      actor,
      ctx.meta,
    );
    return {
      ...output,
      /** Where it opens: the builder, starting from the draft. */
      path: draftPath(output.jobId, output.draftId),
      assumptions: draft.assumptions,
      questions: draft.questions,
    };
  },
};
