import { z } from 'zod';
import { isoDateTime, uuid } from './common';

export const stageKind = z.enum(['open', 'won', 'lost']);
const stageName = z.string().trim().min(1, 'Enter a stage name.').max(60);
const pipelineName = z.string().trim().min(1, 'Enter a pipeline name.').max(80);

export const StageOut = z.object({
  id: uuid,
  name: z.string(),
  kind: stageKind,
  position: z.number().int(),
  leadCount: z.number().int(),
});
export const PipelineOut = z.object({
  id: uuid,
  name: z.string(),
  position: z.number().int(),
  isDefault: z.boolean(),
  archivedAt: isoDateTime.nullable(),
  stages: z.array(StageOut),
});
export type PipelineOut = z.infer<typeof PipelineOut>;

export const PipelineCreateInput = z.object({
  workspaceId: uuid,
  name: pipelineName,
  /** Optional stage template; the default is New, Contacted, Estimate sent, Won, Lost. */
  stages: z
    .array(z.object({ name: stageName, kind: stageKind }))
    .min(3)
    .max(20)
    .optional(),
});
export const PipelineCreateOutput = z.object({ pipelineId: uuid });
export const PipelineUpdateInput = z.object({
  workspaceId: uuid,
  pipelineId: uuid,
  name: pipelineName.optional(),
  position: z.number().int().min(0).optional(),
});
export const PipelineUpdateOutput = z.object({ pipelineId: uuid, updated: z.array(z.string()) });
export const PipelineArchiveInput = z.object({ workspaceId: uuid, pipelineId: uuid });
export const PipelineArchiveOutput = z.object({ pipelineId: uuid });

export const StageCreateInput = z.object({
  workspaceId: uuid,
  pipelineId: uuid,
  name: stageName,
  kind: stageKind.default('open'),
  afterStageId: uuid.nullable().optional(),
});
export const StageCreateOutput = z.object({ stageId: uuid });
export const StageUpdateInput = z.object({
  workspaceId: uuid,
  stageId: uuid,
  name: stageName.optional(),
  kind: stageKind.optional(),
});
export const StageUpdateOutput = z.object({ stageId: uuid, updated: z.array(z.string()) });
export const StageReorderInput = z.object({
  workspaceId: uuid,
  pipelineId: uuid,
  stageIds: z.array(uuid).min(3).max(20),
});
export const StageReorderOutput = z.object({ pipelineId: uuid, order: z.array(uuid) });
export const StageDeleteInput = z.object({
  workspaceId: uuid,
  stageId: uuid,
  moveLeadsToStageId: uuid.nullable().optional(),
});
export const StageDeleteOutput = z.object({ stageId: uuid, movedLeads: z.number().int() });

export const PipelineListInput = z.object({
  workspaceId: uuid,
  includeArchived: z.boolean().default(false),
});
export const PipelineListOutput = z.object({ pipelines: z.array(PipelineOut) });
