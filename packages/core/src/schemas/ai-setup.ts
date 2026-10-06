/** Quick setup for the AI teammate (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5): the query and the commands. */
import { z } from 'zod';
import { AI_SETUP_STEPS, AiSetupAnswers, AiSetupMark } from '../ai-setup/answers';
import { SETUP_KINDS } from '../ai-setup/kinds';
import { AiSetupStateOut } from '../ai-setup/state';
import { displayName, industry, uuid } from './common';

const step = z.enum(AI_SETUP_STEPS);

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

export const AiSetupFinishInput = z.object({
  workspaceId: uuid,
  answers: AiSetupAnswers,
  /**
   * The teammate's revision the answers started from, or null when there was no teammate. Someone saving its
   * settings in between is a revision_conflict.
   */
  baseRevision: z.int().min(1).nullable(),
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
