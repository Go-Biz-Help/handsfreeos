/**
 * Quick setup's saved answers (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §9): an agency keeps the answers one
 * client business gave, only those that aren't about that business (`AI_SETUP_TEMPLATE_FIELDS`), as a starting point
 * for its others (the owner's 58B). A business without a teammate starts from the ones picked on the first screen,
 * else from the newest saved for its kind of business. The onboarding setup starts from them too, with what they set
 * for its own questions beside them: the goal and how customers pay (`SavedSetupStart`, the owner's 54A).
 * Browser-safe.
 */
import { z } from 'zod';
import { formatHours } from '../calendar/format';
import { PAY_WITH, type PayWith } from '../onboarding-setup/answers';
import { ONBOARDING_GOALS, type OnboardingGoal } from '../onboarding/steps';
import { QUESTION_WORDS } from '../onboarding/words';
import { AiSetupAnswers } from './answers';
import { SETUP_JOBS, type SetupJob, type SetupKind } from './kinds';
import { AI_SETUP_TEMPLATE_FIELDS, startingAiSetupAnswers, type AiSetupTemplate } from './plan';
import type { AiSetupState } from './state';
import { AI_SETUP_TONE_LABELS } from './words';

/** What each kind of business is called where an agency's saved answers are listed. */
export const SETUP_KIND_LABELS: Readonly<Record<SetupKind, string>> = {
  home: 'Home services',
  salon: 'Salons and spas',
  fitness: 'Fitness',
  health: 'Health care',
  pets: 'Pet care',
  auto: 'Auto',
  lessons: 'Lessons and childcare',
  real_estate: 'Real estate agents',
  property: 'Property management',
  insurance: 'Insurance agents',
  legal_money: 'Legal and financial',
  professional: 'Professional services',
  events: 'Events',
  food: 'Food and restaurants',
  stays: 'Stays and travel',
  rentals: 'Rentals',
  retail: 'Shops',
  community: 'Nonprofits and churches',
  other: 'Other businesses',
};

const pick = (answers: AiSetupAnswers): AiSetupTemplate =>
  Object.fromEntries(AI_SETUP_TEMPLATE_FIELDS.map((f) => [f, answers[f]])) as AiSetupTemplate;

/**
 * Saved answers as kept, each one that still reads on its own: one that doesn't, and a tone that was the
 * business's own words, are left to the business's own picks.
 */
export function aiSetupTemplateOf(stored: unknown): Partial<AiSetupTemplate> {
  const raw =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const field of AI_SETUP_TEMPLATE_FIELDS) {
    if (raw[field] === undefined) continue;
    const r = AiSetupAnswers.shape[field].safeParse(raw[field]);
    if (r.success && !(field === 'tone' && r.data === 'keep')) out[field] = r.data;
  }
  return out as Partial<AiSetupTemplate>;
}

/**
 * What an agency keeps from a business with a teammate: the answers it was set up with that aren't about it. A tone
 * the business wrote in its own words, and questions for leads its teammate doesn't ask, stay with the business:
 * another one starts from its own.
 */
export function aiSetupTemplateOfBusiness(state: AiSetupState): Partial<AiSetupTemplate> {
  const out: Partial<AiSetupTemplate> = pick(startingAiSetupAnswers(state));
  if (out.tone === 'keep') delete out.tone;
  if (!state.teammate?.config.qualify.questions.length) delete out.questions;
  return out;
}

/**
 * The answers with what saved answers set (or, with none, the business's own picks) in place of what was answered:
 * picking where to start from on the first screen picks those answers again.
 */
export function withAiSetupTemplate(
  answers: AiSetupAnswers,
  state: AiSetupState,
  template: Partial<AiSetupTemplate> | null,
): AiSetupAnswers {
  return { ...answers, ...pick(startingAiSetupAnswers(state, template)) };
}

/** The saved answers a business starts from while nobody picked: the newest saved for its kind, else none. */
export function defaultAiSetupTemplate<
  T extends { readonly kind: string; readonly updatedAt: string },
>(templates: readonly T[], kind: SetupKind): T | null {
  let best: T | null = null;
  for (const t of templates)
    if (t.kind === kind && (!best || t.updatedAt > best.updatedAt)) best = t;
  return best;
}

/**
 * The saved answers the screens start from: those picked on the first screen (null: our picks), else, while nobody
 * picked, the newest saved for the kind of business. Ones removed since they were picked leave our picks.
 */
export function chosenAiSetupTemplate<
  T extends { readonly id: string; readonly kind: string; readonly updatedAt: string },
>(templates: readonly T[], picked: string | null | undefined, kind: SetupKind): T | null {
  if (picked === undefined) return defaultAiSetupTemplate(templates, kind);
  return templates.find((t) => t.id === picked) ?? null;
}

const JOB_WORDS: Readonly<Record<SetupJob, string>> = {
  reply: 'replies to new leads',
  answer: 'answers questions',
  book: 'books appointments',
  qualify: 'asks qualifying questions',
  follow_up: 'follows up',
};

/** What saved answers set, in a line: "Max · Friendly · Replies to new leads, answers questions, follows up". */
export function aiSetupTemplateAbout(template: Partial<AiSetupTemplate>): string {
  const jobs = SETUP_JOBS.filter((j) => template.jobs?.includes(j)).map((j) => JOB_WORDS[j]);
  const does = jobs.join(', ');
  return [
    template.name?.trim() || null,
    template.tone ? AI_SETUP_TONE_LABELS[template.tone] : null,
    does ? does.charAt(0).toUpperCase() + does.slice(1) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * What saved answers set for the onboarding setup's own questions (the owner's 54A): what to help with first, and how
 * customers pay. They're kept beside the AI teammate's answers and read the same forgiving way. Never anything about
 * one business: its name, address, services, number or customers.
 */
export interface SavedSetupStart {
  readonly goal?: OnboardingGoal;
  readonly payWith?: PayWith;
}

/** The goal and how customers pay, as saved answers keep them, each only while it still reads. */
export function savedSetupStartOf(stored: unknown): SavedSetupStart {
  const raw =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const goal = z.enum(ONBOARDING_GOALS).safeParse(raw['goal']);
  const payWith = z.enum(PAY_WITH).safeParse(raw['payWith']);
  return {
    ...(goal.success ? { goal: goal.data } : {}),
    ...(payWith.success ? { payWith: payWith.data } : {}),
  };
}

const PAY_WORDS: Readonly<Record<PayWith, string>> = {
  stripe: 'Customers pay with Stripe',
  square: 'Customers pay with Square',
  later: 'Payments later',
};

/**
 * What saved answers set for the onboarding setup, in a line: "Getting booked · Open Mon–Fri 8:00 AM–5:00 PM ·
 * Customers pay with Stripe". Empty for answers saved before they kept these.
 */
export function savedSetupBasics(
  template: Pick<Partial<AiSetupTemplate>, 'openHours'>,
  start: SavedSetupStart,
): string {
  return [
    start.goal ? QUESTION_WORDS.goals[start.goal] : null,
    template.openHours?.length ? `Open ${formatHours(template.openHours)}` : null,
    start.payWith ? PAY_WORDS[start.payWith] : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Shared by the web and the phone. `{name}` is the teammate's name (`withAiName`). */
export const AI_SETUP_TEMPLATE_WORDS = {
  /** The first screen's choice, while the agency has saved answers and the business has no teammate. */
  startFrom: 'Start from',
  startFromHint: 'Answers your agency saved. You can change any of them on the next screens.',
  ourPicks: 'Our picks for this kind of business',
  /** After Save, for the agency's owners and admins. */
  saveTitle: 'Save these answers for your other businesses',
  saveHint: (agency: string) =>
    `What you want help with first, your open hours, how customers pay, and what {name} helps with, when it answers, its name, how it says it’s AI, its tone, prices and questions for leads. Nothing else about this business is saved: not its name, address, services, number or customers. ${agency}’s other businesses can start their setup from them.`,
  saveName: 'Name',
  saveAction: 'Save',
  saved: (saved: string) =>
    `Saved as “${saved}”. Your other businesses can start from it on quick setup’s first screen.`,
} as const;
