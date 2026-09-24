/**
 * Automations' "Learn from corrections": adding the line of guidance the worker made of them to what the AI knows.
 */
import { z } from 'zod';
import { LESSON_PLACES } from '../knowledge/lessons';
import { uuid } from './common';

/** A lesson that goes against what the AI knows (app.teammate_lessons.conflict). */
export const LessonConflictSchema = z.object({
  place: z.enum(LESSON_PLACES),
  itemId: uuid.nullable(),
  where: z.string().trim().min(1).max(200),
  existing: z.string().trim().min(1).max(500),
  replacement: z.string().trim().max(500),
  explain: z.string().trim().min(1).max(300),
});

export const TeammateLessonApplyInput = z.object({
  workspaceId: uuid,
  lessonId: uuid,
  /** The line as a person corrected it, when the suggested one needs a tweak. */
  line: z.string().trim().min(1, 'Write the line to add.').max(300).optional(),
  /**
   * When the lesson goes against what the AI knows: true puts the new words in place of the old ones. It has to
   * be said; keeping the old ones is dismissing the lesson.
   */
  replace: z.boolean().optional(),
});
export const TeammateLessonApplyOutput = z.object({
  lessonId: uuid,
  /** The line that was added to the business's policies. */
  line: z.string(),
  /** The old words it took the place of, and where; null when nothing said otherwise (any more). */
  replaced: z
    .object({
      where: z.string(),
      before: z.string(),
      after: z.string(),
    })
    .nullable(),
});
