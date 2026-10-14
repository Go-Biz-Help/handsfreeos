/**
 * What the main offer's screens say (docs/main-offer.md): its page in Settings and the builder, a step at a time.
 * One copy for the web now and the phone later. Browser-safe.
 */
import type { OfferAssistPath } from './assist';
import type { ScoredPart } from './parts';

/** The builder's steps, in order. */
export const OFFER_STEPS = [
  'niche',
  'who',
  'outcome',
  'timeframe',
  'method',
  'guarantee',
  'price',
  'proof',
  'line',
  'score',
] as const;
export type OfferStep = (typeof OFFER_STEPS)[number];

/** A box on a step: what it asks, and a hint under it. */
export interface OfferBox {
  readonly path: OfferAssistPath | `niche.${string}`;
  readonly label: string;
  readonly hint?: string;
  /** A sentence or two, not a few words. */
  readonly long?: boolean;
  readonly placeholder?: string;
}

export interface OfferStepWords {
  /** In the step list: "Guarantee". */
  readonly name: string;
  /** Under it while it's empty: "What if it doesn't work". */
  readonly about: string;
  readonly title: string;
  readonly hint: string;
  readonly boxes: readonly OfferBox[];
  /** The part the score names it by, for "Change the guarantee". */
  readonly part?: ScoredPart;
}

export const OFFER_STEP_WORDS: Record<OfferStep, OfferStepWords> = {
  niche: {
    name: 'Your niche',
    about: 'Start from your best customer',
    title: 'Start with your best customer',
    hint: 'Proof beats potential. The customers you already got a great result for are the easiest to win again. This niche is for your outreach only; you can still work with anyone.',
    boxes: [
      { path: 'niche.bestCustomer', label: 'Who’s the best customer you’ve had?' },
      { path: 'niche.theirWork', label: 'What line of work are they in?' },
      { path: 'niche.theirSize', label: 'How big were they when they came to you?' },
      { path: 'niche.howLong', label: 'How long did the result take?' },
      { path: 'niche.result', label: 'What result did you get them?', long: true },
      {
        path: 'niche.lookalikes',
        label: 'Who looks just like them, that you could find 100 of now?',
        hint: 'Don’t worry about how you’ll find them yet. Social Outreach does that.',
        long: true,
      },
    ],
  },
  who: {
    name: 'Who',
    about: 'Who it’s for, and their problem',
    title: 'Who it’s for',
    hint: 'One line of work and a slice of it. The more specific, the more of them stop and read.',
    part: 'who',
    boxes: [
      {
        path: 'who.work',
        label: 'What line of work are they in?',
        hint: 'Be specific: “Roofers”, not “businesses”.',
      },
      {
        path: 'who.slice',
        label: 'Which slice of it?',
        hint: 'By their problem (stuck on referrals) or their size (2 to 3 crews).',
      },
      { path: 'who.size', label: 'How big are they?' },
      { path: 'who.problem', label: 'Their single most painful problem', long: true },
    ],
  },
  outcome: {
    name: 'Outcome',
    about: 'The result they get',
    title: 'The result you get them',
    hint: 'Say plainly what they get. A business wants more money, or more time to make more money; a household wants the result and the worry gone.',
    part: 'outcome',
    boxes: [
      {
        path: 'outcome.result',
        label: 'The result, measurable',
        hint: 'A number, a range, or a before and after. Only what you control.',
        long: true,
      },
      { path: 'outcome.measure', label: 'How is it measured?', long: true },
      { path: 'outcome.why', label: 'Why does it matter to them?', long: true },
    ],
  },
  timeframe: {
    name: 'Timeframe',
    about: 'How fast',
    title: 'How fast',
    hint: 'Without a timeframe, people assume it takes forever. Say how long it usually takes, and why.',
    part: 'timeframe',
    boxes: [
      { path: 'timeframe.typical', label: 'How long does it usually take?' },
      { path: 'timeframe.why', label: 'Why is that realistic?', long: true },
    ],
  },
  method: {
    name: 'Method',
    about: 'How you do it, in 3 to 5 steps',
    title: 'How you do it',
    hint: 'Your system from start to finish, in 3 to 5 steps. It shows you have a plan, and it becomes your short video and your sales calls.',
    part: 'method',
    boxes: [
      {
        path: 'method.different',
        label: 'What’s different about how you do it?',
        hint: 'The answer to “How are you different from the others?” before anyone asks it.',
        long: true,
      },
    ],
  },
  guarantee: {
    name: 'Guarantee',
    about: 'What if it doesn’t work',
    title: 'Your guarantee',
    hint: 'What they get if it doesn’t work. It takes the risk off them, so the only question left is whether they trust you. It covers customers who qualify, so you never promise everyone everything.',
    part: 'guarantee',
    boxes: [
      { path: 'guarantee.promise', label: 'What do you promise if it doesn’t work?', long: true },
      { path: 'guarantee.when', label: 'When does it apply?', long: true },
      {
        path: 'guarantee.qualifies',
        label: 'Who qualifies?',
        hint: 'A customer who can’t get the result through no fault of yours isn’t one to promise it to. Say who is.',
        long: true,
      },
    ],
  },
  price: {
    name: 'Price',
    about: 'What it costs, and why it’s worth it',
    title: 'Your price',
    hint: 'If they trusted every word so far, could they justify the price? Make the value easy to see from their side.',
    part: 'price',
    boxes: [
      { path: 'price.amount', label: 'What’s your price?' },
      { path: 'price.structure', label: 'How is it built?', long: true },
      {
        path: 'price.value',
        label: 'Why is it worth it to them?',
        hint: 'Do the math from their side: “one new customer pays for three months”.',
        long: true,
      },
    ],
  },
  proof: {
    name: 'Proof',
    about: 'Real results',
    title: 'Real results',
    hint: 'One line each: who, what result, how long. Real results earn the trust a great offer needs. Never made up.',
    boxes: [],
  },
  line: {
    name: 'Put it together',
    about: 'Your offer in one line',
    title: 'Put it together',
    hint: 'Your whole offer in one line. You won’t say all of it in every message, but you should be able to say it in one breath.',
    boxes: [
      { path: 'line', label: 'Your offer in one line', long: true },
      { path: 'inAFewWords.outcome', label: 'The outcome, in a few words' },
      { path: 'inAFewWords.guarantee', label: 'The guarantee, in a few words' },
    ],
  },
  score: {
    name: 'Score and go live',
    about: 'Every part needs 7',
    title: 'Score and go live',
    hint: 'The AI scores each part the way a coach would on a call: honest and specific. Every part needs 7 out of 10, so your outreach starts from an offer people want.',
    boxes: [],
  },
};

export const MAIN_OFFER_WORDS = {
  title: 'Main offer',
  pageHint:
    'Who you help, the result, how fast, how, your guarantee and your price. Your sales add-ons say it for you.',
  building: 'Building your main offer',
  finishLater: 'Finish later',
  counter: (n: number) => `${n} of ${OFFER_STEPS.length}`,
  saved: (time: string) => `Draft saved ${time}`,
  continue: 'Continue',
  back: 'Back',
  examples: 'Examples to model, not to copy:',
  examplesAi: 'Ask the AI for examples',
  improve: 'Improve',
  writeIt: 'Write it for me',
  pickOne: 'Pick one, or keep yours',
  useThis: 'Use this',
  useSteps: 'Use these steps',
  useLines: 'Use these lines',
  fromAi: 'From the AI · nothing is used until you pick',
  findNiche: 'Find my niche',
  suggestNiches: 'Suggest niches for me',
  noCustomers: 'I don’t have customers yet',
  haveCustomers: 'I do have a best customer',
  noneYetTitle: 'No past customers? That’s fine.',
  noneYet:
    'Pick the most painful problem in a line of work you know and can easily reach. The AI looks at your business and suggests three, with what those customers want most.',
  nichesTitle: 'Three niches to start with',
  useNiche: 'Use this niche and continue',
  steps: 'Your steps, in order',
  addStep: 'Add a step',
  stepLabel: (n: number) => `Step ${n}`,
  moveUp: (n: number) => `Move step ${n} up`,
  takeOut: (n: number) => `Take out step ${n}`,
  proofLabel: (n: number) => `Result ${n}`,
  addProof: 'Add a result',
  proofPlaceholder: 'A 3-crew roofer got 14 inspections in 30 days',
  startFromAnswers: 'Start again from my answers',
  formula:
    'We help [who] get [outcome] within [timeframe] using [method]. If [guarantee]. [Price].',
  forMessages: 'For your messages',
  forMessagesHint:
    'A few words each, so a first message can carry them. Messages never say the price.',
  previewTitle: 'How a first message will read',
  previewNote: 'Social Outreach writes each one, with something real about them first',
  scoreIt: 'Score my offer',
  scoreAgain: 'Score again',
  scoring: 'Scoring…',
  scoredAt: (time: string) => `Scored ${time}`,
  scoredTitle: 'How each part scored',
  checksTitle: 'The quick checks',
  checks: {
    threeSeconds: 'A stranger sees the result in 3 seconds',
    vague: 'Specific, not vague',
    generic: 'Stands out from others like you',
    hardToBelieve: 'Easy to believe',
  },
  yes: 'Yes',
  notYet: 'Not yet',
  fixFirst: (part: string) => `Fix the ${part.toLowerCase()} first`,
  allClear: 'Every part scores 7 or more',
  stillNeeds: 'Before it can be scored and go live, fill in:',
  goLive: 'Go live',
  change: (part: string) => `Change the ${part.toLowerCase()}`,
  goTo: (step: string) => `Go to ${step}`,
  useAnyway: 'Use it anyway…',
  anywayTitle: 'Go live under the bar?',
  anywayScored: (part: string, score: number) =>
    `The ${part.toLowerCase()} scored ${score} out of 10.`,
  anywayNote:
    'An offer under the bar usually gets fewer yeses. You can still use it now and come back to it.',
  anywayWhy: 'Why is it going live now?',
  anywayPlaceholder: 'Testing it with past customers first',
  anywayHint: 'Kept with this version, so everyone sees why later.',
  anywayGo: 'Go live anyway',
  cancel: 'Cancel',
  live: (version: number) =>
    `Your offer is live. Version ${version} is what your sales add-ons say now.`,
  // The page in Settings.
  startTitle: 'Build your main offer',
  startHint:
    'One clear offer your customers say yes to. It’s the first thing that decides whether outreach works. About 30 minutes, a step at a time, with the AI’s help.',
  startSteps: [
    ['Find your niche', 'Start from your best customer.'],
    ['Six parts', 'Who, outcome, timeframe, method, guarantee, price.'],
    ['Score it', 'Every part needs 7 out of 10.'],
    ['Go live', 'Your sales add-ons start using it.'],
  ] as const,
  start: 'Start building',
  startNote: 'You can stop any time. Your draft is kept.',
  askOwner:
    'Your business hasn’t built its main offer yet. Ask an owner or admin of this business to build it in Settings → Main offer.',
  changeOffer: 'Change your offer',
  openDraft: 'Open the draft',
  throwAway: 'Throw it away',
  throwAwayAsk: 'Throw away this draft? The live version stays as it is.',
  draftBy: (who: string) => `${who} is changing your offer`,
  draftAbout: (time: string, scored: boolean, live: number | null) =>
    `Saved ${time} · ${scored ? 'scored' : 'not scored yet'}${live ? ` · Version ${live} keeps running until it’s published.` : ''}`,
  tabLive: 'Live version',
  tabVersions: 'Versions',
  liveLine: (version: number, date: string, who: string | null) =>
    `Live · version ${version} · published ${date}${who ? ` by ${who}` : ''}`,
  allClearBadge: 'Every part 7 or more',
  underBarBadge: 'Under the bar',
  inMessages: 'In messages:',
  byPart: 'Your offer, part by part',
  howScored: 'How it scored',
  weakest: (part: string, fix: string) => `Weakest: the ${part.toLowerCase()}. ${fix}`,
  usedBy: 'Who uses it',
  whoChanges: 'Owners and admins change it. Everyone on the team can see it.',
  versionName: (n: number) => `Version ${n}`,
  versionMeta: (lowest: number, date: string, who: string | null) =>
    `Lowest part ${lowest} · ${date}${who ? ` · ${who}` : ''}`,
  wentLiveAnyway: (why: string) => `went live anyway: “${why}”`,
  liveBadge: 'Live',
} as const;

/**
 * How a first message carries the offer, for the builder's preview: the workbook's script, in a few words each.
 * Social Outreach writes the real ones, with something about the person first.
 */
export function firstMessagePreview(outcome: string, guarantee: string): string {
  const o = outcome.trim() || '[the outcome]';
  const g = guarantee.trim() || '[the guarantee]';
  return `Just reaching out to see if you’d be open to ${o}, where ${g}? If so, let me know and I’ll send more info.`;
}
