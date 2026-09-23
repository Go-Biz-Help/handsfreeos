/**
 * Automations' "Repeated corrections": adding the line of guidance the worker made of them to what the AI knows.
 */
import { z } from 'zod';
import { uuid } from './common';

export const TeammateLessonApplyInput = z.object({
  workspaceId: uuid,
  lessonId: uuid,
  /** The line as a person corrected it, when the suggested one needs a tweak. */
  line: z.string().trim().min(1, 'Write the line to add.').max(300).optional(),
});
export const TeammateLessonApplyOutput = z.object({
  lessonId: uuid,
  /** The line that was added to the business's policies. */
  line: z.string(),
});
