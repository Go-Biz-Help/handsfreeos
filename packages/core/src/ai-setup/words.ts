/**
 * Quick setup's words, shared by the web and the phone (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4).
 * Browser-safe.
 */
import type { DisclosureMode, HoursMode } from '../ai-team/config';
import type { AiSetupStep, AiSetupTone } from './answers';
import type { SetupJob, SetupKind, SetupTone } from './kinds';

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

/** A screen's title with the teammate's name in it. */
export const aiSetupStepTitle = (step: AiSetupStep, name: string): string =>
  AI_SETUP_STEP_TITLES[step].replaceAll('{name}', name.trim() || 'Ava');

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

/** The calendar quick setup makes when Book is ticked and there isn't one customers can book. */
export const aiSetupCalendarName = (kind: SetupKind): string =>
  kind === 'home' ? 'Service calls' : 'Appointments';

/** The service area made from a list of ZIP codes. */
export const AI_SETUP_AREA_NAME = 'Service area';

export const AI_SETUP_WORDS = {
  /** The small link that leaves quick setup for today's full settings. */
  setItUpMyself: 'Set it up myself',
  moreSettings: 'More settings',
  runAgain: 'Run quick setup again',
  /** Shown before saving a run when the business already has a teammate. */
  willChange: 'Here’s what will change',
  nothingChanges: 'Nothing changes. Your answers match what’s saved.',
  turnOn: 'Turn on with training wheels',
  notYet: 'Not yet',
  skip: 'Skip',
  /** "What do customers ask you most?" */
  topQuestions: 'What do customers ask you most?',
  topQuestionsHint: 'Up to 3, with your answers. Optional.',
  noWebsite: 'We don’t have one',
  /** A run left part way on another device. */
  carryOn: 'Carry on where you left off',
  startOver: 'Start over',
  savedNotice: 'Saved. Try a few questions before you turn it on.',
} as const;
