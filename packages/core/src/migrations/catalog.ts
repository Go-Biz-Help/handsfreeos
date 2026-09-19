/**
 * What can move house, and in what order (Milestone 11).
 *
 * This catalog is the one place a category is described, and it is deliberately written in HandsFreeOS's own
 * words rather than any one CRM's. An adapter says which of these it can read; the scan says how many of each
 * it found; the dependency engine reads `dependsOn` and `pass`; the screens read `label` and `blurb`. A new
 * source adapter adds no rows here unless it can genuinely do something none of the others can.
 *
 * `release` is the honest answer to "will this come across today?", and the four values are not the same
 * thing:
 *   ready     — the importer exists and is tested; it comes across now.
 *   next      — counted by the scan so nobody is surprised, imported in a later step of this milestone.
 *   excluded  — deliberately never imported. Automations are the whole of this list, on purpose: the point of
 *               HandsFreeOS is to need fewer of them, so we read them to learn what the business relies on
 *               and recommend the native thing instead.
 *   deferred  — websites and funnels: detected and counted so the boundary is visible and the demand is
 *               measurable, not imported in this release.
 *   unsupported — HandsFreeOS has nowhere to put it at all. This is the honest one, and the uncomfortable
 *               one: custom fields are the first. We count them, keep every value with the record they
 *               belonged to, and say so — and the count of businesses hitting this is what decides whether
 *               we build it. A category here must never be described as "coming soon" when the truth is
 *               that nobody has built it.
 */

/** The nine passes of an import, in the order they run. Lower goes first; a pass may run in parallel inside itself. */
export const MIGRATION_PASSES = {
  /** The business itself: its name, time zone and address. */
  workspace: 1,
  /** The people and the shapes records need before there are records: users, fields, tags. */
  definitions: 2,
  /** Customers and the companies they belong to. Almost everything else hangs off these. */
  contacts: 3,
  /** The structures records live in: calendars, pipelines, forms, the product catalog. */
  structure: 4,
  /** The records themselves: conversations, opportunities, appointments, invoices. */
  records: 5,
  /** Their children: messages, calls, lines, answers, history. */
  children: 6,
  /** Copying files across, and pointing the records at the copies. */
  media: 7,
  /** Optional links that could not be made while their other half was still arriving. */
  links: 8,
  /** Counting, checking and reconciling. */
  verify: 9,
} as const;
export type MigrationPass = (typeof MIGRATION_PASSES)[keyof typeof MIGRATION_PASSES];

export type CategoryRelease = 'ready' | 'next' | 'excluded' | 'deferred' | 'unsupported';

export interface MigrationCategory {
  readonly id: string;
  /** What a person calls it. Sentence case, plural, no jargon. */
  readonly label: string;
  /** One line under the label on the inventory screen. */
  readonly blurb: string;
  readonly pass: MigrationPass;
  /** Categories that must be imported first. The engine adds these to a selection and says why. */
  readonly dependsOn: readonly string[];
  /** Categories this would like but can live without; attached in the links pass when they are there. */
  readonly prefers?: readonly string[];
  /** What it becomes here, for the report and for the source mapping. Empty when nothing is written. */
  readonly targetType: string | null;
  /** Whether a person can pick through the pieces inside (one calendar, one pipeline) or only take the lot. */
  readonly selection: 'category' | 'resource';
  readonly release: CategoryRelease;
  /** Said on the screen wherever the release is not `ready`, in place of a count that would mislead. */
  readonly releaseNote?: string;
}

const c = (x: MigrationCategory): MigrationCategory => x;

export const MIGRATION_CATEGORIES: readonly MigrationCategory[] = [
  c({
    id: 'locations',
    label: 'Businesses',
    blurb: 'Each sub-account of the old system, and the business here it becomes.',
    pass: MIGRATION_PASSES.workspace,
    dependsOn: [],
    targetType: 'workspace',
    selection: 'resource',
    release: 'ready',
  }),
  c({
    id: 'users',
    label: 'Team',
    blurb: 'Everyone who worked in the old system, so their name stays on what they did.',
    pass: MIGRATION_PASSES.definitions,
    dependsOn: ['locations'],
    targetType: 'user',
    selection: 'resource',
    release: 'ready',
  }),
  c({
    id: 'custom_fields',
    label: 'Custom fields',
    blurb: 'The extra fields the old system kept on customers, and what type each one is.',
    pass: MIGRATION_PASSES.definitions,
    dependsOn: ['locations'],
    // M15 built custom fields here, so these stopped being homeless: the field comes across as a field, and
    // its values arrive on the customers as values you can see, filter and report on.
    targetType: 'custom_field',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'tags',
    label: 'Tags',
    blurb: 'Every label put on a customer, kept as a tag here.',
    pass: MIGRATION_PASSES.definitions,
    dependsOn: ['locations'],
    targetType: 'tag',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'companies',
    label: 'Companies',
    blurb: 'The businesses your customers work for, and who belongs to which.',
    pass: MIGRATION_PASSES.contacts,
    dependsOn: ['locations'],
    prefers: ['users', 'custom_fields', 'tags'],
    targetType: 'company',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'contacts',
    label: 'Customers',
    blurb: 'Names, numbers, addresses, who owns them, and whether they agreed to texts.',
    pass: MIGRATION_PASSES.contacts,
    dependsOn: ['locations'],
    prefers: ['users', 'custom_fields', 'tags', 'companies'],
    targetType: 'person',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'pipelines',
    label: 'Pipelines',
    blurb: 'Your pipelines and their stages, in the order you had them.',
    pass: MIGRATION_PASSES.structure,
    dependsOn: ['locations'],
    targetType: 'pipeline',
    selection: 'resource',
    release: 'ready',
  }),
  c({
    id: 'calendars',
    label: 'Calendars',
    blurb: 'Each calendar with its hours, its people and how it books.',
    pass: MIGRATION_PASSES.structure,
    dependsOn: ['locations'],
    prefers: ['users'],
    targetType: 'calendar',
    selection: 'resource',
    release: 'ready',
  }),
  c({
    id: 'forms',
    label: 'Forms and surveys',
    blurb: 'The forms on your site, their questions, and every answer sent in.',
    pass: MIGRATION_PASSES.structure,
    dependsOn: ['locations'],
    prefers: ['custom_fields'],
    targetType: 'form',
    selection: 'resource',
    release: 'ready',
  }),
  c({
    id: 'products',
    label: 'Products and prices',
    blurb: 'What you sell and what you charge, before any invoice can point at it.',
    pass: MIGRATION_PASSES.structure,
    dependsOn: ['locations'],
    targetType: 'product',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'templates',
    label: 'Templates',
    blurb: 'The wording you reuse: the emails and texts you wrote once and send again.',
    pass: MIGRATION_PASSES.definitions,
    dependsOn: ['locations'],
    targetType: null,
    selection: 'category',
    release: 'unsupported',
    releaseNote:
      'HandsFreeOS has nowhere to keep wording on its own — it lives in the workflow or the message that ' +
      'uses it. Copy anything you want to keep before you close the old account.',
  }),
  c({
    id: 'conversations',
    label: 'Conversations',
    blurb: 'Every thread with a customer, on every channel, in one timeline.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['contacts'],
    prefers: ['users'],
    targetType: 'conversation',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'opportunities',
    label: 'Leads',
    blurb: 'What each customer is worth, where it stands, and how it got there.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['contacts', 'pipelines'],
    prefers: ['users', 'custom_fields'],
    targetType: 'lead',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'appointments',
    label: 'Appointments',
    blurb: 'Visits past and future, at the times they were actually booked for.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['contacts', 'calendars'],
    prefers: ['users'],
    targetType: 'appointment',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'tasks',
    label: 'Tasks and notes',
    blurb: 'What people wrote down and what they still have to do.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['contacts'],
    prefers: ['users'],
    targetType: 'task',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'form_submissions',
    label: 'Form answers',
    blurb: 'Every form a customer filled in, attached to the customer.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['forms', 'contacts'],
    targetType: 'form_submission',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'invoices',
    label: 'Invoices and payments',
    blurb: 'What was billed, what was paid, and what was given back.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['contacts', 'products'],
    targetType: 'invoice',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'estimates',
    label: 'Estimates',
    blurb: 'Quotes you sent, and which ones were accepted.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['contacts', 'products'],
    targetType: 'estimate',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'subscriptions',
    label: 'Payment plans',
    blurb: 'Recurring charges as history. Nothing bills again until you say so.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['contacts', 'products'],
    targetType: 'subscription',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'messages',
    label: 'Messages',
    blurb: 'Texts, emails and chats inside each conversation, in the order they happened.',
    pass: MIGRATION_PASSES.children,
    dependsOn: ['conversations'],
    prefers: ['users'],
    targetType: 'message',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'calls',
    label: 'Calls and voicemail',
    blurb: 'Who called whom, how long for, and the recording if there was one.',
    pass: MIGRATION_PASSES.children,
    dependsOn: ['conversations'],
    prefers: ['users'],
    targetType: 'call',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'reviews',
    label: 'Reviews',
    blurb: 'What customers said about you in public, and who you asked.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['locations'],
    prefers: ['contacts'],
    targetType: null,
    selection: 'category',
    release: 'unsupported',
    releaseNote:
      'Your reviews are on Google and Facebook — the old system only showed them to you. Leaving does not ' +
      'lose a single one, and they stay where people read them.',
  }),
  c({
    id: 'media',
    label: 'Photos, recordings and files',
    blurb: 'Copied here, so the history still opens after you cancel the old system.',
    pass: MIGRATION_PASSES.media,
    dependsOn: [],
    targetType: 'file',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'integrations',
    label: 'Connected apps',
    blurb: 'What the old system was plugged into, turned into a list of things to reconnect.',
    pass: MIGRATION_PASSES.workspace,
    dependsOn: ['locations'],
    targetType: 'reconnect_task',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'phone_numbers',
    label: 'Phone numbers',
    blurb: 'Found here, moved by the carrier. Nothing happens to a number without your say-so.',
    pass: MIGRATION_PASSES.workspace,
    dependsOn: ['locations'],
    targetType: 'port_request',
    selection: 'resource',
    release: 'ready',
  }),
  c({
    id: 'sending_domains',
    label: 'Email domains',
    blurb: 'The domains you send from, and the DNS records they will need here.',
    pass: MIGRATION_PASSES.workspace,
    dependsOn: ['locations'],
    targetType: 'reconnect_task',
    selection: 'category',
    release: 'ready',
  }),
  c({
    id: 'workflows',
    label: 'Automations',
    blurb: 'Read to learn what your business relies on. Never rebuilt as automations here.',
    pass: MIGRATION_PASSES.workspace,
    dependsOn: ['locations'],
    targetType: null,
    selection: 'category',
    release: 'excluded',
    releaseNote:
      'HandsFreeOS does these things itself. We read yours to check nothing is missing, and recommend the setting that replaces each one.',
  }),
  c({
    id: 'websites',
    label: 'Websites',
    blurb: 'The pages the old system hosted for you.',
    pass: MIGRATION_PASSES.structure,
    dependsOn: ['locations'],
    targetType: null,
    selection: 'resource',
    release: 'unsupported',
    releaseNote:
      'HandsFreeOS does not host websites. Yours needs somewhere else to live before you close the old ' +
      'account, and its forms and booking links should point here once it does.',
  }),
  c({
    id: 'funnels',
    label: 'Funnels',
    blurb: 'Landing pages and the steps people walked through them.',
    pass: MIGRATION_PASSES.structure,
    dependsOn: ['locations'],
    targetType: null,
    selection: 'resource',
    release: 'unsupported',
    releaseNote:
      'HandsFreeOS does not host pages. What the pages were for lives here — the forms, the booking links ' +
      'and the customers they made — but the pages themselves need somewhere else to live.',
  }),
];

const BY_ID = new Map(MIGRATION_CATEGORIES.map((x) => [x.id, x]));

export function migrationCategory(id: string): MigrationCategory | undefined {
  return BY_ID.get(id);
}

export const MIGRATION_CATEGORY_IDS: readonly string[] = MIGRATION_CATEGORIES.map((x) => x.id);

/** The categories an import actually writes today. Everything else is counted and explained. */
export const IMPORTABLE_CATEGORIES: readonly string[] = MIGRATION_CATEGORIES.filter(
  (x) => x.release === 'ready',
).map((x) => x.id);

/** Whether choosing this category could ever put a record in the business. */
export function isImportable(id: string): boolean {
  return migrationCategory(id)?.release === 'ready';
}

/** Categories in the order they run, stable within a pass so two runs queue the same work. */
export function categoriesInOrder(ids: readonly string[]): MigrationCategory[] {
  const seen = new Set<string>();
  const out: MigrationCategory[] = [];
  for (const id of ids) {
    const cat = BY_ID.get(id);
    if (cat && !seen.has(id)) {
      seen.add(id);
      out.push(cat);
    }
  }
  return out.sort((a, b) => a.pass - b.pass || a.id.localeCompare(b.id));
}

/** The capability status a category's release implies, before any sign-in or account is looked at. */
export function releaseCapability(
  release: CategoryRelease,
): 'ready' | 'not_in_release' | 'not_imported' | 'not_supported' {
  switch (release) {
    case 'ready':
      return 'ready';
    case 'excluded':
      return 'not_imported';
    case 'unsupported':
      return 'not_supported';
    case 'next':
    case 'deferred':
      return 'not_in_release';
  }
}
