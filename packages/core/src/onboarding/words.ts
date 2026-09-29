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
          action: `Open ${provider}`,
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
} as const;
