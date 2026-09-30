/**
 * What Getting started keeps. Browser-safe.
 *
 * - The business's answers and skips live in `workspaces.settings.onboarding`, written only by the onboarding
 *   commands (`workspace.update` refuses the key), because a second owner and the agency need to see them.
 * - One person's view lives in `users.settings.onboarding`, keyed by business: whether they hid the guide, when
 *   they finished it or the tour, and their own skips.
 * - An owner or admin can turn the guide off for the whole business (`turnedOff`): then nobody there sees it, the
 *   setup wizard or the tour, whatever their own view says.
 *
 * Both are read forgivingly: a part that doesn't parse is treated as never set, and the rest still counts.
 */
import { z } from 'zod';
import {
  BUSINESS_STEPS,
  CUSTOMER_SOURCES,
  ONBOARDING_GOALS,
  PERSONAL_STEPS,
  TEAM_SIZES,
  type BusinessStepKey,
  type OnboardingAnswers,
  type PersonalStepKey,
} from './steps';

export const ONBOARDING_SETTINGS_KEY = 'onboarding';

export const OnboardingAnswersSchema = z.object({
  goal: z.enum(ONBOARDING_GOALS),
  customersIn: z.enum(CUSTOMER_SOURCES),
  teamSize: z.enum(TEAM_SIZES),
});

/** Who did it, and when. */
export const OnboardingMark = z.object({ at: z.iso.datetime(), by: z.uuid() });
export type OnboardingMark = z.infer<typeof OnboardingMark>;

export interface BusinessOnboarding {
  readonly answers: OnboardingAnswers | null;
  readonly skipped: Partial<Record<BusinessStepKey, OnboardingMark>>;
  /** "Add them as you go" on the customers step. */
  readonly customersAsYouGo: OnboardingMark | null;
  /** Turned off for everyone in the business, by an owner or admin. */
  readonly turnedOff: OnboardingMark | null;
}

export interface PersonalOnboarding {
  readonly hidden: boolean;
  readonly tourDoneAt: string | null;
  /** Set once, the first time every step on this person's list was done or skipped. */
  readonly finishedAt: string | null;
  readonly skipped: Partial<Record<PersonalStepKey, string>>;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const parsed = <T>(schema: z.ZodType<T>, v: unknown, fallback: T): T => {
  const r = schema.safeParse(v);
  return r.success ? r.data : fallback;
};

/** A business's answers and skips, from its settings. */
export function businessOnboardingOf(
  settings: Record<string, unknown> | null | undefined,
): BusinessOnboarding {
  const raw = asRecord(settings?.[ONBOARDING_SETTINGS_KEY]);
  const skipped: Partial<Record<BusinessStepKey, OnboardingMark>> = {};
  for (const [key, mark] of Object.entries(asRecord(raw['skipped'])))
    if ((BUSINESS_STEPS as readonly string[]).includes(key)) {
      const m = OnboardingMark.safeParse(mark);
      if (m.success) skipped[key as BusinessStepKey] = m.data;
    }
  return {
    answers: parsed(OnboardingAnswersSchema.nullable(), raw['answers'] ?? null, null),
    skipped,
    customersAsYouGo: parsed(OnboardingMark.nullable(), raw['customersAsYouGo'] ?? null, null),
    turnedOff: parsed(OnboardingMark.nullable(), raw['turnedOff'] ?? null, null),
  };
}

const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(new Date(v).getTime()) ? v : null;

/** One person's view of one business's guide, from their own settings. */
export function personalOnboardingOf(
  userSettings: Record<string, unknown> | null | undefined,
  workspaceId: string,
): PersonalOnboarding {
  const raw = asRecord(asRecord(userSettings?.[ONBOARDING_SETTINGS_KEY])[workspaceId]);
  const skipped: Partial<Record<PersonalStepKey, string>> = {};
  for (const [key, at] of Object.entries(asRecord(raw['skipped'])))
    if ((PERSONAL_STEPS as readonly string[]).includes(key) && isoOrNull(at))
      skipped[key as PersonalStepKey] = at as string;
  return {
    hidden: raw['hidden'] === true,
    tourDoneAt: isoOrNull(raw['tourDoneAt']),
    finishedAt: isoOrNull(raw['finishedAt']),
    skipped,
  };
}

/** The whole of `users.settings.onboarding` with one business's entry replaced, the others kept as they were. */
export function withPersonalOnboarding(
  userSettings: Record<string, unknown> | null | undefined,
  workspaceId: string,
  next: PersonalOnboarding,
): Record<string, unknown> {
  return {
    ...asRecord(userSettings?.[ONBOARDING_SETTINGS_KEY]),
    [workspaceId]: {
      ...(next.hidden ? { hidden: true } : {}),
      ...(next.tourDoneAt ? { tourDoneAt: next.tourDoneAt } : {}),
      ...(next.finishedAt ? { finishedAt: next.finishedAt } : {}),
      ...(Object.keys(next.skipped).length ? { skipped: next.skipped } : {}),
    },
  };
}

/** What's stored for a business, with nothing empty kept. */
export function storedBusinessOnboarding(next: BusinessOnboarding): Record<string, unknown> {
  return {
    ...(next.answers ? { answers: next.answers } : {}),
    ...(Object.keys(next.skipped).length ? { skipped: next.skipped } : {}),
    ...(next.customersAsYouGo ? { customersAsYouGo: next.customersAsYouGo } : {}),
    ...(next.turnedOff ? { turnedOff: next.turnedOff } : {}),
  };
}
