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

import { CALENDAR_SECTIONS } from '../calendar/describe';
import { money } from '../money/format';
import { RCS_FIRST_YEAR_CENTS } from '../money/rcs-fees';
import { PERMISSION_GROUPS, type Permission } from '../permissions';

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
  'billing',
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

/** The calendar editor's own sections, down its left side, in its order. */
const CALENDAR_SECTION_NAMES = CALENDAR_SECTIONS.map((s) => s.name).join(', ');

/**
 * The AI teammate's own sections, down the left of its Teammate tab, in their three groups and order
 * (apps/web/src/lib/ai-team/describe.ts, MODULE_GROUPS), and what each holds.
 */
const TEAMMATE_SECTIONS =
  'Basics: Identity (name, email signature, how it says it’s AI, tone), Channels (Texts, Email, Website chat, Phone calls), Hours (Always, After hours only, Custom). What it does: Respond (message new leads first, and how soon), Answer (from Knowledge, and photos customers send), Qualify (its questions, in the order it asks them, and what happens when a lead qualifies), Book (which calendars and what each is for, rescheduling, cancelling, the waitlist, repeat visits, and checking the service area), Follow up (how many monthly ones; when each follow-up goes is set in Settings → Automations), Add-ons (only when an add-on running here offers it something). Rules and safety: Hand-off (when it hands over, who is told and how), Autonomy (how many approvals before it works on its own, and when drafts expire), Limits (replies a day, look-ups, its share of the AI limit, discounts, bills, quotes, plans). Under them: Run quick setup again';

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
    'If it already says Needs reconnecting, press Reconnect beside it and sign in again instead.',
    'For Google Meet transcripts, press Allow Meet transcripts under your Google calendar and allow it.',
  ],
};

/** Zoom links and transcripts come from the person's own Zoom account, which only they can sign in to. */
const CONNECT_ZOOM: SettingsHandover = {
  what: 'connect Zoom',
  why: 'you sign in to Zoom yourself, so nobody else can do it for you',
  on: { where: ['Settings', 'My calendar'], path: '/settings/my-calendar' },
  steps: [
    'Open Settings → My calendar.',
    'In Video meetings, press Connect Zoom.',
    'Sign in to Zoom and allow HandsFreeOS.',
  ],
};

const AREAS: Record<SettingsArea, AreaEntry> = {
  business: {
    label: 'Workspace',
    what: 'the business name, time zone, industry, website, review link and business hours',
    where: ['Settings', 'Workspace'],
    onScreen: [
      'Workspace: Business name, Time zone, Industry, Website, Review link (Google Business Profile), and Business hours (the AI teammate’s after-hours follows them)',
      'Logo and colour: the logo and the colour on the booking page, website chat, invoices and emails',
      'Your page: Show your page, and once it’s on, Your page is at, with Copy the link and Open it',
      'Getting started guide: Show Getting started, for everyone in the business',
      'Your own web address',
      'Delete this business (owners only)',
    ],
    path: '/settings/workspace',
    permission: 'workspace.update',
    canChange: [
      'the name, time zone and industry',
      'the website and review link, or take either off',
      'open hours',
      'the business’s street address, which the setup’s Your business asks (it isn’t on this screen): estimates and invoices show it unless Settings → Payments gives another',
      'the colour, taking the logo off, or looking for the logo on the website again; adding one from their own computer or phone is theirs, under Logo and colour',
      'turn your page on or off',
      'turn Getting started on or off for everyone in the business',
    ],
    handovers: [
      {
        what: 'upload a logo',
        why: 'it is a picture from your own computer or phone, which only you can pick',
        steps: [
          'Open Settings → Workspace.',
          'In Logo and colour, press Upload a logo (Change, once there is one) and pick the picture.',
        ],
      },
    ],
    howTo: [
      'Copy your page’s link: Settings → Workspace, then Copy the link under Your page is at (Show your page has to be on)',
    ],
  },
  branded_domain: {
    label: 'Your own web address',
    what: 'the domain the customer-facing links are served on — forms, payment links, estimates, invoices, website chat, and the booking page and calendar links — instead of app.handsfreeos.com',
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
      'Change your offer (before there is one: Build your main offer, with Start building)',
      'A draft someone is working on: who is changing it and when, with Open the draft and Throw it away',
      'Names you go by',
      'Live version: each part with its score, how it scored, the weakest part, who uses it, and your direction (Edit your direction)',
      'Versions: each version with its lowest score, when and who, and why one went live anyway',
      'The builder (Change your offer, Open the draft or Start building): a step at a time from Your niche (Find my niche, Suggest niches for me) through Who, Outcome, Timeframe, Method, Guarantee, Price, Proof and Put it together, each box with Improve or Write it for me, then Review and go live: Score my offer, How each part scored, Go live, Use it anyway…, the tries (Make Try N) and Finish later',
    ],
    path: '/settings/main-offer',
    permission: 'main_offer.manage',
    canChange: [
      'change any part of it, its steps or its real results, in the draft',
      'score the draft, or have the AI write a try and take parts of it in',
      'ask the AI for niches, or for better words for a box, as Find my niche, Improve and Write it for me do',
      'put the draft live as the next version, with your OK, or throw it away',
      'the owner’s direction for the whole offer, and the names the business goes by',
    ],
    howTo: [
      'Change one part: Settings → Main offer, Change your offer (or Open the draft), go to its step, then Review and go live, Score my offer, then Go live',
      'Have the AI write a try: Settings → Main offer, Change your offer, Review and go live, then Make Try N; tap the parts to keep, then Apply N parts to my draft',
      'Put it live under the bar: Review and go live, Use it anyway…, give the reason, then Go live anyway',
      'Find who to sell to: the builder’s first step, Your niche, then Find my niche (or Suggest niches for me, with no customers yet)',
      'Change your direction for the whole offer: Settings → Main offer, Live version, Edit your direction',
      'A promotion like $50 off this month: Knowledge → Promotions, Add a promotion (not the main offer)',
    ],
    handovers: [],
  },
  add_ons: {
    label: 'Add-ons',
    what: 'the add-ons this business has (extra features for particular kinds of work) and whether each one is on, the ones it could add, what’s coming soon, and the vote on what comes next',
    where: ['Add-ons'],
    onScreen: [
      'In this business: each add-on, whether it is on and what that means, Open, its Settings, and Turn on, Turn off, Uninstall, Install or Delete its data as where it stands allows; a note when it’s being tested here, isn’t quite finished, or can’t come back',
      'Each add-on: What it lets you do, What it needs and Works with, each with why',
      'Available to add: Install, or in its place a note (a paid one HandsFreeOS support turns on, or what it needs that can’t be added here)',
      'Coming soon: what the weekly vote picked, until it can be added, and whether this business voted for it',
      'Vote on what’s next: every planned add-on, with a search, categories, groups, Sort (Most votes, A to Z) and an Upvote on each; the business has one vote on each, and every Sunday at midnight Eastern the one with the most votes becomes Coming soon',
    ],
    path: '/add-ons',
    permission: 'addons.manage',
    canChange: [
      'add an add-on, turn one on or off, or uninstall one, with what has to move with it',
      'change an add-on’s own settings, the ones on its settings page (Real Estate Agent’s Deal settings, Social Outreach’s settings), for whoever that add-on lets change them',
      'vote for a planned add-on as the business, or take its vote back',
      'disconnect an account the business connected for an add-on',
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
      {
        what: 'start an add-on fresh',
        why: 'it deletes all of the add-on’s data, which can’t be undone, so only an owner does it, typing the add-on’s name',
        steps: [
          'Open the add-on’s own settings, where it offers Start fresh, and type its name to confirm.',
          'An add-on that doesn’t offer it: on Add-ons, at the bottom of the side menu, Uninstall it, press Delete its data, then Install it again.',
        ],
      },
      {
        what: 'connect an add-on to another service with a sign-in or a key',
        why: 'signing in to the other service, and its key, are the person’s own, so a key never goes in this chat',
        steps: [
          'Open the add-on’s Connections: a Connections tab among its own settings when it has one, or the link I can give you.',
          'Press Sign in with … and sign in at the other service; or press Connect… (Use your own account… to use yours in place of HandsFreeOS’s), paste the key, then Try it and save.',
          'To go back to HandsFreeOS’s own account, press Switch back to HandsFreeOS’s account, or ask me to: it wipes your own key.',
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
      // From the page's own groups, so a card added there is named here too.
      `A card for each of ${PERMISSION_GROUPS.map((g) => g.title).join(', ')}, with an Admins and a Members column; each permission’s own words are in get_settings (area permissions)`,
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
    howTo: [
      'Let someone send documents to sign, or make document templates: Settings → Permissions, the Documents card (Send documents to sign, Make document templates)',
    ],
    handovers: [],
  },
  pipelines: {
    label: 'Pipelines',
    what: 'the pipelines leads move through, and their stages',
    where: ['Settings', 'Pipelines'],
    onScreen: [
      'Pipelines and stages: a card for each pipeline (the first one is the Default, with its badge), with how many leads it holds, Rename, Add stage and Archive; under it each stage with what it counts as (Open, Won or Lost), its leads, Move up, Move down, Edit (its name and Kind) and Delete',
      'New pipeline, at the bottom',
    ],
    path: '/settings/pipelines',
    permission: 'pipelines.manage',
    canChange: [
      'add, rename or archive a pipeline',
      'add, rename, reorder or delete a stage',
      'change what a stage counts as (open, won or lost), while no leads are in it',
    ],
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
      'what the AI changed lately and why (to read), and taking off a tag it put on',
    ],
    handovers: [],
  },
  fields: {
    label: 'Fields',
    what: 'the business’s own fields on customers, companies and its own kinds of records',
    where: ['Settings', 'Fields'],
    onScreen: [
      'Fields for: Contacts, Companies, or one of your own kinds of records',
      'Fields: the list, each with Move up, Move down, Edit and Retire, and Add field (Name, What it holds, Choices, Help)',
    ],
    path: '/settings/fields',
    permission: 'fields.manage',
    canChange: [
      'add a field to customers, companies or a kind of record',
      'rename it, or change its choices (renaming one keeps it on the records that have it), help line or whether it shows when empty',
      'put the fields in another order',
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
      'add one of the starters in one go (pets, vehicles, properties, units, students, equipment), with their fields and owners',
      'set up, rename, archive or bring back a relationship type, and how many each end may have',
      'set up one of the starter relationships (spouse or partner, family member, parent and child, emergency contact, works at, business location)',
    ],
    handovers: [],
  },
  // Customers, conversations and bookings deleted for good, for their 30 days (20261027000400): owners only, unless
  // an owner gives Delete for good to someone.
  deleted_bin: {
    label: 'Deleted bin',
    what: 'customers, conversations, bookings, leads, companies and records deleted for good, kept 30 days so they can be brought back, then gone',
    where: ['Settings', 'Deleted bin'],
    onScreen: [
      'Deleted bin: each thing deleted, newest first, with what it is, what went with it, who deleted it and when it goes for good (or Being deleted now), with Bring back, and Show more under the list',
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
      `Pressing a calendar opens its own settings, down the left under Settings on this calendar: ${CALENDAR_SECTION_NAMES}`,
      'At the top of a calendar: Turn on (Resume when it’s paused), History, Preview booking page, and More (Name, color and time zone…, Change link…, Pause, Back to draft, Archive, or Bring back as a draft once it’s archived)',
      'Beside its settings: How this calendar works, Labels, Booking link (with Copy and Open, and Customers can book it online), and Things to check, with a Fix button for each problem it can fix',
    ],
    path: '/settings/calendars',
    permission: 'calendars.manage',
    canChange: [
      'create a calendar',
      'rename it, or change its description, colour, time zone or booking link',
      'who works it, how a booking picks a person, people per booking, and each person’s weight, order and Must go',
      'what it offers and what each booking needs, its lengths and start times, and each service’s own video link',
      'its hours, open hours or fixed sessions, buffers and travel time, and booking rules (notice, how far ahead, only between dates, a daily limit per person)',
      'turn it on or pause it, put it back to a draft, archive it, or bring an archived one back',
      'what happens to visits already booked when someone comes off it: keep them, reassign them, or cancel them and tell the customers',
      'apply a fix Things to check offers',
      'seats per time, the places it happens and their video links, a webinar’s settings, and routing by ZIP code and which territories',
      'repeat visits, and the waitlist and how long offers last',
      'intake questions, and the cancel and reschedule rules',
      'the confirmation and reminders customers get, and the team’s new-booking email',
      'whether it checks people’s own Google or Outlook calendars, and adds bookings to them',
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
      'Put a calendar back to a draft, or bring an archived one back: press the calendar, then More, then Back to draft or Bring back as a draft',
      'Rename a calendar, or change its colour or time zone: press the calendar, then More, then Name, color and time zone…',
      'Change a calendar’s link: press the calendar, then More, then Change link… (the old link keeps working and sends people to the new one)',
      'See or put back an earlier version of a calendar: press the calendar, then History, then Restore',
      'See a calendar’s booking page: press the calendar, then Preview booking page',
      'Copy one calendar’s booking link: Settings → Calendars, the copy icon beside it, or press the calendar and Copy under Booking link',
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
      'its name, lengths, price shown, setup before and cleanup after',
      'how often it repeats (a customer is due again)',
      'who can do it, what it needs and how many, and the hours it can be booked',
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
    canChange: [
      'add, change or archive a resource',
      'its name, kind, how many there are, where it is, and its hours',
    ],
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
    canChange: [
      'add, change or delete a territory',
      'its ZIP codes, or so many miles from an address, and who covers it',
      'rename an area drawn on the map, change who covers it, or turn it into ZIP codes or a distance',
    ],
    handovers: [
      {
        what: 'draw an area on the map, or change one drawn there',
        why: 'its corners are placed by hand on the map, which I can’t see',
        steps: [
          'Open Settings → Calendars → Territories.',
          'Press New, or the pencil beside the territory.',
          'Under Where it covers, pick Draw on map, and click each corner of the area.',
          'Press Add territory, or Save.',
        ],
      },
    ],
  },
  booking_site: {
    label: 'Booking site',
    what: 'the page customers book on: its address, name and intro',
    where: ['Settings', 'Calendars', 'Booking site'],
    onScreen: [
      'At the top: the booking site’s address, with a copy icon and an open icon beside it',
      'Booking site: Business name shown, Link name (changing it breaks links already shared), Intro, and Taking bookings online',
      'Below: Want your own web address? It’s set up in Settings → Workspace',
    ],
    path: '/settings/calendars/booking-site',
    permission: 'calendars.manage',
    canChange: ['its link name, the name and the intro', 'whether it’s taking bookings online'],
    handovers: [],
  },
  team: {
    label: 'Members',
    what: 'who works here and what each of them may do',
    where: ['Members'],
    onScreen: [
      'Invite teammate, at the top (Email address, then Owner, Admin or Member, then Send invite)',
      'Everyone in the business, with a Role picker; ⋯ beside a person has Edit hours (Edit my hours on your own row), View as <their name> (owners and admins, for someone below them: the app as they see it, read-only, until Stop viewing; only the person starts and stops it), Permissions (owners only), and Remove from workspace (Leave workspace on your own row)',
      'Also has access via the agency (Put me on this business), and Pending invitations with Resend and Revoke',
    ],
    path: '/members',
    permission: 'members.invite',
    canChange: [
      'invite someone (owners and admins)',
      'change what a teammate may do (owners and admins; only an owner makes or changes an owner)',
      'remove a teammate (owners and admins)',
      'resend or cancel an invitation (owners and admins)',
      'leave the business, for anyone, on a card that says what they lose',
    ],
    handovers: [
      {
        what: 'accept an invitation',
        why: 'the person invited opens the email and accepts it themselves',
        steps: [
          'They open the email from HandsFreeOS and press Accept invitation.',
          'If they aren’t signed in, they sign in or make an account with that email address.',
          'They press Accept invitation.',
        ],
      },
      {
        what: 'view the app as a teammate',
        why: 'seeing it as someone else is started and stopped only by the person, never by the Assistant',
        steps: [
          'Members, ⋯ beside the teammate, then View as <their name> (owners and admins, for someone below them).',
          'It’s read-only. Stop viewing on the banner ends it.',
        ],
      },
    ],
    howTo: [
      'Invite someone: Members, press Invite teammate',
      'Change someone’s role: Members, the Role picker on their row',
      'Let one person do more or less than their role: Members, ⋯ beside them, then Permissions (owners only)',
      'Resend or cancel an invitation: Members, Pending invitations, Resend or Revoke',
      'Remove someone: Members, ⋯ beside them, then Remove from workspace',
      'Leave the business: Members, ⋯ on your own row, then Leave workspace',
      'See what a teammate sees, read-only: Members, ⋯ beside them, then View as <their name> (owners and admins); Stop viewing on the banner ends it',
    ],
    notHere: ['changing a teammate’s name or email for them', 'an invite link to share'],
  },
  texting: {
    label: 'Texting & calls',
    what: 'your business number, who it rings, voicemail, quiet hours and carrier registration. Until texting is on, the carrier registration reads in rows: Number bought, then Business profile and brand (a2p_customer_profile, a2p_trust_product and a2p_brand together), then Texting campaign (a2p_campaign, which waits for the brand), then Texting turns on. While textingFees.due is set, nothing has gone to the carriers yet: it goes once the person pays it',
    where: ['Settings', 'Texting & calls'],
    onScreen: [
      'Phone & texting: On or Off, its Account SID and Sub-account SID, and Numbers already in this account',
      'Before there is a number: Get a business number (or I already have a number I want to keep, to bring one over, with Check for a HighLevel number and Bring it here for a Twilio account), then the carrier registration',
      'The Steps: Number, Business details, Carrier review',
      'Register for texting now: Start the registration, or Pick up the registration where it was left',
      'Before the carriers approve: The carriers are reviewing (the business), with Number bought, Business profile and brand, Texting campaign and Texting turns on; Pay the carrier fees first when they’re due; Fix and send again after a rejection',
      'Your numbers: Add a number',
      'Who sees which conversations',
      'Business number: Text me a test, and Release this number under ⋯',
      'Carrier registration (once approved): where it stands, and View what we sent',
      'RCS messaging: Stop renewing, and Change the details',
      'Texting rules: Quiet hours, Remind the team when a customer waits, and STOP, START and HELP (always on)',
      'When a customer calls: which browsers and phones ring, and Ring for',
      'What forwarded phones show',
      'Call recording: whether customers hear that calls are recorded',
      'Voicemail: on or off, and the greeting',
    ],
    path: '/settings/texting',
    permission: 'channels.manage',
    canChange: [
      'get a number, or give one up',
      'who it rings, for how long, and voicemail',
      'what the customer sees when a call is forwarded',
      'quiet hours, and when to remind the team a customer is waiting',
      'fill in the carrier registration with you, or send it to HandsFreeOS to check',
      'turn Phone & texting on or off, and read its Account SIDs and the numbers already in its account',
      'look up where a number is today (Check), list the numbers in a connected Twilio account, or disconnect that account',
      'send a test text to your cell',
      'name a number, or make it the default',
      'choose who a number rings',
      'choose whether each person sees only their own conversations',
      'start bringing over a number the business already has',
      'whether customers hear that calls are recorded',
      'connect the RCS sender HandsFreeOS made, by its id',
      'pause or turn on RCS, choose its number, check it, or disconnect it',
      'stop RCS renewing, or cancel an unpaid RCS request so its details can be changed (asking again and paying stay with you)',
    ],
    handovers: [
      {
        what: 'get texting approved by the carriers',
        why: 'the phone carriers review it, which takes a few days and is out of everyone’s hands here',
        steps: [
          'I fill in the registration with you; you send it from Before it goes, its last step, once its checks are all green (or I ask HandsFreeOS to check it by hand).',
          'Wait for the carriers: The carriers are reviewing, on Settings → Texting & calls, shows where it stands (Carrier registration, once they approve).',
          'Texting turns on by itself once they approve it.',
        ],
      },
      {
        what: 'connect a Twilio account to bring its numbers here',
        why: 'it signs in with the account’s auth token or API key, which never goes in a chat',
        steps: [
          'Open Settings → Texting & calls and press I already have a number I want to keep.',
          'Under Where is your number today?, choose My own Twilio account, type the Account SID and Auth token (or an API key and its secret) from your Twilio console, and press Connect and show my numbers.',
          'Once it’s connected, I can list its numbers and bring the one you pick here. Keep the number in that account until it lands: releasing or deleting it there can lose it for good.',
          'Only your organization’s owners and admins can connect one, because one account can hold every one of your businesses’ numbers. Anyone else can still ask for a number to be sent here.',
        ],
      },
      {
        what: 'ask for RCS, and pay for it',
        why: 'it’s paid for on Stripe’s page, which only you can do',
        steps: [
          'Open Settings → Texting & calls and, in RCS messaging, fill in what your sender should show.',
          `Press Pay ${money(RCS_FIRST_YEAR_CENTS)} and send, then pay on Stripe’s page.`,
          'HandsFreeOS makes the sender and connects it. After that I can pause it, choose its number or check it for you.',
        ],
      },
    ],
  },
  email: {
    label: 'Email',
    what: 'the addresses you send from, your own sending domain, connected mailboxes and blocked addresses',
    where: ['Settings', 'Email'],
    onScreen: [
      'Sending address: Name customers see (one name, on every address), Make default, and Who reads it',
      'Use your own domain: Add domain, Add address, Check now, Remove domain, Receive mail here too and Stop receiving here; Another domain for a second one',
      // Connect Gmail is greyed out as Coming soon until Google's review (NEXT_PUBLIC_GMAIL_ENABLED).
      'Connected mailboxes: Connect Outlook, and Connect Gmail marked Coming soon',
      'Where senders’ mail goes: Remove',
      'Blocked addresses: Unblock',
      'Mail from people not in Contacts: Add or link, Dismiss',
    ],
    notHere: [
      'connecting a Gmail mailbox: coming soon, so connect Outlook or send from the workspace address',
    ],
    path: '/settings/email',
    permission: 'channels.manage',
    canChange: [
      'add or change a sending address, on the shared domain or your own',
      'make an address one person’s own',
      'decide what becomes of the address of someone who has left',
      'add or remove your own sending domain, and check it',
      'receive mail at your own domain, or stop',
      'disconnect a connected mailbox',
      'unblock an address',
      'block an address',
      'file mail from someone not in Contacts under a customer, or dismiss it',
      'forget where a sender’s mail goes, so it is sorted as usual',
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
    what: 'the chat boxes on your websites: who answers each, how it looks, where its button sits on phones and computers, what it asks for. Every one is listed under Website chats on the Forms page too, which is where another one is added; this page shows the first',
    where: ['Settings', 'Website chat'],
    onScreen: [
      'Before it is on: Your sites, and Turn on website chat',
      'Website chat: on or paused, Who answers, Daily limit',
      'Your sites',
      'Add it to your site: the snippet',
      'Try it',
      'Look: Name, Greeting, Button label, Button colour, Words on the button and top bar, Top bar of the chat, Show your logo',
      'Where the button sits: On computers and On phones, each with Button (label, icon only, or hidden on phones), Corner and Higher up by',
      'When nobody is answering: Let them chat anyway or Show the away message and a short form, Away message, What to ask visitors for, and Offer a box to get texts',
      'Your logo: the business’s logo and colour, as on Settings → Workspace',
    ],
    path: '/settings/website-chat',
    permission: 'channels.manage',
    canChange: [
      'set one up on your website (or another one), and turn each on or off',
      'which sites it may show on, and its name',
      'who answers: your AI teammate, or only your team',
      'the most new chats it takes a day',
      'its greeting, button label and colours, and showing your logo',
      'where its button sits on computers and on phones: the corner, how far up, label or icon only, or hidden on phones',
      'whether visitors can chat anyway while nobody is answering, the away message, when it asks visitors for their name, mobile and email, and the box to get texts',
      'a new key for its snippet, when someone put it on a site that isn’t yours',
    ],
    handovers: [
      {
        what: 'put the chat box on your website',
        why: 'the snippet goes into your website, which lives outside HandsFreeOS',
        steps: [
          'I set the chat box up and give you the snippet.',
          'Paste it into your site before </body> (or into your site builder’s custom-code box). I can give the steps for WordPress, Wix, Squarespace, GoHighLevel or Webflow.',
          'Your sites on the chat’s page (under Website chats on the Forms page) goes green once it sees it.',
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
    canChange: [
      'disconnect a Facebook Page or an Instagram account, so its messages stop coming here',
      'disconnect a Facebook sign-in, and every Page and account it connected',
    ],
    handovers: [
      {
        what: 'connect a Facebook Page or an Instagram account, or connect one again',
        why: 'you sign in to Facebook yourself and choose the Pages, so nobody else can do it for you',
        steps: [
          'Open Settings → Facebook & Instagram and press Connect Facebook.',
          'Sign in with a Facebook account that manages the business’s Page, and leave every permission ticked.',
          'Pick which Pages and Instagram accounts answer in the inbox.',
        ],
      },
      {
        what: 'let a Page’s lead ads send their leads in',
        why: 'it is a permission on Facebook, which only you can give',
        steps: [
          'If Lead ads says the sign-in didn’t allow reading leads, press Connect Facebook again and leave Leads ticked.',
          'If it says Facebook is keeping the leads out, open Leads Access in Meta Business Suite’s settings and add HandsFreeOS.',
          'The next lead shows up under Lead ads within a minute of being sent.',
        ],
      },
    ],
  },
  templates: {
    label: 'Templates',
    what: 'saved wording for texts and emails, in folders, that the inbox’s reply box can put in',
    where: ['Settings', 'Templates'],
    onScreen: [
      'Templates, with the tabs In use and Put away, by folder',
      'New template (Name, Send as, Subject, Message, Folder)',
      'Put away and Restore on each',
    ],
    howTo: [
      'Use one in a reply: open the conversation in Inbox, press Insert a template beside the paperclip, then pick it',
    ],
    path: '/settings/templates',
    permission: 'templates.manage',
    canChange: ['add, change, put away or restore a template'],
    handovers: [],
  },
  lead_intake: {
    label: 'Lead intake',
    what: 'what happens when a stranger texts, calls or emails: whether they become a customer and a lead, and where that lead lands',
    where: ['Settings', 'Lead intake'],
    onScreen: [
      'A switch for each way in: Someone texts your number, Someone calls and doesn’t get through, Someone emails your business address, Someone messages your Facebook Page, Someone messages your Instagram account, Someone fills in your lead ad’s form, and Indeed emails you about an applicant. Each has Open a lead as well as the customer, Leads land in, and At most N a day',
      'Forms and connected apps: Website form, Connect an app, and Replace the key and Retire it on each',
    ],
    path: '/settings/lead-intake',
    permission: 'channels.manage',
    canChange: [
      'turn each way in on or off: texts, missed calls, emails, Facebook Page and Instagram messages, lead ad forms and Indeed applicants',
      'whether a lead opens as well as the customer',
      'which pipeline and stage those leads land in, and what they are filed under',
      'the most leads a day a channel may open',
      'add a form for your website, and give a form a new key',
      'pause, turn back on, change or retire a website form or connected app',
    ],
    handovers: [
      {
        what: 'put a website form on your site',
        why: 'its snippet goes into your website, which lives outside HandsFreeOS',
        steps: [
          'I add the form for you, on the sites you name.',
          'Open Settings → Lead intake, find it under Forms and connected apps, and press Copy the snippet.',
          'Paste it into your page where the form should be.',
        ],
      },
      {
        what: 'connect an app like Zapier',
        why: 'an app’s key is a secret shown once, and I never put one in a chat',
        steps: [
          'Open Settings → Lead intake and, in Forms and connected apps, press Connect an app.',
          'Copy the key it shows you, once, into the app.',
          'Tell me where you want those leads to land and I’ll set it up for you.',
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
      'Your address (until one is written, documents show the address from your setup)',
      'Terms and notes',
      'Deposits',
      'Invoice reminders, and the nudge for an estimate nobody answered',
    ],
    path: '/settings/payments',
    permission: 'money.manage',
    canChange: [
      'bank transfer on or off (card is always on), sales tax, its name and whether new items start taxable',
      'your business address on documents, or taking it off',
      'when invoices are due, the notes at the bottom of estimates and invoices, and how long an estimate is good for',
      'the deposit an estimate asks for: none, a share or a set amount',
      'invoice reminders before, on and after the due date, and the nudge for an estimate nobody answered',
      'rename a payout account, make one the default, or disconnect it (plans still billing through it keep billing at Stripe or Square only if you say so)',
      'who may bill into each payout account',
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
      {
        what: 'reconnect a payout account that needs it',
        why: 'Stripe or Square asks you to sign in to them again yourself',
        steps: [
          'Open Settings → Payments.',
          'On the account marked Needs reconnecting or Not working, press Reconnect.',
          'Sign in to Stripe or Square again; you land back here when it is done.',
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
      'add, change or archive an item, or put an archived one back',
      'its name, code, kind (product, service or fee), price, what one is called, tax, and the service customers book it as',
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
      'how partners are paid: their share, the smallest payout, the calendar their links book, and the terms (or taking them off)',
      'make a customer a partner, give one their own share, pause, end or bring one back, and mark which partner sent a customer',
      'send a partner their page in the portal, or send it again',
      'take the card partner payouts are charged to off (only someone who manages money)',
    ],
    handovers: [
      {
        what: 'put on, or change, the card partner payouts are charged to',
        why: 'the card is typed on the payment provider’s own page, which only you can do. The buttons show only to someone who manages money, and only once HandsFreeOS has opened partner payouts for the business',
        steps: [
          'Open Settings → Partners.',
          'Under Paying your partners, press Add a card, or Change the card. If it says HandsFreeOS doesn’t pay your partners for you yet, there’s no card to add: pay them yourself from what each is owed.',
          'Type the card on Stripe’s page; you come back here when it is done.',
        ],
      },
    ],
  },
  usage: {
    label: 'Usage & balance',
    what: 'what the business pays HandsFreeOS: the balance texts, calls, phone numbers and AI replies come out of, top-ups, the daily AI limit, the card and the statement',
    where: ['Settings', 'Usage & balance'],
    onScreen: [
      'Your founding spot, while the business has one: what it costs and when it renews, with a link to Settings → Billing, where its cards and payment date are',
      'Your balance: Top up now',
      'Automatic top-up',
      'Daily AI limit: the most the AI may spend in a day, and what it has spent today',
      'Card on file',
      'What things cost',
      'Statement',
    ],
    path: '/settings/usage',
    permission: 'money.manage',
    canChange: [
      'automatic top-up: on or off, the balance it tops up below, and how much it adds',
      'top up the balance now, from the card on file',
      'the daily AI limit',
      'take the card off, which turns automatic top-up off',
    ],
    handovers: [
      {
        what: 'add a card, or use a different one',
        why: 'the card is typed on the payment provider’s own page, which only you can do',
        steps: [
          'Open Settings → Usage & balance.',
          'Under Card on file, press Add a card, or Use a different card.',
          'Type the card on the payment provider’s page; you come back here when it is done.',
        ],
      },
    ],
  },
  billing: {
    label: 'Billing',
    what: 'the business’s HandsFreeOS plan: its next payment and payment date, the cards it’s paid with (a default and backups tried in turn), stopping it renewing, and a payment that didn’t go through',
    where: ['Settings', 'Billing'],
    onScreen: [
      'Your payment didn’t go through, while one is owed: what and when, why the bank said no, the next automatic try, Try my cards now, Add a card and pay, and Ask for more time (or where that request is)',
      'Your plan: what it costs, the next payment and its date, Change date, and Stop renewing or Keep it renewing',
      'Cards: the default first, then the backups in the order they’re tried, each with Make default and Remove, a decline kept on its card, and Add a card',
    ],
    path: '/settings/billing',
    permission: 'money.manage',
    canChange: [
      'make another card the default, or take a backup card off (never the default)',
      'move the payment date: later is charged now for the days it adds, earlier takes them off the next payment',
      'try the cards again now, when a payment is owed',
      'ask HandsFreeOS for more time to pay, with the day they think they can pay by',
      'whether the plan renews',
    ],
    handovers: [
      {
        what: 'add a card to the plan, or pay with a new card',
        why: 'the card is typed on Stripe’s own page, which only you can do',
        steps: [
          'Open Settings → Billing.',
          'Under Cards, press Add a card. To use it for a payment that didn’t go through, press Add a card and pay at the top instead.',
          'Type the card on Stripe’s page; you come back here when it is done.',
        ],
      },
    ],
    howTo: [
      'Change which card is charged first: Settings → Billing → Cards → Make default on that card.',
      'Change the payment date: Settings → Billing → Your plan → Change date, pick the day, and confirm what it costs or saves.',
    ],
    notHere: [
      'pausing the plan: it can stop renewing, but not pause',
      'billing on the phone app: billing is changed on the web',
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
      'turn any automation on or off, except Drafts awaiting review, Connection broke and Texting turned down, which are always on; Re-engage dead leads and Text leads that went quiet the first time with their message on the card for an owner to read, as only an owner sees Looks good, turn on',
      'which kinds of thing Home looks for',
      'how fast a lead counts as waiting, and what a big job is',
      'when a lead has gone quiet, for every stage or one open stage at a time',
      'what HandsFreeOS does on its own, and how it words it',
      'when each of the AI teammate’s follow-ups after silence goes, and how many monthly ones come after',
      'when a dead lead counts as cold, how many a day are re-engaged, and the message they get',
      'which form Intake questions sends after a first booking, and the message it goes with',
      'when the Maintenance due texts go (how many days before, and between), and how many a day',
      'when the end-of-day email goes out',
      'what the AI does when a voicemail box answers its call',
    ],
    handovers: [],
    howTo: [
      'Change one automation: Settings → Automations, its switch, or Adjust beside it',
      'Set what a typical job is worth: Settings → Automations, Adjust on Hot lead alert',
      'Change when follow-ups go: Settings → Automations, Adjust on Follow-ups after silence, then each follow-up’s time',
    ],
  },
  ai_teammate: {
    label: 'AI teammate',
    what: 'your AI teammate: its name, what it may do, which channels it answers on and its hours',
    where: ['AI teammate'],
    onScreen: [
      'Tabs: Teammate, Instructions, Funnels, Review, Activity, Approvals',
      `Teammate: its settings, down the left, in three groups: ${TEAMMATE_SECTIONS}`,
      'Beside them: Status (Off, Training wheels, Automatic), the things to check (each with its Fix), and How it works',
      'At the top: Test console, History, and More (Website chat settings, Knowledge, turn it off or on)',
      'Instructions: the rules it reads on every reply, call and test (up to 50, 300 characters each), with Add instruction, and Edit or Delete on each',
      'Funnels: each funnel with its pipeline, how many people are at each stage and its switch, and New funnel; a funnel opens its steps (who gets in, the stages, the messages, wording and approvals, Try it as a lead) beside its map, with Pause, Turn on or Archive it',
      'Review: what it sent on its own, newest first, Not rated yet or All, each with thumbs up or down; a thumbs down suggests a rule to Save rule',
      'Activity: every run, what started it, what it looked up, the checks, and what it sent or drafted',
      'Approvals: its drafts waiting for an OK, and Decided lately',
    ],
    path: '/ai-team',
    permission: 'ai_team.manage',
    canChange: [
      'set one up, name it, and how it introduces itself',
      'off, training wheels, or automatic',
      'which channels it answers on, the address it emails from, the website chat it answers, and its hours',
      'what it may do: answer, qualify, book, follow up',
      'its first message to a new lead: by text or email, and how long after the lead comes in',
      'whether it reschedules, cancels, uses a waitlist, books repeat visits and checks the service area',
      'whether it looks at photos and gives rough price ranges from them',
      'which add-ons it uses in a conversation',
      'the questions it asks new leads, where a qualified lead goes, and who is told',
      'its limits: replies a day, look-ups, its share of the AI limit, discounts, bills, quotes and plans',
      'when it hands a customer to a person, who is told, and what the customer hears',
      'whether it answers phone calls, when it picks up, its voice and greeting',
      'its email signature and tone',
      'how many approvals before it works on its own, and when drafts expire',
      'approve, change or reject what it wrote while it waits for an OK',
      'the order it asks its qualifying questions in',
      'its instructions: add, change or delete one',
      'save or drop a rule it suggests from feedback on its replies',
      'its funnels: make one, change a stage, a message or a move, turn it on, pause it or archive it',
      'try it as a customer by text, email or the website chat, and read what it would say and do (nothing is sent)',
      'run quick setup again, from what is saved',
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
      'Try it as a customer: AI teammate, Test console (or ask me to try a question on it)',
      'Undo a change: Undo on the save card, or History, then Restore',
      'See what it did: AI teammate → Activity',
      'Approve what it wrote: AI teammate → Approvals, Review, then Approve and send',
      'Teach it a rule: AI teammate → Instructions, Add instruction',
      'Build a funnel: AI teammate → Funnels, New funnel; Turn on, Pause or Archive it on the funnel',
      'See what it sent on its own and rate it: AI teammate → Review; a thumbs down suggests a rule, and Save rule keeps it',
      'Change the order of its questions: the Qualify section, the up and down arrows beside each question',
      'Run quick setup again: AI teammate, Run quick setup again under the sections',
    ],
    notHere: ['deleting it, or having more than one'],
  },
  knowledge: {
    label: 'Knowledge',
    what: 'what your AI knows about the business: what you offer, service area, hours, policies and how to sound',
    where: ['Knowledge'],
    onScreen: [
      'Tabs: Overview, Items, Documents, Website, Promotions, Suggestions',
      'Overview: FAQs, Articles, Facts and Documents (each with how many are published and drafts), Business profile (Edit opens its sections: What you do, Services, Where and when, Policies, Tone of voice, Prices), Tone of voice, Suggestions, Try it',
      'Scan website and Add an FAQ, at the top',
    ],
    path: '/knowledge',
    permission: 'knowledge.manage',
    canChange: [
      'what you offer, your services and their prices, your area, hours and policies',
      'how it should sound, the words to use and to avoid, how it signs off, and whether it may quote prices',
      'add a question and answer, a fact or an article, or many FAQs typed or pasted in at once',
      'change, publish, archive or bring back an FAQ, fact, article or document',
      'accept, edit or reject suggestions, accept all of the website’s at once, and answer questions customers asked',
      'scan the website, or only change its address',
      'ask a question as Try it does, and see the answer and the items it used',
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
    what: 'your own name, how the web app looks, your side menu, your sign-in, what you are told about, your cell, and the businesses you are in with your role in each',
    where: ['Settings', 'Account'],
    onScreen: [
      'Profile: your name, and the email you sign in with (it can’t be changed here yet); your initials stand in for a photo',
      'Appearance: Light, Dark or System, for the web app, saved to your account; the phone app keeps its own',
      'Side menu: how many places are in it, in groups and hidden, and Edit menu (Move up, Move down, Move to a group, Add a group, Group name, Ungroup, Hide and Show, Use suggested groups, Start over, then Save menu)',
      'Sign-in methods: Password, Google, Passkeys ("Keep at least two so you are never locked out")',
      'Notifications: each kind with its push and email switches, and how many phones the pushes go to; then the ones that only email',
      'My cell phone: your number, Verified or Not verified yet, and Verify my cell',
      'Delete my account: type your email address, then Delete my account; a business you are the only owner of is named first',
    ],
    path: '/settings',
    permission: null,
    canChange: [
      'your name',
      'the web app’s light or dark (the phone app’s is set on that phone, under More, then Settings, then Appearance)',
      'which emails you get, each kind of phone alert, and the daily agency digest (agency owners and admins)',
      'your side menu: hide or show places, move them, put them in a group by name, rename or ungroup a group, use the suggested groups, or start over',
      'add a business the way Create workspace does, under one of your organizations (its owners and admins)',
    ],
    handovers: [
      {
        what: 'change your password, Google sign-in or passkeys',
        why: 'these are your keys to the account; you set them yourself',
        steps: [
          'Open Settings → Account (on the phone: More, then Settings, then Profile and sign-in, which opens it on the web).',
          'Use Sign-in methods to change any of them, and keep at least two.',
          'Apple sign-in is on the iPhone app’s sign-in screen (Continue with Apple), not under Sign-in methods.',
        ],
      },
      {
        what: 'confirm your cell number',
        why: 'HandsFreeOS calls it and you press 1, so it has to be you',
        steps: [
          'Open Settings → Account and find My cell phone (on the phone: More, then Settings, then My cell phone).',
          'Put your number in and press Verify my cell.',
          'Answer the call and press 1.',
        ],
      },
      {
        what: 'delete your account',
        why: 'it cannot be undone, so it is typed in by hand',
        steps: [
          'Open Settings → Account (on the phone: More, then Settings, then Delete my account).',
          'If you’re a business’s only owner, make someone else an owner of it first, in its Members: it’s named there.',
          'Under Delete my account, type your email address and press Delete my account.',
        ],
      },
    ],
    howTo: [
      'Not getting notifications on the phone: in the phone app, More, then Settings, then Notifications; This phone says whether it gets them; press Turn on notifications, or Open the phone’s settings when they’re off there, or Try again when it wasn’t added',
      'Dark mode on the phone: in the phone app, More, then Settings, then Appearance (System, Light or Dark, for that phone alone)',
      'Fewer alerts at night: turn kinds off under Notifications, or use the phone’s own Focus or Do Not Disturb; on an iPhone, Urgent items and safety check-ins can still break through Focus',
      'Switch business: press the business name at the top of the side menu; on the phone, the business’s mark at the top left, or Switch on their card at the top of More',
    ],
    notHere: [
      'changing the email you sign in with (it’s coming with the security settings)',
      'a profile photo (your initials stand in for now)',
      'quiet hours for your own alerts (quiet hours are only for what goes to customers)',
    ],
  },
  my_calendar: {
    label: 'My calendar',
    what: 'your own working hours, time off, and the Google or Outlook calendar and Zoom account HandsFreeOS uses',
    where: ['Settings', 'My calendar'],
    onScreen: [
      'Weekly hours',
      'Time zone',
      'Time off: Add time off, and remove beside each (extra open time shows there too)',
      'Calendar connection: Google or Outlook; once connected, Sync now, Disconnect (under ⋯) and Allow Meet transcripts; Reconnect when it needs reconnecting',
      'Video meetings: Connect Zoom; once connected, Disconnect',
    ],
    path: '/settings/my-calendar',
    permission: null,
    canChange: [
      'your working hours and the time zone they are in',
      'add or take out time off',
      'sync or disconnect your Google or Outlook calendar',
      'disconnect Zoom',
      'a teammate’s hours and time off (owners and admins)',
    ],
    handovers: [CONNECT_CALENDAR, CONNECT_ZOOM],
    howTo: [
      'Block time off: Settings → My calendar, press Add time off',
      'Set someone else’s hours (owners and admins): Members, ⋯ beside them, then Edit hours',
      'Make Zoom links for appointments: Settings → My calendar, press Connect Zoom under Video meetings',
    ],
  },
  safety: {
    label: 'Safety',
    what: 'check-ins for visits (showings, open houses, tours): how long after someone’s planned end they are asked if they are OK, how long after that their contacts are told (then told again every 10 minutes, for an hour, until someone says they’re OK), and who is told when someone has nobody to tell: no teammate contact still in the business, and nobody outside who has replied OK and not STOP',
    where: ['Settings', 'Safety'],
    onScreen: [
      'Ask them after: minutes past their planned end before the phone asks “Still there?”',
      'Then tell their contacts after: minutes with no answer before their contacts are told; then they’re told again every 10 minutes, for an hour, until someone says the person is OK',
      'Who’s told when someone has nobody to tell: the safety person (The owners and admins when nobody is picked), then Save',
      'What each person sees: the times as each person’s own Safety page and the phone show them, with a link to your Safety page',
    ],
    path: '/settings/safety',
    permission: 'workspace.update',
    canChange: [
      'how long before someone is asked if they are OK, how long before their contacts are told, and who is told when someone has nobody to tell',
      'for the person asking, and only them: checking in, adding time and checking out, asking for help on a card that says who is told, and who is told about them',
    ],
    handovers: [],
    howTo: [
      'Choose who is told if you don’t check out: in the phone app, open More, then Settings, then My safety',
      'Check in for a visit: in the phone app, open the appointment and press Check in (Share where I am shares where the phone is until check-out)',
      'See or end your own check-in on a computer: the Still there? notification under the bell, or Settings → Safety, then your Safety page under What each person sees (I’m OK, check me out; +15 min)',
      'Ask for help: Help on the phone’s check-in banner tells them at once where you are; in danger, call 911 yourself',
      'Answer an alert about a teammate: press the Safety notification under the bell, the push on the phone or the email’s link, then I reached them once they’re OK',
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
      'Each import’s own page: its progress, result and the rows that did not import',
    ],
    path: '/settings/imports',
    permission: 'records.import',
    canChange: ['cancel an import that’s still going (rows already in stay)'],
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
      'Connected: each system connected, with Start a migration (Call it, then Look at <the system>, which counts what’s there and brings nothing across yet)',
      'Each move, with its status (Needs a look, Ready to set up, Bringing it across, Keeping up with the old system, Done…); press one for its own page',
      'A move’s page: What we found; Where each one lands, with Save and choose what to bring; What to bring, with Save what to bring; The plan, with Bring it across',
      'While it runs: Bringing it across, with Pause or Carry on, Try N again for what failed, and whether a customer is Same as someone already here or Somebody new',
      'Once it’s done: Brought across, with the things left for you, each linking to its screen; Take it back; and Delete this move',
      'An agency’s owners and admins see every move of the agency’s in the Agency area, under Migrations',
    ],
    path: '/settings/migrations',
    permission: 'migrations.manage',
    canChange: [
      'once a system is connected: count what’s in it, choose what comes over and where each sub-account lands, and start the move',
      'pause a move, carry it on or retry it, and settle a possible duplicate it found',
    ],
    handovers: [
      {
        what: 'connect the system the business is moving from',
        why: 'you give HandsFreeOS read access to your old system yourself, with a private token only you can make there',
        steps: [
          'Open Settings → Migrations and press Connect a CRM.',
          'Pick the system you are coming from, like GoHighLevel.',
          'In GoHighLevel, under Settings, open Private Integrations, make one with read access (View Contacts, and whatever else you want brought across), and copy its token: it is shown once.',
          'Paste the token there, never in this chat, with the sub-account’s Location ID (in GoHighLevel’s Business Profile, or the long code after /location/ in its address bar), then press Connect.',
          'Then I can count what’s there and, once you say what to bring over, start the move. Nothing is brought across until you say yes, and the old account is never changed.',
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
