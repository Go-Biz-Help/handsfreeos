/**
 * The timeline's words, for the web's record page and the phone's (M10 step 15). Browser-safe, and the one place
 * that decides who did a thing, what they did, what shows in the quiet well under it, and what colour its dot is.
 *
 * It was `apps/web/src/components/timeline/describe.tsx`; nothing it says has changed. The dot's colour comes back
 * as a **tone**, not a class name, so the web keeps its Tailwind classes and the phone uses its own.
 */
import { zonedParts } from '../calendar/engine/zoned';
import { callClock } from '../inbox/time';
import { lowerLabel, relatedWords } from '../relationships/words';
import type { TimelineEntry } from '../schemas/activity';
import { notAppliedWords } from './not-applied';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Texts, emails and website chats mirror a conversation: what the customer sent, or what the business sent them. */
export function isChannelEntry(e: TimelineEntry): boolean {
  return e.kind === 'sms' || e.kind === 'email' || e.kind === 'chat' || !!e.meta.direction;
}
const inbound = (e: TimelineEntry) => isChannelEntry(e) && e.meta.direction === 'inbound';
const undelivered = (e: TimelineEntry) =>
  e.meta.status === 'failed' || e.meta.status === 'undelivered' || e.meta.status === 'bounced';

/** The AI teammate that wrote the entry (`meta.aiTeammate`), or null for anyone else's. */
function aiTeammateOf(
  e: TimelineEntry,
): { readonly name: string; readonly approvedBy: string | null } | null {
  if (e.actorType !== 'ai_employee') return null;
  const t = obj(e.meta.aiTeammate);
  return { name: str(t.name) || 'The AI teammate', approvedBy: str(t.approvedBy) || null };
}

/**
 * " · approved by Chris" after what the AI teammate did when a person's OK sent it (their name from the
 * members the page has); nothing otherwise.
 */
export function timelineApproval(
  e: TimelineEntry,
  members: readonly { readonly id: string; readonly fullName: string }[] = [],
): string {
  const ai = aiTeammateOf(e);
  if (!ai?.approvedBy) return '';
  const name = members.find((m) => m.id === ai.approvedBy)?.fullName;
  return ` · approved by ${name ? (name.trim().split(/\s+/)[0] ?? name) : 'a teammate'}`;
}

/**
 * Who did it, for the timeline row: the customer for what they sent us, a teammate, "Ava (AI)" for the AI
 * teammate, "Workflow: <name>" for a workflow's step, "Import" for system work on someone's behalf, or the app.
 */
export function timelineActor(e: TimelineEntry, subjectName?: string): string {
  if (inbound(e)) return subjectName || 'The customer';
  const ai = aiTeammateOf(e);
  if (ai) return ai.name === 'The AI teammate' ? ai.name : `${ai.name} (AI)`;
  // What the customer did on the booking page: they booked, moved or cancelled it themselves.
  if (e.subtype === 'appointment_booked_online' || (isAppointment(e) && e.meta.by === 'customer'))
    return subjectName || 'The customer';
  // A customer who confirmed by text (C, or YES while asked) or with the Confirm button on their appointment page.
  if (e.subtype === 'appointment_confirmed' && (e.meta.via === 'sms' || e.meta.via === 'link'))
    return subjectName || 'The customer';
  // A call a teammate placed: the worker settled it, but the teammate called.
  if (e.kind === 'call' && e.actor) return e.actor.fullName;
  if (e.actorType === 'workflow') {
    const name = str(obj(e.meta.workflow).name);
    return name ? `Workflow: ${name}` : 'Workflow';
  }
  if (e.actorType === 'system') return e.meta.onBehalfOf ? 'Import' : 'HandsFreeOS';
  return e.actor?.fullName ?? 'Former member';
}

/**
 * How an appointment's time reads inside a timeline entry: "Fri, Sep 18 at 10:00 AM", where the business is. The
 * calendar's own `fmtAt` says exactly this; it's written out here from the scheduling engine's zoned parts so the
 * timeline doesn't depend on the calendar's screen layer, and a caller with its own formatter can pass it in.
 */
export type FormatAt = (iso: string, timeZone: string) => string;

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export const timelineFormatAt: FormatAt = (iso, timeZone) => {
  const p = zonedParts(new Date(iso), timeZone);
  const hour = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const time = `${hour}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
  return `${WEEKDAYS_SHORT[p.weekday]!}, ${MONTHS_SHORT[p.month - 1]!} ${p.day} at ${time}`;
};

/** The sentence after the actor's name. */
export function describeTimeline(
  e: TimelineEntry,
  recordType: 'person' | 'company' | 'lead' | 'custom_record',
  /** Who is reading, for "you answered in the browser". */
  viewerId?: string,
  /** The workspace's zone, for appointment times. */
  timeZone?: string,
  /** The calendar's own `fmtAt`, when the caller already has it. */
  formatAt: FormatAt = timelineFormatAt,
): string {
  if (isAppointment(e)) return describeAppointment(e, timeZone, formatAt);
  if (e.kind === 'note') return 'added a note';
  if (e.kind === 'call') return describeCall(e, viewerId);
  if (e.kind === 'visit') return 'logged a visit';
  if (e.kind === 'sms') {
    const keyword = str(e.meta.keyword);
    if (keyword === 'stop') return 'opted out of texts (STOP)';
    if (keyword === 'start') return 'opted back in to texts';
    if (inbound(e)) return 'texted';
    const auto = actionCenterNoun(e);
    if (auto) return undelivered(e) ? `sent ${auto} · not delivered` : `sent ${auto}`;
    // Held for quiet hours (M10), and sent when they ended.
    const held = e.meta.scheduled === true ? ' when quiet hours ended' : '';
    return undelivered(e) ? `sent a text${held} · not delivered` : `sent a text${held}`;
  }
  if (e.kind === 'email') {
    const subject = str(e.meta.subject) ? ` · ${str(e.meta.subject)}` : '';
    if (inbound(e)) return `emailed${subject}`;
    const auto = actionCenterNoun(e);
    if (auto)
      return undelivered(e) ? `sent ${auto} by email that bounced` : `sent ${auto} by email`;
    return undelivered(e) ? `sent an email that bounced${subject}` : `sent an email${subject}`;
  }
  if (e.kind === 'chat') return inbound(e) ? 'chatted on your website' : 'replied in chat';
  const title = str(e.meta.title);
  const noun =
    recordType === 'person'
      ? 'this person'
      : recordType === 'company'
        ? 'this company'
        : recordType === 'custom_record'
          ? // A record of a kind the business made up says what it is: "added this pet".
            `this ${str(e.meta.kind) ? lowerLabel(str(e.meta.kind)) : 'record'}`
          : 'this lead';
  switch (e.subtype) {
    case 'created':
      return `added ${noun}`;
    case 'archived':
      return `archived ${noun}`;
    case 'restored':
      return `restored ${noun}`;
    // Two records for the same customer, merged: said on the one kept, naming the duplicate as it was.
    case 'merged':
      return `merged ${str(e.meta.mergedName) || 'a duplicate'} into ${noun}`;
    case 'lead_created':
      return `created the lead ${e.body ?? ''}${str(e.meta.stage) ? ` in ${str(e.meta.stage)}` : ''}`;
    case 'stage_changed':
      return `moved ${title || 'the lead'} from ${str(e.meta.from)} to ${str(e.meta.to)}`;
    case 'won':
      return `won ${title || 'the lead'}`;
    case 'lost':
      return `marked ${title || 'the lead'} lost`;
    case 'reopened':
      return `reopened ${title || 'the lead'}`;
    case 'assigned':
      return e.body?.startsWith('Assigned to ')
        ? `assigned ${title || 'the lead'} to ${e.body.slice('Assigned to '.length)}`
        : `unassigned ${title || 'the lead'}`;
    case 'next_action':
      return e.body
        ? `set the next action on ${title || 'the lead'}`
        : `cleared the next action on ${title || 'the lead'}`;
    case 'task_done':
      return 'completed a task';
    case 'file_added':
      return 'uploaded a file';
    case 'lead_qualified':
      return `marked ${title || e.body || 'the lead'} qualified: every answer is in, and none rules them out`;
    case 'edit_not_applied':
      return notAppliedWords(e.meta);
    // Relationships (0101): the pair as both records were named then, the same on either one's page.
    case 'related':
    case 'unrelated': {
      const a = obj(e.meta.a);
      const b = obj(e.meta.b);
      return relatedWords(
        e.subtype,
        { name: str(a.name) || 'someone', label: str(a.label) },
        { name: str(b.name) || 'someone', label: str(b.label) },
        e.meta.mutual === true,
      );
    }
    default:
      return e.subtype?.replace(/_/g, ' ') ?? 'made a change';
  }
}

/**
 * What HandsFreeOS sent on its own for the Action Center (the system actor's `meta.actionCenter`): "a confirmation
 * request" for an unconfirmed visit, else "a follow-up". Null for any other message.
 */
function actionCenterNoun(e: TimelineEntry): string | null {
  if (e.actorType !== 'system') return null;
  const ac = obj(e.meta.actionCenter);
  if (!str(ac.itemId) && !str(ac.itemKind)) return null;
  return str(ac.itemKind) === 'unconfirmed_appointment' ? 'a confirmation request' : 'a follow-up';
}

/** Appointment entries: booked (by staff, the Assistant or online), moved, cancelled, done, no-show or confirmed. */
const isAppointment = (e: TimelineEntry) =>
  e.kind === 'system' && !!e.subtype?.startsWith('appointment_');

function describeAppointment(
  e: TimelineEntry,
  timeZone: string | undefined,
  fmt: FormatAt,
): string {
  const what = e.body || 'an appointment';
  // Core never asks the engine what zone it is in (`test/intl.test.ts`): both callers pass the business's, and the
  // web hands in the browser's when a business has no calendar yet, which is what it has always shown there.
  const zone = timeZone || 'UTC';
  const at = (v: unknown) => (typeof v === 'string' ? fmt(v, zone) : 'a time');
  switch (e.subtype) {
    case 'appointment_booked':
      return num(e.meta.occurrences)
        ? `booked ${num(e.meta.occurrences)} visits of ${what}, starting ${at(e.meta.startsAt)}`
        : `booked ${what} for ${at(e.meta.startsAt)}`;
    case 'appointment_booked_online':
      return `booked ${what} online for ${at(e.meta.startsAt)}`;
    case 'appointment_booked_waitlist':
      return `booked ${what} from the waitlist for ${at(e.meta.startsAt)}`;
    case 'appointment_rescheduled':
      return `rescheduled ${what} from ${at(e.meta.from)} to ${at(e.meta.to)}`;
    case 'appointment_cancelled':
      return `cancelled ${what} on ${at(e.meta.startsAt)}`;
    case 'appointment_completed':
      return `marked ${what} on ${at(e.meta.startsAt)} done`;
    case 'appointment_no_show':
      return `marked ${what} on ${at(e.meta.startsAt)} a no-show`;
    // M8: "Kendra confirmed AC tune-up by text", "Priya marked AC tune-up confirmed".
    case 'appointment_confirmed':
      return e.meta.via === 'sms'
        ? `confirmed ${what} by text`
        : e.meta.via === 'link'
          ? `confirmed ${what} online`
          : e.meta.via === 'ai'
            ? `marked ${what} confirmed for the customer`
            : `marked ${what} confirmed`;
    case 'appointment_confirmation_removed':
      return `took back the confirmation on ${what}`;
    default:
      return e.subtype!.replace(/_/g, ' ');
  }
}

/** A call through the business number (it has a call id), or one logged by hand. */
function describeCall(e: TimelineEntry, viewerId?: string): string {
  if (!e.meta.callId) return 'logged a call';
  // A call a teammate placed through their own cell (M10), showing the business number.
  const cell = e.meta.answeredVia === 'bridge';
  switch (e.subtype) {
    case 'voicemail':
      return `left a voicemail · ${callClock(num(e.meta.recordingSeconds))}`;
    case 'missed':
    case 'outbound_missed':
      return cell ? 'called from their cell, no answer' : 'called, no answer';
    case 'outbound':
      return cell
        ? `called · ${callClock(num(e.meta.durationSeconds))} · from their cell`
        : `called · ${callClock(num(e.meta.durationSeconds))}`;
    case 'answered': {
      const how =
        e.meta.answeredVia === 'forwarding'
          ? 'answered on a forwarding phone'
          : e.meta.answeredVia === 'ai'
            ? 'the AI teammate answered'
            : viewerId && e.meta.answeredByUserId === viewerId
              ? 'you answered in the browser'
              : 'answered in the browser';
      return `called · ${callClock(num(e.meta.durationSeconds))} · ${how}`;
    }
    default:
      return `called · ${callClock(num(e.meta.durationSeconds))}`;
  }
}

/** Whether the row shows the body in a quiet well (notes, calls, texts, task titles, file names). */
export function timelineBody(e: TimelineEntry): string | null {
  if (e.kind !== 'system') return e.body;
  switch (e.subtype) {
    case 'task_done':
    case 'file_added':
    case 'next_action':
      return e.body;
    case 'lost':
      return e.body?.replace(/^Lost:\s*/, '') || null;
    case 'appointment_cancelled':
      return str(e.meta.reason) || null;
    default:
      return null;
  }
}

/**
 * The colour of an entry's dot, as a tone each app paints in its own way: `ai` is the AI teammate's violet, and the
 * rest are the kit's own.
 */
export type TimelineTone = 'ai' | 'accent' | 'success' | 'warning' | 'danger' | 'muted';

export function timelineTone(e: TimelineEntry): TimelineTone {
  if (e.kind === 'sms' && str(e.meta.keyword) === 'stop') return 'muted';
  // The AI teammate's entries wear its violet (an undelivered message still shows red).
  if (aiTeammateOf(e) && !undelivered(e)) return 'ai';
  if (e.subtype === 'lead_qualified') return 'success';
  if (e.kind === 'sms' || e.kind === 'email' || e.kind === 'chat')
    return undelivered(e) ? 'danger' : 'accent';
  if (e.kind === 'note') return 'accent';
  if (e.kind === 'call' && ['missed', 'outbound_missed', 'voicemail'].includes(e.subtype ?? ''))
    return 'warning';
  if (e.kind === 'call' || e.kind === 'visit') return 'success';
  if (e.subtype === 'file_added') return 'warning';
  if (e.subtype === 'appointment_booked_online') return 'warning';
  if (
    e.subtype === 'appointment_booked' ||
    e.subtype === 'appointment_booked_waitlist' ||
    e.subtype === 'appointment_rescheduled'
  )
    return 'accent';
  if (e.subtype === 'appointment_cancelled') return 'danger';
  if (e.subtype === 'appointment_completed' || e.subtype === 'appointment_confirmed')
    return 'success';
  if (e.subtype === 'won') return 'success';
  if (e.subtype === 'lost') return 'danger';
  if (e.subtype === 'related') return 'accent';
  return 'muted';
}

/** The run a workflow's entry came from (`meta.workflow.runId`), for "See the run". */
export function timelineRunId(e: TimelineEntry): string | null {
  if (e.actorType !== 'workflow') return null;
  const runId = obj(e.meta.workflow).runId;
  return typeof runId === 'string' && runId ? runId : null;
}

/** An entry someone may delete: their own note, call or visit. Texts and emails mirror a conversation. */
export function timelineEditable(e: TimelineEntry): boolean {
  return e.kind !== 'system' && !isChannelEntry(e);
}

/** The words the timeline itself says, beyond one entry. */
export const TIMELINE_WORDS = {
  emptyTitle: 'Nothing here yet',
  emptyBody: 'Notes, calls, texts, tasks and files show up here as they happen.',
  older: 'Show older',
  seeRun: 'See the run',
  deleteEntry: 'Delete entry',
  deleteConfirm: 'Delete this entry from the timeline? This is recorded in the audit log.',
  deleted: 'Deleted.',
} as const;
