/**
 * What the onboarding setup picks before anyone answers, and where it carries on from
 * (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4–§5). Browser-safe: `onboarding_setup.get` gives the
 * screens these, and the commands work them out again the same way.
 */
import type { AiSetupAnswers } from '../ai-setup/answers';
import { SETUP_JOBS, type SetupJob, type SetupKind } from '../ai-setup/kinds';
import {
  AI_SETUP_TEMPLATE_FIELDS,
  startingAiSetupAnswers,
  startingJobs,
  type AiSetupTemplate,
} from '../ai-setup/plan';
import type { SavedSetupStart } from '../ai-setup/templates';
import type { OnboardingGoal } from '../onboarding/steps';
import {
  OnboardingSetupAnswers,
  resumeAiAnswers,
  resumeOwnAnswers,
  type OnboardingSetupRecord,
} from './answers';
import { ONBOARDING_KIND_INFO } from './kinds';
import type { OnboardingSetupState } from './state';

/** Customers book a time: a calendar customers can book is on already, else the kind of business says so. */
export const booksTimeOf = (state: Pick<OnboardingSetupState, 'kind' | 'calendars'>): boolean =>
  state.calendars.length > 0 || ONBOARDING_KIND_INFO[state.kind].booksTime;

/** Getting booked for a business whose customers book a time, else Answering leads fast. */
export const goalFor = (booksTime: boolean): OnboardingGoal => (booksTime ? 'booked' : 'leads');

/** The jobs with booking when customers book a time, and never when they don't: then there's nothing to book on. */
function withBooking(jobs: readonly SetupJob[], booksTime: boolean): SetupJob[] {
  const on = new Set<SetupJob>(jobs);
  if (booksTime) on.add('book');
  else on.delete('book');
  return SETUP_JOBS.filter((j) => on.has(j));
}

/** The jobs Ava starts with ticked: its goal's and its kind's, with booking only when customers book a time. */
export const onboardingJobs = (
  goal: OnboardingGoal,
  kind: SetupKind,
  booksTime: boolean,
): SetupJob[] => withBooking(startingJobs(goal, kind), booksTime);

/**
 * Answers a business starts from that its agency saved (the owner's 54A): the AI teammate's, and the setup's own
 * goal and how customers pay. Never anything about the business they were saved from.
 */
export interface OnboardingSetupSaved {
  readonly answers: Partial<AiSetupTemplate>;
  readonly start: SavedSetupStart;
}

/**
 * The setup's own answers before anyone answers: what the business said before, else what its agency saved, else
 * its kind's picks.
 */
export function startingOwnAnswers(
  state: OnboardingSetupState,
  start: SavedSetupStart = {},
): OnboardingSetupAnswers {
  const booksTime = booksTimeOf(state);
  const c = state.customers;
  return OnboardingSetupAnswers.parse({
    goal: state.goal ?? start.goal ?? goalFor(booksTime),
    teamSize: state.quick?.teamSize ?? (state.team.members > 1 ? 'small' : 'solo'),
    booksTime,
    customersIn:
      state.quick?.customersIn ??
      (c.running === 'migration'
        ? 'ghl'
        : c.running === 'import' || c.count > 0
          ? 'sheet'
          : 'none'),
    hasEin: null,
    payWith: state.payments.provider ?? start.payWith ?? 'later',
    reviewLink: state.reviewLink ?? '',
  });
}

/**
 * The AI part's answers before anyone answers them: the AI quick setup's picks (`startingAiSetupAnswers`) for the
 * goal and booking answered so far. A business with a teammate keeps its own jobs; an agency's saved answers keep
 * theirs, with booking only when this business's customers book a time.
 */
export function startingAiAnswers(
  state: OnboardingSetupState,
  own: Pick<OnboardingSetupAnswers, 'goal' | 'booksTime'>,
  template: Partial<AiSetupTemplate> | null = null,
): AiSetupAnswers {
  const picks = startingAiSetupAnswers({ ...state, goal: own.goal }, template);
  if (state.teammate) return picks;
  if (template?.jobs) return { ...picks, jobs: withBooking(picks.jobs, own.booksTime) };
  return { ...picks, jobs: onboardingJobs(own.goal, state.kind, own.booksTime) };
}

/** Every answer picked before anyone answers, for Start over. */
export function startingOnboardingSetupAnswers(
  state: OnboardingSetupState,
  saved: OnboardingSetupSaved | null = null,
): OnboardingSetupAnswers {
  const own = startingOwnAnswers(state, saved?.start);
  return { ...own, ai: startingAiAnswers(state, own, saved?.answers ?? null) };
}

/**
 * Where to carry on from: the answers given on the screens finished so far, and today's picks for the rest. The AI
 * part's picks follow the goal and booking answers kept, so ticking Getting booked ticks Book for Ava.
 */
export function resumeOnboardingSetup(
  state: OnboardingSetupState,
  record: Pick<OnboardingSetupRecord, 'draft' | 'reached' | 'kind'>,
  saved: OnboardingSetupSaved | null = null,
): OnboardingSetupAnswers {
  const own = resumeOwnAnswers(startingOwnAnswers(state, saved?.start), record, state.kind);
  return {
    ...own,
    ai: resumeAiAnswers(startingAiAnswers(state, own, saved?.answers ?? null), record, state.kind),
  };
}

/**
 * The answers with what saved answers set (or, with none, today's picks) in place of what was answered: picking
 * where to start from on the first screen picks those answers again, as the AI quick setup's Start from does.
 */
export function withOnboardingSetupSaved(
  answers: OnboardingSetupAnswers,
  state: OnboardingSetupState,
  saved: OnboardingSetupSaved | null,
): OnboardingSetupAnswers {
  const start = startingOwnAnswers(state, saved?.start);
  const own = { ...answers, goal: start.goal, payWith: start.payWith };
  const ai = startingAiAnswers(state, own, saved?.answers ?? null);
  return {
    ...own,
    ai: {
      ...answers.ai,
      ...Object.fromEntries(AI_SETUP_TEMPLATE_FIELDS.map((f) => [f, ai[f]])),
    },
  };
}
