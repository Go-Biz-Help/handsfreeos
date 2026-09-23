import { z } from 'zod';
import { LeadQualification } from './ai-team';
import { isoDateTime, uuid } from './common';
import {
  CompanyRef,
  ListInput,
  notApplied,
  PersonRef,
  seenId,
  seenText,
  source,
  tagIds,
  TagRef,
  UserRef,
} from './crm';
import { stageKind } from './pipeline';

export const leadStatus = z.enum(['open', 'won', 'lost']);
const title = z.string().trim().min(1, 'Give the lead a title.').max(160);
const valueCents = z.number().int().min(0).max(1_000_000_000_00);
const nextAction = z.string().trim().max(200).nullable().optional();
const lostReason = z.string().trim().min(1, 'Add a reason.').max(300);

export const LeadCreateInput = z
  .object({
    workspaceId: uuid,
    /** The id the phone made for it (M10). */
    id: uuid.optional(),
    title,
    personId: uuid.nullable().optional(),
    companyId: uuid.nullable().optional(),
    pipelineId: uuid.optional(),
    stageId: uuid.optional(),
    valueCents: valueCents.default(0),
    source,
    assigneeUserId: uuid.nullable().optional(),
    expectedCloseOn: z.iso.date().nullable().optional(),
    nextAction,
    nextActionAt: isoDateTime.nullable().optional(),
    tagIds: tagIds.optional(),
  })
  .refine((v) => !!v.personId || !!v.companyId, {
    path: ['personId'],
    error: 'Pick a person or a company.',
  });
export const LeadCreateOutput = z.object({ leadId: uuid, stageId: uuid });

/** What the person saw of each detail they edited (see kernel/field-merge). */
export const LeadSeen = z.object({
  title: seenText,
  personId: seenId,
  companyId: seenId,
  valueCents: z.number().nullable().optional(),
  source: seenText,
  assigneeUserId: seenId,
  expectedCloseOn: seenText,
  nextAction: seenText,
  nextActionAt: seenText,
});

/** Only the details that were edited, each merged on its own: newest wins. */
export const LeadUpdateInput = z.object({
  workspaceId: uuid,
  leadId: uuid,
  title: title.optional(),
  personId: uuid.nullable().optional(),
  companyId: uuid.nullable().optional(),
  valueCents: valueCents.optional(),
  source,
  assigneeUserId: uuid.nullable().optional(),
  expectedCloseOn: z.iso.date().nullable().optional(),
  /** The one thing to do next, and when (the AI teammate may change only these two). */
  nextAction,
  nextActionAt: isoDateTime.nullable().optional(),
  base: LeadSeen.optional(),
});
export const LeadUpdateOutput = z.object({
  leadId: uuid,
  updated: z.array(z.string()),
  notApplied,
});

export const LeadMoveStageInput = z.object({
  workspaceId: uuid,
  leadId: uuid,
  stageId: uuid,
  /** Place the lead after this lead in the stage; omit for the bottom, null for the top. */
  afterLeadId: uuid.nullable().optional(),
  lostReason: lostReason.optional(),
  /** Why HandsFreeOS moved it ("Quote 1042 went out"), for its timeline. Only HandsFreeOS gives one. */
  because: z.string().trim().min(1).max(200).optional(),
});
/** The "Deal in the wrong stage" card's one press: move the deal to the stage what happened to it says. */
export const LeadCatchUpInput = z.object({ workspaceId: uuid, leadId: uuid });
export const LeadCatchUpOutput = z.object({
  leadId: uuid,
  stageId: uuid,
  /** The stage's name, for the toast ("Moved to Estimate sent"). */
  stageName: z.string(),
});
export const LeadMoveStageOutput = z.object({
  leadId: uuid,
  /** The stage it's in: another one when someone moved it later than this move was made. */
  stageId: uuid,
  status: leadStatus,
  position: z.number(),
  /** ['stageId'] when someone moved it later than this move was made (M10), so it stays where they put it. */
  notApplied,
});

export const LeadSetNextActionInput = z.object({
  workspaceId: uuid,
  leadId: uuid,
  text: z.string().trim().min(1).max(200).nullable(),
  dueAt: isoDateTime.nullable().optional(),
});
export const LeadSetNextActionOutput = z.object({
  leadId: uuid,
  nextAction: z.string().nullable(),
  nextActionAt: isoDateTime.nullable(),
});

export const LeadArchiveInput = z.object({ workspaceId: uuid, leadId: uuid });
export const LeadArchiveOutput = z.object({ leadId: uuid });

export const LeadCard = z.object({
  id: uuid,
  title: z.string(),
  pipelineId: uuid,
  stageId: uuid,
  stageName: z.string(),
  stageKind,
  status: leadStatus,
  person: PersonRef.nullable(),
  company: CompanyRef.nullable(),
  valueCents: z.number(),
  source: z.string().nullable(),
  assignee: UserRef,
  expectedCloseOn: z.string().nullable(),
  nextAction: z.string().nullable(),
  nextActionAt: isoDateTime.nullable(),
  needsNextAction: z.boolean(),
  /** An open lead whose next action's time has passed (the pipeline card's overdue dot). */
  nextActionOverdue: z.boolean(),
  /** The latest real contact either way (a text, email, chat, connected call or visit). */
  lastContactAt: isoDateTime.nullable(),
  wonAt: isoDateTime.nullable(),
  lostAt: isoDateTime.nullable(),
  lostReason: z.string().nullable(),
  position: z.number(),
  tags: z.array(TagRef),
  stageEnteredAt: isoDateTime,
  archivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type LeadCard = z.infer<typeof LeadCard>;

export const LeadBoardInput = z.object({ workspaceId: uuid, pipelineId: uuid.optional() });
export const LeadBoardOutput = z.object({
  pipeline: z.object({ id: uuid, name: z.string() }),
  pipelines: z.array(z.object({ id: uuid, name: z.string() })),
  stages: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      kind: stageKind,
      position: z.number().int(),
      count: z.number().int(),
      valueCents: z.number(),
      leads: z.array(LeadCard),
    }),
  ),
});

export const LeadListInput = ListInput.extend({
  workspaceId: uuid,
  q: z.string().trim().max(120).optional(),
  status: leadStatus.optional(),
  pipelineId: uuid.optional(),
  assigneeUserId: uuid.optional(),
  personId: uuid.optional(),
  companyId: uuid.optional(),
  /** Only leads created at or after this time. */
  createdAfter: isoDateTime.optional(),
  /** Only open leads with no next action (the rule behind LeadCard.needsNextAction). */
  withoutNextAction: z.boolean().optional(),
  includeArchived: z.boolean().default(false),
});
export const LeadListOutput = z.object({
  items: z.array(LeadCard),
  nextCursor: z.string().nullable(),
});

export const LeadGetInput = z.object({ workspaceId: uuid, leadId: uuid });
export const LeadGetOutput = z.object({
  /** With its qualifying answers (M7), once any are recorded. */
  lead: LeadCard.extend({ qualification: LeadQualification.nullable() }),
  stages: z.array(
    z.object({ id: uuid, name: z.string(), kind: stageKind, position: z.number().int() }),
  ),
});
