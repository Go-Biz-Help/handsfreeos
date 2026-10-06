/**
 * Quick setup's words, shared by the web and the phone (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4).
 * Browser-safe.
 */
import type { DisclosureMode, HoursMode } from '../ai-team/config';
import type { TestOutcome } from '../ai-team/test-console';
import type { AiSetupStep, AiSetupTone } from './answers';
import type { SetupJob, SetupTone } from './kinds';

/** Each screen's question. `{name}` is the teammate's name. */
export const AI_SETUP_STEP_TITLES: Readonly<Record<AiSetupStep, string>> = {
  business: 'Your business',
  jobs: 'What should {name} help with?',
  about: 'About your business',
  hours: 'When are you open, and when should {name} answer?',
  facts: 'Quick facts',
  meet: 'Meet {name}',
  voice: 'How should {name} sound?',
  learned: 'What {name} learned from your website',
  qualify: 'Qualifying questions',
  loop: 'Stay in the loop',
  chat: 'Add {name} to your website?',
  try: 'Try {name}, then turn it on',
};

/** What each screen says under its question. `{name}` is the teammate's name. */
export const AI_SETUP_STEP_HINTS: Readonly<Record<AiSetupStep, string>> = {
  business: 'Check these first: they decide what {name} asks you next.',
  jobs: 'Tick all that fit. You can change any of it later.',
  about: '{name} tells customers this, so say it the way you would.',
  hours: '{name} tells customers when you’re open.',
  facts: 'Quick answers {name} can give customers. Skip any that don’t fit.',
  meet: 'Customers see this name. {name} never pretends to be a person.',
  voice: 'How {name} writes to customers, and whether it gives prices.',
  learned: 'Keep what’s right, and untick anything that isn’t.',
  qualify: '{name} asks new leads these, then tells you who’s a good fit.',
  loop: 'When {name} needs a person, you get an alert on your phone.',
  chat: 'Texting can take weeks to be approved. With a chat on your website, {name} can start today.',
  try: 'Saved. Try a few questions before you turn it on.',
};

/** Words with the teammate's name in them. */
export const withAiName = (words: string, name: string): string =>
  words.replaceAll('{name}', name.trim() || 'Ava');

/** A screen's title with the teammate's name in it. */
export const aiSetupStepTitle = (step: AiSetupStep, name: string): string =>
  withAiName(AI_SETUP_STEP_TITLES[step], name);

/** What a screen says under its question, with the teammate's name in it. */
export const aiSetupStepHint = (step: AiSetupStep, name: string): string =>
  withAiName(AI_SETUP_STEP_HINTS[step], name);

export const AI_SETUP_JOB_LABELS: Readonly<Record<SetupJob, string>> = {
  reply: 'Reply to new leads fast',
  answer: 'Answer questions',
  book: 'Book appointments',
  qualify: 'Ask qualifying questions',
  follow_up: 'Follow up when leads go quiet',
};

export const AI_SETUP_TONE_LABELS: Readonly<Record<AiSetupTone, string>> = {
  friendly: 'Friendly',
  professional: 'Professional',
  short: 'Short and simple',
  keep: 'Keep what I wrote',
};

/**
 * What each tone puts in Knowledge → Business profile → Tone of voice, which every AI reply reads. Quick setup
 * recognises its own words there, so a run after a person rewrote them offers to keep theirs.
 */
export const AI_SETUP_TONE_TEXTS: Readonly<Record<SetupTone, string>> = {
  friendly: 'Friendly and warm, in plain everyday words.',
  professional: 'Professional and polite, clear and to the point.',
  short: 'Short and simple: a sentence or two, in plain words.',
};

export const AI_SETUP_ANSWER_WHEN_LABELS: Readonly<Record<HoursMode, string>> = {
  always: 'All the time',
  after_hours: 'Only when you’re closed',
  custom: 'Only at set times',
};

export const AI_SETUP_DISCLOSURE_LABELS: Readonly<Record<DisclosureMode, string>> = {
  first_message: 'In its first message',
  when_asked: 'Only when asked',
};

export const AI_SETUP_PRICE_LABELS = {
  no: 'No, the team gives prices',
  yes: 'Yes, exactly as written',
} as const;

export const AI_SETUP_CHAT_LABELS = { yes: 'Yes, add the chat', no: 'Not now' } as const;

/** The service area made from a list of ZIP codes. */
export const AI_SETUP_AREA_NAME = 'Service area';

export const AI_SETUP_WORDS = {
  /** The small link that leaves quick setup for today's full settings. */
  setItUpMyself: 'Set it up myself',
  /** Back to quick setup from the presets "Set it up myself" shows. */
  quickInstead: 'Rather answer a few simple questions?',
  quickSetup: 'Quick setup',
  moreSettings: 'More settings',
  runAgain: 'Run quick setup again',
  /** Shown before saving a run when the business already has a teammate. */
  willChange: 'Here’s what will change',
  nothingChanges: 'Nothing changes. Your answers match what’s saved.',
  turnOn: 'Turn on with training wheels',
  notYet: 'Not yet',
  /** The note after "Turn on with training wheels", on the page it goes on to. */
  turnedOnNote: 'Turned on. {name} starts with training wheels: every message waits for your OK.',
  skip: 'Skip',
  /** "What do customers ask you most?" */
  topQuestions: 'What do customers ask you most?',
  topQuestionsHint: 'Up to 3, with your answers. Optional.',
  noWebsite: 'We don’t have one',
  /** A run left part way on another device. */
  carryOn: 'Carry on where you left off',
  startOver: 'Start over',
  savedNotice: 'Saved. Try a few questions before you turn it on.',
  /** The screens' counter: "Quick setup · 3 of 11". */
  position: (n: number, of: number) => `Quick setup · ${n} of ${of}`,
  next: 'Next',
  back: 'Back',
  save: 'Save',
  /** Save on a business that has a teammate: what will change comes first. */
  saveChanges: 'Save these changes',
  summary: 'What {name} will do',
  done: 'Done',
  cancel: 'Cancel',
} as const;

/** The labels on the screens, shared by the web and the phone. `{name}` is the teammate's name (`withAiName`). */
export const AI_SETUP_FIELD_WORDS = {
  businessName: 'Business name',
  businessNameMissing: 'Name your business.',
  kind: 'Kind of business',
  kindHint: 'It picks the questions and facts that fit.',
  kindMissing: 'Pick the kind of business from the list, or Other.',
  website: 'Your website',
  websiteHint:
    '{name} reads it while you answer the rest: your services, where you work and your hours.',
  noWebsiteHint: 'No problem. You’ll tell {name} about your business on the next screens.',
  description: 'What you do',
  services: 'Your services',
  serviceName: 'Service',
  serviceDescription: 'What it includes (optional)',
  addService: 'Add a service',
  removeService: 'Remove this service',
  /** While Ava reads the website for these screens. */
  reading: '{name} is reading your website. What it finds fills in here.',
  /** Under a quick fact the website answered. */
  fromWebsite: 'From your website. Check it’s right.',
  openHours: 'When you’re open',
  answerWhen: 'When should {name} answer?',
  customHours: 'The hours {name} answers',
  yes: 'Yes',
  no: 'No',
  name: 'Name',
  disclosure: 'How does {name} tell people it’s AI?',
  disclosureRecommended: 'Recommended',
  disclosureWhenAsked: 'It answers truthfully whenever someone asks if they’re talking to a bot.',
  disclosureCalifornia:
    'A bot that helps sell to or book California customers has to say it’s a bot up front. If you have customers there, pick “In its first message”, or check with a lawyer first.',
  tone: 'How {name} sounds',
  keepTone: 'What you wrote in Knowledge stays as it is.',
  prices: 'Can {name} tell customers your prices?',
  pricesHint: 'Only the prices in Knowledge, exactly as written.',
  findings: 'Found on your website',
  keepAll: 'Keep all',
  findingsWaiting:
    '{name} is still reading your website. What it finds after you go on waits in Knowledge → Website.',
  findingsNone: '{name} didn’t find anything new on your website.',
  findingsFailed: '{name} couldn’t read your website. Try again later in Knowledge → Website.',
  learnedNoWebsite: 'Add what customers ask you most, or a PDF like a price sheet.',
  question: 'Question',
  answer: 'Your answer',
  addQuestion: 'Add a question',
  removeQuestion: 'Remove this question',
  pdf: 'Add a PDF',
  pdfHint: 'A price sheet, brochure or menu. It waits in Knowledge for you to check.',
  pdfAdded: (file: string) => `Added ${file}. It waits in Knowledge for you to check.`,
  qualifyAnswer: 'They answer with',
  qualifyChoices: 'Choices, separated by commas',
  qualifyKinds: { text: 'Their own words', choice: 'A choice', yes_no: 'Yes or no' },
  qualifyProtected:
    'Ask about what they need, not who they are: questions about family, age, religion or health aren’t allowed.',
  appTitle: 'Get the phone app',
  appWhy: 'Alerts reach you on the phone app, wherever you are.',
  appOn: 'The phone app is on your phone.',
  cellTitle: 'Your cell',
  cellWhy: 'Hand-offs are texted to your cell too.',
  cellNoNumber:
    'Once the business has a number, add your cell in Settings → Account, so hand-off texts reach you.',
  emailOff: 'Email alerts stay off. Turn them on in More settings if you want them.',
  chatCode: 'Add the chat to your website',
  chatCodeHint: 'Paste this once, just before </body> on every page.',
  chatMoreWays: 'More ways to add it',
  copy: 'Copy',
  copied: 'Copied',
  askThese: 'Ask {name} these questions',
  askOwn: 'Ask your own question',
  ask: 'Ask',
  asking: 'Asking…',
  knew: 'Answered',
  handedOff: 'Handed to a person',
  noReply: 'No reply',
  addAnswer: 'Add the answer',
  addAnswerHint: 'Write the answer the way you’d say it. {name} uses it from now on.',
  addedAnswer: 'Added. Asking again…',
  textTip:
    'Once texting works, text your business number from your own phone to see {name} answer.',
  isOn: '{name} is on.',
  turnedOn: (approvals: number) =>
    `{name} is on with training wheels: every message waits for your OK until you’ve approved ${approvals}.`,
  reportTitle: 'How {name} did',
  reportAllKnown: '{name} answered every question.',
  reportGaps: (n: number) =>
    n === 1 ? '1 question went to a person.' : `${n} questions went to a person.`,
} as const;

/** How a question on the test chat went, as its badge says. */
export const AI_SETUP_OUTCOME_WORDS: Readonly<Record<TestOutcome, string>> = {
  replied: AI_SETUP_FIELD_WORDS.knew,
  drafted: AI_SETUP_FIELD_WORDS.knew,
  handed_off: AI_SETUP_FIELD_WORDS.handedOff,
  no_reply: AI_SETUP_FIELD_WORDS.noReply,
};
