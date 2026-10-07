/**
 * An agency's view of its client businesses' setup (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, board 11):
 * where each business stands, as the Client businesses page and the daily digest show it. Browser-safe: the facts
 * are read on the server (`onboarding.clients`), and this decides what they add up to.
 */
import type { OnboardingStep } from './steps';
import { stepTitle, stepWords } from './words';

/** How long an owner can stay away, with must-dos still open, before the business counts as stuck. */
export const STUCK_AFTER_DAYS = 5;

export const CLIENT_GROUPS = ['stuck', 'setup', 'done'] as const;
export type ClientGroup = (typeof CLIENT_GROUPS)[number];

export interface ClientStanding {
  readonly group: ClientGroup;
  readonly badge: string;
  /** Why, in a few words: the step that needs a fix, how long the owner has been away, what's next. */
  readonly note: string;
}

const PROVIDERS: Readonly<Record<string, string>> = { stripe: 'Stripe', square: 'Square' };

/** The words on the agency's Setup column, its filters and its sheet. */
export const AGENCY_SETUP_WORDS = {
  column: 'Setup',
  filters: { all: 'All', stuck: 'Stuck', setup: 'Setting up', done: 'Done' } satisfies Record<
    'all' | ClientGroup,
    string
  >,
  badges: {
    stuck: 'Stuck',
    setup: 'Setting up',
    optional: 'Optional left',
    review: 'In review',
    done: 'Done',
    off: 'Guide off',
  },
  summary: (total: number, stuck: number, setup: number) =>
    `${total} ${total === 1 ? 'business' : 'businesses'} · ${stuck} stuck on setup · ${setup} still setting up`,
  away: (days: number) => `Hasn’t signed in for ${days} days`,
  next: (title: string) => `Next: ${title}`,
  optional: (titles: readonly string[]) => titles.join(', '),
  allDone: 'Everything’s set up',
  skipped: (n: number) => `Everything’s done or skipped (${n} skipped)`,
  off: 'Getting started is off for this business',
  fixes: {
    number: 'Carriers turned down texting',
    paymentsInfo: (provider: string) => `${provider} needs more details`,
    paymentsSignIn: (provider: string) => `${provider} needs signing in again`,
  },
  /** The sheet's line under the business's name. */
  owner: (name: string, done: number, total: number, lastSignedIn: string | null) =>
    [name, `${done} of ${total} done`, lastSignedIn ? `last signed in ${lastSignedIn}` : null]
      .filter(Boolean)
      .join(' · '),
  basics: 'The basics',
  later: 'When they’re ready',
  doItForThem: 'Do it for them',
  ownersCall: 'The owner’s call',
  ownerSignsIn: 'The owner signs in to Stripe or Square',
  remind: (firstName: string) => `Email ${firstName} a reminder`,
  remindNoOwner: 'Email a reminder',
  openWorkspace: 'Open their workspace',
  /** The guided setup, which hands the business to its owner at the end. */
  openSetup: 'Open the setup',
  add: 'Add a client business',
  noClients: 'Add one, set it up for them, and hand it to its owner to check and finish.',
  reminded: (email: string) => `Reminder sent to ${email}.`,
  remindedToday:
    'This business already got a reminder today. One a day is plenty; try again tomorrow.',
  remindOff:
    'Getting started is off for this business, so there’s nothing to remind them about. Its owners can turn it on in Settings → Workspace.',
  remindDone: 'This business is set up, so there’s nothing to remind them about.',
  noOwner: (business: string) =>
    `Nobody owns ${business} yet apart from your agency, so there’s nobody to remind. Invite its owner from its Members page first.`,
  /** One line in the daily agency digest, per stuck business. */
  digest: (business: string, note: string) => `${business} is stuck on setup: ${note}.`,
} as const;

/** The few words for a step that needs a fix, for the Setup column. */
export function fixNote(step: OnboardingStep): string {
  if (step.key === 'payments') {
    const provider = PROVIDERS[step.note.provider ?? ''] ?? 'The payment account';
    return step.note.phase === 'needs_info'
      ? AGENCY_SETUP_WORDS.fixes.paymentsInfo(provider)
      : AGENCY_SETUP_WORDS.fixes.paymentsSignIn(provider);
  }
  return AGENCY_SETUP_WORDS.fixes.number;
}

const DAY = 24 * 60 * 60 * 1000;
const isOpen = (s: OnboardingStep) => s.state === 'todo' || s.state === 'needs_fix';

/**
 * Where one client business stands, from its business steps (never anyone's own list) and when an owner last signed
 * in. Stuck: a step needs a fix, or the owners have been away for `STUCK_AFTER_DAYS` with must-dos still open. Done:
 * every step done, waiting on someone else, or skipped, or the guide turned off. Setting up: anything else.
 */
export function clientStanding(input: {
  readonly steps: readonly OnboardingStep[];
  readonly enabled: boolean;
  /** The latest any owner of the business signed in; null when that isn't known. */
  readonly lastSignInAt: string | null;
  readonly now: Date;
}): ClientStanding {
  const w = AGENCY_SETUP_WORDS;
  const fix = input.steps.find((s) => s.state === 'needs_fix');
  if (fix) return { group: 'stuck', badge: w.badges.stuck, note: fixNote(fix) };
  if (!input.enabled) return { group: 'done', badge: w.badges.off, note: w.off };
  const mustDos = input.steps.filter((s) => s.mustDo && isOpen(s));
  const away = input.lastSignInAt
    ? Math.floor((input.now.getTime() - new Date(input.lastSignInAt).getTime()) / DAY)
    : 0;
  if (mustDos.length && away >= STUCK_AFTER_DAYS)
    return { group: 'stuck', badge: w.badges.stuck, note: w.away(away) };
  if (mustDos.length)
    return {
      group: 'setup',
      badge: w.badges.setup,
      note: w.next(stepTitle(mustDos[0]!.key, mustDos[0]!.note.name)),
    };
  const later = input.steps.filter(isOpen);
  if (later.length)
    return {
      group: 'setup',
      badge: w.badges.optional,
      note: w.optional(later.map((s) => stepTitle(s.key, s.note.name))),
    };
  const waiting = input.steps.find((s) => s.state === 'waiting');
  if (waiting)
    return {
      group: 'done',
      badge: w.badges.review,
      note: stepWords(waiting).badge ?? w.allDone,
    };
  const skipped = input.steps.filter((s) => s.state === 'skipped').length;
  return {
    group: 'done',
    badge: w.badges.done,
    note: skipped ? w.skipped(skipped) : w.allDone,
  };
}
