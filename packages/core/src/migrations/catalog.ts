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

export type CategoryRelease = 'ready' | 'next' | 'excluded' | 'deferred';

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
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
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
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
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
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
  }),
  c({
    id: 'products',
    label: 'Products and prices',
    blurb: 'What you sell and what you charge, before any invoice can point at it.',
    pass: MIGRATION_PASSES.structure,
    dependsOn: ['locations'],
    targetType: 'product',
    selection: 'category',
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
  }),
  c({
    id: 'templates',
    label: 'Templates',
    blurb: 'Saved texts and emails you send again and again.',
    pass: MIGRATION_PASSES.structure,
    dependsOn: ['locations'],
    targetType: 'template',
    selection: 'resource',
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
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
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
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
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
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
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
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
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
  }),
  c({
    id: 'form_submissions',
    label: 'Form answers',
    blurb: 'Every form a customer filled in, attached to the customer.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['forms', 'contacts'],
    targetType: 'form_submission',
    selection: 'category',
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
  }),
  c({
    id: 'invoices',
    label: 'Invoices and payments',
    blurb: 'What was billed, what was paid, and what was given back.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['contacts', 'products'],
    targetType: 'invoice',
    selection: 'category',
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
  }),
  c({
    id: 'estimates',
    label: 'Estimates',
    blurb: 'Quotes you sent, and which ones were accepted.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['contacts', 'products'],
    targetType: 'estimate',
    selection: 'category',
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
  }),
  c({
    id: 'subscriptions',
    label: 'Payment plans',
    blurb: 'Recurring charges as history. Nothing bills again until you say so.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['contacts', 'products'],
    targetType: 'subscription',
    selection: 'category',
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
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
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
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
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
  }),
  c({
    id: 'reviews',
    label: 'Reviews',
    blurb: 'What customers said about you in public, and who you asked.',
    pass: MIGRATION_PASSES.records,
    dependsOn: ['locations'],
    prefers: ['contacts'],
    targetType: 'review',
    selection: 'category',
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
  }),
  c({
    id: 'media',
    label: 'Photos, recordings and files',
    blurb: 'Copied here, so the history still opens after you cancel the old system.',
    pass: MIGRATION_PASSES.media,
    dependsOn: [],
    targetType: 'file',
    selection: 'category',
    release: 'next',
    releaseNote: 'Counted now, brought across in a later step.',
  }),
  c({
    id: 'integrations',
    label: 'Connected apps',
    blurb: 'What the old system was plugged into, turned into a list of things to reconnect.',
    pass: MIGRATION_PASSES.workspace,
    dependsOn: ['locations'],
    targetType: 'reconnect_task',
    selection: 'category',
    release: 'next',
    releaseNote: 'Counted now, listed as setup steps in a later step.',
  }),
  c({
    id: 'phone_numbers',
    label: 'Phone numbers',
    blurb: 'Found here, moved by the carrier. Nothing happens to a number without your say-so.',
    pass: MIGRATION_PASSES.workspace,
    dependsOn: ['locations'],
    targetType: 'port_request',
    selection: 'resource',
    release: 'next',
    releaseNote: 'Counted now, ported in a later step.',
  }),
  c({
    id: 'sending_domains',
    label: 'Email domains',
    blurb: 'The domains you send from, and the DNS records they will need here.',
    pass: MIGRATION_PASSES.workspace,
    dependsOn: ['locations'],
    targetType: 'reconnect_task',
    selection: 'category',
    release: 'next',
    releaseNote: 'Counted now, listed as setup steps in a later step.',
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
    blurb: 'Counted so you know what stays behind.',
    pass: MIGRATION_PASSES.workspace,
    dependsOn: ['locations'],
    targetType: null,
    selection: 'category',
    release: 'deferred',
    releaseNote: 'Not part of migrations yet. Your site keeps working wherever it is now.',
  }),
  c({
    id: 'funnels',
    label: 'Funnels',
    blurb: 'Counted so you know what stays behind.',
    pass: MIGRATION_PASSES.workspace,
    dependsOn: ['locations'],
    targetType: null,
    selection: 'category',
    release: 'deferred',
    releaseNote: 'Not part of migrations yet.',
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
