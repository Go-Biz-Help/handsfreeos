/**
 * What the onboarding setup picks before anyone answers, and where it carries on from
 * (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4–§5). Browser-safe: `onboarding_setup.get` gives the
 * screens these, and the commands work them out again the same way.
 */
import type { AiSetupAnswers } from '../ai-setup/answers';
import { SETUP_JOBS, type SetupJob, type SetupKind } from '../ai-setup/kinds';
import { startingAiSetupAnswers, startingJobs, type AiSetupTemplate } from '../ai-setup/plan';
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

/**
 * The jobs Ava starts with ticked: its goal's and its kind's, with booking when customers book a time and never
 * when they don't, since then there's no booking page to book on.
 */
export function onboardingJobs(
  goal: OnboardingGoal,
  kind: SetupKind,
  booksTime: boolean,
): SetupJob[] {
  const on = new Set<SetupJob>(startingJobs(goal, kind));
  if (booksTime) on.add('book');
  else on.delete('book');
  return SETUP_JOBS.filter((j) => on.has(j));
}

/** The setup's own answers before anyone answers: what the business said before, else its kind's picks. */
export function startingOwnAnswers(state: OnboardingSetupState): OnboardingSetupAnswers {
  const booksTime = booksTimeOf(state);
  const c = state.customers;
  return OnboardingSetupAnswers.parse({
    goal: state.goal ?? goalFor(booksTime),
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
    payWith: state.payments.provider ?? 'later',
    reviewLink: state.reviewLink ?? '',
  });
}

/**
 * The AI part's answers before anyone answers them: the AI quick setup's picks (`startingAiSetupAnswers`) for the
 * goal and booking answered so far. A business with a teammate, or an agency's saved answers, keeps its own jobs.
 */
export function startingAiAnswers(
  state: OnboardingSetupState,
  own: Pick<OnboardingSetupAnswers, 'goal' | 'booksTime'>,
  template: Partial<AiSetupTemplate> | null = null,
): AiSetupAnswers {
  const picks = startingAiSetupAnswers({ ...state, goal: own.goal }, template);
  if (state.teammate || template?.jobs) return picks;
  return { ...picks, jobs: onboardingJobs(own.goal, state.kind, own.booksTime) };
}

/** Every answer picked before anyone answers, for Start over. */
export function startingOnboardingSetupAnswers(
  state: OnboardingSetupState,
  template: Partial<AiSetupTemplate> | null = null,
): OnboardingSetupAnswers {
  const own = startingOwnAnswers(state);
  return { ...own, ai: startingAiAnswers(state, own, template) };
}

/**
 * Where to carry on from: the answers given on the screens finished so far, and today's picks for the rest. The AI
 * part's picks follow the goal and booking answers kept, so ticking Getting booked ticks Book for Ava.
 */
export function resumeOnboardingSetup(
  state: OnboardingSetupState,
  record: Pick<OnboardingSetupRecord, 'draft' | 'reached' | 'kind'>,
  template: Partial<AiSetupTemplate> | null = null,
): OnboardingSetupAnswers {
  const own = resumeOwnAnswers(startingOwnAnswers(state), record, state.kind);
  return {
    ...own,
    ai: resumeAiAnswers(startingAiAnswers(state, own, template), record, state.kind),
  };
}
