/**
 * Every part of the business someone can set up, in one list (M12): what it is called, where it lives, what the
 * Assistant may change there, and — for the few it cannot — what the person has to do themselves.
 *
 * One source for three things: the fixed part of the Assistant's prompt (so it names the right screen), the
 * `settings_help` tool (so a person gets the steps and a link), and `get_settings` (so it can read what is there
 * now before proposing a change). Browser-safe: the panels and the worker read the same list.
 */

import type { Permission } from '../permissions';

export const SETTINGS_AREAS = [
  'business',
  'branded_domain',
  'pipelines',
  'calendars',
  'services',
  'resources',
  'territories',
  'booking_site',
  'team',
  'tags',
  'texting',
  'email',
  'website_chat',
  'lead_intake',
  'payments',
  'products',
  'action_center',
  'ai_teammate',
  'knowledge',
  'my_account',
  'my_calendar',
  'imports',
] as const;
export type SettingsArea = (typeof SETTINGS_AREAS)[number];

/** Something only the person can finish, and what it takes. */
export interface SettingsHandover {
  /** What they are trying to do, in their words: "connect Stripe". */
  readonly what: string;
  /** Why the Assistant can't: shown as the first line of the answer. */
  readonly why: string;
  /** What to do, a step a line. */
  readonly steps: readonly string[];
}

export interface SettingsAreaInfo {
  readonly area: SettingsArea;
  /** What it is called on screen: "Texting & calls". */
  readonly label: string;
  /** One line: what is set up here. */
  readonly what: string;
  /** The screen, under /app/w/<workspaceId>. */
  readonly path: string;
  /** What someone needs to change it; null when it is their own account. */
  readonly permission: Permission | null;
  /** What the Assistant can change here, in plain words. Empty when it can only read. */
  readonly canChange: readonly string[];
  /** What the person has to do themselves. */
  readonly handovers: readonly SettingsHandover[];
}

const AREAS: Record<SettingsArea, Omit<SettingsAreaInfo, 'area'>> = {
  business: {
    label: 'Workspace',
    what: 'the business name, time zone, industry, website, review link and open hours',
    path: '/settings/workspace',
    permission: 'workspace.update',
    canChange: ['the name, time zone and industry', 'the website and review link', 'open hours'],
    handovers: [],
  },
  branded_domain: {
    label: 'Your own web address',
    what: 'the domain the customer-facing links are served on — forms, payment links, estimates, invoices, website chat, and the booking page and calendar links — instead of handsfreeos.com',
    // The same screen as the business itself: one domain covers every public link, so it does not belong
    // under any one of them.
    path: '/settings/workspace',
    permission: 'channels.manage',
    canChange: [],
    handovers: [
      {
        what: 'use your own domain for your forms, payment links and booking page',
        why: 'the records go in with whoever you bought the domain from, which only you can sign in to',
        steps: [
          'Open Settings → Workspace and type the address you want, like go.yourbusiness.com.',
          'Give it a moment — it works out what your DNS needs and shows the records on that same card.',
          'Put the records it shows you — usually one, sometimes two — in with whoever you bought the domain from (GoDaddy, Namecheap, wherever it is).',
          'DNS often takes a few hours. The card says when it is working, and it keeps checking on its own.',
        ],
      },
    ],
  },
  pipelines: {
    label: 'Pipelines',
    what: 'the pipelines leads move through, and their stages',
    path: '/settings/pipelines',
    permission: 'pipelines.manage',
    canChange: ['add, rename or archive a pipeline', 'add, rename, reorder or delete a stage'],
    handovers: [],
  },
  calendars: {
    label: 'Calendars',
    what: 'the calendars people book on: who works them, what they offer, hours and booking rules',
    path: '/settings/calendars',
    permission: 'calendars.manage',
    canChange: [
      'create a calendar',
      'rename it, or change its colour, time zone or booking link',
      'who works it, and what it offers',
      'its hours, buffers and booking rules',
      'turn it on or off',
    ],
    handovers: [
      {
        what: 'connect a Google or Outlook calendar',
        why: 'you sign in to Google or Microsoft yourself, so nobody else can do it for you',
        steps: [
          'Open Settings → My calendar.',
          'Press Connect beside Google or Outlook.',
          'Sign in and allow HandsFreeOS to see when you are busy.',
        ],
      },
    ],
  },
  services: {
    label: 'Services',
    what: 'what you book: how long each job takes, what it costs, who can do it',
    path: '/settings/calendars/services',
    permission: 'calendars.manage',
    canChange: [
      'add, change or archive a service',
      'its lengths, price, buffers and colour',
      'who can do it, and what it needs',
    ],
    handovers: [],
  },
  resources: {
    label: 'Resources',
    what: 'things a job needs as well as a person: a truck, a bay, a piece of equipment',
    path: '/settings/calendars/resources',
    permission: 'calendars.manage',
    canChange: ['add, change or archive a resource', 'how many there are, and its hours'],
    handovers: [],
  },
  territories: {
    label: 'Territories',
    what: 'which ZIP codes each person covers',
    path: '/settings/calendars/territories',
    permission: 'calendars.manage',
    canChange: ['add, change or delete a territory', 'its ZIP codes and who covers them'],
    handovers: [],
  },
  booking_site: {
    label: 'Booking site',
    what: 'the page customers book on: its address, name and intro',
    path: '/settings/calendars/booking-site',
    permission: 'calendars.manage',
    canChange: ['the address, name and intro', 'turn the booking site on or off'],
    handovers: [],
  },
  team: {
    label: 'Team',
    what: 'who works here and what each of them may do',
    path: '/members',
    permission: 'members.invite',
    canChange: [
      'invite someone',
      'change what a teammate may do',
      'remove a teammate',
      'resend or cancel an invitation',
    ],
    handovers: [
      {
        what: 'accept an invitation',
        why: 'the person invited opens the email and accepts it themselves',
        steps: [
          'They get an email from HandsFreeOS.',
          'They press Accept and pick how they sign in.',
        ],
      },
    ],
  },
  tags: {
    label: 'Tags',
    what: 'the labels you put on customers and leads',
    path: '/settings/workspace',
    permission: 'tags.manage',
    canChange: ['add, rename, recolour or delete a tag'],
    handovers: [],
  },
  texting: {
    label: 'Texting & calls',
    what: 'your business number, who it rings, voicemail, quiet hours and carrier registration',
    path: '/settings/texting',
    permission: 'channels.manage',
    canChange: [
      'get a number, or give one up',
      'who it rings, for how long, and voicemail',
      'what the customer sees when a call is forwarded',
      'quiet hours, and when to remind the team a customer is waiting',
      'fill in and send the carrier registration',
    ],
    handovers: [
      {
        what: 'get texting approved by the carriers',
        why: 'the phone carriers review it, which takes a few days and is out of everyone’s hands here',
        steps: [
          'Send the registration (I can fill it in with you).',
          'Wait for the carriers: Settings → Texting & calls shows where it stands.',
          'Texting turns on by itself once they approve it.',
        ],
      },
    ],
  },
  email: {
    label: 'Email',
    what: 'the addresses you send from, your own sending domain, and blocked addresses',
    path: '/settings/email',
    permission: 'channels.manage',
    canChange: [
      'add or change a sending address',
      'add or remove your own sending domain, and check it',
      'unblock an address',
    ],
    handovers: [
      {
        what: 'connect a Gmail or Outlook mailbox',
        why: 'you sign in to Google or Microsoft yourself',
        steps: [
          'Open Settings → Email.',
          'Press Connect beside Gmail or Outlook.',
          'Sign in and allow HandsFreeOS to read and send that mail.',
        ],
      },
      {
        what: 'use your own domain for email',
        why: 'the records go in with whoever you bought the domain from, which only you can sign in to',
        steps: [
          'I add the domain here and give you the records to copy.',
          'You add them where you bought the domain (GoDaddy, Namecheap, wherever it is).',
          'Tell me when they are in and I will check it.',
        ],
      },
    ],
  },
  lead_intake: {
    label: 'Lead intake',
    what: 'what happens when a stranger texts, calls or emails: whether they become a customer and a lead, and where that lead lands',
    path: '/settings/lead-intake',
    permission: 'channels.manage',
    canChange: [
      'turn a channel on or off',
      'whether a lead opens as well as the customer',
      'which pipeline and stage those leads land in, and what they are filed under',
      'the most leads a day a channel may open',
    ],
    handovers: [
      {
        what: 'connect a form on your own website, or an app like Zapier',
        why: 'a form needs its key pasted into your website, and an app’s key is a secret I never put in a chat',
        steps: [
          'Open Settings → Lead intake and press Website form or Connect an app.',
          'A form gives you a snippet to paste into your page; an app gives you a key, shown once.',
          'Tell me where you want those leads to land and I’ll set the pipeline up for you.',
        ],
      },
    ],
  },
  website_chat: {
    label: 'Website chat',
    what: 'the chat box on your website: who answers it, how it looks, what it asks for',
    path: '/settings/website-chat',
    permission: 'channels.manage',
    canChange: [
      'turn it on or off',
      'which sites it may show on',
      'its greeting, label and colour',
      'what it asks visitors for, and who answers',
    ],
    handovers: [
      {
        what: 'put the chat box on your website',
        why: 'the snippet goes into your website, which lives outside HandsFreeOS',
        steps: [
          'I set the chat box up and give you the snippet.',
          'Paste it into your site before </body> (or into your site builder’s custom-code box).',
          'Settings → Website chat goes green once it sees it.',
        ],
      },
    ],
  },
  payments: {
    label: 'Payments',
    what: 'how you get paid: accounts, tax, terms, deposits, reminders and numbering',
    path: '/settings/payments',
    permission: 'money.manage',
    canChange: [
      'ways to pay, sales tax and your business address',
      'terms, notes, and how estimates and invoices are numbered',
      'deposits, and how long an estimate is good for',
      'invoice reminders and estimate nudges',
      'rename a payout account, make one the default, or disconnect it',
    ],
    handovers: [
      {
        what: 'connect Stripe or Square',
        why: 'you sign in to them yourself, and they ask for your business details',
        steps: [
          'Open Settings → Payments.',
          'Press Connect beside Stripe or Square.',
          'Sign in there and finish their questions; you land back here when it is done.',
        ],
      },
    ],
  },
  products: {
    label: 'Products',
    what: 'what goes on an estimate or invoice: your items, their prices and tax',
    path: '/settings/payments/products',
    permission: 'money.manage',
    canChange: [
      'add, change or archive an item',
      'its price, unit, tax and the service it matches',
    ],
    handovers: [],
  },
  // The key stays action_center: Settings → Action Center became Settings → Automations, and its settings with it.
  action_center: {
    label: 'Automations',
    what: 'every automation: what Home watches for, the reminders and follow-ups, and what HandsFreeOS handles on its own',
    path: '/settings/automations',
    permission: 'workspace.update',
    canChange: [
      'turn each automation on or off',
      'which kinds of thing Home looks for',
      'how fast a lead counts as waiting, and what a big job is',
      'what HandsFreeOS does on its own, and how it words it',
    ],
    handovers: [],
  },
  ai_teammate: {
    label: 'AI teammate',
    what: 'your AI teammate: its name, what it may do, which channels it answers on and its hours',
    path: '/ai-team',
    permission: 'ai_team.manage',
    canChange: [
      'set one up, name it, and how it introduces itself',
      'off, training wheels, or automatic',
      'which channels it answers on, and its hours',
      'what it may do: answer, qualify, book, follow up',
      'its limits, and when it hands a customer to a person',
    ],
    handovers: [],
  },
  knowledge: {
    label: 'Knowledge base',
    what: 'what your AI knows about the business: what you offer, hours, policies and how to sound',
    path: '/knowledge',
    permission: 'knowledge.manage',
    canChange: [
      'what you offer, your area, hours and policies',
      'how it should sound, and whether it may quote prices',
      'add a question and answer, a fact or an article',
    ],
    handovers: [
      {
        what: 'add a document to the knowledge base',
        why: 'the file is on your computer, so you pick it',
        steps: ['Open Knowledge → Documents.', 'Press Add and choose a PDF, text or CSV file.'],
      },
    ],
  },
  my_account: {
    label: 'Account',
    what: 'your own name, how the app looks, and what you are told about',
    path: '/settings',
    permission: null,
    canChange: ['your name', 'light or dark', 'which emails and phone alerts you get'],
    handovers: [
      {
        what: 'change your password, Google sign-in or passkeys',
        why: 'these are your keys to the account; you set them yourself',
        steps: ['Open Settings → Account.', 'Use Sign-in methods to change any of them.'],
      },
      {
        what: 'confirm your cell number',
        why: 'HandsFreeOS calls it and you press 1, so it has to be you',
        steps: [
          'Open Settings → Account → My cell.',
          'Put your number in and press Confirm.',
          'Answer the call and press 1.',
        ],
      },
      {
        what: 'delete your account',
        why: 'it cannot be undone, so it is typed in by hand',
        steps: ['Open Settings → Account.', 'Under Delete account, type your email to confirm.'],
      },
    ],
  },
  my_calendar: {
    label: 'My calendar',
    what: 'your own working hours, and time off',
    path: '/settings/my-calendar',
    permission: null,
    canChange: ['your working hours', 'time off, and extra hours you are available'],
    handovers: [],
  },
  imports: {
    label: 'Imports',
    what: 'bringing customers in from a spreadsheet, or moving a business over from another system',
    path: '/settings/imports',
    permission: 'records.import',
    canChange: [],
    handovers: [
      {
        what: 'import a spreadsheet of customers',
        why: 'the file is on your computer, so you pick it and check the columns line up',
        steps: [
          'Open Settings → Imports and press New import.',
          'Choose People or Companies and pick your file.',
          'Check the columns match, then start it.',
        ],
      },
      {
        what: 'move a business over from another system',
        why: 'you sign in to the old system yourself so HandsFreeOS may read it',
        steps: [
          'Open Settings → Migrations.',
          'Pick the system you are coming from and sign in there.',
          'Choose what to bring over; it runs from there.',
        ],
      },
    ],
  },
};

export const settingsArea = (area: SettingsArea): SettingsAreaInfo => ({
  area,
  ...AREAS[area],
});

export const settingsAreas = (): readonly SettingsAreaInfo[] => SETTINGS_AREAS.map(settingsArea);

/** The screen itself, for a card's link. */
export const settingsPath = (workspaceId: string, area: SettingsArea): string =>
  `/app/w/${workspaceId}${AREAS[area].path}`;

/**
 * The areas as the fixed part of the prompt says them: one line each, so the model names the right screen without
 * anything being looked up per question.
 */
export function settingsMapText(): string {
  return settingsAreas()
    .map((a) => {
      const handovers = a.handovers.map((h) => h.what);
      const theirs = handovers.length ? ` They do themselves: ${handovers.join('; ')}.` : '';
      return `- ${a.label} (${a.area}): ${a.what}.${theirs}`;
    })
    .join('\n');
}
