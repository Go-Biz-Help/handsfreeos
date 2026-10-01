/**
 * The support desk's two pages of counts (M13), said once for the web's /admin and the phone's Support desk: Health
 * (what has failed lately everywhere, and which AI is answering) and Getting started (how businesses get through it,
 * the onboarding plan's §9). Dates are the screen's to write, in the reader's own zone; everything else is here.
 */

// ---------- Health ----------

/** What `platform.health.summary` counts, as far as the page shows it. */
export interface DeskHealthCounts {
  readonly failedJobs: { readonly count: number };
  readonly failedDeliveries: { readonly count: number };
  readonly emailBounces: { readonly count: number };
  readonly failedTexts: { readonly count: number };
  readonly paymentFailures: { readonly count: number };
  readonly lostTranscripts: { readonly count: number };
  readonly wallets: {
    readonly suspended: number;
    readonly declines: number;
    readonly drifting: number;
    readonly negative: number;
    readonly unreconciledDays: number;
  };
  readonly outboxBacklog: number;
}

/** The numbers across the top of Health. Anything over nothing is worth a look. */
export function deskHealthCards(
  health: DeskHealthCounts,
): readonly { readonly label: string; readonly value: number }[] {
  return [
    { label: 'Background jobs that failed', value: health.failedJobs.count },
    { label: 'Webhooks that failed', value: health.failedDeliveries.count },
    { label: 'Emails that bounced', value: health.emailBounces.count },
    { label: 'Texts that failed', value: health.failedTexts.count },
    { label: 'Payments that failed', value: health.paymentFailures.count },
    { label: 'Calls with no words', value: health.lostTranscripts.count },
    // The usage wallets (M16). `Balances that disagree` is the one to look at first: the cached balance is what every
    // spending gate reads, so a wallet out of step with its own ledger means every gate is lying.
    { label: 'Cards declined', value: health.wallets.declines },
    { label: 'Balances suspended', value: health.wallets.suspended },
    { label: 'Balances that disagree', value: health.wallets.drifting },
    { label: 'Balances below zero', value: health.wallets.negative },
    // The shadow week's own check: days the nightly true-up against Twilio did not run for a business with a carrier
    // account. Nothing else would ever tell us the margin numbers were built on a missing day.
    { label: 'Days not reconciled', value: health.wallets.unreconciledDays },
    { label: 'Work still queued', value: health.outboxBacklog },
  ];
}

/** How far back Health looks when nobody says. */
export const DESK_HEALTH_HOURS = 24;

/** How far back Health looks, from an address's hours: one to a week (168); anything else is the last day. */
export const deskHealthHours = (value: unknown): number =>
  Math.min(168, Math.max(1, Number(value ?? DESK_HEALTH_HOURS) || DESK_HEALTH_HOURS));

export const DESK_HEALTH_WORDS = {
  /** "Since Sep 30, 9:41 AM · oldest queued job 12 minutes old": the queue is only news past five minutes. */
  since: (when: string, oldestPendingMinutes: number | null) =>
    `Since ${when}${
      oldestPendingMinutes !== null && oldestPendingMinutes > 5
        ? ` · oldest queued job ${oldestPendingMinutes} minutes old`
        : ''
    }`,
  lastFew: 'The last few',
  nothingFailed: 'Nothing has failed in this window. Enjoy it.',
  noBusiness: 'no business',
} as const;

// ---------- which AI answers ----------

export type DeskAiProvider = 'claude' | 'openai';
export type DeskAiMode = 'auto' | DeskAiProvider;

/** What `platform.ai_provider.get` says, as far as the page shows it. */
export interface DeskAiState {
  readonly mode: DeskAiMode;
  readonly active: DeskAiProvider;
  readonly answering: DeskAiProvider;
  readonly reason: 'status' | 'errors' | null;
  readonly claudeStatus: string | null;
  readonly goodChecks: number;
  readonly checkedAt: string | null;
  readonly switchedAt: string | null;
  readonly modeSetAt: string | null;
  readonly modeSetBy: string | null;
}

export const DESK_AI_NAMES: Readonly<Record<DeskAiProvider, string>> = {
  claude: 'Claude',
  openai: 'OpenAI',
};

/** The switch's three positions, in its order. */
export const DESK_AI_MODES = ['auto', 'claude', 'openai'] as const satisfies readonly DeskAiMode[];

export const DESK_AI_MODE_WORDS: Readonly<Record<DeskAiMode, string>> = {
  auto: 'Auto',
  claude: 'Always Claude',
  openai: 'Always OpenAI',
};

/** Why the checks moved it to OpenAI. */
export const DESK_AI_REASON_WORDS: Readonly<Record<'status' | 'errors', string>> = {
  status: 'Claude’s status page reports trouble',
  errors: 'Claude’s answers kept failing',
};

/** What Claude's status page said about the Claude API, in plain words. */
export const DESK_AI_STATUS_WORDS: Readonly<Record<string, string>> = {
  operational: 'All good',
  degraded_performance: 'Slow',
  partial_outage: 'Partly down',
  major_outage: 'Down',
  under_maintenance: 'Maintenance',
};

export const deskAiStatusWords = (status: string | null): string =>
  status === null
    ? 'Not checked yet'
    : (DESK_AI_STATUS_WORDS[status] ?? status.replaceAll('_', ' '));

/** Why it's where it is: the checks' reason on Auto, or who kept it there. `when` writes a date. */
export function deskAiWhy(ai: DeskAiState, when: (iso: string) => string): string | null {
  if (ai.mode === 'auto')
    return ai.answering === 'openai' && ai.reason
      ? `${DESK_AI_REASON_WORDS[ai.reason]}. Back on Claude after two good checks in a row (${Math.min(ai.goodChecks, 2)} so far).`
      : null;
  return `Kept on ${DESK_AI_NAMES[ai.mode]}${ai.modeSetBy ? ` by ${ai.modeSetBy}` : ''}${ai.modeSetAt ? `, ${when(ai.modeSetAt)}` : ''}.`;
}

/** Kept on Claude while the checks would have moved it: worth saying, since that's the risky way round. */
export const deskAiOverruled = (ai: DeskAiState): string | null =>
  ai.mode === 'claude' && ai.active === 'openai' && ai.reason
    ? `On Auto it would be on OpenAI now: ${DESK_AI_REASON_WORDS[ai.reason]}.`
    : null;

/** The four facts at the top of the block; a warning is anything not on a well Claude. */
export function deskAiFacts(
  ai: DeskAiState,
  when: (iso: string) => string,
): readonly { readonly label: string; readonly value: string; readonly warn: boolean }[] {
  return [
    { label: 'Answering now', value: DESK_AI_NAMES[ai.answering], warn: ai.answering === 'openai' },
    {
      label: 'Claude’s status page',
      value: deskAiStatusWords(ai.claudeStatus),
      warn: !(ai.claudeStatus === null || ai.claudeStatus === 'operational'),
    },
    { label: 'Last checked', value: ai.checkedAt ? when(ai.checkedAt) : 'Not yet', warn: false },
    { label: 'Last switched', value: ai.switchedAt ? when(ai.switchedAt) : 'Never', warn: false },
  ];
}

export const DESK_AI_WORDS = {
  title: 'Which AI answers',
  autoExplain:
    'Auto moves to OpenAI when Claude’s status page shows trouble or its answers fail, and back after two good checks 5 minutes apart.',
} as const;

// ---------- Getting started ----------

/** The windows Getting started counts over, in days; 30 unless somebody picks another. */
export const DESK_ONBOARDING_WINDOWS = [7, 30, 90] as const;
export type DeskOnboardingWindow = (typeof DESK_ONBOARDING_WINDOWS)[number];
export const DESK_ONBOARDING_DEFAULT_WINDOW: DeskOnboardingWindow = 30;

/** A window from an address or a tap; anything else is the default. */
export const deskOnboardingWindow = (days: unknown): DeskOnboardingWindow =>
  DESK_ONBOARDING_WINDOWS.find((d) => d === Number(days)) ?? DESK_ONBOARDING_DEFAULT_WINDOW;

/** Matomo's Pages report for the web app (site 5, the web's `components/matomo.tsx`), over the same days. */
export const deskMatomoPagesUrl = (days: number): string =>
  `https://gobizhelp.matomo.cloud/index.php?module=CoreHome&action=index&idSite=5&period=range&date=last${days}` +
  `#?idSite=5&period=range&date=last${days}&category=General_Actions&subcategory=General_Pages`;

/** The numbers across the top of Getting started, each with the id its card is known by. */
export function deskOnboardingCards(c: {
  readonly started: number;
  readonly asYouGo: number;
  readonly finished: {
    readonly businesses: number;
    readonly nothingSkipped: number;
    readonly teammates: number;
  };
  readonly hidden: number;
  readonly turnedOff: number;
}): readonly {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly note?: string;
}[] {
  return [
    { label: 'Answered the quick questions', value: c.started, id: 'started' },
    {
      label: 'Finished setting up',
      value: c.finished.businesses,
      note: `${c.finished.nothingSkipped} with nothing skipped`,
      id: 'finished',
    },
    { label: 'Teammates who finished', value: c.finished.teammates, id: 'teammates' },
    { label: 'Adding customers as they go', value: c.asYouGo, id: 'as-you-go' },
    { label: 'People who hid the guide', value: c.hidden, id: 'hidden' },
    { label: 'Businesses that turned it off', value: c.turnedOff, id: 'turned-off' },
  ];
}

export const DESK_ONBOARDING_WORDS = {
  lastDays: (days: number) => `Last ${days} days`,
  since: (when: string) => `Since ${when}`,
  skippedTitle: 'Skipped steps',
  skippedExplain:
    'Most skipped first. A business counts once per step, however often it skips it; a step on someone’s own list counts people.',
  step: 'Step',
  skipped: 'Skipped',
  broughtBack: 'Brought back',
  /** Whose list a step is on. */
  stepFor: { business: 'Business', person: 'Own list' } as const,
  howFarTitle: 'How far people get',
  /** The paragraph under it; the `code` parts are addresses, set as code. */
  howFar: [
    'Each wizard step is its own page, so Matomo’s page views show the way through: from ',
    { code: 'onboarding' },
    ' to the questions, then each ',
    { code: 'onboarding/:id/setup/…' },
    ' step. ',
  ] as readonly (string | { readonly code: string })[],
  openMatomo: 'Open the pages report in Matomo',
} as const;
