/**
 * A customer, a company or a lead's own page: the head, its summary lines, the tabs and the details, for the web's
 * record page and the phone's 360 view (M10 step 15). Browser-safe, so both say exactly the same thing.
 *
 * The web's wording was inline in `apps/web/src/components/crm/record-page.tsx`; none of it has changed. What the
 * phone says beyond the web — "Added today · Website form" in the canvas's head, and "Possible duplicate of …" for a
 * record made with no signal — lives here too, so the web can catch up without a second copy.
 */
import { money } from '../money/format';
import { formatDate, monthYear, timeOfDay } from './format';

export type RecordKind = 'person' | 'company' | 'lead';

/** "ML" for Maria Lopez, "A" for one word, "?" for nothing. */
export function initialsOf(name: string, fallback = '?'): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  return (
    parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[parts.length - 1]![0]!
  ).toUpperCase();
}

/** The badge beside a name on the web: "Customer since Sep 2025", or "Archived". */
export function customerSince(createdAt: string): string {
  return `Customer since ${monthYear(createdAt)}`;
}

/**
 * The line under the name on the phone: "Added today · Website form", "Added Sep 14 · Referral", or just the date
 * when nothing said where they came from.
 */
export function addedLine(
  createdAt: string,
  source: string | null | undefined,
  now = Date.now(),
): string {
  const at = new Date(createdAt);
  const when = at.toDateString() === new Date(now).toDateString() ? 'today' : formatDate(createdAt);
  return [`Added ${when}`, source?.trim() || null].filter(Boolean).join(' · ');
}

/** "Owes $2,551.88" beside a customer's name, or nothing when they owe nothing. */
export function owesWords(balanceCents: number | null | undefined): string | null {
  return (balanceCents ?? 0) > 0 ? `Owes ${money(balanceCents)}` : null;
}

/**
 * "Possible duplicate of Maria Lopez" and the sentence under it, for a record made with no signal that turned out to
 * match one already saved (M10: it's kept and flagged, never merged).
 */
export function possibleDuplicateWords(other: {
  readonly name: string;
  readonly matchedOn?: 'phone' | 'email' | 'name' | null;
  readonly value?: string | null;
}): { readonly title: string; readonly body: string; readonly open: string } {
  const on =
    other.matchedOn === 'email'
      ? 'email address'
      : other.matchedOn === 'name'
        ? 'name'
        : 'phone number';
  return {
    title: `Possible duplicate of ${other.name}`,
    body: `Same ${on}${other.value ? `, ${other.value}` : ''}. This one was added with no signal, before ${other.name}’s record reached the phone.`,
    open: `Open ${other.name}`,
  };
}

/** The tabs over a record, with their counts: "Leads · 1", "Tasks · 0", "Files · 1". */
export function recordTabLabel(
  tab: 'timeline' | 'appointments' | 'money' | 'leads' | 'tasks' | 'files' | 'details',
  count: number | null,
): string {
  const name = {
    timeline: 'Timeline',
    appointments: 'Appointments',
    money: 'Money',
    leads: 'Leads',
    tasks: 'Tasks',
    files: 'Files',
    details: 'Details',
  }[tab];
  return count === null ? name : `${name} · ${count}`;
}

/** The open lead card beside a record: "Won today at 9:40 AM · Dale Ramsey" under its stage. */
export function leadOutcomeLine(lead: {
  readonly status: 'open' | 'won' | 'lost';
  readonly wonAt?: string | null;
  readonly lostAt?: string | null;
  readonly by?: string | null;
  readonly stageEnteredAt?: string | null;
}): string | null {
  const at = lead.status === 'won' ? lead.wonAt : lead.status === 'lost' ? lead.lostAt : null;
  if (!at) return null;
  const d = new Date(at);
  const today = d.toDateString() === new Date().toDateString();
  const when = today ? `today at ${timeOfDay(at)}` : formatDate(at, { time: true });
  const verb = lead.status === 'won' ? 'Won' : 'Lost';
  return [`${verb} ${when}`, lead.by?.trim() || null].filter(Boolean).join(' · ');
}

/** What the record page says, in one place. */
export const RECORD_WORDS = {
  archived: 'Archived',
  noContact: 'No contact details yet.',
  unassigned: 'Unassigned',
  formerMember: 'Former member',
  none: '—',
  notLinked: 'Not linked to a company.',
  nobodyLinked: 'Nobody linked yet.',
  openLead: 'Open lead',
  leads: 'Leads',
  noOpenLeads: 'No open leads.',
  startOne: 'Start one',
  inStage: 'in stage',
  value: 'Value',
  assignedTo: 'Assigned to',
  noLeadsTitle: 'No leads yet',
  noLeadsBody: 'A lead is a job you might win. It moves across the pipeline.',
  tasksHint: 'Reminders for the team about this customer.',
  leadTasksHint: 'Reminders about this lead.',
  details: 'Details',
  edit: 'Edit',
  editDetails: 'Edit details',
  /** The detail rows, in the order both apps show them. */
  labels: {
    phone: 'Phone',
    email: 'Email',
    website: 'Website',
    address: 'Address',
    company: 'Company',
    owner: 'Owner',
    /** The owner and everyone else on the customer (0104). */
    assignedTo: 'Assigned to',
    source: 'Source',
    created: 'Created',
    notes: 'Notes',
  },
  /** The buttons the phone offers on a record, in the canvas's order. */
  actions: {
    call: 'Call',
    text: 'Text',
    email: 'Email',
    book: 'Book',
    note: 'Note',
    photo: 'Photo',
    task: 'Task',
    lead: 'Lead',
    logCall: 'Log call',
    file: 'File',
    tag: 'Tag',
    /** Send a document to sign (docs/documents.md), for whoever can send them. */
    document: 'Document',
  },
} as const;

/** On a duplicate that was merged into another record: where everything of theirs went. */
export function mergedWords(intoName: string): string {
  return `Merged into ${intoName}: everything of theirs is on that record now, and this one stays archived.`;
}

/**
 * "This person is archived: hidden from lists, found in search under Archived, history kept." On a customer's or
 * company's page, and a business's own record's (`noun` its kind's singular, lower-cased: "pet").
 */
export function archivedNotice(noun: string, canRestore: boolean): string {
  return `This ${noun} is archived: hidden from lists, found in search under Archived, history kept.${
    canRestore ? ' Restore from the menu to use it again.' : ''
  }`;
}

/**
 * What the dialogs that archive and restore say. Archiving takes a thing out of the lists, never out of search, which
 * finds it under Archived (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, How it works, 5).
 */
export const ARCHIVE_WORDS = {
  /** A customer or company. */
  archiveCustomer:
    'Archived records leave the lists but keep their history, and search finds them under Archived. You can restore them at any time. This is recorded in the audit log.',
  restoreCustomer: 'They come back to the lists and can be used on new leads again.',
  /** One of the business's own records. */
  archiveRecord:
    'It leaves lists, and search finds it under Archived. Its history, tasks, files and relationships are kept.',
  restoreRecord: 'It comes back into lists, and search finds it with the rest again.',
} as const;

/**
 * What the Assistant's card says before it archives or restores a customer, a company or one of the business's own
 * records (`plural` its kind's: "Pets"): where it goes, that search still finds it, and where to bring it back.
 */
export function archiveCardWords(
  what: 'customer' | 'company' | 'record',
  plural = '',
): { readonly away: string; readonly back: string } {
  switch (what) {
    case 'customer':
      return {
        away: 'They leave Contacts but keep their history, and search finds them under Archived. Bring them back any time: Contacts, Show archived.',
        back: 'They come back to Contacts, and can go on new leads again.',
      };
    case 'company':
      return {
        away: 'It leaves Contacts but keeps its history, and search finds it under Archived. Bring it back any time: Contacts → Companies, Show archived.',
        back: 'It comes back to Contacts.',
      };
    case 'record':
      return {
        away: `It leaves ${plural}, and search finds it under Archived. Its history, tasks, files and relationships stay.`,
        back: `It comes back to ${plural}.`,
      };
  }
}

/**
 * The tag that makes a customer a client whatever else is known of them (crm/clients.ts): Social Outreach's **Mark as
 * client** puts it on (docs/outreach.md, decision 91). Compared without capitals, so a business's own "client" tag
 * counts too.
 */
export const CLIENT_TAG = 'Client';

/**
 * Why someone is a client, in the order each is looked for (crm/clients.ts, `personIsClient` and
 * `personClientCause`): a won lead, a job underway or done, a visit they came to, a plan they're on, a paid bill, or
 * the Client tag.
 */
export const CLIENT_CAUSES = ['won', 'job', 'visit', 'plan', 'paid', 'tagged'] as const;
export type ClientCause = (typeof CLIENT_CAUSES)[number];

/**
 * The causes Contacts counts: its Leads and Clients filter, and the Client badge in Contacts and Search. The Client
 * tag counts too (Chris, 26 Oct 2026, decision 91, asked and built with its default). To count only what was done for
 * them, take `'tagged'` out here: `clientRule` follows.
 */
export const CONTACTS_CLIENT_CAUSES: readonly ClientCause[] = CLIENT_CAUSES;

/** Each cause in words, after "A client in Contacts: ". */
export const CLIENT_CAUSE_WORDS: Readonly<Record<ClientCause, string>> = {
  won: 'a lead of theirs was won',
  job: 'a job for them is underway or done',
  visit: 'they came to a visit',
  plan: 'they’re on a plan',
  paid: 'they paid a bill',
  tagged: `they’re tagged ${CLIENT_TAG}`,
};

/**
 * The Contacts page: its name, and its filter between leads and clients. Who counts as a client is the list's to
 * work out (crm/clients.ts); `clientRule` says the same thing in words, so the two are changed together.
 */
export const CONTACTS_WORDS = {
  title: 'Contacts',
  search: 'Search contacts',
  standing: 'Leads or clients',
  all: 'All',
  leads: 'Leads',
  clients: 'Clients',
  lead: 'Lead',
  client: 'Client',
  clientRule: `Clients are people you’re working for, have worked for, or who have paid you: a won lead, a job underway or done, a visit they came to, a plan they’re on, or a paid bill${
    CONTACTS_CLIENT_CAUSES.includes('tagged') ? `, or they’re tagged ${CLIENT_TAG}` : ''
  }. Everyone else is a lead.`,
} as const;
