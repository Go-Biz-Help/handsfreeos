/**
 * The onboarding setup's screens and answers, and what the business keeps of them
 * (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4–§5). Browser-safe.
 *
 * - The screens come in stops, as the flow chart draws them. Stop 12, the AI teammate, is the AI quick setup's own
 *   screens, minus the ones already asked: the business, its services and area, and its hours.
 * - The answers are one document, `OnboardingSetupAnswers`: the setup's own, and the AI quick setup's under `ai`,
 *   since "About your business" and "When are you open?" answer the AI part's questions too. Every field is picked
 *   before anyone answers (`startingOnboardingSetupAnswers`), so a screen only ever changes what it shows.
 * - While someone is part way through, the business keeps their answers and the furthest screen they finished in
 *   `workspaces.settings.onboardingSetup`, written only by the setup's own commands (`workspace.update` refuses the
 *   key), so they can stop on the computer and carry on from the phone. It is read forgivingly: answers that no
 *   longer parse count as never given.
 */
import { z } from 'zod';
import {
  AI_SETUP_KIND_FIELDS,
  AiSetupAnswers,
  aiSetupStepApplies,
  type AiSetupFlowFacts,
  type AiSetupStep,
} from '../ai-setup/answers';
import { SETUP_KINDS, type SetupKind } from '../ai-setup/kinds';
import { CUSTOMER_SOURCES, ONBOARDING_GOALS, TEAM_SIZES } from '../onboarding/steps';
import { canActOnRole, type WorkspaceRole } from '../permissions';

export const ONBOARDING_SETUP_SETTINGS_KEY = 'onboardingSetup';

/** The screens, in order. Signing up comes first and makes the business, so it isn't one of these. */
export const ONBOARDING_SETUP_SCREENS = [
  'business',
  'goal',
  'about',
  'hours',
  'look',
  'page',
  'customers',
  'booking',
  'number',
  'paid',
  'jobs',
  'facts',
  'meet',
  'voice',
  'learned',
  'qualify',
  'chat',
  'loop',
  'try',
  'done',
] as const;
export type OnboardingSetupScreen = (typeof ONBOARDING_SETUP_SCREENS)[number];

/** The stops the screens come in, for "3 of 15"; the AI teammate's is several screens. */
export const ONBOARDING_SETUP_STOPS = [
  { key: 'signup', screens: [] },
  { key: 'business', screens: ['business'] },
  { key: 'goal', screens: ['goal'] },
  { key: 'about', screens: ['about'] },
  { key: 'hours', screens: ['hours'] },
  { key: 'look', screens: ['look'] },
  { key: 'page', screens: ['page'] },
  { key: 'customers', screens: ['customers'] },
  { key: 'booking', screens: ['booking'] },
  { key: 'number', screens: ['number'] },
  { key: 'paid', screens: ['paid'] },
  { key: 'ai', screens: ['jobs', 'facts', 'meet', 'voice', 'learned', 'qualify', 'chat'] },
  { key: 'loop', screens: ['loop'] },
  { key: 'try', screens: ['try'] },
  { key: 'done', screens: ['done'] },
] as const satisfies readonly {
  readonly key: string;
  readonly screens: readonly OnboardingSetupScreen[];
}[];
export type OnboardingSetupStop = (typeof ONBOARDING_SETUP_STOPS)[number]['key'];

/** The AI quick setup's screen each of these is, for its checks and words. */
export const AI_SCREEN_OF: Readonly<Partial<Record<OnboardingSetupScreen, AiSetupStep>>> = {
  about: 'about',
  hours: 'hours',
  jobs: 'jobs',
  facts: 'facts',
  meet: 'meet',
  voice: 'voice',
  learned: 'learned',
  qualify: 'qualify',
  chat: 'chat',
  loop: 'loop',
  try: 'try',
};

/** How the business is paid, on "Get paid, and get reviews". */
export const PAY_WITH = ['stripe', 'square', 'later'] as const;
export type PayWith = (typeof PAY_WITH)[number];

export const ONBOARDING_SETUP_MAX = { invites: 10, reviewLink: 500 } as const;

export const OnboardingSetupAnswers = z.object({
  /** "What do you want help with first?" */
  goal: z.enum(ONBOARDING_GOALS).default('leads'),
  /** "How many people work with you?" */
  teamSize: z.enum(TEAM_SIZES).default('solo'),
  /** "Do customers book a time with you?" No skips the booking stop. */
  booksTime: z.boolean().default(false),
  /** "A simple page for your business", asked only with no website: Use this page, or Not now. */
  usePage: z.boolean().default(true),
  /** "Where are your customers now?" Each answer opens its own way in. */
  customersIn: z.enum(CUSTOMER_SOURCES).default('none'),
  /** "Do you have an EIN?", for the kind of number: local with one, toll-free without. Null until asked. */
  hasEin: z.boolean().nullable().default(null),
  /** "How do customers pay you?" */
  payWith: z.enum(PAY_WITH).default('later'),
  /** The Google review link the thank-you text sends, as typed; empty for none. */
  reviewLink: z
    .string()
    .trim()
    .max(ONBOARDING_SETUP_MAX.reviewLink, 'Keep it under 500 characters.')
    .default(''),
  /** The AI quick setup's answers: what "About your business" and "When are you open?" ask too. */
  ai: AiSetupAnswers.default(() => AiSetupAnswers.parse({})),
});
export type OnboardingSetupAnswers = z.infer<typeof OnboardingSetupAnswers>;
export type OnboardingSetupAnswersInput = z.input<typeof OnboardingSetupAnswers>;

type OwnField = Exclude<keyof OnboardingSetupAnswers, 'ai'>;
type AiField = keyof AiSetupAnswers;

/** What each screen asks: the setup's own answers, and the AI part's. A screen with none only shows or does things. */
export const ONBOARDING_SETUP_SCREEN_FIELDS: Readonly<
  Record<
    OnboardingSetupScreen,
    { readonly own: readonly OwnField[]; readonly ai: readonly AiField[] }
  >
> = {
  business: { own: [], ai: [] },
  goal: { own: ['goal', 'teamSize'], ai: [] },
  about: { own: ['booksTime'], ai: ['description', 'services', 'area'] },
  hours: { own: [], ai: ['openHours'] },
  // The logo and colour are saved at once, by their own commands (look/look.ts).
  look: { own: [], ai: [] },
  page: { own: ['usePage'], ai: [] },
  customers: { own: ['customersIn'], ai: [] },
  booking: { own: [], ai: [] },
  number: { own: ['hasEin'], ai: [] },
  paid: { own: ['payWith', 'reviewLink'], ai: [] },
  jobs: { own: [], ai: ['jobs'] },
  facts: { own: [], ai: ['facts'] },
  meet: { own: [], ai: ['name', 'disclosure'] },
  voice: { own: [], ai: ['tone', 'allowPrices'] },
  learned: { own: [], ai: ['topQuestions', 'keepFindings', 'dropFindings'] },
  qualify: { own: [], ai: ['questions'] },
  chat: { own: [], ai: ['chat'] },
  loop: { own: [], ai: [] },
  try: { own: [], ai: [] },
  done: { own: [], ai: [] },
};

/** Picked from the kind of business, so they're picked again when the kind changes on the first screen. */
export const ONBOARDING_SETUP_KIND_FIELDS: readonly OwnField[] = ['booksTime'];

/**
 * Whether a screen shows: the simple page only for a business with no website; booking only when customers book a
 * time; the AI part's qualifying questions only when Ava asks them, and its chat only for a website (or the page)
 * without one.
 */
export function onboardingSetupScreenApplies(
  screen: OnboardingSetupScreen,
  answers: Pick<OnboardingSetupAnswers, 'booksTime' | 'ai'>,
  facts: AiSetupFlowFacts,
): boolean {
  if (screen === 'page') return !facts.website;
  if (screen === 'booking') return answers.booksTime;
  if (screen === 'qualify' || screen === 'chat')
    return aiSetupStepApplies(screen, answers.ai, facts);
  return true;
}

type Applies = Pick<OnboardingSetupAnswers, 'booksTime' | 'ai'>;

/** The screens this business goes through, in order. */
export function onboardingSetupScreens(
  answers: Applies,
  facts: AiSetupFlowFacts,
): OnboardingSetupScreen[] {
  return ONBOARDING_SETUP_SCREENS.filter((s) => onboardingSetupScreenApplies(s, answers, facts));
}

/** The screen after this one, or null after the last. */
export function onboardingSetupNextScreen(
  screen: OnboardingSetupScreen,
  answers: Applies,
  facts: AiSetupFlowFacts,
): OnboardingSetupScreen | null {
  return (
    ONBOARDING_SETUP_SCREENS.slice(ONBOARDING_SETUP_SCREENS.indexOf(screen) + 1).find((s) =>
      onboardingSetupScreenApplies(s, answers, facts),
    ) ?? null
  );
}

/** The screen before this one, or null on the first. */
export function onboardingSetupPreviousScreen(
  screen: OnboardingSetupScreen,
  answers: Applies,
  facts: AiSetupFlowFacts,
): OnboardingSetupScreen | null {
  return (
    ONBOARDING_SETUP_SCREENS.slice(0, ONBOARDING_SETUP_SCREENS.indexOf(screen))
      .reverse()
      .find((s) => onboardingSetupScreenApplies(s, answers, facts)) ?? null
  );
}

/** The stop a screen is part of. */
export const onboardingSetupStopOf = (screen: OnboardingSetupScreen): OnboardingSetupStop =>
  ONBOARDING_SETUP_STOPS.find((s) => (s.screens as readonly string[]).includes(screen))!.key;

/**
 * Where a screen sits among the stops this business goes through, for "Stop 3 of 13". Signing up counts as the
 * first, already done; a stop that doesn't apply isn't counted.
 */
export function onboardingSetupProgress(
  screen: OnboardingSetupScreen,
  answers: Applies,
  facts: AiSetupFlowFacts,
): { readonly stop: OnboardingSetupStop; readonly at: number; readonly of: number } {
  const shown = new Set<string>(onboardingSetupScreens(answers, facts));
  const stops = ONBOARDING_SETUP_STOPS.filter(
    (s) => s.key === 'signup' || s.screens.some((x) => shown.has(x)),
  );
  const stop = onboardingSetupStopOf(screen);
  return { stop, at: stops.findIndex((s) => s.key === stop) + 1, of: stops.length };
}

/** The later of two screens. */
export const laterOnboardingSetupScreen = (
  a: OnboardingSetupScreen | null,
  b: OnboardingSetupScreen,
): OnboardingSetupScreen =>
  a && ONBOARDING_SETUP_SCREENS.indexOf(a) > ONBOARDING_SETUP_SCREENS.indexOf(b) ? a : b;

/** The screens up to and including this one. */
export const onboardingSetupScreensTo = (
  reached: OnboardingSetupScreen,
): readonly OnboardingSetupScreen[] =>
  ONBOARDING_SETUP_SCREENS.slice(0, ONBOARDING_SETUP_SCREENS.indexOf(reached) + 1);

/**
 * The setup's own answers to carry on from: those of the screens finished so far over today's picks. A draft
 * answered for another kind of business keeps only what isn't picked by kind.
 */
export function resumeOwnAnswers(
  starting: OnboardingSetupAnswers,
  record: Pick<OnboardingSetupRecord, 'draft' | 'reached' | 'kind'>,
  kind: SetupKind,
): OnboardingSetupAnswers {
  const { draft, reached } = record;
  if (!draft || !reached) return starting;
  const out: Record<string, unknown> = { ...starting };
  for (const screen of onboardingSetupScreensTo(reached))
    for (const field of ONBOARDING_SETUP_SCREEN_FIELDS[screen].own)
      if (record.kind === kind || !ONBOARDING_SETUP_KIND_FIELDS.includes(field))
        out[field] = draft[field];
  return out as OnboardingSetupAnswers;
}

/**
 * The AI part's answers to carry on from, the same way: those of the screens finished so far over today's picks,
 * with what's picked by kind (jobs, quick facts, tone, questions) picked again for another kind of business.
 */
export function resumeAiAnswers(
  starting: AiSetupAnswers,
  record: Pick<OnboardingSetupRecord, 'draft' | 'reached' | 'kind'>,
  kind: SetupKind,
): AiSetupAnswers {
  const { draft, reached } = record;
  if (!draft || !reached) return starting;
  const out: Record<string, unknown> = { ...starting };
  for (const screen of onboardingSetupScreensTo(reached))
    for (const field of ONBOARDING_SETUP_SCREEN_FIELDS[screen].ai)
      if (record.kind === kind || !AI_SETUP_KIND_FIELDS.includes(field))
        out[field] = draft.ai[field];
  return out as AiSetupAnswers;
}

/** Who did it, and when. */
export const OnboardingSetupMark = z.object({ at: z.iso.datetime(), by: z.uuid() });
export type OnboardingSetupMark = z.infer<typeof OnboardingSetupMark>;

/** The roles an agency invites a business's owner as: owner when it may give that role, else admin. */
export const HAND_OVER_ROLES = ['owner', 'admin'] as const;
export type HandOverRole = (typeof HAND_OVER_ROLES)[number];

/** What handing it over invites the owner as, from the role here of whoever hands it over. */
export const handOverRoleOf = (role: WorkspaceRole | null): HandOverRole =>
  canActOnRole(role, 'owner') ? 'owner' : 'admin';

/**
 * An agency set the business up for its owner and handed it over to check and finish (the owner's 53A): who did it
 * and when, and whom it invited. `name` and `agency` are kept as they were then, for "Sam at Bright Marketing set up
 * …": the owner may not see either otherwise. Null `email` and `role`: nobody was invited from the setup.
 */
export const OnboardingSetupHandOver = OnboardingSetupMark.extend({
  name: z.string().max(200),
  agency: z.string().max(200),
  email: z.email().nullable(),
  role: z.enum(HAND_OVER_ROLES).nullable(),
});
export type OnboardingSetupHandOver = z.infer<typeof OnboardingSetupHandOver>;

/**
 * The hand-over an invitation brings someone to: the setup was handed to the owner and isn't finished, and the
 * invitation is for the email it named (or anyone's, when it named none) as an owner or admin, who may finish it.
 * The invitation email says so, and accepting it opens the setup.
 */
export function handOverFor(
  record: Pick<OnboardingSetupRecord, 'handedOver' | 'finished'>,
  invitation: { readonly email: string; readonly role: string },
): OnboardingSetupHandOver | null {
  const h = record.handedOver;
  if (!h || record.finished || (invitation.role !== 'owner' && invitation.role !== 'admin'))
    return null;
  return h.email === null || h.email.toLowerCase() === invitation.email.toLowerCase() ? h : null;
}

/** What the business keeps. */
export interface OnboardingSetupRecord {
  /** The answers so far; kept once finished too, so the last screens can still show them. */
  readonly draft: OnboardingSetupAnswers | null;
  /** The furthest screen finished. */
  readonly reached: OnboardingSetupScreen | null;
  /** The kind of business the draft was answered for. */
  readonly kind: SetupKind | null;
  /**
   * The agency's saved answers picked on the first screen (the owner's 54A), null for our picks; left out while
   * nobody picked, so the newest for the business's kind is used.
   */
  readonly template?: string | null;
  readonly started: OnboardingSetupMark | null;
  /** When the agency handed it to the business's owner to check and finish; left out until it does. */
  readonly handedOver?: OnboardingSetupHandOver;
  /** When "Stay in the loop" saved everything, by someone on the business's own team. */
  readonly finished: OnboardingSetupMark | null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const parsed = <T>(schema: z.ZodType<T>, v: unknown): T | null => {
  const r = schema.safeParse(v);
  return r.success ? r.data : null;
};

/** What a business keeps of the onboarding setup, from its settings. */
export function onboardingSetupOf(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): OnboardingSetupRecord {
  const raw = asRecord(settings?.[ONBOARDING_SETUP_SETTINGS_KEY]);
  const draft = raw['draft'] == null ? null : parsed(OnboardingSetupAnswers, raw['draft']);
  const reached = draft ? parsed(z.enum(ONBOARDING_SETUP_SCREENS), raw['reached']) : null;
  const template =
    raw['template'] === null ? null : (parsed(z.uuid(), raw['template']) ?? undefined);
  const handedOver = parsed(OnboardingSetupHandOver, raw['handedOver']);
  return {
    draft: reached ? draft : null,
    reached,
    kind: reached ? parsed(z.enum(SETUP_KINDS), raw['kind']) : null,
    ...(reached && template !== undefined ? { template } : {}),
    started: parsed(OnboardingSetupMark, raw['started']),
    ...(handedOver ? { handedOver } : {}),
    finished: parsed(OnboardingSetupMark, raw['finished']),
  };
}

/** What's stored, with nothing empty kept. */
export function storedOnboardingSetup(next: OnboardingSetupRecord): Record<string, unknown> {
  return {
    ...(next.draft && next.reached
      ? {
          draft: next.draft,
          reached: next.reached,
          ...(next.kind ? { kind: next.kind } : {}),
          ...(next.template !== undefined ? { template: next.template } : {}),
        }
      : {}),
    ...(next.started ? { started: next.started } : {}),
    ...(next.handedOver ? { handedOver: next.handedOver } : {}),
    ...(next.finished ? { finished: next.finished } : {}),
  };
}
