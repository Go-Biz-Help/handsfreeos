/** The onboarding setup (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5): the query and the commands. */
import { z } from 'zod';
import { SETUP_KINDS } from '../ai-setup/kinds';
import { BusinessAddress } from '../onboarding-setup/address';
import {
  ONBOARDING_SETUP_MAX,
  ONBOARDING_SETUP_SCREENS,
  OnboardingSetupAnswers,
  OnboardingSetupMark,
} from '../onboarding-setup/answers';
import { OnboardingSetupStateOut } from '../onboarding-setup/state';
import { AiSetupFinishOutput, pageOrigin } from './ai-setup';
import { displayName, email, industry, timezone, uuid } from './common';

const screen = z.enum(ONBOARDING_SETUP_SCREENS);

export const OnboardingSetupGetInput = z.object({ workspaceId: uuid });
export const OnboardingSetupGetOutput = z.object({
  state: OnboardingSetupStateOut,
  /** Where the screens start: what someone answered so far, and today's picks for the rest. */
  answers: OnboardingSetupAnswers,
  /** Today's picks alone, for Start over. */
  starting: OnboardingSetupAnswers,
  /** The furthest screen finished so far; null before anyone started. */
  reached: screen.nullable(),
  started: OnboardingSetupMark.nullable(),
  /** When "Stay in the loop" saved everything. */
  finished: OnboardingSetupMark.nullable(),
});

export const OnboardingSetupSaveInput = z.object({
  workspaceId: uuid,
  /** The screen just finished. */
  screen,
  answers: OnboardingSetupAnswers,
  /** The first screen's answers, saved to the business straight away. Only with screen `business`. */
  business: z
    .object({
      name: displayName.optional(),
      industry: industry.optional(),
      address: BusinessAddress.optional(),
      timezone: timezone.optional(),
      /** As typed, with or without https://. Null: "We don’t have one". Left out: unchanged. */
      website: z.string().trim().max(500).nullable().optional(),
    })
    .optional(),
  /** "Invite them now": invited as team members straight away. Only with screen `goal`. */
  invite: z
    .array(email)
    .max(
      ONBOARDING_SETUP_MAX.invites,
      `Invite at most ${ONBOARDING_SETUP_MAX.invites} people here.`,
    )
    .default(() => []),
});
export type OnboardingSetupSaveInput = z.infer<typeof OnboardingSetupSaveInput>;
export const OnboardingSetupSaveOutput = z.object({
  workspaceId: uuid,
  reached: screen,
  kind: z.enum(SETUP_KINDS),
  /** The kind of business changed, so the picks after the first screen were made again. */
  kindChanged: z.boolean(),
  /** Ava started reading the website. */
  scanStarted: z.boolean(),
  /** Who was invited just now. */
  invited: z.array(z.string()),
  /** What leaving the screen changed in the business, one line each. */
  changes: z.array(z.string()),
  /** What it couldn't do, and how to: "Sam is already in this business." */
  notes: z.array(z.string()),
  /** The booking calendar it made; null when it made none. */
  calendarId: uuid.nullable(),
});

export const OnboardingSetupFinishInput = z.object({
  workspaceId: uuid,
  answers: OnboardingSetupAnswers,
  /**
   * The AI teammate's revision the answers started from, or null when there was no teammate. Someone saving its
   * settings in between is a revision_conflict.
   */
  baseRevision: z.int().min(1).nullable(),
  pageOrigin,
});
export const OnboardingSetupFinishOutput = AiSetupFinishOutput.extend({
  /** Everything that changed, the AI part's and the setup's own, one line each. */
  changes: z.array(z.string()),
});
