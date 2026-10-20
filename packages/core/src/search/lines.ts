/**
 * The grey lines under a search result (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Words in core"), worked out from
 * its facts so the dropdown, the Search page and the phone print the same: "(504) 555-0142 · dana.smith@gmail.com ·
 * Texted 2 days ago", "12 people · 4 open leads", "Marcus Smith · Invoice #1031" with "Paid Sep 30". Browser-safe.
 */
import { binLeftLine } from '../bin-words';
import { fmtDateShort, fmtMonthDay, fmtRange, localDayOf } from '../calendar/when';
import { lastContactWords } from '../crm/pipeline-words';
import { dueWording } from '../money/words';
import type { SearchHit } from '../schemas/search';

export interface HitLines {
  /** The grey line under the title. */
  readonly line: string | null;
  /** A chip beside it: "Paid Sep 30". */
  readonly chip: string | null;
  /** A second line on the Search page: the open lead under a contact's name, or the company they work at. */
  readonly under: string | null;
}

/**
 * The timeline lines that count as being in touch with someone, for a contact's last contact (decision 35): a
 * message, a call, a note or a visit either way, or a booking. Bookkeeping lines (created, archived, assigned, a file
 * added, an intake, an add-on's line and the rest) never count. One list, for the SQL and for this file.
 */
export const CONTACT_LINES = {
  kinds: ['note', 'call', 'visit', 'email', 'sms', 'chat', 'portal', 'messenger', 'instagram'],
  bookedSubtypes: [
    'appointment_booked',
    'appointment_booked_online',
    'appointment_booked_waitlist',
  ],
} as const;

/** Whether a timeline line of this kind and subtype counts as being in touch. */
export function countsAsContact(kind: string, subtype: string | null): boolean {
  return (
    (CONTACT_LINES.kinds as readonly string[]).includes(kind) ||
    (kind === 'system' &&
      (CONTACT_LINES.bookedSubtypes as readonly string[]).includes(subtype ?? ''))
  );
}

interface When {
  readonly now?: number;
  readonly timeZone: string;
}

const DAY_MS = 86_400_000;

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const joined = (parts: readonly (string | null | undefined | false)[]): string | null =>
  parts.filter((p): p is string => !!p).join(' · ') || null;

/** "Oct 9", with the year when it isn't this one, where the business is. */
function day(at: string, w: When): string {
  const now = w.now ?? Date.now();
  return fmtMonthDay(localDayOf(at, w.timeZone), Number(localDayOf(now, w.timeZone).slice(0, 4)));
}

/** The verb for the newest real contact, by the timeline line's kind and subtype. */
function contactVerb(kind: string, subtype: string | null): string {
  switch (kind) {
    case 'sms':
      return 'Texted';
    case 'email':
      return 'Emailed';
    case 'call':
      return subtype === 'missed' || subtype === 'outbound_missed' || subtype === 'voicemail'
        ? 'Missed call'
        : 'Called';
    case 'visit':
      return 'Visit';
    case 'note':
      return 'Note';
    case 'chat':
    case 'portal':
      return 'Chatted';
    case 'messenger':
    case 'instagram':
      return 'Messaged';
    case 'paid':
      return 'Paid';
    default:
      return 'Booked';
  }
}

/**
 * The last contact on a contact's row: "Texted 2 days ago", "Called yesterday", "Booked today", then the date after a
 * week ("Emailed Oct 9", "Paid Sep 30"). How long ago is `lastContactWords`' own wording, so it reads one way
 * everywhere.
 */
export function lastContactLine(
  c: { readonly kind: string; readonly subtype: string | null; readonly at: string },
  w: When,
): string {
  const now = w.now ?? Date.now();
  const verb = contactVerb(c.kind, c.subtype);
  const ago = Math.floor((now - Date.parse(c.at)) / DAY_MS);
  return ago < 7
    ? `${verb} ${lastContactWords(c.at, now).toLowerCase()}`
    : `${verb} ${day(c.at, w)}`;
}

/** Where an estimate stands, short: "Sent Oct 17 · Not opened yet". */
function estimateLine(f: SearchHit['facts'], w: When): string | null {
  switch (f.status) {
    case 'draft':
      return 'Not sent yet';
    case 'accepted':
      return 'Approved';
    case 'declined':
      return 'Declined';
    case 'expired':
      return 'Expired';
    case 'void':
      return 'Voided';
    default:
      return f.sentAt
        ? `Sent ${day(f.sentAt, w)} · ${f.openedAt ? 'Opened' : 'Not opened yet'}`
        : null;
  }
}

/** What an invoice owes or how it ended: "Due Fri", "6 days overdue", "Paid Sep 30", "Not sent yet". */
function invoiceLine(f: SearchHit['facts'], w: When): string | null {
  const now = w.now ?? Date.now();
  switch (f.status) {
    case 'draft':
      return 'Not sent yet';
    case 'void':
      return 'Voided';
    case 'paid':
      return f.paidAt ? `Paid ${day(f.paidAt, w)}` : 'Paid';
    default:
      return f.dueOn ? dueWording(f.dueOn, now, w.timeZone) : null;
  }
}

/** The lines under one search result. */
export function hitLines(hit: SearchHit, w: When): HitLines {
  const f = hit.facts;
  const now = w.now ?? Date.now();
  if (hit.badges.includes('archived') && f.archivedAt)
    return {
      line: `Archived ${day(f.archivedAt, w)} · Restore from the record’s menu`,
      chip: null,
      under: null,
    };
  switch (hit.kind) {
    case 'contacts':
      return {
        line: joined([f.phone, f.email, f.lastContact ? lastContactLine(f.lastContact, w) : null]),
        chip: null,
        under: f.openLead
          ? joined([f.openLead.title, f.openLead.stage])
          : f.company
            ? `Works at ${f.company}`
            : null,
      };
    case 'companies':
      return {
        line: joined([
          f.people !== undefined ? count(f.people, 'person', 'people') : null,
          f.openLeads ? count(f.openLeads, 'open lead') : null,
        ]),
        chip: null,
        under: null,
      };
    case 'leads':
      return {
        line: joined([f.customer, f.pipeline && f.stage ? `${f.pipeline} › ${f.stage}` : f.stage]),
        chip: null,
        under: null,
      };
    case 'money':
      if (f.docKind === 'payment')
        return {
          line: joined([f.customer, f.invoiceNumber ? `Invoice #${f.invoiceNumber}` : null]),
          chip: f.paidAt ? `Paid ${day(f.paidAt, w)}` : null,
          under: null,
        };
      return {
        line: joined([
          f.customer,
          f.docKind === 'estimate' ? estimateLine(f, w) : invoiceLine(f, w),
        ]),
        chip: null,
        under: null,
      };
    case 'calendar':
      return {
        line: joined([
          f.startsAt ? fmtDateShort(localDayOf(f.startsAt, w.timeZone)) : null,
          f.startsAt && f.endsAt ? fmtRange(f.startsAt, f.endsAt, w.timeZone) : null,
          f.who,
        ]),
        chip: null,
        under: null,
      };
    case 'tasks':
      return {
        line: joined([
          'Task',
          f.doneAt
            ? `Done ${day(f.doneAt, w)}`
            : f.dueAt
              ? dueWording(localDayOf(f.dueAt, w.timeZone), now, w.timeZone)
              : null,
          f.owner,
        ]),
        chip: null,
        under: null,
      };
    case 'notes':
      return {
        line: joined([f.on ? `Note on ${f.on}` : 'Note', hit.at ? day(hit.at, w) : null]),
        chip: null,
        under: null,
      };
    case 'files':
      return {
        line: joined([f.on ? `On ${f.on}` : null, hit.why.page ? `page ${hit.why.page}` : null]),
        chip: null,
        under: null,
      };
    case 'forms':
      return {
        line: joined([
          f.answeredBy === undefined
            ? null
            : f.answeredBy
              ? `Answered by ${f.answeredBy}`
              : hit.badges.includes('anonymous')
                ? 'Answered by someone who didn’t say who'
                : // Someone who said who, no longer a customer by name: merged away, deleted or erased.
                  'Answered by someone with no name on file',
          hit.at ? day(hit.at, w) : null,
        ]),
        chip: null,
        under: null,
      };
    case 'messages':
    case 'spam':
      return {
        line:
          f.messages !== undefined && hit.at
            ? `Last one ${lastContactWords(hit.at, now).toLowerCase()} · ${count(f.messages, 'message')}`
            : joined([
                hit.at ? day(hit.at, w) : null,
                f.matches && f.matches > 1 ? count(f.matches, 'match', 'matches') : null,
              ]),
        chip: null,
        under: null,
      };
    case 'settings':
      return {
        line: joined([f.on ? `Settings › ${f.on}` : 'Settings', f.status]),
        chip: null,
        under: null,
      };
    case 'bin':
      return {
        line:
          f.deletedAt && f.purgeAfter
            ? binLeftLine(
                { deletedAt: f.deletedAt, purgeAfter: f.purgeAfter, emptying: false },
                now,
              )
            : null,
        chip: null,
        under: null,
      };
    default:
      return { line: hit.subtitle, chip: null, under: null };
  }
}
