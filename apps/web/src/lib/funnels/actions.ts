'use client';
/**
 * Teammate funnels (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md): every call the Funnels screens make.
 */
import type { FunnelDefinition, FunnelDraft } from '@hfos/core';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import type { Ok } from '@/lib/api/types';

export type FunnelList = Ok<'/v1/queries/funnel.list'>;
export type FunnelSummaryOut = FunnelList['funnels'][number];
export type FunnelGetOut = Ok<'/v1/queries/funnel.get'>;
export type FunnelIssueOut = FunnelGetOut['issues'][number];
export type FunnelPeopleOut = Ok<'/v1/queries/funnel.people'>;
export type FunnelPersonOut = FunnelPeopleOut['people'][number];
export type FunnelSuggestionsOut = Ok<'/v1/queries/funnel.suggestions'>;
export type PipelineList = Ok<'/v1/queries/pipeline.list'>;
export type PipelineOut = PipelineList['pipelines'][number];

export interface NewFunnelInput {
  readonly name: string;
  readonly pipelineId?: string;
  readonly newPipeline?: {
    readonly name: string;
    readonly stages: readonly { readonly name: string; readonly kind: 'open' | 'won' | 'lost' }[];
  };
  readonly description?: string;
  /** The AI's draft, its stages named as the pipeline's. */
  readonly draft?: FunnelDraft;
}

export function funnelActions(workspaceId: string) {
  const api = () => apiBrowser();
  return {
    create: async (input: NewFunnelInput) =>
      unwrap(
        await api().POST('/v1/commands/funnel.create', {
          body: {
            workspaceId,
            name: input.name,
            ...(input.pipelineId ? { pipelineId: input.pipelineId } : {}),
            ...(input.newPipeline
              ? {
                  newPipeline: {
                    name: input.newPipeline.name,
                    stages: [...input.newPipeline.stages],
                  },
                }
              : {}),
            ...(input.description ? { description: input.description } : {}),
            ...(input.draft ? { draft: input.draft } : {}),
          },
        }),
      ),
    /** "Describe it, AI drafts": the worker asks the model; nothing is saved until `create`. */
    draft: (description: string, pipelineId?: string) =>
      workerPost<{ draft: FunnelDraft }>('/v1/funnels/draft', {
        workspaceId,
        description,
        ...(pipelineId ? { pipelineId } : {}),
      }),
    get: async (funnelId: string): Promise<FunnelGetOut> =>
      unwrap(await api().POST('/v1/queries/funnel.get', { body: { workspaceId, funnelId } })),
    save: async (input: {
      funnelId: string;
      revision: number;
      name: string;
      definition: FunnelDefinition;
      moveFrom?: Record<string, string>;
    }) =>
      unwrap(
        await api().POST('/v1/commands/funnel.save', {
          body: {
            workspaceId,
            funnelId: input.funnelId,
            revision: input.revision,
            name: input.name,
            definition: input.definition,
            ...(input.moveFrom && Object.keys(input.moveFrom).length
              ? { moveFrom: input.moveFrom }
              : {}),
          },
        }),
      ),
    turnOn: async (funnelId: string, addExisting: boolean) =>
      unwrap(
        await api().POST('/v1/commands/funnel.turn_on', {
          body: { workspaceId, funnelId, addExisting },
        }),
      ),
    pause: async (funnelId: string) =>
      unwrap(await api().POST('/v1/commands/funnel.pause', { body: { workspaceId, funnelId } })),
    archive: async (funnelId: string) =>
      unwrap(await api().POST('/v1/commands/funnel.archive', { body: { workspaceId, funnelId } })),
    decideSuggestion: async (funnelPersonId: string, accept: boolean) =>
      unwrap(
        await api().POST('/v1/commands/funnel.decide_suggestion', {
          body: { workspaceId, funnelPersonId, accept },
        }),
      ),
    people: async (funnelId: string, stageId?: string): Promise<FunnelPeopleOut> =>
      unwrap(
        await api().POST('/v1/queries/funnel.people', {
          body: { workspaceId, funnelId, ...(stageId ? { stageId } : {}) },
        }),
      ),
  };
}
