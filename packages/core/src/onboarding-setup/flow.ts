/**
 * How the onboarding setup's screens behave, the same on the web and on the phone
 * (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §6): where they open, the first screen's answers, what
 * a screen still needs before Next, and the answers as they're kept. The screens only draw them. Browser-safe.
 */
import {
  aiSetupFlowFactsOf,
  aiSetupProblemsOf,
  cleanAiSetupAnswers,
  type AiSetupProblems,
} from '../ai-setup/flow';
import { BusinessAddress, timeZoneForAddress, type BusinessAddressInput } from './address';
import {
  ONBOARDING_SETUP_SCREEN_FIELDS,
  OnboardingSetupAnswers,
  onboardingSetupNextScreen,
  type OnboardingSetupScreen,
} from './answers';
import { onboardingSetupScreenProblems } from './summary';
import type { OnboardingSetupState } from './state';
import { ONBOARDING_SETUP_WORDS as W } from './words';

/**
 * Where the screens open: the screen after the furthest one finished, or that one when it's the last. A finished
 * setup opens on its last screen.
 */
export function onboardingSetupFirstScreen(got: {
  readonly state: Pick<OnboardingSetupState, 'website' | 'chat'>;
  readonly answers: Pick<OnboardingSetupAnswers, 'booksTime' | 'ai'>;
  readonly reached: OnboardingSetupScreen | null;
  readonly finished: unknown;
}): OnboardingSetupScreen {
  if (got.finished && !got.reached) return 'done';
  if (!got.reached) return 'business';
  return (
    onboardingSetupNextScreen(got.reached, got.answers, aiSetupFlowFactsOf(got.state)) ??
    got.reached
  );
}

/** The first screen's answers, saved to the business straight away. */
export interface OnboardingSetupBusinessDraft {
  readonly name: string;
  readonly industry: string;
  readonly address: BusinessAddressInput;
  /** The time zone, from the address unless someone changed it. */
  readonly timeZone: string;
  /** Someone picked the time zone themselves, so a new address doesn't change it. */
  readonly timeZonePicked: boolean;
  /** As typed, without https://. */
  readonly site: string;
  /** "We don’t have one". */
  readonly noSite: boolean;
}

const bareSite = (url: string | null): string =>
  (url ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '');

/** The first screen to start from: the business as it is. */
export const onboardingSetupBusinessDraftOf = (
  state: Pick<
    OnboardingSetupState,
    'businessName' | 'industry' | 'website' | 'address' | 'timeZone'
  >,
): OnboardingSetupBusinessDraft => ({
  name: state.businessName,
  industry: state.industry ?? '',
  address: state.address ?? { line1: '', line2: '', city: '', state: '', postalCode: '' },
  timeZone: state.timeZone,
  timeZonePicked: false,
  site: bareSite(state.website),
  noSite: false,
});

/** The draft with a new address, and the time zone that goes with it unless someone picked their own. */
export function withBusinessAddress(
  draft: OnboardingSetupBusinessDraft,
  address: BusinessAddressInput,
): OnboardingSetupBusinessDraft {
  const zone = draft.timeZonePicked ? null : timeZoneForAddress(address);
  return { ...draft, address, ...(zone ? { timeZone: zone } : {}) };
}

/** The first screen's answers as `onboarding_setup.save` takes them: no website when there's none, or none typed. */
export function onboardingSetupBusinessOf(draft: OnboardingSetupBusinessDraft) {
  const site = draft.site.trim();
  return {
    name: draft.name.trim(),
    industry: draft.industry,
    address: draft.address,
    timezone: draft.timeZone,
    website: draft.noSite || !site ? null : site,
  };
}

/** A refusal's messages by path into the answers ("ai.services.0.name"), as the API gives them. */
export const onboardingSetupProblemsOf = (details: unknown): AiSetupProblems =>
  aiSetupProblemsOf(details);

/**
 * What a screen still needs before Next, by path: on the first screen the name, what they do and the address; on
 * the others each answer's own checks for the screen's fields, then what `onboardingSetupScreenProblems` says.
 */
export function onboardingSetupScreenProblemsOf(
  screen: OnboardingSetupScreen,
  answers: OnboardingSetupAnswers,
  state: OnboardingSetupState,
  business: Pick<OnboardingSetupBusinessDraft, 'name' | 'industry' | 'address'>,
): AiSetupProblems {
  const out: Record<string, string> = {};
  if (screen === 'business') {
    if (!business.name.trim()) out['business.name'] = W.businessNameMissing;
    if (!business.industry) out['business.industry'] = W.kindMissing;
    const address = BusinessAddress.safeParse(business.address);
    if (!address.success)
      for (const issue of address.error.issues) {
        const path = ['business', 'address', ...issue.path.map(String)].join('.');
        if (!out[path]) out[path] = issue.message;
      }
    return out;
  }
  const fields = ONBOARDING_SETUP_SCREEN_FIELDS[screen];
  const parsed = OnboardingSetupAnswers.safeParse(answers);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const [head, sub] = issue.path.map(String);
      const mine =
        head === 'ai'
          ? (fields.ai as readonly string[]).includes(sub ?? '')
          : (fields.own as readonly string[]).includes(head ?? '');
      const path = issue.path.map(String).join('.');
      if (mine && !out[path]) out[path] = issue.message;
    }
  for (const p of onboardingSetupScreenProblems(
    screen,
    parsed.success ? parsed.data : answers,
    state,
  ))
    if (!out[p.path]) out[p.path] = p.message;
  return out;
}

/**
 * The answers as they're kept: checked (this throws on answers a screen didn't pass), and on "What Ava learned",
 * what's ticked kept and the rest turned down.
 */
export function cleanOnboardingSetupAnswers(
  screen: OnboardingSetupScreen,
  answers: OnboardingSetupAnswers,
  findings: readonly { readonly id: string }[],
): OnboardingSetupAnswers {
  const clean = OnboardingSetupAnswers.parse(answers);
  return screen === 'learned'
    ? { ...clean, ai: cleanAiSetupAnswers('learned', clean.ai, findings) }
    : clean;
}
