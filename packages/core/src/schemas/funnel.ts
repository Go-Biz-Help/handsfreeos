/**
 * Funnels' commands and queries (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md): making and changing a funnel,
 * who's in it, and the teammate's suggestions. Browser-safe.
 */
import { z } from 'zod';
import {
  FUNNEL_ADDED_BY,
  FUNNEL_EVENT_KEYS,
  FUNNEL_LEFT_REASONS,
  FUNNEL_PAUSE_REASONS,
  FUNNEL_PERSON_STATUSES,
  FUNNEL_STATUSES,
  FUNNEL_WORDING,
  FunnelDefinition,
} from '../funnels/definition';
import { FunnelDraft } from '../funnels/draft';
import { uuid } from './common';

const funnelName = z.string().trim().min(1).max(80);
const stageKind = z.enum(['open', 'won', 'lost']);

// ---- Making and changing one ----

export const FunnelCreateInput = z
  .object({
    workspaceId: uuid,
    name: funnelName,
    /** The pipeline it runs on, or `newPipeline` for one made from its stages. */
    pipelineId: uuid.optional(),
    newPipeline: z
      .object({
        name: z.string().trim().min(1).max(80),
        stages: z
          .array(z.object({ name: z.string().trim().min(1).max(60), kind: stageKind }))
          .min(3)
          .max(12),
      })
      .optional(),
    /** The AI's draft, its stages named; matched to the pipeline's by `stageMap`, else by name. */
    draft: FunnelDraft.optional(),
    /** Draft stage name → pipeline stage id, for a pipeline the business has. */
    stageMap: z.record(z.string().max(60), uuid).optional(),
    /** What the business described, kept with it. */
    description: z.string().trim().max(4000).optional(),
  })
  .refine((v) => !!v.pipelineId !== !!v.newPipeline, {
    path: ['pipelineId'],
    error: 'Pick a pipeline, or make a new one.',
  });
export const FunnelCreateOutput = z.object({
  funnelId: uuid,
  pipelineId: uuid,
  revision: z.number().int(),
});

export const FunnelSaveInput = z.object({
  workspaceId: uuid,
  funnelId: uuid,
  /** The revision this change started from. */
  revision: z.number().int().min(1),
  name: funnelName.optional(),
  definition: FunnelDefinition,
  /**
   * For each stage taken out that people are at: the stage they go to instead (a stage still in the funnel).
   * Refused without one (`funnel_stage_has_people`).
   */
  moveFrom: z.record(uuid, uuid).optional(),
});
export const FunnelSaveOutput = z.object({ funnelId: uuid, revision: z.number().int() });

export const FunnelTurnOnInput = z.object({
  workspaceId: uuid,
  funnelId: uuid,
  /** Also take in the open leads already in the pipeline, each at the stage they're in (the worker adds them). */
  addExisting: z.boolean().default(false),
});
export const FunnelTurnOnOutput = z.object({
  funnelId: uuid,
  status: z.enum(FUNNEL_STATUSES),
  /** How many open leads `addExisting` takes in. */
  adding: z.number().int(),
});

export const FunnelPauseInput = z.object({ workspaceId: uuid, funnelId: uuid });
export const FunnelPauseOutput = z.object({ funnelId: uuid, status: z.enum(FUNNEL_STATUSES) });

export const FunnelArchiveInput = z.object({ workspaceId: uuid, funnelId: uuid });
export const FunnelArchiveOutput = z.object({ funnelId: uuid, left: z.number().int() });

// ---- Who's in it ----

export const FunnelAddPersonInput = z.object({
  workspaceId: uuid,
  funnelId: uuid,
  personId: uuid,
  /** Their lead in the funnel's pipeline; their open one there when left out, or a new one. */
  leadId: uuid.optional(),
  /** Where they start: the stage their lead is at, else the funnel's start. */
  stageId: uuid.optional(),
  /** How they got in, for the worker's rules (people are always `hand`). */
  addedBy: z.enum(FUNNEL_ADDED_BY).optional(),
});
export const FunnelAddPersonOutput = z.object({
  funnelPersonId: uuid,
  leadId: uuid,
  stageId: uuid,
  /** Already in it: nothing changed. */
  already: z.boolean(),
});

export const FunnelRemovePersonInput = z.object({
  workspaceId: uuid,
  funnelPersonId: uuid,
  /** Why, when HandsFreeOS takes them out (STOP, their lead gone). People just remove them. */
  reason: z.enum(['opted_out', 'lead_gone']).optional(),
});
export const FunnelRemovePersonOutput = z.object({ funnelPersonId: uuid, changed: z.boolean() });

export const FunnelPausePersonInput = z.object({
  workspaceId: uuid,
  funnelPersonId: uuid,
  paused: z.boolean(),
  /** Why, when the system pauses it. People pause it by hand. */
  reason: z.enum(FUNNEL_PAUSE_REASONS).optional(),
});
export const FunnelPausePersonOutput = z.object({
  funnelPersonId: uuid,
  status: z.enum(FUNNEL_PERSON_STATUSES),
  changed: z.boolean(),
});

export const FunnelMovePersonInput = z.object({
  workspaceId: uuid,
  funnelPersonId: uuid,
  stageId: uuid,
  /** The move in their stage that this is: the teammate's are `reply` moves, HandsFreeOS's the others. */
  moveId: z.string().max(20),
  /** Why, in a line ("They said they’re interested"). The move's own words when left out. */
  because: z.string().trim().min(1).max(200).optional(),
});
export const FunnelMovePersonOutput = z.object({
  funnelPersonId: uuid,
  stageId: uuid,
  changed: z.boolean(),
});

/** The worker's bookkeeping on a person: what they did, what went, and the booking it's timed around. */
export const FunnelNoteProgressInput = z.object({
  workspaceId: uuid,
  funnelPersonId: uuid,
  /** At this stage only: a note for another stage is dropped. */
  stageId: uuid,
  seen: z.enum(FUNNEL_EVENT_KEYS).optional(),
  sent: z.array(z.string().max(20)).max(8).optional(),
  appointmentId: uuid.nullable().optional(),
});
export const FunnelNoteProgressOutput = z.object({ changed: z.boolean() });

// ---- The teammate's suggestions ----

export const FunnelSuggestInput = z.object({
  workspaceId: uuid,
  funnelId: uuid,
  personId: uuid,
  why: z.string().trim().min(1).max(300),
});
export const FunnelSuggestOutput = z.object({
  funnelPersonId: uuid.nullable(),
  already: z.boolean(),
});

export const FunnelDecideSuggestionInput = z.object({
  workspaceId: uuid,
  funnelPersonId: uuid,
  accept: z.boolean(),
});
export const FunnelDecideSuggestionOutput = z.object({
  funnelPersonId: uuid,
  status: z.enum(FUNNEL_PERSON_STATUSES),
});

// ---- What the screens read ----

export const FunnelStageRow = z.object({
  id: uuid,
  name: z.string(),
  kind: stageKind,
  position: z.number().int(),
});
export type FunnelStageRow = z.infer<typeof FunnelStageRow>;

export const FunnelSummary = z.object({
  id: uuid,
  name: z.string(),
  pipelineId: uuid,
  pipelineName: z.string(),
  status: z.enum(FUNNEL_STATUSES),
  revision: z.number().int(),
  stages: z.array(FunnelStageRow.extend({ people: z.number().int(), inFunnel: z.boolean() })),
  /** People in it now (active or paused). */
  people: z.number().int(),
  paused: z.number().int(),
  suggestions: z.number().int(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});
export type FunnelSummary = z.infer<typeof FunnelSummary>;

export const FunnelListInput = z.object({ workspaceId: uuid });
export const FunnelListOutput = z.object({ funnels: z.array(FunnelSummary) });

export const FunnelGetInput = z.object({ workspaceId: uuid, funnelId: uuid });
export const FunnelIssueOut = z.object({
  level: z.enum(['red', 'yellow', 'ok']),
  rule: z.string(),
  words: z.string(),
});
export const FunnelGetOutput = z.object({
  funnel: FunnelSummary.extend({ definition: FunnelDefinition }),
  issues: z.array(FunnelIssueOut),
  /** For the pickers: the business's forms and calendars. */
  forms: z.array(z.object({ id: uuid, name: z.string() })),
  calendars: z.array(z.object({ id: uuid, name: z.string() })),
  teammate: z
    .object({
      name: z.string(),
      status: z.enum(['off', 'training', 'automatic']),
      approved: z.number().int(),
      needed: z.number().int(),
    })
    .nullable(),
  timeZone: z.string(),
  businessName: z.string(),
  /** Workflows that are on and text the same new leads (the "Before it goes on" warning, worked out as it's edited). */
  overlappingWorkflows: z.array(z.string()),
  /** Open leads in the pipeline not in any funnel: what "Also add the leads already here" takes. */
  waiting: z.number().int(),
});

export const FunnelNextOut = z.object({
  messageId: z.string(),
  dueAt: z.string(),
  wording: z.enum(FUNNEL_WORDING),
  text: z.string(),
  onlyIf: z.string().nullable(),
});

export const FunnelPersonOut = z.object({
  id: uuid,
  funnelId: uuid,
  funnelName: z.string(),
  funnelStatus: z.enum(FUNNEL_STATUSES),
  personId: uuid,
  personName: z.string(),
  leadId: uuid.nullable(),
  stageId: uuid.nullable(),
  stageName: z.string().nullable(),
  status: z.enum(FUNNEL_PERSON_STATUSES),
  pausedReason: z.enum(FUNNEL_PAUSE_REASONS).nullable(),
  leftReason: z.enum(FUNNEL_LEFT_REASONS).nullable(),
  stageReachedAt: z.string(),
  booking: z.object({ appointmentId: uuid, startsAt: z.string(), title: z.string() }).nullable(),
  next: z.array(FunnelNextOut),
  addedBy: z.enum(FUNNEL_ADDED_BY),
  suggestedWhy: z.string().nullable(),
  createdAt: z.string(),
});
export type FunnelPersonOut = z.infer<typeof FunnelPersonOut>;

export const FunnelOfPersonInput = z.object({ workspaceId: uuid, personId: uuid });
export const FunnelOfPersonOutput = z.object({
  current: FunnelPersonOut.nullable(),
  /** Their funnel's stages, in its pipeline's order: where Move to… can take their lead. */
  stages: z.array(z.object({ id: uuid, name: z.string(), kind: z.enum(['open', 'won', 'lost']) })),
  /** The teammate's suggestion of a funnel for them, waiting for a yes or no. */
  suggestion: FunnelPersonOut.nullable(),
  /** Funnels they could be added to (on or paused, adding by hand allowed). */
  canJoin: z.array(z.object({ id: uuid, name: z.string() })),
  timeZone: z.string(),
});

export const FunnelPeopleInput = z.object({
  workspaceId: uuid,
  funnelId: uuid,
  stageId: uuid.optional(),
  /** Who to list: in it now, the teammate's suggestions, or everyone who left. */
  show: z.enum(['in', 'suggested', 'left']).default('in'),
  limit: z.number().int().min(1).max(200).default(50),
});
export const FunnelPeopleOutput = z.object({
  people: z.array(FunnelPersonOut),
  timeZone: z.string(),
});

export const FunnelSuggestionsInput = z.object({ workspaceId: uuid });
export const FunnelSuggestionsOutput = z.object({ suggestions: z.array(FunnelPersonOut) });
