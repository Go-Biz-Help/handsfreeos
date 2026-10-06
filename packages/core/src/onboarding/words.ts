/**
 * Everything Getting started says: each step's title, the line under it, its button and its badge, and the
 * refusals. The web and the phone both read these, so a step says the same thing everywhere. Browser-safe.
 */
import { PHONE_APP_LINKS } from './app-links';
import {
  waitingDay,
  type OnboardingAnswers,
  type OnboardingStep,
  type OnboardingStepKey,
} from './steps';

export interface StepWords {
  readonly title: string;
  readonly detail: string;
  /** The step's one button; null when there's nothing to press (done, or waiting on someone else). */
  readonly action: string | null;
  /** The chip beside it: "In review · day 2", "Needs a fix", "Skipped". */
  readonly badge: string | null;
}

const PROVIDERS: Record<string, string> = { stripe: 'Stripe', square: 'Square' };

const aiName = (name: string | null | undefined) => name?.trim() || null;

/** A step's title, the same whatever state it's in. */
export function stepTitle(key: OnboardingStepKey, name?: string | null): string {
  switch (key) {
    case 'number':
      return 'Business number & texting';
    case 'payments':
      return 'Connect payments';
    case 'customers':
      return 'Bring in your customers';
    case 'calendar':
      return 'Calendar & booking page';
    case 'ai':
      return `Teach ${aiName(name) ?? 'your AI teammate'}`;
    case 'team':
      return 'Invite your team';
    case 'email_chat':
      return 'Email & website chat';
    case 'app':
      return 'Get the phone app';
    case 'sign_in':
      return 'Sign in faster';
    case 'notifications':
      return 'Turn on notifications';
    case 'my_calendar':
      return 'Connect your calendar';
  }
}

/** The carriers' words, as a clause: no full stop of its own. */
const clause = (s: string | null | undefined) => s?.trim().replace(/[.\s]+$/, '') || null;

type Line = { readonly detail: string; readonly action: string | null };

function todoLine(step: OnboardingStep, answers: OnboardingAnswers | null): Line {
  const n = step.note;
  switch (step.key) {
    case 'number':
      return n.phase === 'submit_registration'
        ? {
            detail: `${n.number ?? 'Your number'} is yours. Send your business details to the carriers so texting can start.`,
            action: 'Send details',
          }
        : {
            detail:
              'Customers call and text this number, and your AI teammate answers on it. Calls work as soon as you pick one.',
            action: 'Get a number',
          };
    case 'payments':
      return {
        detail:
          'Stripe or Square, for estimates, invoices and deposits. The money goes straight to your account.',
        action: 'Connect',
      };
    case 'customers':
      if (n.phase === 'migration_check')
        return {
          detail: 'Your move from your old CRM needs a look before it carries on.',
          action: 'Check it',
        };
      switch (answers?.customersIn) {
        case 'ghl':
          return {
            detail: 'You said they’re in GoHighLevel. Move them over; nothing there is changed.',
            action: 'Move from GoHighLevel',
          };
        case 'sheet':
          return {
            detail: 'Import your spreadsheet. You match the columns before anything is added.',
            action: 'Import a spreadsheet',
          };
        case 'crm':
          return {
            detail: 'Export a spreadsheet from your old CRM, then import it here.',
            action: 'Import a spreadsheet',
          };
        default:
          return {
            detail: 'Import a spreadsheet, or add them as you go: new leads add themselves.',
            action: 'Add customers',
          };
      }
    case 'calendar':
      return n.phase === 'booking'
        ? {
            detail: 'Turn on your booking page so customers can book themselves.',
            action: 'Turn on',
          }
        : {
            detail: 'Your services, your hours, and a page where customers book themselves.',
            action: 'Set up',
          };
    case 'ai': {
      const name = aiName(n.name);
      switch (n.phase) {
        case 'suggestions':
          return {
            detail: `${name ?? 'Your AI teammate'} found ${n.count ?? 0} ${n.count === 1 ? 'thing' : 'things'} on your website. Keep what’s right.`,
            action: 'Review',
          };
        case 'scanning':
          return {
            detail: 'Reading your website. In a minute you can keep what it found.',
            action: null,
          };
        case 'thin':
          return {
            detail: `${name ?? 'Your AI teammate'} needs to know more about your business. Scan your website or add answers.`,
            action: `Teach ${name ?? 'it'}`,
          };
        default:
          return {
            detail:
              'Your AI teammate answers texts, email and website chat. It learns about your business from your website.',
            action: 'Set up',
          };
      }
    }
    case 'team':
      return {
        detail:
          answers?.teamSize === 'small'
            ? 'You said 2 to 5 people work with you. Each gets a sign-in of their own.'
            : answers?.teamSize === 'big'
              ? 'You said 6 or more people work with you. Each gets a sign-in of their own.'
              : 'Each person gets their own sign-in and the right access.',
        action: 'Invite',
      };
    case 'email_chat':
      return n.phase === 'mailbox'
        ? {
            detail: 'Your mailbox is connected. Add chat to your website next.',
            action: 'Add chat',
          }
        : n.phase === 'chat'
          ? {
              detail: 'Chat is on your website. Connect your mailbox next.',
              action: 'Connect mailbox',
            }
          : { detail: 'Connect your mailbox and add chat to your website.', action: 'Set up' };
    case 'app':
      return PHONE_APP_LINKS.testing
        ? {
            detail: 'Test version for now: TestFlight on iPhone, Google Play testing on Android.',
            action: 'Get the links',
          }
        : { detail: 'On the App Store and Google Play.', action: 'Get the app' };
    case 'sign_in':
      return { detail: 'A passkey or Google, instead of typing your password.', action: 'Set up' };
    case 'notifications':
      return {
        detail: 'Hear about new leads and customers waiting on you, even when the app is closed.',
        action: 'Turn on',
      };
    case 'my_calendar':
      return {
        detail: 'Google or Outlook, so nobody books you when you’re already busy.',
        action: 'Connect',
      };
  }
}

function doneLine(step: OnboardingStep): string {
  const n = step.note;
  switch (step.key) {
    case 'number':
      return `${n.number ?? 'Your number'}. Calls and texting work.`;
    case 'payments':
      return `${PROVIDERS[n.provider ?? ''] ?? 'Your account'} is connected.`;
    case 'customers':
      return n.phase === 'as_you_go'
        ? 'You’re adding them as you go.'
        : `${n.count ?? 0} ${n.count === 1 ? 'customer' : 'customers'} in.`;
    case 'calendar':
      return `${n.count ?? 0} ${n.count === 1 ? 'service' : 'services'}, and your booking page is on.`;
    case 'ai':
      return `${aiName(n.name) ?? 'Your AI teammate'} knows your business. Approve its first replies in Inbox.`;
    case 'team':
      return n.phase === 'joined'
        ? `${n.count ?? 0} people in the business.`
        : 'Invitation sent. They’re in once they accept.';
    case 'email_chat':
      return 'Your mailbox and website chat are working.';
    case 'app':
      return 'On your phone.';
    case 'sign_in':
      return 'Set up.';
    case 'notifications':
      return 'On.';
    case 'my_calendar':
      return 'Connected.';
  }
}

function waitingLine(step: OnboardingStep): { detail: string; badge: string } {
  const n = step.note;
  switch (step.key) {
    case 'number':
      if (n.phase === 'provisioning')
        return { detail: 'Your number is being set up. It takes a minute.', badge: 'Setting up' };
      if (n.phase === 'porting')
        return {
          detail: `${n.number ?? 'Your number'} is moving over from your old carrier. That takes a few weeks.`,
          badge: 'Moving over',
        };
      {
        const day = waitingDay(step.since);
        return {
          detail: `${n.number ?? 'Your number'}. Calls work now. The carriers are reviewing texting, which takes a few days to a few weeks; we’ll email you.`,
          badge: day ? `In review · day ${day}` : 'In review',
        };
      }
    case 'payments':
      return {
        detail: `${PROVIDERS[n.provider ?? ''] ?? 'Your payment account'} is still checking your account. That can take a day or two.`,
        badge: 'Checking',
      };
    case 'customers':
      return n.phase === 'import'
        ? {
            detail: 'Your spreadsheet is being imported. Your customers show up as it goes.',
            badge: 'Importing',
          }
        : {
            detail:
              'Your customers are being counted or moved over. We’ll email you when there’s something to check.',
            badge: 'Moving over',
          };
    default:
      return { detail: 'Waiting on someone else.', badge: 'Waiting' };
  }
}

function needsFixLine(step: OnboardingStep): Line {
  const n = step.note;
  if (step.key === 'payments') {
    const provider = PROVIDERS[n.provider ?? ''] ?? 'Your payment account';
    return n.phase === 'needs_info'
      ? {
          detail: `${provider} needs more details from you before you can keep taking payments. Add them in your ${provider} dashboard.`,
          action: 'See what’s needed',
        }
      : {
          detail: `${provider} needs you to sign in again before you can take payments.`,
          action: 'Reconnect',
        };
  }
  const reason = clause(n.reason);
  return {
    detail: `The carriers turned down texting${reason ? `: ${reason}` : ''}. Fix your details and send them again.`,
    action: 'Fix details',
  };
}

/** What one step says, where it stands now. */
export function stepWords(
  step: OnboardingStep,
  answers: OnboardingAnswers | null = null,
): StepWords {
  const title = stepTitle(step.key, step.note.name);
  switch (step.state) {
    case 'done':
      return { title, detail: doneLine(step), action: null, badge: null };
    case 'waiting': {
      const w = waitingLine(step);
      return { title, detail: w.detail, action: null, badge: w.badge };
    }
    case 'needs_fix':
      return { title, ...needsFixLine(step), badge: 'Needs a fix' };
    case 'skipped': {
      const t = todoLine(step, answers);
      return { title, detail: `Skipped for now. ${t.detail}`, action: t.action, badge: 'Skipped' };
    }
    case 'todo':
      return { title, ...todoLine(step, answers), badge: null };
  }
}

/** "3 of 9 done" */
export const progressWords = (p: { readonly done: number; readonly total: number }) =>
  `${p.done} of ${p.total} done`;

/** A list of step titles as a person reads it: "A, B and C". */
function listed(titles: readonly string[]): string {
  if (titles.length <= 1) return titles[0] ?? '';
  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

export const ONBOARDING_WORDS = {
  /** `onboarding.finish` while something is still to do. */
  notFinished: (open: readonly string[]) =>
    `${open.length === 1 ? 'One step is' : `${open.length} steps are`} still to do: ${listed(open)}. Do ${open.length === 1 ? 'it' : 'them'}, or press Skip for now.`,
  /** A teammate trying to skip a step that belongs to the whole business. */
  businessStep:
    'Only an owner or admin of this business can skip that step, because it’s for everyone. Ask one of them, or skip the steps on your own list.',
  /** A step that isn't on this person's list. */
  notYourStep: 'That step isn’t on your list. Refresh the page to see your steps.',
  /** The guide shown again from Get help. */
  shownAgain: 'Getting started is back on Home.',
  /** The guide hidden. */
  hidden: 'Getting started is hidden. It’s under Get help whenever you want it.',
  finished: 'You’re set up.',
  /** Turned off, or back on, for the whole business. */
  turnedOff: 'Getting started is off for everyone in this business.',
  turnedOn: 'Getting started is back on. Everyone who hasn’t finished it sees it on Home again.',
  /** "Email me a link" for the phone app or its notifications, which are done on the phone itself. */
  noLink: 'That one’s done on the phone itself, so there’s no link to send. Do it right here.',
  /** Too many links asked for in a day. */
  linkLimit: (count: number) =>
    `You’ve asked for ${count} links today, which is as many as we send. Open HandsFreeOS on your computer instead, or try again tomorrow.`,
} as const;

/** The switch in Settings → Workspace that turns Getting started off, or on, for the whole business. */
export const GUIDE_SWITCH_WORDS = {
  title: 'Getting started guide',
  on: 'Everyone in this business sees Getting started on Home until they finish it or hide it: the business’s setup steps for owners and admins, a short list of their own for everyone else.',
  off: 'Off for everyone in this business. Nobody sees the guide, the setup steps or the tour. Turn it on again any time.',
  label: 'Show Getting started',
} as const;

/** Getting started in the phone app, besides the words it shares with the web (boards 9 and 10). */
export const PHONE_GUIDE_WORDS = {
  /** The phone app step, on the phone. */
  appDone: 'You’re using it now.',
  /** Notifications turned off in the phone's own settings, where only the phone can turn them back on. */
  notificationsOff:
    'Notifications are off for HandsFreeOS in your phone’s settings. Turn them on there, then come back.',
  openSettings: 'Open Settings',
  needsSignal: 'That needs signal. Try again when you’re back online.',
  tour: 'Take the 1-minute tour',
} as const;

/** "Email me a link": a step that's easier on a computer, sent to the person's email from the phone. */
export const LINK_WORDS = {
  action: 'Email me a link',
  easier: 'Easier on a computer',
  /** Under the next step on the phone, when it's one of those. */
  easierDetail: 'This one’s easier on a computer. We’ll email you a link for later.',
  sent: (email: string) => `Sent to ${email}. Open it on your computer.`,
  alreadySent: (email: string) =>
    `We sent it to ${email} a moment ago. Look for it in your email on your computer.`,
} as const;

/** The guide's own words on a screen, around the steps. */
export const GUIDE_WORDS = {
  title: 'Getting started',
  /** A teammate's list. */
  teammateTitle: 'Get set up',
  teammateIntro: 'A few quick things, about 2 minutes.',
  basics: 'The basics',
  later: 'When you’re ready',
  next: 'Next up',
  hide: 'Hide guide',
  skip: 'Skip',
  undo: 'Undo',
  showAll: (n: number) => `Show all ${n} steps`,
  showFewer: 'Show fewer',
  /** `shortcut` is how this browser opens Ask HandsFreeOS, like ⌘J or Ctrl J. */
  assistantHint: (shortcut: string | null) =>
    `Stuck? ${shortcut ? `Press ${shortcut} and ask` : 'Ask'} HandsFreeOS. It can change most settings for you.`,
  /** Under Get help. */
  menuItem: 'Getting started',
  menuShow: 'Show it on Home again',
  menuOnHome: 'On Home',
  askForHelp: 'Ask us for help',
  finishedTitle: 'You’re set up',
  finishedDetail: (skipped: readonly string[]) =>
    skipped.length === 0
      ? 'Everything on your list is done. From here, Home lists what needs you, most important first.'
      : `Everything else is done. You skipped ${listed(skipped)}; ${skipped.length === 1 ? 'it’s' : 'each is'} in Settings whenever you want it.`,
  finishedDone: 'Done',
  appTitle: 'Get the phone app',
  appTesting:
    'It’s in testing for now. Scan a code with your phone’s camera, or open the link on your phone, then sign in with this account.',
  appAndroidNote:
    'If Google Play says the app isn’t available, ask us to add your Google account to the testers.',
  appNotificationsNote: 'Notifications are turned on in the app itself, on your phone.',
  /** On the card, for a business that never answered the quick questions. */
  answerQuestions: 'Answer 4 quick questions to put these in order',
} as const;

/** The quick questions after Create business (board 1 in design/onboarding). */
export const QUESTION_WORDS = {
  title: 'A few quick questions',
  intro: 'Your answers put your setup in the right order. You can change any of them later.',
  goal: 'What do you want help with first?',
  goals: {
    leads: 'Answering leads fast',
    booked: 'Getting booked',
    paid: 'Getting paid',
    organized: 'Getting organized',
  },
  customersIn: 'Where are your customers now?',
  sources: {
    sheet: 'A spreadsheet',
    ghl: 'GoHighLevel',
    crm: 'Another CRM',
    phone: 'My phone’s contacts',
    none: 'Nowhere yet',
  },
  website: 'What’s your website?',
  websiteHint: 'Your AI teammate reads it to learn your services, prices and hours.',
  noWebsite: 'We don’t have one',
  noWebsiteHint: 'That’s fine. You can tell your AI teammate about the business yourself.',
  teamSize: 'How many people work with you?',
  teams: { solo: 'Just me', small: '2 to 5', big: '6 or more' },
  preview: 'Your setup, in this order',
  previewLater: 'Then, when you’re ready',
  numberFirst:
    'Your business number goes first because phone carriers take a few days to approve texting. You can do everything else while you wait.',
  skip: 'Skip these questions',
  continue: 'Continue',
  unanswered:
    'Pick an answer for each question with choices, or press Skip these questions to set up in the usual order.',
} as const satisfies {
  goals: Record<OnboardingAnswers['goal'], string>;
  sources: Record<OnboardingAnswers['customersIn'], string>;
  teams: Record<OnboardingAnswers['teamSize'], string>;
  [key: string]: unknown;
};

/** One line under each must-do in the quick questions' preview, from the answers so far. */
export function previewDetail(
  key: OnboardingStepKey,
  answers: Partial<OnboardingAnswers> | null = null,
): string {
  switch (key) {
    case 'number':
      return 'Pick a number, and send your details to the carriers';
    case 'payments':
      return 'Stripe or Square, for estimates, invoices and deposits';
    case 'customers':
      switch (answers?.customersIn) {
        case 'ghl':
          return 'Move them from GoHighLevel; nothing there changes';
        case 'sheet':
          return 'Import your spreadsheet';
        case 'crm':
          return 'Export a spreadsheet from your old CRM, then import it';
        case 'phone':
          return 'Add them one at a time, or a spreadsheet later';
        default:
          return 'Add them as they come in';
      }
    case 'calendar':
      return 'Your services, hours and booking link';
    case 'ai':
      return 'It learns about your business from your website';
    default:
      return stepTitle(key);
  }
}

/** The setup wizard's own words, around each step (boards 2 to 5b in design/onboarding). */
export const WIZARD_WORDS = {
  settingUp: (business: string) => `Setting up ${business}`,
  finishLater: 'Finish later',
  railTitle: 'The basics',
  railIntro: 'About 20 minutes. Skip anything and come back to it from Home.',
  railLater: 'Later, from your checklist',
  position: (n: number, of: number) => `${n} of ${of}`,
  back: 'Back',
  skip: 'Skip for now',
  next: 'Continue',
  finish: 'Finish and see Home',
  /** A step already done, when someone opens it again. */
  alreadyDone: 'This one’s done. Change anything below, or carry on.',
  /** Someone who can set the business up but not use what a step opens (a custom role). */
  cantDo:
    'You can’t change this part of the business. Ask an owner of this business to do this step, or skip it for now.',
  ein: {
    question: 'Does your business have an EIN?',
    yes: 'Yes',
    yesDetail: 'You get a local number. Carriers approve texting in 1 to 3 weeks.',
    no: 'No, or I’m a sole proprietor',
    noDetail: 'You get a toll-free number. Carriers approve texting in a few business days.',
  },
  numberReady: (number: string) => `${number} is yours, and texting is on.`,
  numberSettings: 'Change it in Settings → Texting & calls',
  aiManual: 'No website, or something it missed? Add it by hand in Knowledge.',
  aiManualLink: 'Open Knowledge',
  aiTurnOn: 'Your AI teammate starts off. Turn it on from the AI teammate page when you’re ready.',
  aiTurnOnLink: 'Open AI teammate',
  /** What the quick questions said about where the customers are now. */
  customersSaid: {
    sheet: 'You said your customers are in a spreadsheet.',
    ghl: 'You said your customers are in GoHighLevel.',
    crm: 'You said your customers are in another CRM. Export them from it as a spreadsheet, then import that here.',
    phone:
      'You said your customers are in your phone’s contacts. Export them as a spreadsheet, or add them as you go.',
    none: 'You said you don’t keep a list yet, so new leads can add themselves.',
  },
  fitsAnswer: 'Fits your answer',
  ways: {
    migrate: {
      title: 'Move from GoHighLevel',
      detail:
        'Sign in to GoHighLevel. We count what’s there and show you before anything moves. Nothing in GoHighLevel is changed or cancelled.',
    },
    sheet: {
      title: 'Import a spreadsheet',
      detail: 'A CSV with up to 20,000 rows. You match the columns before anything is added.',
    },
    asYouGo: {
      title: 'Add them as you go',
      detail: 'New leads from calls, texts and your booking page add themselves.',
    },
  },
  asYouGoAction: 'Add them as I go',
  migrationCounting: {
    title: 'Counting a big account takes a while',
    detail:
      'Keep setting up. The counts wait for you under Settings → Migrations, and on your checklist.',
  },
  migrationOpen: 'See the move',
  migrationReady: 'Open it to choose what comes across. Nothing moves until you say so.',
  calendarServices: 'Services',
  calendarServicesHint: 'What customers can book. Add each one with how long it takes.',
  calendarName: 'Service calls',
  calendarMake: 'Make my booking calendar',
  calendarMakeDetail:
    'One calendar your team takes bookings on, open during their working hours. Change anything later in Settings → Calendars.',
  calendarNeedsService: 'Add a service first, so there’s something to book.',
  calendarMade: (name: string) => `${name} takes bookings.`,
  calendarDraft: (name: string) =>
    `${name} isn’t taking bookings yet. Finish it in Settings → Calendars.`,
  calendarOpen: 'Open it',
  /** The booking page is there but off: publishing the texting opt-in form names it without turning it on. */
  bookingOff: 'Your booking page is off, so customers can’t book online yet.',
  bookingTurnOn: 'Turn it on',
  busyTimes: 'Your busy times',
  busyTimesDetail:
    'Connect Google or Outlook so nobody books you while you’re already out on a job.',
  busyTimesLink: 'Connect your calendar',
  paymentsSaid: 'You said getting paid comes first.',
  providers: {
    stripe: {
      title: 'Stripe',
      badge: 'Most businesses',
      detail:
        'Cards and bank payments. No account yet? You can open one while you connect. Stripe may take a day or two to check your details.',
    },
    square: {
      title: 'Square',
      detail:
        'If you already take payments with Square, keep using it. Your payments and payouts stay the same.',
    },
  },
  connect: (provider: string) => `Connect ${provider}`,
  paymentsWaiting: (provider: string) =>
    `${provider} is checking your details. That usually takes a day or two, and you can carry on meanwhile.`,
  titles: {
    number: 'Get your business number',
    payments: 'Connect how you get paid',
    customers: 'Bring in your customers',
    calendar: 'Set up your calendar and booking page',
    ai: 'Teach your AI teammate about your business',
  },
  intros: {
    number:
      'Customers call and text this number, and your AI teammate answers on it too. Calls work as soon as you pick one. Texting needs the phone carriers’ OK first.',
    payments:
      'Connect Stripe or Square and customers pay on their own link. The money goes straight to your account; HandsFreeOS never holds it.',
    customers: 'Bring them in once, and everything they do from now on lands in one place.',
    calendar:
      'Customers book themselves on your booking page, and your AI teammate books into the same calendar.',
    ai: 'Your AI teammate answers texts, email and website chat, and books visits. Nothing it learns is used until you keep it.',
  },
} as const satisfies {
  titles: Record<'number' | 'payments' | 'customers' | 'calendar' | 'ai', string>;
  intros: Record<'number' | 'payments' | 'customers' | 'calendar' | 'ai', string>;
  customersSaid: Record<OnboardingAnswers['customersIn'], string>;
  [key: string]: unknown;
};

/** One short line under a step in the wizard's rail: where it stands, or what it asks for. */
export function railLine(
  step: OnboardingStep,
  answers: Partial<OnboardingAnswers> | null = null,
): string {
  if (step.state === 'skipped') return 'Skipped for now';
  if (step.state === 'needs_fix') return 'Needs a fix';
  const n = step.note;
  if (step.state === 'waiting')
    return step.key === 'number' && n.number
      ? `${n.number} · texting in review`
      : (stepWords(step).badge ?? 'Waiting');
  if (step.state === 'done')
    switch (step.key) {
      case 'number':
        return `${n.number ?? 'Your number'} · texting on`;
      case 'ai':
        return `${aiName(n.name) ?? 'Your AI teammate'} knows your business`;
      case 'customers':
        return n.phase === 'as_you_go' ? 'Adding them as you go' : `${n.count ?? 0} in`;
      case 'calendar':
        return 'Booking page on';
      case 'payments':
        return `${PROVIDERS[n.provider ?? ''] ?? 'Payments'} connected`;
      default:
        return 'Done';
    }
  return previewDetail(step.key, answers);
}

/**
 * The tour's stops, in order (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, board 7): each one a place in the
 * menu. The phone's bottom bar has no Ask HandsFreeOS, so a phone-width tour skips it; a place someone took out of
 * their menu, or can't open, is skipped too.
 */
export const TOUR_STOPS = ['home', 'inbox', 'pipeline', 'calendar', 'ask'] as const;
export type TourStop = (typeof TOUR_STOPS)[number];

export const TOUR_WORDS = {
  label: 'Tour of the menu',
  position: (n: number, of: number) => `${n} of ${of}`,
  skip: 'Skip tour',
  back: 'Back',
  next: 'Next',
  done: 'Done',
  take: 'Take the tour',
  /** On the Getting started card, until the tour is taken or skipped. */
  offer: 'New here? A one-minute tour shows where everything is.',
} as const;

/** One stop's title and words. `shortcut` is how this browser opens Ask HandsFreeOS, like ⌘J. */
export function tourStopWords(
  stop: TourStop,
  shortcut: string | null = null,
): { readonly title: string; readonly body: string } {
  switch (stop) {
    case 'home':
      return {
        title: 'Home is your Action Center',
        body: 'What needs you, most important first, with the money at stake. Your Getting started guide lives here until you finish or hide it.',
      };
    case 'inbox':
      return {
        title: 'Every conversation in one place',
        body: 'Texts, calls, email and website chat land in Inbox. Your AI teammate’s drafts wait here for your OK.',
      };
    case 'pipeline':
      return {
        title: 'Your leads and jobs',
        body: 'Each lead has a stage, from New to Won. Move it along as the job does, and see the money in each stage.',
      };
    case 'calendar':
      return {
        title: 'Every visit, however it was booked',
        body: 'Visits booked on your booking page, by your AI teammate, or by your team all show up here.',
      };
    case 'ask':
      return {
        title: 'Ask HandsFreeOS anything',
        body: `${shortcut ? `Press ${shortcut}` : 'Open it'} to ask about your business or get something done, like “add a service called Duct cleaning.”`,
      };
  }
}
