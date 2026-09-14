/**
 * Milestone 6 schemas: workflows (the draft, versions, tests, runs, approvals and AI builder proposals) and
 * agency templates. A definition is a recursive tree, so it travels as a JSON object and core's
 * `parseDefinition` checks it; ops travel as `WorkflowOpList` and are checked when they're applied.
 * Browser-safe.
 */
import { z } from 'zod';
import { Trigger } from '../workflows/definition';
import { PLACEHOLDER_KEY_RE, REF_KINDS } from '../workflows/ids';
import { WorkflowOpList } from '../workflows/ops';
import { RECIPE_KEYS } from '../workflows/recipes';
import { displayName, isoDateTime, uuid } from './common';

const jsonObject = z.record(z.string(), z.unknown());
const description = z.string().trim().max(2000).nullable().optional();
const baseRevision = z.int().min(1);
const limit = z.int().min(1).max(100).default(50);
const cursor = z.string().max(400).optional();

export const WorkflowStatusValue = z.enum(['draft', 'active', 'paused', 'archived']);
export const WorkflowRunStatusValue = z.enum([
  'running',
  'waiting',
  'awaiting_approval',
  'held',
  'completed',
  'stopped',
  'failed',
]);
/** A run that still holds its place: the re-entry indexes, "active now", Stop and Remove. */
export const LIVE_RUN_STATUSES = ['running', 'waiting', 'awaiting_approval', 'held'] as const;
export const WorkflowStepStatusValue = z.enum([
  'running',
  'done',
  'skipped',
  'waiting',
  'failed',
  'dead',
]);
export const WorkflowApprovalStatusValue = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
]);
export const TemplateInstallStatusValue = z.enum(['pending', 'installed', 'failed']);
export const WorkflowTestModeValue = z.enum(['simulate', 'send_to_me']);

/** Placeholder key → the id it stands for in this business (null leaves it unmapped). */
export const PlaceholderMapping = z
  .record(
    z.string().regex(PLACEHOLDER_KEY_RE, 'Placeholder keys are lowercase words.'),
    uuid.nullable(),
  )
  .refine((m) => Object.keys(m).length <= 100, { error: 'At most 100 placeholders.' });

const StepKey = z
  .string()
  .min(3)
  .max(100)
  .regex(/^s_[a-z0-9]{8}#[1-9][0-9]*$/, 'A step key is a step id, #, and the visit number.');

// ---- Shared outputs ----

const UserOut = z.object({ id: uuid, fullName: z.string() });
const NamedRef = z.object({ id: uuid, name: z.string() });
const PersonRef = z.object({ id: uuid, fullName: z.string() });

export const WorkflowIssueOut = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  fields: z.array(z.string()).readonly(),
  stepId: z.string().nullable(),
  fixes: z
    .array(z.object({ id: z.string(), label: z.string(), ops: z.array(jsonObject).readonly() }))
    .readonly(),
});

export const WorkflowPlaceholderOut = z.object({
  key: z.string(),
  kind: z.enum(REF_KINDS),
  label: z.string(),
});

export const WorkflowSourceOut = z.object({
  kind: z.enum(['blank', 'recipe', 'template']),
  recipeKey: z.string().nullable(),
  recipeName: z.string().nullable(),
  template: z
    .object({
      id: uuid,
      name: z.string(),
      installedVersion: z.int().nullable(),
      latestVersion: z.int().nullable(),
      updateAvailable: z.boolean(),
    })
    .nullable(),
});

export const WorkflowSummaryOut = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  status: WorkflowStatusValue,
  revision: z.int(),
  testedRevision: z.int().nullable(),
  /** The draft as it stands passed a test (tested_revision = revision). */
  tested: z.boolean(),
  activeVersion: z.object({ id: uuid, version: z.int() }).nullable(),
  /** From the trigger index: the published version's trigger once there is one, the draft's before. */
  trigger: z.object({ kind: z.string(), event: z.string().nullable(), summary: z.string() }),
  calendarIds: z.array(uuid),
  allCalendars: z.boolean(),
  reentry: z.string(),
  source: WorkflowSourceOut,
  runs30d: z.int(),
  activeRuns: z.int(),
  lastError: z
    .object({ runId: uuid, stepKey: z.string(), message: z.string(), at: isoDateTime })
    .nullable(),
  /** The newest real run (tests aside): when it started, where it stands, and whom it's for. */
  lastRun: z
    .object({
      id: uuid,
      status: WorkflowRunStatusValue,
      startedAt: isoDateTime,
      endedAt: isoDateTime.nullable(),
      endReason: z.string().nullable(),
      person: PersonRef.nullable(),
    })
    .nullable(),
  createdBy: UserOut.nullable(),
  updatedAt: isoDateTime,
});
export type WorkflowSummaryOut = z.infer<typeof WorkflowSummaryOut>;

export const WorkflowVersionOut = z.object({
  id: uuid,
  version: z.int(),
  revision: z.int(),
  source: z.string(),
  diff: z.array(z.string()),
  publishedBy: UserOut.nullable(),
  testRunId: uuid.nullable(),
  createdAt: isoDateTime,
});

export const WorkflowCatalogsOut = z.object({
  timeZone: z.string(),
  team: z.array(z.object({ userId: uuid, name: z.string(), active: z.boolean() })).readonly(),
  pipelines: z
    .array(
      z.object({
        id: uuid,
        name: z.string(),
        archived: z.boolean(),
        stages: z.array(z.object({ id: uuid, name: z.string(), archived: z.boolean() })).readonly(),
      }),
    )
    .readonly(),
  tags: z.array(NamedRef).readonly(),
  calendars: z.array(z.object({ id: uuid, name: z.string(), archived: z.boolean() })).readonly(),
  services: z.array(z.object({ id: uuid, name: z.string(), archived: z.boolean() })).readonly(),
  workflows: z.array(NamedRef).readonly(),
  textingReady: z.boolean(),
});

// ---- Workflow commands ----

export const WorkflowCreateInput = z
  .object({
    workspaceId: uuid,
    name: displayName,
    description,
    /** "How do you want to start?": empty, a built-in recipe, or an AI builder proposal. */
    from: z.enum(['blank', 'recipe', 'proposal']).default('blank'),
    recipeKey: z.enum(RECIPE_KEYS).optional(),
    /** Recipes: what each placeholder stands for here. Unmapped ones stay and show as issues. */
    mapping: PlaceholderMapping.optional(),
    /** Blank workflows: the trigger to start with (manual when missing). */
    trigger: Trigger.optional(),
    proposalId: uuid.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.from === 'recipe' && !v.recipeKey)
      ctx.addIssue({ code: 'custom', message: 'Pick a recipe.', path: ['recipeKey'] });
    if (v.from === 'proposal' && !v.proposalId)
      ctx.addIssue({ code: 'custom', message: 'Name the proposal.', path: ['proposalId'] });
    if (v.from !== 'blank' && v.trigger)
      ctx.addIssue({
        code: 'custom',
        message: 'Only a blank workflow takes a trigger here.',
        path: ['trigger'],
      });
    if (v.from !== 'recipe' && v.mapping)
      ctx.addIssue({ code: 'custom', message: 'Only recipes take a mapping.', path: ['mapping'] });
  });
export const WorkflowCreateOutput = z.object({
  workflowId: uuid,
  revision: z.int(),
  issues: z.array(WorkflowIssueOut),
  /** Placeholders still to map. */
  placeholders: z.array(WorkflowPlaceholderOut),
});

export const WorkflowSaveDraftInput = z.object({
  workspaceId: uuid,
  workflowId: uuid,
  /** The revision the ops were made against; a newer save in between is a 409 revision_conflict. */
  baseRevision,
  ops: WorkflowOpList,
});
export const WorkflowSaveDraftOutput = z.object({
  workflowId: uuid,
  revision: z.int(),
  /** False when the ops changed nothing (no new revision). */
  changed: z.boolean(),
  /** The ops in plain words. */
  changes: z.array(z.string()),
  issues: z.array(WorkflowIssueOut),
});

export const WorkflowRenameInput = z
  .object({ workspaceId: uuid, workflowId: uuid, name: displayName.optional(), description })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    error: 'Change the name or the description.',
  });
export const WorkflowRenameOutput = z.object({
  workflowId: uuid,
  name: z.string(),
  description: z.string().nullable(),
});

export const WorkflowPublishInput = z.object({ workspaceId: uuid, workflowId: uuid, baseRevision });
export const WorkflowPublishOutput = z.object({
  workflowId: uuid,
  versionId: uuid,
  version: z.int(),
  status: WorkflowStatusValue,
  changes: z.array(z.string()),
});

export const WorkflowRefInput = z.object({ workspaceId: uuid, workflowId: uuid });
export const WorkflowStatusOutput = z.object({
  workflowId: uuid,
  status: WorkflowStatusValue,
  changed: z.boolean(),
  /** Archive stops the runs still going. */
  stoppedRunIds: z.array(uuid),
});

export const WorkflowRestoreVersionInput = z.object({
  workspaceId: uuid,
  workflowId: uuid,
  version: z.int().min(1),
  baseRevision,
});

export const WorkflowContactInput = z.object({
  workspaceId: uuid,
  workflowId: uuid,
  personId: uuid,
});
export const WorkflowEnrolOutput = z.object({
  workflowId: uuid,
  personId: uuid,
  /** The engine starts the run (people can't insert runs). */
  requested: z.literal(true),
});
export const WorkflowRemoveContactOutput = z.object({
  workflowId: uuid,
  personId: uuid,
  /** Runs stopped now (owners and admins). */
  stoppedRunIds: z.array(uuid),
  /** True when the engine finishes the removal (someone without workflows.manage asked). */
  pending: z.boolean(),
});

export const WorkflowStopRunInput = z.object({
  workspaceId: uuid,
  runId: uuid,
  reason: z.string().trim().max(200).nullable().optional(),
});
export const WorkflowStopRunOutput = z.object({
  runId: uuid,
  status: WorkflowRunStatusValue,
  stopped: z.boolean(),
});

export const WorkflowDecideApprovalInput = z.object({
  workspaceId: uuid,
  approvalId: uuid,
  decision: z.enum(['approve', 'reject']),
  /** Approve only: changes to what the step previews (an AI-written text). */
  edits: z
    .record(z.string().min(1).max(40), z.string().max(5000))
    .refine((e) => Object.keys(e).length <= 10, { error: 'At most 10 changes.' })
    .optional(),
  reason: z.string().trim().max(1000).nullable().optional(),
});
export const WorkflowDecideApprovalOutput = z.object({
  approvalId: uuid,
  runId: uuid,
  status: WorkflowApprovalStatusValue,
});

export const WorkflowStepActionInput = z.object({
  workspaceId: uuid,
  runId: uuid,
  stepKey: StepKey,
});
export const WorkflowStepActionOutput = z.object({
  runId: uuid,
  stepKey: z.string(),
  requested: z.literal(true),
});

export const WorkflowTestInput = z.object({
  workspaceId: uuid,
  workflowId: uuid,
  /** Simulate sends nothing and fast-forwards waits; "Send to me" sends only to the tester. */
  mode: WorkflowTestModeValue.default('simulate'),
  /** The sample customer whose details fill the variables. */
  personId: uuid.nullable().optional(),
  /** Values to assume, by variable or field path (a trigger value, an AI category). */
  assume: z
    .record(z.string().min(1).max(100), z.unknown())
    .refine((a) => Object.keys(a).length <= 50, { error: 'At most 50 values.' })
    .optional(),
});
export const WorkflowTestOutput = z.object({
  workflowId: uuid,
  revision: z.int(),
  mode: WorkflowTestModeValue,
  requested: z.literal(true),
  /** The request's event: the test run the engine starts carries it (`workflow.run_list {triggerEventId}`). */
  eventId: uuid,
});

export const WorkflowProposalApplyInput = z.object({
  workspaceId: uuid,
  proposalId: uuid,
  /** The draft revision the editor has; required when the proposal changes an existing workflow. */
  baseRevision: baseRevision.optional(),
  /** A proposal for a new workflow: its name (else one from the proposal). */
  name: displayName.optional(),
});
export const WorkflowProposalApplyOutput = z.object({
  workflowId: uuid,
  revision: z.int(),
  created: z.boolean(),
  changes: z.array(z.string()),
  issues: z.array(WorkflowIssueOut),
});

/** The editor applied a proposal itself (one Undo) and saved it: record that it's applied. */
export const WorkflowProposalMarkAppliedInput = z.object({ workspaceId: uuid, proposalId: uuid });
export const WorkflowProposalMarkAppliedOutput = z.object({
  proposalId: uuid,
  appliedAt: isoDateTime,
  /** False when it was already marked. */
  changed: z.boolean(),
});

/** System (the AI builder): a proposal's ops, made against a draft revision or for a new workflow. */
export const WorkflowProposalCreateInput = z
  .object({
    workspaceId: uuid,
    /** null: a new workflow. */
    workflowId: uuid.nullable(),
    /** The draft revision the ops were made against (null for a new workflow). */
    baseRevision: baseRevision.nullable(),
    /** What the person asked for. */
    prompt: z.string().trim().min(1).max(4000),
    ops: WorkflowOpList,
    /** The AI's own summary of the change. */
    summary: z.string().trim().max(4000).nullable().default(null),
    /** What was asked for that workflows can't do. */
    unsupported: z
      .array(z.string().trim().min(1).max(500))
      .max(20)
      .default(() => []),
    /** The person who asked. */
    createdBy: uuid,
  })
  .refine((v) => (v.workflowId === null) === (v.baseRevision === null), {
    error:
      'A proposal for a workflow names the revision it was made against; a new one names none.',
    path: ['baseRevision'],
  });
export const WorkflowProposalCreateOutput = z.object({
  proposalId: uuid,
  expiresAt: isoDateTime,
});

// ---- Workflow queries ----

export const WorkflowListInput = z.object({
  workspaceId: uuid,
  status: z.array(WorkflowStatusValue).max(4).optional(),
  includeArchived: z.boolean().default(false),
  /** The calendar's Automations module: workflows that name this calendar or watch every calendar. */
  calendarId: uuid.optional(),
});
export const WorkflowListOutput = z.object({ items: z.array(WorkflowSummaryOut) });

export const WorkflowGetInput = z.object({ workspaceId: uuid, workflowId: uuid });
export const WorkflowGetOutput = z.object({
  workflow: WorkflowSummaryOut.extend({
    /** The draft (core's WorkflowDefinition). */
    definition: jsonObject,
    definitionVersion: z.int(),
    /** Checks computed now, against the workspace as it is. */
    issues: z.array(WorkflowIssueOut),
    installedRevision: z.int().nullable(),
    /** An installed copy the business has changed since (an update then warns). */
    changedSinceInstall: z.boolean(),
  }),
  versions: z.array(WorkflowVersionOut),
});

export const WorkflowVersionGetInput = z.object({
  workspaceId: uuid,
  workflowId: uuid,
  version: z.int().min(1),
});
export const WorkflowVersionGetOutput = z.object({
  version: WorkflowVersionOut.extend({ workflowId: uuid, definition: jsonObject }),
});

export const WorkflowCatalogsInput = z.object({ workspaceId: uuid });
export const WorkflowCatalogsOutput = z.object({ catalogs: WorkflowCatalogsOut });

export const WorkflowRunOut = z.object({
  id: uuid,
  workflow: NamedRef,
  versionId: uuid.nullable(),
  version: z.int().nullable(),
  status: WorkflowRunStatusValue,
  isTest: z.boolean(),
  testMode: WorkflowTestModeValue.nullable(),
  testRevision: z.int().nullable(),
  person: PersonRef.nullable(),
  leadId: uuid.nullable(),
  appointmentId: uuid.nullable(),
  conversationId: uuid.nullable(),
  cursor: z.string().nullable(),
  stepCount: z.int(),
  endReason: z.string().nullable(),
  depth: z.int(),
  startedBy: uuid.nullable(),
  startedAt: isoDateTime,
  endedAt: isoDateTime.nullable(),
});
export type WorkflowRunOut = z.infer<typeof WorkflowRunOut>;

export const WorkflowRunListInput = z.object({
  workspaceId: uuid,
  workflowId: uuid.optional(),
  status: z.array(WorkflowRunStatusValue).max(7).optional(),
  personId: uuid.optional(),
  includeTests: z.boolean().default(false),
  /** Test runs only (the Runs page's "Tests"); wins over includeTests. */
  onlyTests: z.boolean().default(false),
  /** The run an event started, such as a test request (`workflow.test` answers with its event id). */
  triggerEventId: uuid.optional(),
  /** Runs that started in this window. */
  startedAfter: isoDateTime.optional(),
  startedBefore: isoDateTime.optional(),
  limit,
  cursor,
});
export const WorkflowRunListOutput = z.object({
  items: z.array(WorkflowRunOut),
  nextCursor: z.string().nullable(),
});

export const WorkflowStatsInput = z.object({ workspaceId: uuid });
export const WorkflowStatsOutput = z.object({
  /** Real runs (tests aside) that started today, where the business is. */
  runsToday: z.int(),
  /** Real runs going now: running, waiting, needing an approval or held. */
  liveRuns: z.int(),
  /** Texts and emails workflows sent today. */
  messagesToday: z.int(),
  /** Texts holding for quiet hours to end, now. */
  quietHoursHeld: z.int(),
  /** Approvals still to decide, and the customers the newest few are about. */
  approvalsPending: z.int(),
  approvalCustomers: z.array(z.string()),
  /** Real runs that failed in the last 30 days, and the newest one's workflow. */
  failedRuns: z.int(),
  failedWorkflow: NamedRef.nullable(),
  /** Real runs that started in the last 30 days, by where they stand. */
  runs30d: z.object({
    all: z.int(),
    waiting: z.int(),
    awaitingApproval: z.int(),
    failed: z.int(),
  }),
});

export const WorkflowRunStepOut = z.object({
  id: uuid,
  stepKey: z.string(),
  status: WorkflowStepStatusValue,
  attempt: z.int(),
  input: jsonObject.nullable(),
  output: jsonObject.nullable(),
  error: jsonObject.nullable(),
  eventIds: z.array(uuid),
  nextStepKey: z.string().nullable(),
  tokens: z.int(),
  startedAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
});

export const WorkflowApprovalOut = z.object({
  id: uuid,
  workflow: NamedRef,
  runId: uuid,
  stepKey: z.string(),
  status: WorkflowApprovalStatusValue,
  /** Named approvers; empty means the owners and admins. */
  approvers: z.array(UserOut),
  preview: jsonObject,
  edits: jsonObject.nullable(),
  reason: z.string().nullable(),
  decidedBy: UserOut.nullable(),
  decidedAt: isoDateTime.nullable(),
  via: z.string().nullable(),
  expiresAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  person: PersonRef.nullable(),
  /** Whether the person asking may decide it (still pending, and theirs or they manage workflows). */
  canDecide: z.boolean(),
});

export const WorkflowRunGetInput = z.object({ workspaceId: uuid, runId: uuid });
export const WorkflowRunGetOutput = z.object({
  run: WorkflowRunOut.extend({
    context: jsonObject,
    visits: z.record(z.string(), z.int()),
    waitingFor: z.array(z.string()),
    stopOn: z.array(z.string()),
    originRunId: uuid.nullable(),
    triggerEventId: uuid.nullable(),
  }),
  /** What the run follows: its version, or the draft a test ran. */
  definition: jsonObject.nullable(),
  steps: z.array(WorkflowRunStepOut),
  approvals: z.array(WorkflowApprovalOut),
});

export const WorkflowApprovalListInput = z.object({
  workspaceId: uuid,
  status: WorkflowApprovalStatusValue.default('pending'),
  workflowId: uuid.optional(),
  limit,
  cursor,
});
export const WorkflowApprovalListOutput = z.object({
  items: z.array(WorkflowApprovalOut),
  nextCursor: z.string().nullable(),
});

export const WorkflowProposalGetInput = z.object({ workspaceId: uuid, proposalId: uuid });
export const WorkflowProposalGetOutput = z.object({
  proposal: z.object({
    id: uuid,
    workflowId: uuid.nullable(),
    baseRevision: z.int().nullable(),
    prompt: z.string(),
    ops: z.array(jsonObject),
    summary: z.string().nullable(),
    unsupported: z.array(z.string()),
    /** The ops in plain words, against the draft they were written for. */
    changes: z.array(z.string()),
    /** The draft moved on since; applying it is refused. */
    stale: z.boolean(),
    expired: z.boolean(),
    appliedAt: isoDateTime.nullable(),
    createdBy: UserOut.nullable(),
    expiresAt: isoDateTime,
    createdAt: isoDateTime,
  }),
});

// ---- Agency templates (organization level) ----

export const ExtractedPlaceholderOut = WorkflowPlaceholderOut.extend({ id: z.string() });

export const WorkflowTemplateCreateFromWorkflowInput = z.object({
  organizationId: uuid,
  workflowId: uuid,
  name: displayName,
  description,
});
export const WorkflowTemplateCreateFromWorkflowOutput = z.object({
  templateId: uuid,
  revision: z.int(),
  /** The workspace ids swapped for placeholders, with what they were. */
  placeholders: z.array(ExtractedPlaceholderOut),
});

/** A blank template: its trigger (by hand when missing) and no steps; revision 1, nothing published yet. */
export const WorkflowTemplateCreateInput = z.object({
  organizationId: uuid,
  name: displayName,
  description,
  trigger: Trigger.optional(),
});
export const WorkflowTemplateCreateOutput = z.object({ templateId: uuid, revision: z.int() });

/** A template's name or description. Businesses' installed copies keep their own. */
export const WorkflowTemplateRenameInput = z
  .object({ organizationId: uuid, templateId: uuid, name: displayName.optional(), description })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    error: 'Change the name or the description.',
  });
export const WorkflowTemplateRenameOutput = z.object({
  templateId: uuid,
  name: z.string(),
  description: z.string().nullable(),
});

export const WorkflowTemplateRefInput = z.object({ organizationId: uuid, templateId: uuid });
export const WorkflowTemplatePublishOutput = z.object({
  templateId: uuid,
  version: z.int(),
  /** False when the template hadn't changed since its newest version. */
  published: z.boolean(),
});

export const WorkflowTemplatePushInput = z.object({
  organizationId: uuid,
  templateId: uuid,
  workspaceIds: z.array(uuid).min(1, 'Pick a business.').max(100),
  /** Per business: what each placeholder stands for there. */
  mappings: z.record(uuid, PlaceholderMapping).default(() => ({})),
});
export const WorkflowTemplatePushOutput = z.object({
  templateId: uuid,
  version: z.int(),
  installIds: z.array(uuid),
});

export const WorkflowTemplateSummaryOut = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  revision: z.int(),
  latestVersion: z.int().nullable(),
  archivedAt: isoDateTime.nullable(),
  installs: z.object({
    total: z.int(),
    installed: z.int(),
    pending: z.int(),
    failed: z.int(),
    /** Installed on an older version than the newest. */
    behind: z.int(),
  }),
  createdBy: UserOut.nullable(),
  updatedAt: isoDateTime,
});

export const WorkflowTemplateListInput = z.object({
  organizationId: uuid,
  includeArchived: z.boolean().default(false),
});
export const WorkflowTemplateListOutput = z.object({ items: z.array(WorkflowTemplateSummaryOut) });

export const WorkflowTemplateGetOutput = z.object({
  template: WorkflowTemplateSummaryOut.extend({
    definition: jsonObject,
    placeholders: z.array(WorkflowPlaceholderOut),
  }),
  versions: z.array(
    z.object({
      id: uuid,
      version: z.int(),
      diff: z.array(z.string()),
      publishedBy: UserOut.nullable(),
      createdAt: isoDateTime,
    }),
  ),
  installs: z.array(
    z.object({
      id: uuid,
      workspaceId: uuid,
      workspaceName: z.string(),
      workflowId: uuid.nullable(),
      installedVersion: z.int().nullable(),
      status: TemplateInstallStatusValue,
      lastError: z.string().nullable(),
      behind: z.boolean(),
      mapping: z.record(z.string(), z.unknown()),
      pushedBy: UserOut.nullable(),
      pushedAt: isoDateTime.nullable(),
      installedAt: isoDateTime.nullable(),
    }),
  ),
});

export const WorkflowTemplateSaveDraftInput = z.object({
  organizationId: uuid,
  templateId: uuid,
  /** The revision the ops were made against; a newer save in between is a 409 revision_conflict. */
  baseRevision,
  ops: WorkflowOpList,
});
export const WorkflowTemplateSaveDraftOutput = z.object({
  templateId: uuid,
  revision: z.int(),
  /** False when the ops changed nothing (no new revision). */
  changed: z.boolean(),
  changes: z.array(z.string()),
  /** The template's own checks; its placeholders aren't problems (each business maps them). */
  issues: z.array(WorkflowIssueOut),
});

/** System: one pushed install turned into a draft in its business. */
export const WorkflowTemplateInstallInput = z.object({ workspaceId: uuid, installId: uuid });
export const WorkflowTemplateInstallOutput = z.object({
  installId: uuid,
  status: TemplateInstallStatusValue,
  workflowId: uuid.nullable(),
  version: z.int().nullable(),
  /** A new draft was made (false: the business already had its copy, which is left as it is). */
  created: z.boolean(),
  /** Placeholders left for the business to pick. */
  unmapped: z.array(z.string()),
  error: z.string().nullable(),
});

/** System, on a person's request: the newest template version applied to a business's copy, as a draft. */
export const WorkflowTemplateApplyUpdateInput = z.object({
  workspaceId: uuid,
  workflowId: uuid,
  baseRevision,
});
export const WorkflowTemplateApplyUpdateOutput = z.object({
  workflowId: uuid,
  revision: z.int(),
  version: z.int(),
  changed: z.boolean(),
  changes: z.array(z.string()),
  /** The business's own changes put back on top of the new version, and those that no longer fit. */
  kept: z.array(z.string()),
  dropped: z.array(z.string()),
  unmapped: z.array(z.string()),
  issues: z.array(WorkflowIssueOut),
});
