/** Getting started (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md): the status query and the commands. */
import { z } from 'zod';
import { OnboardingAnswersSchema } from '../onboarding/settings';
import {
  BUSINESS_STEPS,
  CUSTOMER_SOURCES,
  ONBOARDING_GOALS,
  PERSONAL_STEPS,
  STEP_STATES,
  TEAM_SIZES,
} from '../onboarding/steps';
import { isoDateTime, uuid } from './common';

export const onboardingStepKey = z.enum([...BUSINESS_STEPS, ...PERSONAL_STEPS]);

/** What only the device knows: the browser the person's sign-in methods, the phone itself and its notifications. */
export const OnboardingDeviceFacts = z.object({
  signIn: z.boolean().optional(),
  app: z.boolean().optional(),
  notifications: z.boolean().optional(),
});

export const OnboardingStatusInput = z.object({
  workspaceId: uuid,
  device: OnboardingDeviceFacts.optional(),
});

export const OnboardingStepOut = z.object({
  key: onboardingStepKey,
  group: z.enum(['basics', 'later', 'yours']),
  mustDo: z.boolean(),
  state: z.enum(STEP_STATES),
  since: isoDateTime.nullable(),
  note: z.object({
    phase: z.string().optional(),
    number: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    provider: z.string().nullable().optional(),
    count: z.number().int().optional(),
    partsDone: z.number().int().optional(),
    partsTotal: z.number().int().optional(),
  }),
});

export const OnboardingStatusOutput = z.object({
  workspaceId: uuid,
  /** `business` for someone who sets the business up; `personal` for a teammate, who sees only their own list. */
  audience: z.enum(['business', 'personal']),
  /** False when an owner or admin turned Getting started off for the whole business: nobody there sees it. */
  enabled: z.boolean(),
  answers: OnboardingAnswersSchema.nullable(),
  website: z.string().nullable(),
  steps: z.array(OnboardingStepOut),
  done: z.number().int(),
  total: z.number().int(),
  skipped: z.number().int(),
  complete: z.boolean(),
  next: onboardingStepKey.nullable(),
  view: z.object({
    hidden: z.boolean(),
    tourDoneAt: isoDateTime.nullable(),
    finishedAt: isoDateTime.nullable(),
    /** On for the business, and this person hasn't finished or hidden it: the guide shows on Home. */
    show: z.boolean(),
  }),
});

export const OnboardingSaveAnswersInput = z.object({
  workspaceId: uuid,
  goal: z.enum(ONBOARDING_GOALS),
  customersIn: z.enum(CUSTOMER_SOURCES),
  teamSize: z.enum(TEAM_SIZES),
  /** "What's your website?" As typed, with or without https://. Null: "We don't have one". Left out: unchanged. */
  website: z.string().trim().max(500).nullable().optional(),
});
export const OnboardingSaveAnswersOutput = z.object({
  workspaceId: uuid,
  answers: OnboardingAnswersSchema,
  website: z.string().nullable(),
});

export const OnboardingSkipInput = z.object({
  workspaceId: uuid,
  step: onboardingStepKey,
  /** False brings a skipped step back. */
  skipped: z.boolean().default(true),
});
export const OnboardingSkipOutput = z.object({
  workspaceId: uuid,
  step: onboardingStepKey,
  skipped: z.boolean(),
  changed: z.boolean(),
});

export const OnboardingAsYouGoInput = z.object({
  workspaceId: uuid,
  asYouGo: z.boolean().default(true),
});
export const OnboardingAsYouGoOutput = z.object({
  workspaceId: uuid,
  asYouGo: z.boolean(),
  changed: z.boolean(),
});

export const OnboardingSetViewInput = z
  .object({
    workspaceId: uuid,
    /** Hide the guide from Home, or show it again from Get help. */
    hidden: z.boolean().optional(),
    /** The tour was finished or skipped. */
    tourDone: z.boolean().optional(),
  })
  .refine((v) => v.hidden !== undefined || v.tourDone !== undefined, {
    error: 'Nothing to change.',
  });
export const OnboardingSetViewOutput = z.object({
  workspaceId: uuid,
  hidden: z.boolean(),
  tourDoneAt: isoDateTime.nullable(),
});

export const OnboardingFinishInput = z.object({
  workspaceId: uuid,
  device: OnboardingDeviceFacts.optional(),
});
export const OnboardingFinishOutput = z.object({
  workspaceId: uuid,
  finishedAt: isoDateTime,
});

/** "Email me a link" on the phone: the page that does one step on this person's list, sent to their email. */
export const OnboardingSendLinkInput = z.object({
  workspaceId: uuid,
  step: onboardingStepKey,
});
export const OnboardingSendLinkOutput = z.object({
  workspaceId: uuid,
  step: onboardingStepKey,
  /** The address it went to. */
  email: z.string(),
  /** False when the same link went a moment ago: that one is still on its way. */
  sent: z.boolean(),
});

/** Getting started on or off for the whole business (Settings → Workspace). */
export const OnboardingSetEnabledInput = z.object({
  workspaceId: uuid,
  enabled: z.boolean(),
});
export const OnboardingSetEnabledOutput = z.object({
  workspaceId: uuid,
  enabled: z.boolean(),
  changed: z.boolean(),
});
