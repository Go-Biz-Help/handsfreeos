/**
 * Every part of the business someone can set up, in one list (M12): what it is called, where it lives, what the
 * Assistant may change there, and — for the few it cannot — what the person has to do themselves.
 *
 * One source for three things: the fixed part of the Assistant's prompt (so it names the right screen), the
 * `settings_help` tool (so a person gets the steps and a link), and `get_settings` (so it can read what is there
 * now before proposing a change). Browser-safe: the panels and the worker read the same list.
 *
 * `where` is the way there a click at a time, in the words the side menu and the tabs use, and `onScreen` is what
 * the person finds when they arrive, top to bottom. The Assistant once sent someone to "Settings → Territories",
 * which is not a tab: territories are a button under Settings → Calendars. So the whole way is spelled out here
 * and in the prompt, and test/settings-map.test.ts checks every step against the menus it names.
 */

import type { Permission } from '../permissions';

export const SETTINGS_AREAS = [
  'business',
  'branded_domain',
  'permissions',
  'pipelines',
  'tags',
  'fields',
  'relationships',
  'calendars',
  'services',
  'resources',
  'territories',
  'booking_site',
  'team',
  'texting',
  'email',
  'website_chat',
  'templates',
  'lead_intake',
  'payments',
  'products',
  'usage',
  'action_center',
  'ai_teammate',
  'knowledge',
  'my_account',
  'my_calendar',
  'imports',
  'migrations',
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
  /**
   * The screen the steps start on, when it isn't the area's own: connecting a calendar is asked about under
   * Calendars but happens on My calendar.
   */
  readonly on?: { readonly where: readonly string[]; readonly path: string };
}

export interface SettingsAreaInfo {
  readonly area: SettingsArea;
  /** What it is called on screen: "Texting & calls". */
  readonly label: string;
  /** One line: what is set up here. */
  readonly what: string;
  /**
   * How to get there from the side menu, a click at a time, as each menu and tab names it:
   * ['Settings', 'Calendars', 'Territories'].
   */
  readonly where: readonly string[];
  /** What is on that screen, top to bottom, each part as the screen heads it. */
  readonly onScreen: readonly string[];
  /** The screen, under /app/w/<workspaceId>. */
  readonly path: string;
  /** What someone needs to change it; null when it is their own account. */
  readonly permission: Permission | null;
  /** What the Assistant can change here, in plain words. Empty when it can only read. */
  readonly canChange: readonly string[];
  /** What the person has to do themselves. */
  readonly handovers: readonly SettingsHandover[];
}

type AreaEntry = Omit<SettingsAreaInfo, 'area'>;

/** The calendar editor's own sections, down its left side, in its order (apps/web/src/lib/calendar/describe.ts). */
const CALENDAR_SECTIONS =
  'Team & assignment, Services & lengths, Availability, Capacity, Locations, Resources, Buffers & travel, Territories, Booking window, Repeats, Waitlist, Intake questions, Cancel & reschedule rules, Notifications, Calendar connections, CRM, Payments, Automations';

/** The AI teammate's own sections, in its order (apps/web/src/lib/ai-team/describe.ts). */
const TEAMMATE_SECTIONS =
  'Identity, Channels, Respond, Answer, Qualify, Book, Follow up, Hours, Autonomy, Limits, Hand-off';

/** Asked about under Calendars as often as under My calendar, so both carry it; it happens on My calendar. */
const CONNECT_CALENDAR: SettingsHandover = {
  what: 'connect a Google or Outlook calendar',
  why: 'you sign in to Google or Microsoft yourself, so nobody else can do it for you',
  on: { where: ['Settings', 'My calendar'], path: '/settings/my-calendar' },
  steps: [
    'Open Settings → My calendar.',
    'In Calendar connection, press Google or Outlook.',
    'Sign in and allow HandsFreeOS to see when you are busy.',
  ],
};

const AREAS: Record<SettingsArea, AreaEntry> = {
  business: {
    label: 'Workspace',
    what: 'the business name, time zone, industry, website, review link and business hours',
    where: ['Settings', 'Workspace'],
    onScreen: [
      'Workspace: Business name, Time zone, Industry, Website, Review link (Google Business Profile), and Business hours (the AI teammate’s after-hours follows them)',
      'Your own web address',
      'Delete this business (owners only)',
    ],
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
    where: ['Settings', 'Workspace'],
    onScreen: [
      'Your own web address, below the Workspace card: The domain you want to use, Use this domain, then the DNS records and Check now',
    ],
    path: '/settings/workspace',
    permission: 'channels.manage',
    canChange: [],
    handovers: [
      {
        what: 'use your own domain for your forms, payment links, estimates, invoices and booking page',
        why: 'the records go in with whoever you bought the domain from, which only you can sign in to',
        steps: [
          'Open Settings → Workspace, and in Your own web address type the address you want, like go.yourbusiness.com, then press Use this domain.',
          'Give it a moment — it works out what your DNS needs and shows the records on that same card.',
          'Put the records it shows you — usually one, sometimes two — in with whoever you bought the domain from (GoDaddy, Namecheap, wherever it is).',
          'DNS often takes a few hours. The card says when it is working, and it keeps checking on its own.',
        ],
      },
    ],
  },
  permissions: {
    label: 'Permissions',
    what: 'what admins and members may do, and the people who have settings of their own',
    where: ['Settings', 'Permissions'],
    onScreen: [
      'Who can do what',
      'A card for each of Customers, Inbox and calls, Calendar, Money, Automations and AI, and Business and team, with an Admins and a Members column',
      'Back to the defaults: Reset admins, Reset members',
      'People with their own settings (one person’s own are changed in Members: ⋯ beside them, then Permissions)',
    ],
    path: '/settings/permissions',
    permission: 'permissions.manage',
    canChange: [],
    handovers: [
      {
        what: 'change what admins or members may do',
        why: 'who may do what is the owner’s call, and it is set on the screen, not from here',
        steps: [
          'Open Settings → Permissions (only an owner sees it).',
          'Tick or untick what Admins and Members may do in each card.',
          'For one person only, open Members, press ⋯ beside them and choose Permissions.',
        ],
      },
    ],
  },
  pipelines: {
    label: 'Pipelines',
    what: 'the pipelines leads move through, and their stages',
    where: ['Settings', 'Pipelines'],
    onScreen: [
      'Pipelines and stages: a card for each pipeline, with Rename, Add stage and Archive',
      'New pipeline, at the bottom',
    ],
    path: '/settings/pipelines',
    permission: 'pipelines.manage',
    canChange: ['add, rename or archive a pipeline', 'add, rename, reorder or delete a stage'],
    handovers: [],
  },
  tags: {
    label: 'Tags',
    what: 'the labels you put on customers and leads, and the AI putting them on',
    where: ['Settings', 'Tags'],
    onScreen: [
      'Tags: every tag (a tag is put on from a customer’s own page)',
      'Let the AI tag your customers: what to look for, which tags, which customers, then Go through my customers',
      'What the AI changed lately',
    ],
    path: '/settings/tags',
    permission: 'tags.manage',
    canChange: [
      'add, rename, recolour or delete a tag',
      'have the AI go through every customer and put tags on, or stop it',
    ],
    handovers: [],
  },
  fields: {
    label: 'Fields',
    what: 'the business’s own fields on customers, companies and its own kinds of records',
    where: ['Settings', 'Fields'],
    onScreen: [
      'Fields for: Customers, Companies, or one of your own kinds of records',
      'Fields: the list, and Add field (Name, What it holds, Choices, Help)',
    ],
    path: '/settings/fields',
    permission: 'fields.manage',
    canChange: [],
    handovers: [
      {
        what: 'add or change a field',
        why: 'fields are set up on the screen; I can’t make them from here yet',
        steps: [
          'Open Settings → Fields.',
          'Pick what it is for under Fields for, and press Add field.',
          'Name it, say what it holds, and save.',
        ],
      },
    ],
  },
  relationships: {
    label: 'Relationships',
    what: 'the business’s own kinds of records (pets, vehicles, properties) and how they relate to customers',
    where: ['Settings', 'Relationships'],
    onScreen: ['Kinds of records: New kind of record', 'Relationship types: New relationship type'],
    path: '/settings/relationships',
    permission: 'fields.manage',
    canChange: [],
    handovers: [
      {
        what: 'add a kind of record, or a way records relate',
        why: 'these are set up on the screen; I can’t make them from here yet',
        steps: [
          'Open Settings → Relationships.',
          'Press New kind of record, or New relationship type.',
          'Name it and save; its fields are then under Settings → Fields.',
        ],
      },
    ],
  },
  calendars: {
    label: 'Calendars',
    what: 'the calendars people book on: who works them, what they offer, hours and booking rules',
    where: ['Settings', 'Calendars'],
    onScreen: [
      'A row of buttons at the top: Calendars, Services, Resources, Territories, Booking site',
      'Calendars: every calendar, and New calendar',
      `Pressing a calendar opens its own settings, down the left under Settings on this calendar: ${CALENDAR_SECTIONS}`,
      'Beside them: Booking link, with Customers can book it online, and Things to check',
    ],
    path: '/settings/calendars',
    permission: 'calendars.manage',
    canChange: [
      'create a calendar',
      'rename it, or change its colour, time zone or booking link',
      'who works it, and what it offers',
      'its hours, buffers and booking rules',
      'turn it on or off',
    ],
    handovers: [CONNECT_CALENDAR],
  },
  services: {
    label: 'Services',
    what: 'what you book: how long each job takes, what it costs, who can do it',
    where: ['Settings', 'Calendars', 'Services'],
    onScreen: [
      'Services: the list, and New service',
      'Each service: Name, Price shown, Lengths customers can pick, Setup before, Cleanup after, Who can do it, Needs, and Only at certain hours',
    ],
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
    where: ['Settings', 'Calendars', 'Resources'],
    onScreen: [
      'Resources: the list, and New (Name, Kind, How many, Where it is, Only at certain hours)',
    ],
    path: '/settings/calendars/resources',
    permission: 'calendars.manage',
    canChange: ['add, change or archive a resource', 'how many there are, and its hours'],
    handovers: [],
  },
  territories: {
    label: 'Territories',
    what: 'the service area: where the business goes (ZIP codes, a distance, or an area drawn on a map) and who covers each part',
    where: ['Settings', 'Calendars', 'Territories'],
    onScreen: [
      'Territories: the list, and New (Name, Where it covers, Who covers it)',
      'A calendar only sends bookings by them once Route by ZIP code is on in that calendar’s own Territories section (open the calendar from Settings → Calendars)',
      'The AI teammate checks them when Service area is on in its Book section',
    ],
    path: '/settings/calendars/territories',
    permission: 'calendars.manage',
    canChange: ['add, change or delete a territory', 'its ZIP codes and who covers them'],
    handovers: [],
  },
  booking_site: {
    label: 'Booking site',
    what: 'the page customers book on: its address, name and intro',
    where: ['Settings', 'Calendars', 'Booking site'],
    onScreen: ['Booking site: Business name shown, Link name, Intro, and Taking bookings online'],
    path: '/settings/calendars/booking-site',
    permission: 'calendars.manage',
    canChange: ['the address, name and intro', 'turn the booking site on or off'],
    handovers: [],
  },
  team: {
    label: 'Members',
    what: 'who works here and what each of them may do',
    where: ['Members'],
    onScreen: [
      'Invite teammate, at the top',
      'Everyone in the business; ⋯ beside a person has Edit hours, Permissions, and Remove from workspace',
      'Also has access via the agency, and Pending invitations',
    ],
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
  texting: {
    label: 'Texting & calls',
    what: 'your business number, who it rings, voicemail, quiet hours and carrier registration',
    where: ['Settings', 'Texting & calls'],
    onScreen: [
      'Before there is a number: Get a business number (or I already have a number I want to keep, to bring one over), then the carrier registration',
      'Your numbers: Add a number',
      'Who sees which conversations',
      'Business number: Text me a test, and Release this number under ⋯',
      'Carrier registration: where it stands, and View what we sent',
      'RCS messaging',
      'Texting rules: Quiet hours, and Remind the team when a customer waits',
      'When a customer calls: which browsers and phones ring, and Ring for',
      'What forwarded phones show',
      'Voicemail: on or off, and the greeting',
    ],
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
          'Wait for the carriers: Carrier registration on Settings → Texting & calls shows where it stands.',
          'Texting turns on by itself once they approve it.',
        ],
      },
    ],
  },
  email: {
    label: 'Email',
    what: 'the addresses you send from, your own sending domain, connected mailboxes and blocked addresses',
    where: ['Settings', 'Email'],
    onScreen: [
      'Sending address: the name customers see, and which address is the default',
      'Use your own domain: Add domain, Check now',
      'Connected mailboxes: Connect Gmail, Connect Outlook',
      'Blocked addresses',
      'Mail from people not in Customers',
    ],
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
          'In Connected mailboxes, press Connect Gmail or Connect Outlook.',
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
  website_chat: {
    label: 'Website chat',
    what: 'the chat box on your website: who answers it, how it looks, what it asks for',
    where: ['Settings', 'Website chat'],
    onScreen: [
      'Before it is on: Your sites, and Turn on website chat',
      'Website chat: on or paused, Who answers, Daily limit',
      'Your sites',
      'Add it to your site: the snippet',
      'Try it',
      'Look: Greeting, Button label, Colour',
      'When nobody is answering: Away message, and What to ask visitors for',
    ],
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
          'Your sites on Settings → Website chat goes green once it sees it.',
        ],
      },
    ],
  },
  templates: {
    label: 'Templates',
    what: 'saved texts and emails the team sends from the inbox, in folders',
    where: ['Settings', 'Templates'],
    onScreen: ['Templates: by folder, with New template (Name, Send as, Subject, Message, Folder)'],
    path: '/settings/templates',
    permission: 'templates.manage',
    canChange: [],
    handovers: [
      {
        what: 'add or change a template',
        why: 'templates are written on the screen; I can’t save them from here yet',
        steps: [
          'Open Settings → Templates and press New template.',
          'Pick Text or Email, write it, and put it in a folder if you like.',
        ],
      },
    ],
  },
  lead_intake: {
    label: 'Lead intake',
    what: 'what happens when a stranger texts, calls or emails: whether they become a customer and a lead, and where that lead lands',
    where: ['Settings', 'Lead intake'],
    onScreen: [
      'A switch for each way in: Someone texts your number, Someone calls and doesn’t get through, Someone emails your business address — each with where its leads land and how many a day',
      'Forms and connected apps: Website form, Connect an app',
    ],
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
          'Open Settings → Lead intake and, in Forms and connected apps, press Website form or Connect an app.',
          'A form gives you a snippet to paste into your page; an app gives you a key, shown once.',
          'Tell me where you want those leads to land and I’ll set the pipeline up for you.',
        ],
      },
    ],
  },
  payments: {
    label: 'Payments',
    what: 'how you get paid: accounts, tax, terms, deposits, reminders and numbering',
    where: ['Settings', 'Payments'],
    onScreen: [
      'Accounts you get paid into: Connect Stripe, Connect Square',
      'Ways to pay',
      'Sales tax',
      'Numbering',
      'Your address',
      'Terms and notes',
      'Deposits',
      'Invoice reminders, and the nudge for an estimate nobody answered',
    ],
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
          'In Accounts you get paid into, press Connect Stripe or Connect Square.',
          'Sign in there and finish their questions; you land back here when it is done.',
        ],
      },
    ],
  },
  products: {
    label: 'Products',
    what: 'what goes on an estimate or invoice: your items, their prices and tax',
    where: ['Settings', 'Products'],
    onScreen: [
      'Products and services: New product (Name, Code, Price, Per, Charge sales tax on it, Customers can book it)',
      'Maintenance plans: Open Plans goes to Money → Plans',
    ],
    path: '/settings/payments/products',
    permission: 'money.manage',
    canChange: [
      'add, change or archive an item',
      'its price, unit, tax and the service it matches',
    ],
    handovers: [],
  },
  usage: {
    label: 'Usage & balance',
    what: 'what the business pays HandsFreeOS: the balance texts, calls, phone numbers and AI replies come out of, top-ups, the card and the statement',
    where: ['Settings', 'Usage & balance'],
    onScreen: [
      'Your balance: Top up now',
      'Automatic top-up',
      'Card on file',
      'What things cost',
      'Statement',
    ],
    path: '/settings/usage',
    permission: 'money.manage',
    canChange: [],
    handovers: [
      {
        what: 'top up the balance, or change the card',
        why: 'it is a card payment, which you make yourself',
        steps: [
          'Open Settings → Usage & balance.',
          'Press Top up now, or turn on Automatic top-up.',
          'Card on file is where the card is added or changed.',
        ],
      },
    ],
  },
  // The key stays action_center: Settings → Action Center became Settings → Automations, and its settings with it.
  action_center: {
    label: 'Automations',
    what: 'every automation: what Home watches for, the reminders and follow-ups, and what HandsFreeOS handles on its own',
    where: ['Settings', 'Automations'],
    onScreen: [
      'Reaching customers: Leads and sales, Appointments, After the job',
      'Keeping the business on track: Daily briefings, Pipeline and records, Service and handoffs, Marketing and content, Ads and money, Health and quality',
      'Each automation has a switch, and Adjust for its own settings',
    ],
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
    where: ['AI teammate'],
    onScreen: [
      'Tabs: Teammate, Activity, Approvals',
      `Teammate: its settings, in order: ${TEAMMATE_SECTIONS}`,
      'Beside them: Status (Off, Training wheels, Automatic)',
      'At the top: Test console, History, and More (Website chat settings, Knowledge, turn it off or on)',
    ],
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
    label: 'Knowledge',
    what: 'what your AI knows about the business: what you offer, service area, hours, policies and how to sound',
    where: ['Knowledge'],
    onScreen: [
      'Tabs: Overview, Items, Documents, Website, Offers, Suggestions',
      'Overview: Business profile (Edit opens its sections: What you do, Services, Where and when, Policies, Tone of voice, Prices), Tone of voice, Suggestions, Try it',
      'Scan website and Add an FAQ, at the top',
    ],
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
        on: { where: ['Knowledge', 'Documents'], path: '/knowledge/documents' },
        steps: [
          'Open Knowledge → Documents.',
          'Press Choose a file and pick a PDF, text or CSV file.',
        ],
      },
    ],
  },
  my_account: {
    label: 'Account',
    what: 'your own name, how the app looks, your side menu, your sign-in, and what you are told about',
    where: ['Settings', 'Account'],
    onScreen: [
      'Profile: your name',
      'Appearance: Light, Dark or System',
      'Side menu: Edit menu, to reorder, group or hide places in the side menu',
      'Sign-in methods: Password, Google, Passkeys',
      'Notifications: which push and email alerts you get',
      'My cell phone',
      'Delete my account',
    ],
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
          'Open Settings → Account and find My cell phone.',
          'Put your number in and press Verify my cell.',
          'Answer the call and press 1.',
        ],
      },
      {
        what: 'delete your account',
        why: 'it cannot be undone, so it is typed in by hand',
        steps: ['Open Settings → Account.', 'Under Delete my account, type your email to confirm.'],
      },
    ],
  },
  my_calendar: {
    label: 'My calendar',
    what: 'your own working hours, time off, and the Google or Outlook calendar HandsFreeOS checks',
    where: ['Settings', 'My calendar'],
    onScreen: ['Weekly hours', 'Time off: Add time off', 'Calendar connection: Google, Outlook'],
    path: '/settings/my-calendar',
    permission: null,
    canChange: ['your working hours', 'time off, and extra hours you are available'],
    handovers: [CONNECT_CALENDAR],
  },
  imports: {
    label: 'Imports',
    what: 'bringing customers in from a spreadsheet',
    where: ['Settings', 'Imports'],
    onScreen: [
      'Import a spreadsheet, at the top (Customers has the same Import button)',
      'Every import so far, with how it went',
    ],
    path: '/settings/imports',
    permission: 'records.import',
    canChange: [],
    handovers: [
      {
        what: 'import a spreadsheet of customers',
        why: 'the file is on your computer, so you pick it and check the columns line up',
        steps: [
          'Open Settings → Imports and press Import a spreadsheet.',
          'Choose People or Companies and pick your CSV file.',
          'Check the columns match and look over the preview, then run it.',
        ],
      },
    ],
  },
  migrations: {
    label: 'Migrations',
    what: 'moving a whole business over from another system, like GoHighLevel',
    where: ['Settings', 'Migrations'],
    onScreen: [
      'Connect a CRM, at the top',
      'Connected: each system signed in to, with Start a migration',
    ],
    path: '/settings/migrations',
    permission: 'migrations.manage',
    canChange: [],
    handovers: [
      {
        what: 'move a business over from another system',
        why: 'you sign in to the old system yourself so HandsFreeOS may read it',
        steps: [
          'Open Settings → Migrations and press Connect a CRM.',
          'Pick the system you are coming from and sign in there.',
          'Press Start a migration and choose what to bring over; it runs from there.',
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

/** The way there as a person reads it: "Settings → Calendars → Territories". */
export const settingsWhere = (area: SettingsArea): string => AREAS[area].where.join(' → ');

/** Where a handover's steps start: its own screen when it has one, else the area's. */
export const handoverScreen = (
  workspaceId: string,
  info: SettingsAreaInfo,
  handover: SettingsHandover,
): { readonly where: string; readonly href: string } => ({
  where: (handover.on?.where ?? info.where).join(' → '),
  href: `/app/w/${workspaceId}${handover.on?.path ?? info.path}`,
});

/**
 * The places the everyday work happens, which are not settings: what each is for, the way there, and what is on
 * it. Knowledge, the AI teammate and Members are in the settings list above, because the Assistant sets them up.
 */
export interface AppPlace {
  /** What the side menu calls it. */
  readonly label: string;
  readonly what: string;
  readonly where: readonly string[];
  readonly onScreen: readonly string[];
  /** The screen, under /app/w/<workspaceId>. */
  readonly path: string;
}

export const APP_PLACES: readonly AppPlace[] = [
  {
    label: 'Home',
    what: 'the Action Center: one list of what needs attention, most urgent first',
    where: ['Home'],
    onScreen: [
      'Mine or Everyone',
      'Urgent, Up next, and Handled by HandsFreeOS; each item has Let HandsFreeOS Handle, Snooze, Assign and Dismiss',
      'Today, and what is coming up',
      'A new business sees Finish setting up instead',
    ],
    path: '',
  },
  {
    label: 'Inbox',
    what: 'every conversation with customers: texts, calls, email and website chat',
    where: ['Inbox'],
    onScreen: [
      'New message, at the top',
      'Mine, Unassigned, All; and Open, Snoozed, Closed or Archived',
      'A conversation has Assign, Snooze, Close, and More (Call, Open customer, Hand to the AI teammate, Mark as unread, Archive)',
    ],
    path: '/inbox',
  },
  {
    label: 'Customers',
    what: 'people, companies and the business’s own kinds of records',
    where: ['Customers'],
    onScreen: [
      'Tabs: People, Companies, and any kinds of records of your own',
      'Import and Add person, at the top',
      'A customer’s page: Call, Text, Email, Book, Note, Log call, Task, Lead, File, Add to workflow; tabs Timeline, Appointments, Money, Leads, Tasks, Files, Details; ⋯ has Edit details and Archive',
    ],
    path: '/customers',
  },
  {
    label: 'Pipeline',
    what: 'the leads, as a board or a list, in their stages',
    where: ['Pipeline'],
    onScreen: [
      'A pipeline picker when there is more than one, Board or List, and New lead',
      'A lead’s page: Stage, Note, Log call, Book, File, Add to workflow, Won and Lost',
    ],
    path: '/pipeline',
  },
  {
    label: 'Calendar',
    what: 'the appointments',
    where: ['Calendar'],
    onScreen: [
      'Day, Week, Month, Team and Resources',
      'New appointment, and Manage calendars (which opens Settings → Calendars)',
    ],
    path: '/calendar',
  },
  {
    label: 'Money',
    what: 'invoices, estimates, payments and maintenance plans',
    where: ['Money'],
    onScreen: [
      'Tabs: Invoices, Estimates, Payments, Plans',
      'New estimate and New invoice, at the top; Plans has Put someone on a plan',
      'A sent invoice has Record a payment, Copy link and Void; a sent estimate has Turn into an invoice and They said yes',
    ],
    path: '/money',
  },
  {
    label: 'Workflows',
    what: 'automatic follow-ups, built as steps, on a canvas, or described in a sentence',
    where: ['Workflows'],
    onScreen: [
      'Tabs: Workflows, Runs, Approvals',
      'New workflow, at the top: a recipe, Describe it, or Start blank',
      'A workflow: Steps, Canvas or Describe; Test this draft, then Publish; Pause or Resume',
    ],
    path: '/workflows',
  },
  {
    label: 'Campaigns',
    what: 'one-off outreach by text, email or calls',
    where: ['Campaigns'],
    onScreen: ['New campaign: Texts, Email or Calls, who gets it, then Approve all and send'],
    path: '/campaigns',
  },
  {
    label: 'Forms',
    what: 'forms, surveys and quizzes customers fill in',
    where: ['Forms'],
    onScreen: ['New form', 'A form: Questions, Preview, Results, Share; Publish'],
    path: '/forms',
  },
  {
    label: 'Reviews',
    what: 'Google and Facebook reviews, and answering them',
    where: ['Reviews'],
    onScreen: ['Google and Facebook: Connect', 'Each review: Answer'],
    path: '/reviews',
  },
  {
    label: 'Tasks',
    what: 'to-dos for the team',
    where: ['Tasks'],
    onScreen: ['Mine or Everyone, and New task', 'Overdue, Today, This week, Later, No due date'],
    path: '/tasks',
  },
  {
    label: 'Audit log',
    what: 'who changed what, and when',
    where: ['Audit log'],
    onScreen: ['Today, 7 days or 30 days; a person; a kind of activity'],
    path: '/audit',
  },
  {
    label: 'Ideas',
    what: 'ideas for HandsFreeOS itself, the roadmap and what’s new',
    where: ['Ideas'],
    onScreen: ['Tabs: Ideas, Roadmap, What’s new', 'Share an idea, at the top'],
    path: '/ideas',
  },
];

/**
 * The same word in more than one place. These are the ones people get sent to the wrong screen for, so the prompt
 * says each of them outright.
 */
export const LOOK_ALIKES: readonly string[] = [
  'Service area: the territories that route bookings and that the AI teammate checks are Settings → Calendars → Territories; each calendar only uses them once Route by ZIP code is on in its own Territories section; the words the AI says about the area are Knowledge → Overview, in Business profile under Where and when (Service area).',
  'Hours: the business’s open hours are Settings → Workspace (Business hours); a person’s own are Settings → My calendar (Weekly hours); a calendar’s are its Availability section; the AI teammate’s are its Hours section.',
  'Notifications: what a person is told about is Settings → Account (Notifications); what customers get about a booking is the calendar’s Notifications section; reminders and follow-ups HandsFreeOS sends by itself are Settings → Automations.',
  'Quiet hours: only Settings → Texting & calls, in Texting rules.',
  'Deposits: the default for estimates is Settings → Payments (Deposits); a deposit taken at booking is the calendar’s Payments section.',
  'Payments: getting paid by customers is Settings → Payments; paying HandsFreeOS for texts and calls is Settings → Usage & balance; the money itself is Money.',
  'Team, teammates, staff: the side menu calls it Members.',
  'Connecting Google or Outlook: a calendar is Settings → My calendar; a mailbox is Settings → Email; signing in with Google is Settings → Account.',
];

const trail = (where: readonly string[]) => where.join(' → ');

/**
 * The areas as the fixed part of the prompt says them: the way there and what is on it, so the model names the
 * right screen without anything being looked up per question.
 */
export function settingsMapText(): string {
  return settingsAreas()
    .map((a) => {
      const handovers = a.handovers.map((h) => h.what);
      const theirs = handovers.length ? ` They do themselves: ${handovers.join('; ')}.` : '';
      return `- ${a.label} (${a.area}) is at ${trail(a.where)}: ${a.what}. On it: ${a.onScreen.join('; ')}.${theirs}`;
    })
    .join('\n');
}

/** The everyday places and the look-alikes, for the same fixed part of the prompt. */
export function placesText(): string {
  return [
    ...APP_PLACES.map(
      (p) => `- ${p.label} is at ${trail(p.where)}: ${p.what}. On it: ${p.onScreen.join('; ')}.`,
    ),
    'The same word in more than one place:',
    ...LOOK_ALIKES.map((l) => `- ${l}`),
  ].join('\n');
}
