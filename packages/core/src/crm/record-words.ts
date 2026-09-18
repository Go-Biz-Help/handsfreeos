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
  laterMilestone: 'Properties and equipment arrive with jobs in a later milestone.',
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
  },
} as const;

/** "This person is archived: hidden from lists and searches, history kept." */
export function archivedNotice(kind: 'person' | 'company', canRestore: boolean): string {
  return `This ${kind} is archived: hidden from lists and searches, history kept.${
    canRestore ? ' Restore from the menu to use it again.' : ''
  }`;
}
