/** Quick setup for the AI teammate (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5): the query and the commands. */
import { z } from 'zod';
import { AI_SETUP_MAX, AI_SETUP_STEPS, AiSetupAnswers, AiSetupMark } from '../ai-setup/answers';
import { SETUP_KINDS } from '../ai-setup/kinds';
import { AiSetupFound, AiSetupStateOut } from '../ai-setup/state';
import { displayName, industry, isoDateTime, uuid } from './common';

const step = z.enum(AI_SETUP_STEPS);

/** One of an agency's saved answers (§9), as quick setup's first screen offers it. */
export const AiSetupTemplateOption = z.object({
  id: uuid,
  name: z.string(),
  /** The kind of business they were saved from: one of that kind starts from the newest. */
  kind: z.enum(SETUP_KINDS),
  /** What they set for the AI teammate, in a line (`aiSetupTemplateAbout`). */
  about: z.string(),
  /** What they set for the business, in a line (`savedSetupBasics`): the goal, open hours and payments. */
  basics: z.string().default(''),
  updatedAt: isoDateTime,
});
export type AiSetupTemplateOption = z.infer<typeof AiSetupTemplateOption>;

export const AiSetupGetInput = z.object({ workspaceId: uuid });
export const AiSetupGetOutput = z.object({
  state: AiSetupStateOut,
  /** Where the screens start: what someone answered so far, and today's picks for the rest. */
  answers: AiSetupAnswers,
  /** Today's picks alone, for Start over. */
  starting: AiSetupAnswers,
  /** The furthest screen finished so far; null before anyone started, and once it's finished. */
  reached: step.nullable(),
  started: AiSetupMark.nullable(),
  /** The last time someone finished it. */
  finished: AiSetupMark.nullable(),
  runs: z.int(),
  /** The agency's saved answers this business may start from, by name; none once it has a teammate. */
  templates: z.array(AiSetupTemplateOption).default([]),
  /** The saved answers the screens start from: the ones picked on the first screen, else the newest for its kind. */
  templateId: uuid.nullable().default(null),
  /** Someone picked where to start from on the first screen; until then it follows the kind of business. */
  templatePicked: z.boolean().default(false),
  /**
   * Where this person may save these answers for the agency's other businesses: its owners and admins, when it has
   * more than one business.
   */
  saveTo: z.object({ organizationId: uuid, name: z.string() }).nullable().default(null),
});

export const AiSetupSaveInput = z.object({
  workspaceId: uuid,
  /** The screen just finished. */
  step,
  answers: AiSetupAnswers,
  /** The first screen's answers, saved to the business straight away. Only with step `business`. */
  business: z
    .object({
      name: displayName.optional(),
      industry: industry.optional(),
      /** As typed, with or without https://. Null: "We don’t have one". Left out: unchanged. */
      website: z.string().trim().max(500).nullable().optional(),
    })
    .optional(),
  /**
   * The agency's saved answers to start from, picked on the first screen, or null for our picks. Left out: as
   * before. Only with step `business`, and only while the business has no teammate.
   */
  templateId: uuid.nullable().optional(),
});
export type AiSetupSaveInput = z.infer<typeof AiSetupSaveInput>;
export const AiSetupSaveOutput = z.object({
  workspaceId: uuid,
  reached: step,
  kind: z.enum(SETUP_KINDS),
  /** The kind of business changed, so the picks after the first screen were made again. */
  kindChanged: z.boolean(),
  /** Ava started reading the website. */
  scanStarted: z.boolean(),
});

/**
 * Where the business's simple page is, as the app shows its address: https://app.handsfreeos.com, or the business's
 * own domain once it works. A business with no website gets its website chat there.
 */
export const pageOrigin = z.string().trim().max(300).optional();

export const AiSetupFinishInput = z.object({
  workspaceId: uuid,
  answers: AiSetupAnswers,
  /**
   * The teammate's revision the answers started from, or null when there was no teammate. Someone saving its
   * settings in between is a revision_conflict.
   */
  baseRevision: z.int().min(1).nullable(),
  pageOrigin,
});
export const AiSetupFinishOutput = z.object({
  teammateId: uuid,
  revision: z.int(),
  /** What changed, one line each. */
  changes: z.array(z.string()),
  /** The website chat it added, with the key its code needs; null when it added none. */
  chat: z.object({ widgetId: uuid, publicKey: z.string() }).nullable(),
  /** The booking calendar it made; null when it made none. */
  calendarId: uuid.nullable(),
  /** What it couldn't finish, and how to: "Service calls couldn’t be turned on yet. …". */
  notes: z.array(z.string()),
});

export const AiSetupNoteFoundInput = z.object({
  workspaceId: uuid,
  /** The website in Knowledge it read. */
  sourceId: uuid,
  /** `url` is the address it read; it's kept only while that's still the website's address. */
  found: AiSetupFound.omit({ at: true }),
});
export const AiSetupNoteFoundOutput = z.object({
  /** False when the website changed while it was being read. */
  kept: z.boolean(),
});

// ---- An agency's saved answers (§9) ----

const templateName = z
  .string()
  .trim()
  .min(1, 'Name these answers.')
  .max(AI_SETUP_MAX.templateName, `Keep it under ${AI_SETUP_MAX.templateName} characters.`);

export const AiSetupTemplateSaveInput = z.object({
  organizationId: uuid,
  /** The business whose answers are saved: one of the agency's, with an AI teammate. */
  workspaceId: uuid,
  name: templateName,
});
export const AiSetupTemplateSaveOutput = z.object({
  templateId: uuid,
  name: z.string(),
  kind: z.enum(SETUP_KINDS),
});
export const AiSetupTemplateRenameInput = z.object({
  organizationId: uuid,
  templateId: uuid,
  name: templateName,
});
export const AiSetupTemplateRenameOutput = z.object({ templateId: uuid, name: z.string() });
export const AiSetupTemplateDeleteInput = z.object({ organizationId: uuid, templateId: uuid });
export const AiSetupTemplateDeleteOutput = z.object({ templateId: uuid });
export const AiSetupTemplateListInput = z.object({ organizationId: uuid });
export const AiSetupTemplateListOutput = z.object({
  items: z.array(
    AiSetupTemplateOption.extend({
      /** The business they were saved from, while it's still one of the agency's. */
      from: z.object({ workspaceId: uuid, name: z.string() }).nullable(),
      createdAt: isoDateTime,
    }),
  ),
});
