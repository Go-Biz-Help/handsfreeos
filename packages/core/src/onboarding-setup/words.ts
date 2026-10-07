/**
 * The onboarding setup's words, shared by the web and the phone
 * (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4). The AI part's screens keep the AI quick setup's
 * own words (`ai-setup/words.ts`). Setup says "business" everywhere, never "workspace". Browser-safe.
 */
import { AI_SETUP_STEP_HINTS, AI_SETUP_STEP_TITLES, withAiName } from '../ai-setup/words';
import { QUESTION_WORDS } from '../onboarding/words';
import {
  AI_SCREEN_OF,
  type OnboardingSetupScreen,
  type OnboardingSetupStop,
  type PayWith,
} from './answers';

/** Each stop's short name, for "3 of 13 · About your business". */
export const ONBOARDING_SETUP_STOP_NAMES: Readonly<Record<OnboardingSetupStop, string>> = {
  signup: 'Sign up',
  business: 'Your business',
  goal: 'Your goal',
  about: 'About your business',
  hours: 'Your hours',
  customers: 'Your customers',
  booking: 'Your booking page',
  number: 'Your business number',
  paid: 'Payments and reviews',
  ai: 'Your AI teammate',
  loop: 'Stay in the loop',
  try: 'Try it',
  done: 'Done',
};

/** Each of the setup's own screens: its question, and what it says under it. `{name}` is the teammate's name. */
const OWN_SCREENS: Readonly<
  Partial<Record<OnboardingSetupScreen, { readonly title: string; readonly hint: string }>>
> = {
  business: {
    title: 'Your business',
    hint: 'Your address sets your time zone. {name} starts reading your website while you answer the rest.',
  },
  goal: {
    title: QUESTION_WORDS.goal,
    hint: 'It picks what {name} helps with first, and the order of what’s left on Home.',
  },
  about: {
    title: 'About your business',
    hint: 'Asked once, used everywhere: what {name} tells customers, your price list and what they book.',
  },
  hours: {
    title: 'When are you open?',
    hint: 'Used for your booking times, your team’s hours, {name} and what customers are told.',
  },
  customers: {
    title: QUESTION_WORDS.customersIn,
    hint: 'Each answer goes straight to its way in. Nothing in your old system changes.',
  },
  booking: {
    title: 'Your booking page is ready',
    hint: 'Made from your services and hours. Change anything later in Settings → Calendars.',
  },
  number: {
    title: 'Your business number',
    hint: 'Calls work right away. Texting starts once the phone carriers approve it.',
  },
  paid: {
    title: 'Get paid, and get reviews',
    hint: 'Both are optional, and both can wait for Settings.',
  },
  done: {
    title: 'It’s already working for you',
    hint: 'Here’s what works now, and what’s still on its way.',
  },
};

/**
 * A screen's question, with the teammate's name in it: the setup's own, else the AI quick setup's. "When are you
 * open?" asks only that here; when Ava answers keeps its pick.
 */
export const onboardingSetupTitle = (screen: OnboardingSetupScreen, name: string): string => {
  const own = OWN_SCREENS[screen];
  const ai = AI_SCREEN_OF[screen];
  return withAiName(own?.title ?? (ai ? AI_SETUP_STEP_TITLES[ai] : ''), name);
};

/** What a screen says under its question, with the teammate's name in it. */
export const onboardingSetupHint = (screen: OnboardingSetupScreen, name: string): string => {
  const own = OWN_SCREENS[screen];
  const ai = AI_SCREEN_OF[screen];
  return withAiName(own?.hint ?? (ai ? AI_SETUP_STEP_HINTS[ai] : ''), name);
};

export const PAY_WITH_LABELS: Readonly<Record<PayWith, string>> = {
  stripe: 'Stripe',
  square: 'Square',
  later: 'Later',
};

/** The labels on the setup's own screens. `{name}` is the teammate's name (`withAiName`). */
export const ONBOARDING_SETUP_WORDS = {
  goals: QUESTION_WORDS.goals,
  sources: QUESTION_WORDS.sources,
  teams: QUESTION_WORDS.teams,
  teamSize: QUESTION_WORDS.teamSize,
  /** The counter: "3 of 13". */
  position: (n: number, of: number) => `${n} of ${of}`,
  next: 'Next',
  back: 'Back',
  skip: 'Skip for now',
  carryOn: 'Carry on where you left off',
  startOver: 'Start over',
  summary: 'Your setup so far',
  seeSummary: 'See the summary',
  /** A screen's own part while it's fetched. */
  loading: 'One moment…',
  /** The last screen's button. */
  goHome: 'Go to Home',
  /** Someone who can set the business up but not use what a stop opens (a custom role). */
  cantDo:
    'Your role can’t change this part of the business. Ask an owner of this business to do it, or carry on.',

  // Your business, before it's made
  agency: 'I run an agency that manages several businesses',
  agencyHint: 'Each client gets a business of its own, under one agency you control.',
  agencyName: 'Agency name',
  agencyNameHint: (business: string) =>
    `Shown in your list of businesses as the agency that owns ${business}.`,

  // Your business
  /** The business in the summary before it has a name. */
  unnamed: 'Your business',
  businessName: 'Business name',
  businessNameMissing: 'Name your business.',
  whatYouDo: 'What do you do?',
  whatYouDoHint: 'Search, like “plumber” or “hair salon”, or tap the closest fit.',
  kindMissing: 'Pick what you do: search for it, or tap the closest fit and pick from the list.',
  searchKinds: 'Search kinds of business',
  address: 'Your address',
  addressHint:
    'It goes on your invoices and your texting registration, and it finds you a local number.',
  line1: 'Street address',
  line2: 'Suite or unit (optional)',
  city: 'City',
  state: 'State',
  postalCode: 'ZIP code',
  timeZone: 'Time zone',
  timeZoneFromAddress: (zone: string) => `${zone} time, from your address.`,
  changeTimeZone: 'Change',
  website: 'Your website',
  noWebsite: QUESTION_WORDS.noWebsite,

  // Your goal
  inviteNow: 'Invite them now (optional)',
  inviteHint:
    'They get an email to join as team members. An owner can make any of them an admin later.',
  inviteEmail: 'Their email',
  addInvite: 'Add someone',
  removeInvite: 'Remove this person',
  invited: (email: string) => `Invited ${email}`,

  // About your business
  booksTime: 'Do customers book a time with you?',
  booksTimeHint: 'Yes makes you a booking page from your services and hours.',
  servicePrice: 'Price (optional)',
  serviceLength: 'How long (optional)',
  minutes: (n: number) =>
    n % 60 === 0 ? `${n / 60} hr` : n > 60 ? `${Math.floor(n / 60)} hr ${n % 60} min` : `${n} min`,

  // Customers
  ghlHint: 'Paste a private integration token from GoHighLevel. The move runs while you carry on.',
  sheetHint: 'We match the columns for you, and show a preview to check.',
  crmHint: 'Export a spreadsheet from your old CRM, then bring it in here.',
  phoneHint: 'Pick them one by one in the phone app. Personal contacts stay out.',
  noneHint: 'New leads add themselves as they come in.',

  // Booking
  connectCalendar: 'Connect Google or Outlook (optional)',
  connectCalendarHint: 'So customers never book a time you’re busy.',
  connectCalendarLink: 'Connect your calendar',
  bookingAt: 'Customers book at',
  makingBooking: 'Making your booking page from your services and hours…',
  openBooking: 'Open it',

  // Number
  ein: 'Does your business have an EIN?',
  einHint:
    'With one you get a local number. Without one, a toll-free number, which is approved faster.',
  einYes: 'Yes',
  einNo: 'No',
  haveNumber: 'I already have a number',

  // Paid
  payWith: 'How do customers pay you?',
  payWithLabels: PAY_WITH_LABELS,
  payLater:
    'Customers pay you the way they do today. Connect Stripe or Square any time in Settings → Payments.',
  payConnected: (provider: string) =>
    `${provider} is connected. Customers pay by card on their own link.`,
  paySignInAgain: (provider: string) =>
    `${provider} needs you to sign in again before customers can pay.`,
  reviewLink: 'Your Google review link (optional)',
  reviewLinkHint: 'The thank-you text after a job sends it.',
  findReviewLink: 'How to find it',
  reviewLinkHelp:
    'Search for your business on Google and open your Business Profile. Press Ask for reviews, copy the link it shows, and paste it here.',
} as const;
