/** The onboarding setup (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5): the query and the commands. */
import { z } from 'zod';
import { SETUP_KINDS } from '../ai-setup/kinds';
import { BusinessAddress } from '../onboarding-setup/address';
import {
  HAND_OVER_ROLES,
  ONBOARDING_SETUP_MAX,
  ONBOARDING_SETUP_SCREENS,
  OnboardingSetupAnswers,
  OnboardingSetupHandOver,
  OnboardingSetupMark,
} from '../onboarding-setup/answers';
import { OnboardingSetupStateOut } from '../onboarding-setup/state';
import { AiSetupFinishOutput, AiSetupTemplateOption, pageOrigin } from './ai-setup';
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
  /** When the business's agency handed it to the owner to check and finish (the owner's 53A). */
  handedOver: OnboardingSetupHandOver.nullable().default(null),
  /**
   * Someone from the agency setting it up (`state.forClient`): what handing it over invites the owner as. Only an
   * owner of the business (an owner of the agency) can make someone an owner; anyone else invites an admin.
   */
  handOverAs: z.enum(HAND_OVER_ROLES).nullable().default(null),
  /** When "Stay in the loop" saved everything, by someone on the business's own team. */
  finished: OnboardingSetupMark.nullable(),
  /** The agency's saved answers this business may start from, by name (the owner's 54A); none once it has a teammate. */
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
  /**
   * The agency's saved answers to start from, picked on the first screen, or null for our picks. Left out: as
   * before. Only with screen `business`, and only while the business has no teammate.
   */
  templateId: uuid.nullable().optional(),
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
  /**
   * Someone from the business's agency hands it to the owner (the owner's 53A): the owner's email to invite them to
   * check it and finish, or null to invite them later from Members. Only for someone not on the business's team.
   */
  owner: z.object({ email: email.nullable() }).optional(),
});
export const OnboardingSetupFinishOutput = AiSetupFinishOutput.extend({
  /** Everything that changed, the AI part's and the setup's own, one line each. */
  changes: z.array(z.string()),
  /** Handed to the owner to check and finish; null when the owner finished it. */
  handedOver: OnboardingSetupHandOver.nullable().default(null),
});
