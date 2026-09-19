/**
 * Milestone 15 schemas: forms, surveys and quizzes. A definition is a tree, so it travels as a JSON object
 * and core's FormDefinition checks it; ops travel as `FormOpList` and are checked when they're applied.
 * Browser-safe.
 */
import { z } from 'zod';
import { FORM_MODES } from '../forms/definition';
import { FormOpList } from '../forms/ops';
import { uuid } from './common';

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
  .record(
    z.string().regex(/^q_[a-z0-9]{8}$/, { error: 'That isn’t a question.' }),
    z.unknown(),
  )
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
  /** The token in a "carry on where you left off" link; null when the form doesn't offer that. */
  resumeToken: z.string().nullable(),
});

export const FormSaveAnswersInput = z.object({
  workspaceId: uuid,
  responseId: uuid,
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
  answers: AnswerSheetInput,
  /** Ticked to allow texts. The box starts unticked, as it does on the booking page. */
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
});

export const FormResponseDeleteInput = z.object({ workspaceId: uuid, responseId: uuid });
export const FormResponseDeleteOutput = z.object({ responseId: uuid, deleted: z.literal(true) });
