import type { TimelineEntry } from '@/lib/api/types';
import { fmtAt } from '@/lib/calendar/time';
import { clock } from '@/lib/calls/format';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Texts and emails mirror a conversation: what the customer sent, or what the business sent them. */
export function isChannelEntry(e: TimelineEntry): boolean {
  return e.kind === 'sms' || e.kind === 'email' || !!e.meta.direction;
}
const inbound = (e: TimelineEntry) => isChannelEntry(e) && e.meta.direction === 'inbound';
const undelivered = (e: TimelineEntry) =>
  e.meta.status === 'failed' || e.meta.status === 'undelivered' || e.meta.status === 'bounced';

/**
 * Who did it, for the timeline row: the customer for what they sent us, a teammate, "Import" for system
 * work on someone's behalf, or the app.
 */
export function timelineActor(e: TimelineEntry, subjectName?: string): string {
  if (inbound(e)) return subjectName || 'The customer';
  // What the customer did on the booking page: they booked, moved or cancelled it themselves.
  if (e.subtype === 'appointment_booked_online' || (isAppointment(e) && e.meta.by === 'customer'))
    return subjectName || 'The customer';
  // A call a teammate placed: the worker settled it, but the teammate called.
  if (e.kind === 'call' && e.actor) return e.actor.fullName;
  if (e.actorType === 'system') return e.meta.onBehalfOf ? 'Import' : 'HandsFreeOS';
  return e.actor?.fullName ?? 'Former member';
}

/** The sentence after the actor's name. */
export function describeTimeline(
  e: TimelineEntry,
  recordType: 'person' | 'company' | 'lead',
  /** Who is reading, for "you answered in the browser". */
  viewerId?: string,
  /** The workspace's zone, for appointment times. */
  timeZone?: string,
): string {
  if (isAppointment(e)) return describeAppointment(e, timeZone);
  if (e.kind === 'note') return 'added a note';
  if (e.kind === 'call') return describeCall(e, viewerId);
  if (e.kind === 'visit') return 'logged a visit';
  if (e.kind === 'sms') {
    const keyword = str(e.meta.keyword);
    if (keyword === 'stop') return 'opted out of texts (STOP)';
    if (keyword === 'start') return 'opted back in to texts';
    if (inbound(e)) return 'texted';
    return undelivered(e) ? 'sent a text · not delivered' : 'sent a text';
  }
  if (e.kind === 'email') {
    const subject = str(e.meta.subject) ? ` · ${str(e.meta.subject)}` : '';
    if (inbound(e)) return `emailed${subject}`;
    return undelivered(e) ? `sent an email that bounced${subject}` : `sent an email${subject}`;
  }
  const title = str(e.meta.title);
  const noun =
    recordType === 'person'
      ? 'this person'
      : recordType === 'company'
        ? 'this company'
        : 'this lead';
  switch (e.subtype) {
    case 'created':
      return `added ${noun}`;
    case 'archived':
      return `archived ${noun}`;
    case 'restored':
      return `restored ${noun}`;
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
    default:
      return e.subtype?.replace(/_/g, ' ') ?? 'made a change';
  }
}

/** Appointment entries: booked (by staff, the Assistant or online), moved, cancelled, done or no-show. */
const isAppointment = (e: TimelineEntry) =>
  e.kind === 'system' && !!e.subtype?.startsWith('appointment_');

function describeAppointment(e: TimelineEntry, timeZone?: string): string {
  const what = e.body || 'an appointment';
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const at = (v: unknown) => (typeof v === 'string' ? fmtAt(v, zone) : 'a time');
  switch (e.subtype) {
    case 'appointment_booked':
      return num(e.meta.occurrences)
        ? `booked ${num(e.meta.occurrences)} visits of ${what}, starting ${at(e.meta.startsAt)}`
        : `booked ${what} for ${at(e.meta.startsAt)}`;
    case 'appointment_booked_online':
      return `booked ${what} online for ${at(e.meta.startsAt)}`;
    case 'appointment_rescheduled':
      return `rescheduled ${what} from ${at(e.meta.from)} to ${at(e.meta.to)}`;
    case 'appointment_cancelled':
      return `cancelled ${what} on ${at(e.meta.startsAt)}`;
    case 'appointment_completed':
      return `marked ${what} on ${at(e.meta.startsAt)} done`;
    case 'appointment_no_show':
      return `marked ${what} on ${at(e.meta.startsAt)} a no-show`;
    default:
      return e.subtype!.replace(/_/g, ' ');
  }
}

/** A call through the business number (it has a call id), or one logged by hand. */
function describeCall(e: TimelineEntry, viewerId?: string): string {
  if (!e.meta.callId) return 'logged a call';
  switch (e.subtype) {
    case 'voicemail':
      return `left a voicemail · ${clock(num(e.meta.recordingSeconds))}`;
    case 'missed':
    case 'outbound_missed':
      return 'called, no answer';
    case 'answered': {
      const how =
        e.meta.answeredVia === 'forwarding'
          ? 'answered on a forwarding phone'
          : viewerId && e.meta.answeredByUserId === viewerId
            ? 'you answered in the browser'
            : 'answered in the browser';
      return `called · ${clock(num(e.meta.durationSeconds))} · ${how}`;
    }
    default:
      return `called · ${clock(num(e.meta.durationSeconds))}`;
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

export function timelineDotClass(e: TimelineEntry): string {
  if (e.kind === 'sms' && str(e.meta.keyword) === 'stop') return 'bg-card-3';
  if (e.kind === 'sms' || e.kind === 'email') return undelivered(e) ? 'bg-danger' : 'bg-accent';
  if (e.kind === 'note') return 'bg-accent';
  if (e.kind === 'call' && ['missed', 'outbound_missed', 'voicemail'].includes(e.subtype ?? ''))
    return 'bg-warning';
  if (e.kind === 'call' || e.kind === 'visit') return 'bg-success';
  if (e.subtype === 'file_added') return 'bg-warning';
  if (e.subtype === 'appointment_booked_online') return 'bg-warning';
  if (e.subtype === 'appointment_booked' || e.subtype === 'appointment_rescheduled')
    return 'bg-accent';
  if (e.subtype === 'appointment_cancelled') return 'bg-danger';
  if (e.subtype === 'appointment_completed') return 'bg-success';
  if (e.subtype === 'won') return 'bg-success';
  if (e.subtype === 'lost') return 'bg-danger';
  return 'bg-card-3';
}
