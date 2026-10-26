/**
 * What the main offer's screens say (docs/main-offer.md): its page in Settings and the builder, a step at a time.
 * One copy for the web and the phone. Browser-safe.
 */
import { joinAnd } from '../attention/home-words';
import type { OfferAssistPath } from './assist';
import {
  clearsBar,
  SCORED_PART_LABELS,
  SCORED_PARTS,
  underBar,
  type MainOfferNotes,
  type MainOfferScore,
  type ScoredPart,
} from './parts';

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

/** The step a box is on: `who.work` on Who, `inAFewWords.outcome` on Put it together. */
export function offerStepOf(path: string): OfferStep {
  const first = path.split('.')[0] ?? '';
  if (first === 'line' || first === 'inAFewWords') return 'line';
  return (OFFER_STEPS as readonly string[]).includes(first) ? (first as OfferStep) : 'who';
}

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
    name: 'Review and go live',
    about: 'Notes, tries, then go live',
    title: 'Review and go live',
    hint: 'The AI scores each part the way a coach would on a call: honest and specific. See what’s working and what’s holding each part back, tell it where you want the offer to go, and it writes a new try beside yours. Every part needs 7 out of 10 to go live.',
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
    'A few words each. A first message carries the outcome, and a reply gives the guarantee when someone asks about one. Messages never say the price.',
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
 * Quick picks under a part's note box: each adds its line to the note (HANDSFREEOS_MAIN_OFFER_TRIES_IMPLEMENTATION_PLAN.md).
 */
export const OFFER_NOTE_PICKS = [
  ['Broad on purpose', 'This is broad on purpose.'],
  ['Undersells it', 'This undersells what it really does.'],
  ['Not how I’d say it', 'This isn’t how I’d say it.'],
  ['Say what’s different', 'Say what makes it different from the rest.'],
  ['Make it shorter', 'Make it shorter.'],
] as const;

/** Quick picks under the direction box: each adds its line to the direction. */
export const OFFER_DIRECTION_PICKS = [
  [
    'It’s more than it sounds',
    'It’s more than it sounds like at first. Say what makes it different.',
  ],
  ['Who it’s really for', 'It’s really for: '],
  ['What to lead with', 'Lead with: '],
  ['How it should sound', 'Sound like a calm, plain-spoken person, not a salesperson.'],
] as const;

/** The last step's notes, direction and tries, and the comparison, from the boards on the canvas. */
export const MAIN_OFFER_TRY_WORDS = {
  versions: 'Versions',
  yourDraft: 'Your draft',
  tryName: (n: number) => `Try ${n}`,
  beforeTry: (n: number) => `Before Try ${n}`,
  lowest: (n: number) => `Lowest ${n}`,
  noTries: 'The AI’s tries show up here. Yours stays as it is until you pick parts from one.',
  underBar: (parts: string) => `Under 7: ${parts}`,
  everyPartClears: 'Every part scores 7 or more',
  eachPart: 'Each part',
  eachPartHint:
    'Tell the AI what it got wrong, or what you really mean. Tick Keep this part as is for anything you’re happy with, so the next try leaves it alone.',
  saysNow: 'What it says now',
  working: 'Working',
  holding: 'Holding it back',
  aiFix: 'The AI’s fix:',
  yourNote: 'Your note for the AI',
  notePlaceholder: 'What did it get wrong? What do you really mean?',
  keepAsIs: 'Keep this part as is in the next try',
  keptAsIs: 'Kept as is',
  hasNote: 'Your note',
  editMyself: 'Edit it myself',
  withDirection: 'Scored with your direction',
  directionTitle: 'Where do you want this offer to go?',
  directionHint:
    'Say it in your own words, like you’d tell a coach. The AI follows this over its own rules, and scores against it from now on.',
  directionLabel: 'Your direction for the whole offer',
  directionPlaceholder: 'What is this really? Who is it for? What should it lead with?',
  goingInto: (name: string) => `Going into ${name}`,
  goesDirection: 'Your direction',
  goesNote: (part: string) => `Your note on ${part.toLowerCase()}`,
  goesKept: (part: string) => `${part} kept as is`,
  makeTry: (name: string) => `Make ${name}`,
  making: (name: string) => `Writing ${name}…`,
  draftStays: 'Your draft stays as it is. You pick what to use after.',
  compareTitle: (name: string) => `${name} is ready. Pick what to keep.`,
  compareHint:
    'Your draft is on the left, the AI’s try on the right. Tap the side you want for each part. Nothing changes until you apply your picks.',
  followed: (name: string) => `What ${name} followed`,
  changeFor: (name: string) => `Change it for ${name}`,
  partByPart: 'Part by part',
  partByPartHint: 'Scores are out of 10. The try is scored against your direction.',
  keepAllMine: 'Keep all mine',
  useAll: (name: string) => `Use all of ${name}`,
  yours: 'Yours',
  higher: 'Higher score',
  keptHere: (name: string) => `You kept this as is, so ${name} left it alone.`,
  movedSince: 'Your draft changed after this try was made, so your side shows it as it is now.',
  readsWithPicks: 'How it reads with your picks',
  picked: (name: string, fromTry: number, yours: number) =>
    fromTry
      ? `Using ${name} for ${fromTry} ${fromTry === 1 ? 'part' : 'parts'}, yours for ${yours}`
      : 'All yours so far. Tap a part on the right to use it.',
  apply: (n: number) =>
    n ? `Apply ${n} ${n === 1 ? 'part' : 'parts'} to my draft` : 'Keep my draft as is',
  backToReview: 'Back to review',
  bracketFirst:
    'This try has a blank in [brackets]. The AI never guesses a number for you, so fill it in before this goes live.',
  newLineTitle: 'Your picks need their own line',
  newLineHint:
    'The one-line offer was written for one version or the other. Pick a new one for the mix, or keep yours.',
  keepMyLine: 'Keep my line',
  usedFromTry: (name: string, parts: string) => `Your draft now uses ${name}’s ${parts}.`,
  keptBefore: (name: string) =>
    `Your draft from before is kept as Before ${name}, and ${name} is kept too, so you can mix in more of it later.`,
  restore: 'Restore my draft from before',
  changePicks: 'Change my picks',
  notScored: 'Not scored yet',
  updated: 'updated',
  tryMoved: 'Your draft changed while the AI was writing. Make the try again.',
  lineGroups: {
    line: 'Your offer in one line',
    outcome: 'The outcome, in a few words',
    guarantee: 'The guarantee, in a few words',
  },
  keepMine: 'Keep mine',
  useAndScore: 'Use these and score',
  scoringNow: 'Scoring your offer with your picks…',
  directionKept: 'Your direction is kept',
  directionKeptHint:
    'The AI reads it every time it scores or writes this offer, so the next change starts from what you meant.',
  editDirection: 'Edit your direction',
} as const;

/**
 * The names the business goes by on people's profiles (docs/outreach.md, decision 84), beside the live offer: what
 * Social Outreach's profile check looks for.
 */
export const MAIN_OFFER_NAMES_WORDS = {
  title: 'Names you go by',
  hint: 'The names people should see on your profiles: your company, and the brand you sell if it’s different. Social Outreach checks your profiles for them.',
  usingDefault: (name: string) =>
    `None added yet, so it looks for “${name}”, your business’s name here.`,
  label: 'Add a name',
  placeholder: 'Like your company or brand',
  add: 'Add',
  remove: (name: string) => `Remove ${name}`,
  saved: 'Names saved',
  most: (n: number) => `Up to ${n} names.`,
} as const;

/** "Under 7: who and guarantee", lowest first, or "Every part scores 7 or more": the score at a glance. */
export function underBarTitle(score: MainOfferScore): string {
  const under = underBar(score);
  return under.length
    ? MAIN_OFFER_TRY_WORDS.underBar(
        joinAnd(
          under.map((p) => SCORED_PART_LABELS[p].toLowerCase()),
          SCORED_PARTS.length,
        ),
      )
    : MAIN_OFFER_TRY_WORDS.everyPartClears;
}

/** The video's quick checks, in its order, and whether the offer passes each. */
export function offerChecks(
  score: MainOfferScore,
): readonly { readonly text: string; readonly ok: boolean }[] {
  const c = MAIN_OFFER_WORDS.checks;
  return [
    { text: c.threeSeconds, ok: score.threeSeconds },
    { text: c.vague, ok: !score.flags.vague },
    { text: c.generic, ok: !score.flags.generic },
    { text: c.hardToBelieve, ok: !score.flags.hardToBelieve },
  ];
}

/** One thing the next try is made from: the direction or a note (the owner's words), or a part kept as is. */
export interface GoingIntoTry {
  readonly key: string;
  readonly text: string;
  readonly kept: boolean;
}

/**
 * What goes into the next try, as the direction box lists it: the direction, the notes on parts not kept (a kept part
 * stays exactly as it is, note or not), then the parts kept as is, each in the workbook's order.
 */
export function goingInto(
  direction: string,
  notes: MainOfferNotes,
  keep: readonly ScoredPart[],
): GoingIntoTry[] {
  const W = MAIN_OFFER_TRY_WORDS;
  const out: GoingIntoTry[] = [];
  if (direction.trim()) out.push({ key: 'direction', text: W.goesDirection, kept: false });
  for (const p of SCORED_PARTS)
    if (notes[p]?.trim() && !keep.includes(p))
      out.push({ key: `note-${p}`, text: W.goesNote(SCORED_PART_LABELS[p]), kept: false });
  for (const p of SCORED_PARTS)
    if (keep.includes(p))
      out.push({ key: `kept-${p}`, text: W.goesKept(SCORED_PART_LABELS[p]), kept: true });
  return out;
}

/**
 * What the phone says of the main offer: Settings → Main offer, a try made there, and the steps that stay on the web
 * (HANDSFREEOS_MAIN_OFFER_PHONE_IMPLEMENTATION_PLAN.md). Everything else it shows is the web's words above.
 */
export const MAIN_OFFER_PHONE_WORDS = {
  rowOffline: 'Your offer, scored part by part',
  needsSignal: 'The main offer needs signal. Try again when you’re back online.',
  tryAgain: 'Try again',
  notInUse: (addons: string) =>
    `The main offer comes with ${addons}. Ask an owner or admin of this business to turn it on in More → Add-ons.`,
  nothingLive: 'Nothing is live yet.',
  notScoredHint:
    'Score it to see what’s working and what’s holding each part back, with the AI’s fix for each.',
  scoreOutOf: (part: string, score: number) => `${part}: ${score} out of 10`,
  buildTitle: 'Build your main offer on a computer',
  buildHint:
    'Finding your niche and the first steps are long forms, so they’re on the web. Once it’s built, you can review it, improve it and put it live here.',
  openOnWeb: 'Open on the web',
  onTheWeb: 'Fill it in on the web',
  webDidntOpen:
    'Your phone didn’t open the browser. Open HandsFreeOS on a computer, then Settings → Main offer.',
  stepsOnWeb: 'Add, take out or move a step on the web.',
  liveOnly: (version: number) =>
    `Version ${version} is live. A change here starts a draft, and version ${version} keeps running until it’s published.`,
  draftStays:
    'Your draft stays as it is. You pick what to use from a try on the web, on a computer or in this phone’s browser.',
  tryReady: (name: string) => `${name} is ready`,
  tryReadyHint:
    'Compare it with your draft on the web and pick what to keep. Your draft stays as it is until you do.',
  compareOnWeb: 'Compare on the web',
  compareNote: (name: string) =>
    `Opens ${name} beside your draft. ${name} is kept, so you can also open it later from a computer.`,
  blankForYou: (blank: string) => `Has a blank for you: ${blank}`,
  scoreFromTo: (part: string, from: number, to: number) => `${part}: ${from} to ${to}`,
  /** A part's score in a try, when the draft it came from wasn't scored. */
  tryScored: (part: string, score: number) => `${part}: ${score} in the try`,
  save: 'Save',
  saveNote: 'Saving changes your draft, so it’s scored again before it can go live.',
} as const;

/**
 * Why the AI didn't help with the main offer, in plain words: the worker's own words, except where the web and the
 * phone say it better (no answer at all, today's limit, no AI set up).
 */
export function offerAiWords(e: {
  readonly status: number;
  readonly rule?: string | null;
  readonly code: string;
  readonly message: string;
}): string {
  const why = e.rule ?? e.code;
  if (e.status === 0) return 'The AI isn’t reachable right now. Try again in a minute.';
  if (e.status === 403) return 'Only owners and admins can build the main offer.';
  if (why === 'budget_reached')
    return 'That’s today’s AI limit for this business. It resets at midnight.';
  if (why === 'ai_not_configured')
    return 'The AI isn’t set up for HandsFreeOS yet, so this can’t run. HandsFreeOS support can switch it on.';
  return e.message;
}

/** What Settings' Main offer row says under its name, from `main_offer.get`. */
export function offerRowLine(offer: {
  readonly inUse: boolean;
  readonly comesWith: readonly string[];
  readonly live: { readonly version: number; readonly score: MainOfferScore } | null;
  readonly draft: { readonly score: MainOfferScore | null } | null;
}): string {
  if (!offer.inUse) return `Comes with ${joinAnd(offer.comesWith)}`;
  const live = offer.live
    ? `Version ${offer.live.version} is live${clearsBar(offer.live.score) ? '' : ', under the bar'}`
    : null;
  if (!offer.draft) return live ?? 'Not built yet';
  const score = offer.draft.score;
  const under = score ? underBar(score) : [];
  const draft = !score
    ? 'your draft isn’t scored yet'
    : under.length
      ? `your draft is under 7 on ${joinAnd(
          under.map((p) => `the ${SCORED_PART_LABELS[p].toLowerCase()}`),
          SCORED_PARTS.length,
        )}`
      : 'your draft is ready to go live';
  return live ? `${live} · ${draft}` : draft.charAt(0).toUpperCase() + draft.slice(1);
}

/**
 * How a first message carries the offer, for the builder's preview: the workbook's script, with the outcome in a few
 * words and no guarantee (docs/outreach.md, decision 65). Social Outreach writes the real ones, with something about
 * the person first.
 */
export function firstMessagePreview(outcome: string): string {
  const o = outcome.trim() || '[the outcome]';
  return `Just reaching out to see if you’d be open to ${o}? If so, let me know and I’ll send more info.`;
}
