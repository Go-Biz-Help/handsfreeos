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
  ONBOARDING_SETUP_SCREENS,
  OnboardingSetupAnswers,
  onboardingSetupNextScreen,
  onboardingSetupScreenApplies,
  onboardingSetupStopOf,
  type OnboardingSetupRecord,
  type OnboardingSetupScreen,
  type OnboardingSetupStop,
} from './answers';
import { onboardingSetupBusinessLine, onboardingSetupScreenProblems } from './summary';
import type { OnboardingSetupState } from './state';
import {
  ONBOARDING_SETUP_HAND_OVER_WORDS as HW,
  ONBOARDING_SETUP_WORDS as W,
  PAY_WITH_LABELS,
} from './words';

/**
 * Where the screens open: the screen after the furthest one finished, or that one when it's the last. A finished
 * setup opens on its last screen.
 */
export function onboardingSetupFirstScreen(got: {
  readonly state: Pick<OnboardingSetupState, 'website' | 'page' | 'chat'>;
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

const screenAt = (s: OnboardingSetupScreen | null) =>
  s ? ONBOARDING_SETUP_SCREENS.indexOf(s) : -1;

/**
 * The screen a link asks for (`?at=paid`, coming back from Stripe), when it's one this business goes through and
 * isn't past where it would open; else where it opens.
 */
export function onboardingSetupOpenAt(
  got: Parameters<typeof onboardingSetupFirstScreen>[0],
  at: string | null | undefined,
): OnboardingSetupScreen {
  const first = onboardingSetupFirstScreen(got);
  const asked = ONBOARDING_SETUP_SCREENS.find((s) => s === at);
  if (
    !asked ||
    screenAt(asked) > screenAt(first) ||
    !onboardingSetupScreenApplies(asked, got.answers, aiSetupFlowFactsOf(got.state))
  )
    return first;
  return asked;
}

/**
 * The owner opens a setup their agency handed over and they haven't finished (the owner's 53A): it opens on what the
 * agency set up, to check, with "Change something" and "Finish my part". Whoever handed it over carries on as before.
 */
export const onboardingSetupChecking = (got: {
  readonly state: Pick<OnboardingSetupState, 'forClient'>;
  readonly handedOver: unknown;
  readonly finished: unknown;
}): boolean => !!got.handedOver && !got.finished && !got.state.forClient;

/**
 * Getting started's card on Home: start the setup, carry on, or for the owner of a business their agency set up,
 * check it and finish (`checkFrom`, the agency's name). Whoever handed it over has nothing left to do there.
 */
export function onboardingSetupHomeOf(
  record: Pick<OnboardingSetupRecord, 'started' | 'finished' | 'handedOver'>,
  userId: string,
): { readonly started: boolean; readonly finished: boolean; readonly checkFrom: string | null } {
  const handedOver = record.finished ? null : (record.handedOver ?? null);
  return {
    started: !!record.started,
    finished: !!record.finished || handedOver?.by === userId,
    checkFrom: handedOver && handedOver.by !== userId ? handedOver.agency : null,
  };
}

/**
 * "Finish my part": the screens only the owner can do, their booking page (it books their time) and payments (they
 * go to their own account), each while it's still to do; then "Stay in the loop", the test chat and what works.
 * `at`, the screen open now, stays in it once done, so a page loaded again on it carries on from there.
 */
export function onboardingSetupOwnerScreens(
  answers: Pick<OnboardingSetupAnswers, 'booksTime' | 'payWith'>,
  state: Pick<OnboardingSetupState, 'booking' | 'payments'>,
  at?: OnboardingSetupScreen,
): OnboardingSetupScreen[] {
  return [
    ...(answers.booksTime && (!state.booking.on || at === 'booking') ? (['booking'] as const) : []),
    ...(answers.payWith !== 'later' && (!state.payments.active || at === 'paid')
      ? (['paid'] as const)
      : []),
    'loop',
    'try',
    'done',
  ];
}

/** The screen after this one in the owner's part, or null after the last. */
export const onboardingSetupOwnerNext = (
  screens: readonly OnboardingSetupScreen[],
  screen: OnboardingSetupScreen,
): OnboardingSetupScreen | null => {
  const at = screens.indexOf(screen);
  return at < 0 ? null : (screens[at + 1] ?? null);
};

/** The screen before this one in the owner's part; null on the first, which goes back to checking it. */
export const onboardingSetupOwnerPrevious = (
  screens: readonly OnboardingSetupScreen[],
  screen: OnboardingSetupScreen,
): OnboardingSetupScreen | null => {
  const at = screens.indexOf(screen);
  return at > 0 ? (screens[at - 1] ?? null) : null;
};

/** Where a screen sits in the owner's part, for "2 of 4". */
export const onboardingSetupOwnerProgress = (
  screens: readonly OnboardingSetupScreen[],
  screen: OnboardingSetupScreen,
): { readonly stop: OnboardingSetupStop; readonly at: number; readonly of: number } => ({
  stop: onboardingSetupStopOf(screen),
  at: Math.max(screens.indexOf(screen), 0) + 1,
  of: screens.length,
});

/** "Your part", where the owner checks it: a line for each thing only they can do. */
export const onboardingSetupOwnerPart = (
  screens: readonly OnboardingSetupScreen[],
  answers: Pick<OnboardingSetupAnswers, 'payWith'>,
): string[] =>
  screens.flatMap((s) =>
    s === 'booking'
      ? [HW.partBooking]
      : s === 'paid'
        ? [HW.partPaid(PAY_WITH_LABELS[answers.payWith])]
        : s === 'loop'
          ? [HW.partLoop]
          : [],
  );

/** The screen each answer is on: the setup's own by name, the AI part's as `ai.<name>`. */
const SCREEN_OF = new Map<string, OnboardingSetupScreen>(
  ONBOARDING_SETUP_SCREENS.flatMap((s) => [
    ...ONBOARDING_SETUP_SCREEN_FIELDS[s].own.map((f) => [f, s] as const),
    ...ONBOARDING_SETUP_SCREEN_FIELDS[s].ai.map((f) => [`ai.${f}`, s] as const),
  ]),
);

/**
 * Fresh answers from the server over the ones on screen: each answer not changed on screen since the last save
 * (`touched`, by the same names: `goal`, `ai.services`) whose screen isn't finished yet. So what Ava reads, and the
 * picks that follow the goal and the kind of business, fill in what's still to come, and never undo what someone
 * typed or a screen they finished. An answer no screen asks (when Ava answers) follows the server.
 */
export function mergeOnboardingSetupAnswers(
  local: OnboardingSetupAnswers,
  fresh: OnboardingSetupAnswers,
  touched: ReadonlySet<string>,
  reached: OnboardingSetupScreen | null,
): OnboardingSetupAnswers {
  const done = screenAt(reached);
  const take = (key: string) => {
    const screen = SCREEN_OF.get(key);
    return !touched.has(key) && (!screen || screenAt(screen) > done);
  };
  const out: Record<string, unknown> = { ...local };
  for (const key of Object.keys(fresh) as (keyof OnboardingSetupAnswers)[])
    if (key !== 'ai' && take(key)) out[key] = fresh[key];
  const ai: Record<string, unknown> = { ...local.ai };
  for (const key of Object.keys(fresh.ai) as (keyof OnboardingSetupAnswers['ai'])[])
    if (take(`ai.${key}`)) ai[key] = fresh.ai[key];
  return { ...(out as OnboardingSetupAnswers), ai: ai as OnboardingSetupAnswers['ai'] };
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

/** The first screen before the business is made, right after signing up. */
export const NEW_ONBOARDING_SETUP_BUSINESS: OnboardingSetupBusinessDraft = {
  name: '',
  industry: '',
  address: { line1: '', line2: '', city: '', state: '', postalCode: '' },
  timeZone: 'America/Chicago',
  timeZonePicked: false,
  site: '',
  noSite: false,
};

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

/** The summary's first line while the first screen is typed, before it's saved: "Bella: Hair salon in Denver, …". */
export function onboardingSetupDraftLine(draft: OnboardingSetupBusinessDraft): string {
  const city = draft.address.city.trim();
  return onboardingSetupBusinessLine({
    businessName: draft.name.trim() || W.unnamed,
    industry: draft.industry || null,
    address: city && draft.address.state ? { city, state: draft.address.state } : null,
    timeZone: draft.timeZone,
  });
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

/** What the first screen still needs before Next, by path: the name, what they do and the address. */
export function onboardingSetupBusinessProblemsOf(
  business: Pick<OnboardingSetupBusinessDraft, 'name' | 'industry' | 'address'>,
): AiSetupProblems {
  const out: Record<string, string> = {};
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

/**
 * What a screen still needs before Next, by path: on the first screen `onboardingSetupBusinessProblemsOf`; on the
 * others each answer's own checks for the screen's fields, then what `onboardingSetupScreenProblems` says.
 */
export function onboardingSetupScreenProblemsOf(
  screen: OnboardingSetupScreen,
  answers: OnboardingSetupAnswers,
  state: OnboardingSetupState,
  business: Pick<OnboardingSetupBusinessDraft, 'name' | 'industry' | 'address'>,
): AiSetupProblems {
  if (screen === 'business') return onboardingSetupBusinessProblemsOf(business);
  const out: Record<string, string> = {};
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
