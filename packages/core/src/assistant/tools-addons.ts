/**
 * What HandsFreeOS can do here, for the Assistant (docs/addon-readiness-audit.md §8). The answer is worked out in
 * code from what the business has on and what the person may use (packages/core/src/addons/ai.ts), never from the
 * prompt: what they can do now, what an owner or admin can give them or turn back on, and — only for people who can
 * add add-ons, only when nothing here does what they asked — an add-on that would. Planned add-ons are never offered as
 * something to add. The add-ons' own tools aren't listed here: the Assistant derives them from their operations.
 */
import { z } from 'zod';
import { define } from './tool-kit';

export const addonTools = [
  define({
    name: 'find_capabilities',
    description:
      'What HandsFreeOS can do for this person here, worked out from the features and add-ons this business has on: what they can do now (best matches for their need first), what is here but not theirs (an owner or admin can give them access), and what is installed but turned off (an owner or admin can turn it back on). For someone who can add add-ons it may also name up to two add-ons that would do what they asked, when nothing here does. Call it when they ask what HandsFreeOS can do or whether it can do something, and before saying you can’t do something they asked for, with their need in their words.',
    input: z.object({
      need: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe('What they want to do, in their own words'),
      includePlanned: z
        .boolean()
        .default(false)
        .describe(
          'Also list what is planned and not available yet: only when they ask what is coming',
        ),
    }),
    autonomy: 'auto',
    permission: 'assistant.use',
  }),
] as const;
