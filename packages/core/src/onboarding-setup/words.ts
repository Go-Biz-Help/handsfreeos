/**
 * The onboarding setup's words, shared by the web and the phone
 * (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4). The AI part's screens keep the AI quick setup's
 * own words (`ai-setup/words.ts`). Setup says "business" everywhere, never "workspace". Browser-safe.
 */
import { aiSetupStepHint, aiSetupStepTitle, withAiName } from '../ai-setup/words';
import { LOOK_WORDS } from '../look/words';
import { QUESTION_WORDS } from '../onboarding/words';
import {
  AI_SCREEN_OF,
  type HandOverRole,
  type OnboardingSetupScreen,
  type OnboardingSetupStop,
  type PayWith,
} from './answers';

/** Each stop's short name, for "3 of 15 · About your business". */
export const ONBOARDING_SETUP_STOP_NAMES: Readonly<Record<OnboardingSetupStop, string>> = {
  signup: 'Sign up',
  business: 'Your business',
  goal: 'Your goal',
  about: 'About your business',
  hours: 'Your hours',
  look: 'Your logo and colour',
  page: 'Your page',
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
  look: { title: LOOK_WORDS.title, hint: LOOK_WORDS.intro },
  page: {
    title: 'A simple page for your business',
    hint: 'Made from your answers. Customers can book, call, text or chat from it, and the phone carriers look at it before they approve your texting.',
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
 * The screens that ask something else when someone from the business's agency sets it up for the owner (the owner's
 * 53A): the booking page and "Stay in the loop" are the owner's to do.
 */
const FOR_CLIENT_SCREENS: Readonly<
  Partial<Record<OnboardingSetupScreen, { readonly title: string; readonly hint: string }>>
> = {
  booking: {
    title: 'The booking page is the owner’s',
    hint: 'It books their time, on their own hours, so they make it when they finish. Your services and open hours are saved for it.',
  },
  loop: {
    title: 'Hand it to the owner',
    hint: 'They get an email to check what you set up and finish their part: the booking page, payments and their notifications.',
  },
};

/**
 * A screen's question, with the teammate's name in it: the setup's own, else the AI quick setup's. "When are you
 * open?" asks only that here; when Ava answers keeps its pick. With no website (`place.website` false), the chat
 * screen asks about a chat on the business's simple page. `forClient`: someone from the agency is setting it up
 * for the owner (`state.forClient`).
 */
export const onboardingSetupTitle = (
  screen: OnboardingSetupScreen,
  name: string,
  place?: { readonly website: boolean },
  forClient = false,
): string => {
  const own = (forClient ? FOR_CLIENT_SCREENS[screen] : undefined) ?? OWN_SCREENS[screen];
  const ai = AI_SCREEN_OF[screen];
  if (own) return withAiName(own.title, name);
  return ai ? aiSetupStepTitle(ai, name, place) : '';
};

/** What a screen says under its question, with the teammate's name in it. */
export const onboardingSetupHint = (
  screen: OnboardingSetupScreen,
  name: string,
  place?: { readonly website: boolean },
  forClient = false,
): string => {
  const own = (forClient ? FOR_CLIENT_SCREENS[screen] : undefined) ?? OWN_SCREENS[screen];
  const ai = AI_SCREEN_OF[screen];
  if (own) return withAiName(own.hint, name);
  return ai ? aiSetupStepHint(ai, name, place) : '';
};

/** A stop's short name: "Stay in the loop" is "Hand it over" for someone setting it up for the owner. */
export const onboardingSetupStopName = (stop: OnboardingSetupStop, forClient = false): string =>
  forClient && stop === 'loop' ? 'Hand it over' : ONBOARDING_SETUP_STOP_NAMES[stop];

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
  /** The counter: "3 of 15". */
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

  // Your page
  usePage: 'Use this page',
  notNow: 'Not now',
  pageAt: 'Your page is at',
  openPage: 'Open it',
  /** Under the preview: the buttons that come with the stops after it. */
  pageButtonsLater: (booksTime: boolean) =>
    `${booksTime ? 'Book, Call, Text and Chat switch' : 'Call, Text and Chat switch'} on as you set them up next.`,
  pagePreview: 'A preview of your page',
  pageLater: 'Use your own domain for it any time in Settings → Workspace.',
  pageNotNow:
    'The phone carriers want a website before they approve texting. Turn your page on any time in Settings → Workspace.',

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

/**
 * When someone from the business's agency sets it up for the owner, and when the owner checks it and finishes (the
 * owner's 53A). `agency` is the agency's name, `name` the person's who set it up.
 */
export const ONBOARDING_SETUP_HAND_OVER_WORDS = {
  /** On "Get paid", in place of Connect: payments go to the owner's own account. */
  payWaits: (provider: string) =>
    `The owner signs in to ${provider} when they finish, so payments go to their own account.`,
  /** On the customers stop, in place of the phone's contacts. */
  phoneWaits: 'The owner picks them one by one in the phone app, once they join.',

  // Handing it over
  ownerEmail: 'The owner’s email (optional)',
  ownerEmailHint: (role: HandOverRole) =>
    role === 'owner'
      ? 'They join as the owner of this business. Leave it empty to invite them later from Members.'
      : 'They join as an admin, since only an owner of your agency can make someone an owner. Leave it empty to invite them later from Members.',
  handOver: 'Save and hand it over',
  /** Done, for whoever handed it over. */
  sent: (email: string) => `${email} has an email to check it and finish their part.`,
  notSent: 'Invite the owner from Members when you’re ready. They check it and finish from there.',

  // The owner checks it
  checkCounter: 'Set up for you',
  checkTitle: (agency: string) => `Check what ${agency} set up`,
  checkHint: (name: string, business: string) =>
    `${name} set up ${business} for you. Look it over and change anything you like, then finish your part.`,
  yourPart: 'Your part',
  partBooking: 'Make your booking page, on your own hours',
  partPaid: (provider: string) => `Sign in to ${provider}, so payments go to your account`,
  partLoop: 'Get alerts on your phone when a customer needs you',
  change: 'Change something',
  finishPart: 'Finish my part',
  /** Home's Getting started card, until the owner finishes. */
  homeTitle: (agency: string) => `${agency} set up your business`,
  homeDetail: 'Look over what they did, change anything you like, and finish your part.',
  homeAction: 'Check it and finish',
} as const;
