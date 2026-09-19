import { z } from 'zod';
import { uuid } from './common';

/** The three ways a stranger reaches a business by themselves (M14 slice A). */
export const IntakeChannelKind = z.enum(['text', 'call', 'email']);

export const IntakeSourceUpdateInput = z.object({
  workspaceId: uuid,
  kind: IntakeChannelKind,
  /** What its customers and leads are filed under. */
  name: z.string().trim().min(1).max(60).optional(),
  /** Off: a stranger on this channel is a conversation and nothing else, the way it was before M14. */
  active: z.boolean().optional(),
  /** Off: the customer record is still made, but no lead opens. */
  createLead: z.boolean().optional(),
  /** Null: the business's default pipeline and its first open stage. */
  pipelineId: uuid.nullable().optional(),
  /** Left out with a pipeline: its first open stage. */
  stageId: uuid.nullable().optional(),
  dailyCap: z.number().int().min(1).max(1000).optional(),
});
export const IntakeSourceUpdateOutput = z.object({
  kind: IntakeChannelKind,
  /** The fields that changed. */
  updated: z.array(z.string()),
});

export const IntakeSourceView = z.object({
  kind: IntakeChannelKind,
  name: z.string(),
  active: z.boolean(),
  createLead: z.boolean(),
  pipelineId: uuid.nullable(),
  stageId: uuid.nullable(),
  dailyCap: z.number().int(),
  /** How many leads it has opened today, and when the last one came in. */
  todayCount: z.number().int(),
  lastIntakeAt: z.string().nullable(),
});
export type IntakeSourceViewShape = z.infer<typeof IntakeSourceView>;

export const IntakeListInput = z.object({ workspaceId: uuid });
export const IntakeListOutput = z.object({
  sources: z.array(IntakeSourceView),
  /** The pipelines and stages a channel's leads can be pointed at. */
  pipelines: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      stages: z.array(z.object({ id: uuid, name: z.string(), kind: z.string() })),
    }),
  ),
});
