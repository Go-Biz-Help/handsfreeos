/**
 * Milestone 15 schemas: forms, surveys and quizzes. A definition is a tree, so it travels as a JSON object
 * and core's FormDefinition checks it; ops travel as `FormOpList` and are checked when they're applied.
 * Browser-safe.
 */
import { z } from 'zod';
import { FORM_MODES } from '../forms/definition';
import { FormOpList } from '../forms/ops';
import { isoDateTime, uuid } from './common';

export const FormModeValue = z.enum(FORM_MODES);
export const FormStatusValue = z.enum(['draft', 'live', 'closed', 'archived']);

const formName = z.string().trim().min(1, 'Name the form.').max(120);
const baseRevision = z.int().min(1);
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, {
    error: 'Use lowercase letters, numbers and hyphens.',
  });

/** What's wrong with a form as the business stands today, for the editor to show. */
export const FormIssueOut = z.object({
  message: z.string(),
  questionId: z.string().optional(),
});

export const FormRefInput = z.object({ workspaceId: uuid, formId: uuid });

export const FormCreateInput = z.object({
  workspaceId: uuid,
  name: formName,
  mode: FormModeValue.default('form'),
  /** The words the customer reads at the top; the form's own name when left out. */
  title: z.string().trim().min(1).max(160).optional(),
  /** Start from one of the built-in forms instead of an empty page (core's FORM_STARTERS). */
  starter: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe('A starter’s key, like “quote” or “review”'),
});
export const FormCreateOutput = z.object({
  formId: uuid,
  revision: z.int(),
  slug: z.string(),
  issues: z.array(FormIssueOut),
});

export const FormSaveDraftInput = z.object({
  workspaceId: uuid,
  formId: uuid,
  /** The revision the editor started from; a newer one means somebody else saved first. */
  baseRevision,
  ops: FormOpList,
});
export const FormSaveDraftOutput = z.object({
  formId: uuid,
  revision: z.int(),
  changed: z.boolean(),
  changes: z.array(z.string()),
  issues: z.array(FormIssueOut),
});

export const FormPublishInput = z.object({
  workspaceId: uuid,
  formId: uuid,
  baseRevision,
  source: z.enum(['editor', 'assistant', 'template']).default('editor'),
});
export const FormPublishOutput = z.object({
  formId: uuid,
  versionId: uuid,
  version: z.int(),
  status: FormStatusValue,
});

/** Take answers, or stop taking them. Archiving and restoring have their own commands. */
export const FormSetStatusInput = z.object({
  workspaceId: uuid,
  formId: uuid,
  status: z.enum(['live', 'closed']),
});
export const FormStatusOutput = z.object({ formId: uuid, status: FormStatusValue });

export const FormRenameInput = z.object({ workspaceId: uuid, formId: uuid, name: formName });
export const FormSetSlugInput = z.object({ workspaceId: uuid, formId: uuid, slug });
export const FormSlugOutput = z.object({ formId: uuid, slug: z.string() });

export const FormSetDeliveryInput = z.object({
  workspaceId: uuid,
  formId: uuid,
  /** The sites allowed to frame it; an empty list means it is embedded nowhere. */
  embedOrigins: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .max(200)
        .regex(
          /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$|^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/,
          {
            error: 'Use a site address like https://example.com.',
          },
        ),
    )
    .max(10)
    .optional(),
  /** Let the AI teammate ask these questions in a conversation. */
  inChat: z.boolean().optional(),
});
export const FormDeliveryOutput = z.object({
  formId: uuid,
  embedOrigins: z.array(z.string()),
  inChat: z.boolean(),
});

export const FormDuplicateInput = z.object({
  workspaceId: uuid,
  formId: uuid,
  name: formName.optional(),
});

export const FormRestoreVersionInput = z.object({
  workspaceId: uuid,
  formId: uuid,
  version: z.int().min(1),
  baseRevision,
});

export type FormIssueOut = z.infer<typeof FormIssueOut>;

// ---- Filling one in ----

export const FormSourceValue = z.enum(['link', 'embed', 'chat', 'qr', 'app', 'api']);

/** Answers by question id. What each one may be is the question's own business (core's answerProblem). */
export const AnswerSheetInput = z
  .record(z.string().regex(/^q_[a-z0-9]{8}$/, { error: 'That isn’t a question.' }), z.unknown())
  .refine((a) => Object.keys(a).length <= 300, { error: 'That is more answers than a form has.' });

export const FormStartInput = z.object({
  workspaceId: uuid,
  formId: uuid,
  source: FormSourceValue.default('link'),
  /** The same visitor coming back, as a hash with no address in it. */
  visitorHash: z.string().max(128).nullable().default(null),
});
export const FormStartOutput = z.object({
  responseId: uuid,
  versionId: uuid,
  /**
   * The key to this answer sheet. The page sends it back to save and to submit, so knowing a response's id
   * is not enough to write to somebody else's sheet.
   */
  token: z.string(),
  /** Whether the form offers a "carry on where you left off" link built from that token. */
  canResume: z.boolean(),
});

export const FormSaveAnswersInput = z.object({
  workspaceId: uuid,
  responseId: uuid,
  /** The key `form_response.start` handed back. The public page must send it; the AI teammate is inside
   * the business already, so its runs don't carry one. */
  token: z.string().max(200).optional(),
  answers: AnswerSheetInput,
});
export const FormSaveAnswersOutput = z.object({
  responseId: uuid,
  /** How far along they are, 0 to 1. */
  progress: z.number(),
  calculations: z.record(z.string(), z.number()),
  /** What is still wrong, so a page can show it beside the question. */
  problems: z.array(z.object({ questionId: z.string(), message: z.string() })),
});

export const FormSubmitInput = z.object({
  workspaceId: uuid,
  responseId: uuid,
  token: z.string().max(200).optional(),
  answers: AnswerSheetInput,
  /** Ticked to allow texts. The box starts unticked, as it does on the booking page. */
  smsConsent: z.boolean().default(false),
});
/**
 * A person filling one in themselves (M17), on a phone that may have no signal.
 *
 * Its own input rather than `FormSubmitInput`'s, because the two-step a visitor takes — start a sheet, get a
 * key back, send the answers — needs the network twice and a server-made id. This carries a client-made id
 * instead, so the same submission arriving twice is one answer sheet.
 */
export const FormRecordInput = z.object({
  workspaceId: uuid,
  /** Made on the phone, so a retry is not a second answer sheet. */
  id: uuid.optional(),
  formId: uuid,
  answers: AnswerSheetInput,
  /** Ticked if the customer said it is OK to text them. Starts unticked, as everywhere else. */
  smsConsent: z.boolean().default(false),
});

export const FormSubmitOutput = z.object({
  responseId: uuid,
  personId: uuid.nullable(),
  leadId: uuid.nullable(),
  /** The result they land on (core's r_ id inside the version). */
  resultId: z.string().nullable(),
  score: z.number().nullable(),
  scorePercent: z.int().nullable(),
  passed: z.boolean().nullable(),
  calculations: z.record(z.string(), z.number()),
  /** What the form asks them to pay, in cents; 0 when it asks for nothing. */
  dueCents: z.int(),
  /** The invoice raised for it, which is where the card is taken. */
  invoiceId: uuid.nullable(),
});

export const FormResponseDeleteInput = z.object({ workspaceId: uuid, responseId: uuid });
export const FormResponseDeleteOutput = z.object({ responseId: uuid, deleted: z.literal(true) });

// ---- Reading ----

const cursor = z.string().max(400).optional();
const limit = z.int().min(1).max(100).default(25);

export const FormSummaryOut = z.object({
  formId: uuid,
  name: z.string(),
  mode: FormModeValue,
  status: FormStatusValue,
  slug: z.string(),
  /** How many questions the live version asks (the draft's, before the first publish). */
  questionCount: z.int(),
  responseCount: z.int(),
  /** Of the people who started it, how many finished, 0 to 1; null until somebody has. */
  completionRate: z.number().nullable(),
  lastResponseAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
  version: z.int().nullable(),
  inChat: z.boolean(),
  /** The sites allowed to frame it; empty means it is embedded nowhere. */
  embedOrigins: z.array(z.string()),
});

export const FormListInput = z.object({
  workspaceId: uuid,
  status: z.array(FormStatusValue).optional(),
  mode: z.array(FormModeValue).optional(),
  includeArchived: z.boolean().default(false),
  search: z.string().trim().max(120).optional(),
});
export const FormListOutput = z.object({ items: z.array(FormSummaryOut) });

export const FormGetInput = z.object({ workspaceId: uuid, formId: uuid });
export const FormGetOutput = z.object({
  form: FormSummaryOut,
  /** The draft every editor works on. */
  definition: z.record(z.string(), z.unknown()),
  revision: z.int(),
  issues: z.array(FormIssueOut),
  /** The published versions, newest first. */
  versions: z.array(
    z.object({
      versionId: uuid,
      version: z.int(),
      source: z.string(),
      publishedBy: z.string().nullable(),
      createdAt: isoDateTime,
      /** True for the one people are filling in now. */
      live: z.boolean(),
    }),
  ),
  /** Whether the draft has changed since the last publish. */
  unpublishedChanges: z.boolean(),
});

export const FormVersionGetInput = z.object({ workspaceId: uuid, versionId: uuid });
export const FormVersionGetOutput = z.object({
  versionId: uuid,
  formId: uuid,
  version: z.int(),
  definition: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
});

/** What the editor's pickers offer, and the fields an answer can fill. */
export const FormCatalogsInput = z.object({ workspaceId: uuid });
export const FormCatalogsOutput = z.object({
  pipelines: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      archived: z.boolean(),
      stages: z.array(z.object({ id: uuid, name: z.string() })),
    }),
  ),
  tags: z.array(z.object({ id: uuid, name: z.string() })),
  workflows: z.array(z.object({ id: uuid, name: z.string() })),
  customFields: z.array(
    z.object({ id: uuid, entity: z.string(), label: z.string(), type: z.string() }),
  ),
  team: z.array(z.object({ userId: uuid, name: z.string() })),
});

export const FormResponseOut = z.object({
  responseId: uuid,
  formId: uuid,
  versionId: uuid,
  status: z.enum(['in_progress', 'completed']),
  source: FormSourceValue,
  personId: uuid.nullable(),
  personName: z.string().nullable(),
  leadId: uuid.nullable(),
  scorePercent: z.int().nullable(),
  passed: z.boolean().nullable(),
  resultId: z.string().nullable(),
  startedAt: isoDateTime,
  completedAt: isoDateTime.nullable(),
});

export const FormResponseListInput = z.object({
  workspaceId: uuid,
  formId: uuid,
  /** Half-finished ones are left out unless they are asked for. */
  includeUnfinished: z.boolean().default(false),
  limit,
  cursor,
});
export const FormResponseListOutput = z.object({
  items: z.array(FormResponseOut),
  nextCursor: z.string().nullable(),
});

export const FormResponseGetInput = z.object({ workspaceId: uuid, responseId: uuid });
export const FormResponseGetOutput = z.object({
  response: FormResponseOut,
  /** Every answer with the question as it read when they answered. */
  answers: z.array(
    z.object({
      questionId: z.string(),
      questionTitle: z.string(),
      questionType: z.string(),
      value: z.unknown(),
      text: z.string().nullable(),
      labels: z.array(z.string()),
    }),
  ),
  calculations: z.record(z.string(), z.number()),
});

/** One question's answers, summed up the way that question deserves. */
export const FormQuestionSummaryOut = z.object({
  questionId: z.string(),
  title: z.string(),
  type: z.string(),
  answered: z.int(),
  /** Pick-one and pick-any: how many picked each choice. */
  choices: z.array(z.object({ label: z.string(), count: z.int() })),
  /** Numbers, ratings and scales. */
  average: z.number().nullable(),
  /** Text answers, newest first, for reading rather than counting. */
  samples: z.array(z.string()),
});

export const FormResultsInput = z.object({ workspaceId: uuid, formId: uuid });
export const FormResultsOutput = z.object({
  formId: uuid,
  name: z.string(),
  mode: FormModeValue,
  views: z.int(),
  starts: z.int(),
  completions: z.int(),
  /** Quizzes: how people did. */
  averagePercent: z.number().nullable(),
  passRate: z.number().nullable(),
  questions: z.array(FormQuestionSummaryOut),
  /** Which result people landed on, for an outcome quiz. */
  results: z.array(z.object({ resultId: z.string(), name: z.string(), count: z.int() })),
});
