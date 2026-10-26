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
  'main_offer',
  'add_ons',
  'permissions',
  'pipelines',
  'tags',
  'fields',
  'relationships',
  'deleted_bin',
  'calendars',
  'services',
  'resources',
  'territories',
  'booking_site',
  'team',
  'texting',
  'email',
  'website_chat',
  'facebook_instagram',
  'templates',
  'lead_intake',
  'payments',
  'products',
  'partners',
  'usage',
  'action_center',
  'ai_teammate',
  'knowledge',
  'my_account',
  'my_calendar',
  'safety',
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
  /** "How do I…" on this screen, each answered as the clicks, for doing it themselves. */
  readonly howTo?: readonly string[];
  /** What people look for here that HandsFreeOS doesn't do, so the Assistant says so rather than invent a button. */
  readonly notHere?: readonly string[];
}

type AreaEntry = Omit<SettingsAreaInfo, 'area'>;

/** The calendar editor's own sections, down its left side, in its order (apps/web/src/lib/calendar/describe.ts). */
const CALENDAR_SECTIONS =
  'Team & assignment, Services & lengths, Availability, Capacity, Locations, Resources, Buffers & travel, Territories, Booking window, Repeats, Waitlist, Intake questions, Cancel & reschedule rules, Notifications, Calendar connections, CRM, Payments, Automations';

/** The AI teammate's own sections, in its order (apps/web/src/lib/ai-team/describe.ts), and what each holds. */
const TEAMMATE_SECTIONS =
  'Identity (name, email signature, how it says it’s AI, tone), Channels (Texts, Email, Website chat, Phone calls), Respond (message new leads first, and how soon), Answer (from Knowledge, and photos customers send), Qualify (its questions, and what happens when a lead qualifies), Book (which calendars, rescheduling, cancelling, the waitlist, repeat visits, and checking the service area), Follow up, Hours (Always, After hours only, Custom), Autonomy (how many approvals before it works on its own), Limits (replies a day, discounts, bills, quotes, plans), Hand-off (when it hands over, who is told and how)';

/** Each calendar's own sections are reached the same way. */
const ON_A_CALENDAR = 'Settings → Calendars, press the calendar, then';

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
    canChange: ['add your own web address, check it, or stop using it'],
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
  // Shown only while an add-on that uses it is on (Social Outreach), as the Settings menu shows it.
  main_offer: {
    label: 'Main offer',
    what: 'the business’s one main offer: who it helps, the result, how fast, how, the guarantee and the price, built a part at a time and scored with the AI, then put live as a version. It is only there while an add-on that uses it is on (Social Outreach)',
    where: ['Settings', 'Main offer'],
    onScreen: [
      'The live version, and how each version is doing',
      'The draft: each part, its score and what it still needs before it can go live',
      'Versions',
    ],
    path: '/settings/main-offer',
    permission: 'main_offer.manage',
    canChange: [
      'change any part of it, its steps or its real results, in the draft',
      'score the draft, or have the AI write a try and take parts of it in',
      'put the draft live as the next version, with your OK, or throw it away',
      'the owner’s direction for the whole offer, and the names the business goes by',
    ],
    handovers: [],
    notHere: [
      'promotions such as $50 off this month: those are Knowledge → Promotions, not the main offer',
    ],
  },
  add_ons: {
    label: 'Add-ons',
    what: 'the add-ons this business has (extra features for particular kinds of work) and whether each one is on, the ones it could add, what’s coming soon, and the vote on what comes next',
    where: ['Add-ons'],
    onScreen: [
      'In this business: each add-on, whether it is on, and its Settings',
      'Available to add',
      'Coming soon: what the weekly vote picked, until it can be added',
      'Vote on what’s next: every planned add-on, with a search, categories, groups and an upvote on each',
    ],
    path: '/add-ons',
    permission: 'addons.manage',
    canChange: [
      'add an add-on, turn one on or off, or uninstall one, with what has to move with it',
    ],
    handovers: [
      {
        what: 'delete an add-on’s data',
        why: 'it can’t be undone, so only an owner does it, typing the add-on’s name',
        steps: [
          'Open Add-ons, at the bottom of the side menu.',
          'Uninstall the add-on first, if it is still installed.',
          'Press Delete its data, and type the add-on’s name to confirm.',
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
      'A card for each of Contacts, Inbox and calls, Calendar, Money, Automations and AI, and Business and team, with an Admins and a Members column',
      'Back to the defaults: Reset admins, Reset members',
      'People with their own settings (one person’s own are changed in Members: ⋯ beside them, then Permissions)',
    ],
    path: '/settings/permissions',
    permission: 'permissions.manage',
    canChange: [
      'turn one permission on or off for admins or members',
      'set what one person may do',
      'put a role or a person back to the defaults',
    ],
    handovers: [],
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
      'Fields for: Contacts, Companies, or one of your own kinds of records',
      'Fields: the list, and Add field (Name, What it holds, Choices, Help)',
    ],
    path: '/settings/fields',
    permission: 'fields.manage',
    canChange: [
      'add a field to customers, companies or a kind of record',
      'rename it, or change its choices, help line or whether it shows when empty',
      'retire a field',
    ],
    handovers: [],
  },
  relationships: {
    label: 'Relationships',
    what: 'the business’s own kinds of records (pets, vehicles, properties) and how they relate to customers',
    where: ['Settings', 'Relationships'],
    onScreen: ['Kinds of records: New kind of record', 'Relationship types: New relationship type'],
    path: '/settings/relationships',
    permission: 'fields.manage',
    canChange: [
      'add, change, archive or bring back a kind of record, with its first fields and its tie to customers',
      'set up, rename, archive or bring back a relationship type, and how many each end may have',
    ],
    handovers: [],
  },
  // Customers, conversations and bookings deleted for good, for their 30 days (20261027000400): owners only, unless
  // an owner gives Delete for good to someone.
  deleted_bin: {
    label: 'Deleted bin',
    what: 'customers, conversations and bookings deleted for good, kept 30 days so they can be brought back, then gone',
    where: ['Settings', 'Deleted bin'],
    onScreen: [
      'Deleted bin: each thing deleted, who deleted it and when it goes for good, with Bring back',
      'Empty the bin',
    ],
    path: '/settings/deleted-bin',
    permission: 'records.delete',
    canChange: ['bring something back from the bin'],
    handovers: [
      {
        what: 'empty the bin, or delete something in it now',
        why: 'the AI never deletes anything for good',
        steps: [
          'Open Settings → Deleted bin.',
          'Press Empty the bin to delete everything in it now, or Delete now beside one thing.',
        ],
      },
    ],
    notHere: ['bringing something back after its 30 days: it is gone for good by then'],
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
      'seats per time, the places it happens, and routing by ZIP code and which territories',
      'repeat visits, and the waitlist and how long offers last',
      'intake questions, and the cancel and reschedule rules',
      'the confirmation and reminders customers get, and the team’s new-booking email',
      'CRM: a lead for each booking, and the customer’s owner',
      'taking a deposit or the full price when they book, and which account it’s paid into',
      'put back an earlier saved version',
    ],
    handovers: [CONNECT_CALENDAR],
    howTo: [
      `Change who works a calendar, or how it picks: ${ON_A_CALENDAR} Team & assignment`,
      `Set how much notice and how far ahead people can book: ${ON_A_CALENDAR} Booking window`,
      `Turn on the waitlist: ${ON_A_CALENDAR} Waitlist`,
      `See who is waiting for a time, or take someone off: ${ON_A_CALENDAR} Waitlist, under Waiting for a time`,
      `Allow repeat visits: ${ON_A_CALENDAR} Repeats`,
      `Take a deposit when they book: ${ON_A_CALENDAR} Payments`,
      `Change the confirmation and reminders customers get: ${ON_A_CALENDAR} Notifications`,
      `Ask questions when they book: ${ON_A_CALENDAR} Intake questions`,
      `Let customers cancel or reschedule themselves: ${ON_A_CALENDAR} Cancel & reschedule rules`,
      `Send bookings by ZIP code: ${ON_A_CALENDAR} Territories, and turn on Route by ZIP code`,
      `Send a follow-up and review request after visits: ${ON_A_CALENDAR} Automations`,
      'Turn a calendar on, pause or archive it: press the calendar, then Turn on, or More for Pause and Archive',
      'Copy one calendar’s booking link: Settings → Calendars, the copy icon beside it',
    ],
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
      'Invite teammate, at the top (Email address, then Owner, Admin or Member, then Send invite)',
      'Everyone in the business, with a Role picker; ⋯ beside a person has Edit hours, Permissions (owners only), and Remove from workspace (Leave workspace on your own row)',
      'Also has access via the agency (Put me on this business), and Pending invitations with Resend and Revoke',
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
    howTo: [
      'Invite someone: Members, press Invite teammate',
      'Change someone’s role: Members, the Role picker on their row',
      'Let one person do more or less than their role: Members, ⋯ beside them, then Permissions (owners only)',
      'Resend or cancel an invitation: Members, Pending invitations, Resend or Revoke',
      'Remove someone: Members, ⋯ beside them, then Remove from workspace',
    ],
    notHere: ['changing a teammate’s name or email for them', 'an invite link to share'],
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
      'name a number, or make it the default',
      'choose who a number rings',
      'choose whether each person sees only their own conversations',
      'pause or turn on RCS, choose its number, check it, or disconnect it',
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
      {
        what: 'connect an RCS sender',
        why: 'the sender is made in your own Twilio account, which only you sign in to',
        steps: [
          'Make the RCS sender in your Twilio account.',
          'Open Settings → Texting & calls and, in RCS messaging, press Connect RCS sender.',
          'Paste the sender’s id. After that I can pause it, choose its number or check it for you.',
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
      // Connect Gmail is greyed out as Coming soon until Google's review (NEXT_PUBLIC_GMAIL_ENABLED).
      'Connected mailboxes: Connect Outlook, and Connect Gmail marked Coming soon',
      'Blocked addresses',
      'Mail from people not in Contacts',
    ],
    notHere: [
      'connecting a Gmail mailbox: coming soon, so connect Outlook or send from the workspace address',
    ],
    path: '/settings/email',
    permission: 'channels.manage',
    canChange: [
      'add or change a sending address',
      'add or remove your own sending domain, and check it',
      'unblock an address',
      'block an address',
      'file mail from someone not in Contacts under a customer, or dismiss it',
    ],
    handovers: [
      {
        what: 'connect an Outlook mailbox',
        why: 'you sign in to Microsoft yourself',
        steps: [
          'Open Settings → Email.',
          'In Connected mailboxes, press Connect Outlook.',
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
  // Messenger and Instagram direct messages, through the business's Facebook Page (20261025000200).
  facebook_instagram: {
    label: 'Facebook & Instagram',
    what: 'the Facebook Pages and Instagram accounts whose direct messages come to the inbox, whether their lead ads’ leads come in, and the Facebook sign-ins they came through',
    where: ['Settings', 'Facebook & Instagram'],
    onScreen: [
      'Facebook & Instagram: Connect Facebook (Connect more once one is in)',
      'Pages and accounts, and the ones not connected anymore',
      'Lead ads: each Page’s leads, its forms and the last lead, once a sign-in allows leads',
      'Facebook sign-in',
    ],
    path: '/settings/facebook-instagram',
    permission: 'channels.manage',
    canChange: [],
    handovers: [
      {
        what: 'connect a Facebook Page or an Instagram account',
        why: 'you sign in to Facebook yourself and choose the Pages, so nobody else can do it for you',
        steps: [
          'Open Settings → Facebook & Instagram and press Connect Facebook.',
          'Sign in with a Facebook account that manages the business’s Page, and leave every permission ticked.',
          'Pick which Pages and Instagram accounts answer in the inbox.',
        ],
      },
    ],
  },
  templates: {
    label: 'Templates',
    what: 'saved wording for texts and emails, in folders, that the inbox’s reply box can put in',
    where: ['Settings', 'Templates'],
    onScreen: ['Templates: by folder, with New template (Name, Send as, Subject, Message, Folder)'],
    howTo: [
      'Use one in a reply: open the conversation in Inbox, press Insert a template beside the paperclip, then pick it',
    ],
    path: '/settings/templates',
    permission: 'templates.manage',
    canChange: ['add, change, archive or bring back a template'],
    handovers: [],
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
      'pause, turn back on, change or retire a website form or connected app',
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
      'the letters in front of invoice and estimate numbers, and the next number (it only goes up)',
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
      'the maintenance plans you sell: add one, change its price, what it includes or its visits, stop selling it',
    ],
    handovers: [],
  },
  // Shown only while an add-on that uses partners is on, for whoever holds Manage partners.
  partners: {
    label: 'Partners',
    what: 'the people who send the business customers for a share of what each pays in their first 12 months: their share, the smallest payout, the calendar their links book, the terms they accept, and paying them',
    where: ['Settings', 'Partners'],
    onScreen: [
      'How partners are paid: Their share, Smallest payout, The calendar their links book',
      'Partner terms',
      'Your partners, each with what they have earned and their own page',
      'Paying your partners: the card, the next payout and each month’s statement',
    ],
    path: '/settings/partners',
    permission: 'partners.manage',
    canChange: [
      'how partners are paid: their share, the smallest payout, the calendar their links book, and the terms',
      'make a customer a partner, give one their own share, pause, end or bring one back, and mark which partner sent a customer',
    ],
    handovers: [],
  },
  usage: {
    label: 'Usage & balance',
    what: 'what the business pays HandsFreeOS: the balance texts, calls, phone numbers and AI replies come out of, top-ups, the daily AI limit, the card and the statement',
    where: ['Settings', 'Usage & balance'],
    onScreen: [
      'Your balance: Top up now',
      'Automatic top-up',
      'Daily AI limit: the most the AI may spend in a day, and what it has spent today',
      'Card on file',
      'What things cost',
      'Statement',
    ],
    path: '/settings/usage',
    permission: 'money.manage',
    canChange: ['automatic top-up: on or off, the balance it tops up below, and how much it adds'],
    handovers: [
      {
        what: 'top up the balance now, or change the card',
        why: 'it is a card payment, which you make yourself',
        steps: [
          'Open Settings → Usage & balance.',
          'Press Top up now.',
          'Card on file is where the card is added or changed.',
        ],
      },
      {
        what: 'raise or lower the daily AI limit',
        why: 'it decides how much the business’s AI may spend, which an owner or admin sets themselves',
        steps: [
          'Open Settings → Usage & balance.',
          'Under Daily AI limit, type the most the AI may spend in a day.',
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
      'turn any automation on or off, except Drafts awaiting review, Connection broke and Texting turned down, which are always on; Re-engage dead leads the first time with its message on the card to read',
      'which kinds of thing Home looks for',
      'how fast a lead counts as waiting, and what a big job is',
      'what HandsFreeOS does on its own, and how it words it',
      'when a dead lead counts as cold, how many a day are re-engaged, and the message they get',
      'which form Intake questions sends after a first booking',
      'when the end-of-day email goes out',
      'what the AI does when a voicemail box answers its call',
    ],
    handovers: [],
    howTo: [
      'Change one automation: Settings → Automations, its switch, or Adjust beside it',
      'Set what a typical job is worth: Settings → Automations, Adjust on Hot lead alert',
    ],
  },
  ai_teammate: {
    label: 'AI teammate',
    what: 'your AI teammate: its name, what it may do, which channels it answers on and its hours',
    where: ['AI teammate'],
    onScreen: [
      'Tabs: Teammate, Activity, Approvals',
      `Teammate: its settings, down the left, in order: ${TEAMMATE_SECTIONS}`,
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
      'the questions it asks new leads, where a qualified lead goes, and who is told',
      'its limits: replies a day, look-ups, its share of the AI limit, discounts, bills, quotes and plans',
      'when it hands a customer to a person, who is told, and what the customer hears',
      'whether it answers phone calls, when it picks up, its voice and greeting',
      'its email signature and tone',
      'how many approvals before it works on its own, and when drafts expire',
      'approve, change or reject what it wrote while it waits for an OK',
    ],
    handovers: [],
    howTo: [
      'Turn it off, or back on: AI teammate, Status, then Off (or More, then Turn off)',
      'Let it send without approvals: AI teammate, Status, Switch to automatic now; Back to training puts approvals back',
      'Stop it booking: AI teammate, the Book section, and turn its switch off',
      'Stop it texting new leads first: the Respond section, Message new leads first',
      'Have it answer only after hours: the Hours section, After hours only',
      'Add a question it asks new leads: the Qualify section, Add a question',
      'Have it check the service area: the Book section, the switch for checking your service area',
      'Change who hears about a hand-off: the Hand-off section, Who gets told',
      'Have it answer phone calls: the Channels section, Phone calls',
      'Try it as a customer: AI teammate, Test console',
      'Undo a change: Undo on the save card, or History, then Restore',
      'See what it did: AI teammate → Activity',
      'Approve what it wrote: AI teammate → Approvals, Review, then Approve and send',
    ],
    notHere: ['deleting it, or having more than one'],
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
      'change, publish, archive or bring back an FAQ, fact, article or document',
      'accept, edit or reject suggestions, and answer questions customers asked',
      'scan the website and set its address',
      'add, change or take off a promotion',
    ],
    howTo: [
      'Add an FAQ: Knowledge, press Add an FAQ, then Publish; the same box switches to Article or Fact',
      'Let the AI quote prices: Knowledge → Overview, the AI may quote prices switch',
      'Change how the AI sounds: Knowledge → Overview, Edit on Tone of voice, then Save profile',
      'Add a service and its price: Knowledge → Overview, Edit on Business profile, Add a service, then Save profile',
      'Learn from the website: Knowledge, press Scan website, then Accept what it found',
      'Import FAQs from a spreadsheet: Knowledge → Items, Import CSV',
      'Answer a question the AI couldn’t: Knowledge → Suggestions, type the answer on it, then Save as an FAQ',
      'Stop the AI using an item: open it, then Archive',
      'Test what the AI would say: Knowledge → Overview, Try it, then Ask',
      'Add a promotion: Knowledge → Promotions, Add a promotion',
    ],
    notHere: ['deleting an item or document (archive it instead)'],
    handovers: [
      {
        what: 'add a document to the knowledge base',
        why: 'the file is on your computer, so you pick it',
        on: { where: ['Knowledge', 'Documents'], path: '/knowledge/documents' },
        steps: [
          'Open Knowledge → Documents.',
          'Press Choose a file and pick a PDF or text file.',
          'It arrives as a draft: open it, check the text, and press Publish.',
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
    canChange: [
      'your name',
      'light or dark',
      'which emails you get, each kind of phone alert, and the agency daily email',
      'hide or show places in your side menu, use the suggested groups, or start the menu over',
    ],
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
    howTo: [
      'Block time off: Settings → My calendar, press Add time off',
      'Set someone else’s hours (owners and admins): Members, ⋯ beside them, then Edit hours',
    ],
  },
  safety: {
    label: 'Safety',
    what: 'check-ins for visits (showings, open houses, tours): how long after someone’s planned end they are asked if they are OK, how long after that their contacts are told, and the business’s safety person, who is told when someone has no contacts',
    where: ['Settings', 'Safety'],
    onScreen: [
      'Ask after: minutes past the planned end before the person is asked',
      'Tell their contacts after: minutes with no answer before their contacts are told',
      'Safety person: who is told when someone has no contacts of their own',
      'What each person sees',
    ],
    path: '/settings/safety',
    permission: 'workspace.update',
    canChange: [
      'how long before someone is asked if they are OK, how long before their contacts are told, and the safety person',
    ],
    handovers: [],
    howTo: [
      'Choose who is told if you don’t check out: in the phone app, open More, then Settings, then My safety',
      'Check in for a visit: in the phone app, open the appointment and press Check in',
    ],
    notHere: [
      'Seeing other people’s safety contacts or where they checked in: only each person sees their own',
      'HandsFreeOS calling 911: it never does; Help on the phone opens its own calling',
    ],
  },
  imports: {
    label: 'Imports',
    what: 'bringing customers in from a spreadsheet',
    where: ['Settings', 'Imports'],
    onScreen: [
      'Import a spreadsheet, at the top (Contacts has the same Import button)',
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
      const how = a.howTo?.length ? ` How to: ${a.howTo.join('; ')}.` : '';
      const not = a.notHere?.length ? ` Not in HandsFreeOS: ${a.notHere.join('; ')}.` : '';
      return `- ${a.label} (${a.area}) is at ${trail(a.where)}: ${a.what}. On it: ${a.onScreen.join('; ')}.${theirs}${how}${not}`;
    })
    .join('\n');
}
