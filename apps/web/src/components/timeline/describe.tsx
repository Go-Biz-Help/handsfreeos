import type { TimelineEntry } from '@/lib/api/types';
import { fmtAt } from '@/lib/calendar/time';
import { clock } from '@/lib/calls/format';

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
    const auto = actionCenterNoun(e);
    if (auto) return undelivered(e) ? `sent ${auto} · not delivered` : `sent ${auto}`;
    return undelivered(e) ? 'sent a text · not delivered' : 'sent a text';
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
    case 'lead_qualified':
      return `marked ${title || e.body || 'the lead'} qualified: every answer is in, and none rules them out`;
    case 'edit_not_applied':
      return describeNotApplied(e);
    default:
      return e.subtype?.replace(/_/g, ' ') ?? 'made a change';
  }
}

/**
 * An edit made earlier than someone's later change to the same detail (M10: a phone offline, a dialog left open):
 * "tried to change the phone number to “…”, but Sam’s later change to “…” was kept". Values are shown for names,
 * contact details and notes; `null` when a detail has no words to show (a company, a date).
 */
function describeNotApplied(e: TimelineEntry): string {
  const label = str(e.meta.label) || 'a detail';
  const later = str(e.meta.keptBy) ? `${str(e.meta.keptBy)}’s later change` : 'a later change';
  const wanted = e.meta.wanted;
  const stays = e.meta.stays;
  if (typeof wanted !== 'string' || typeof stays !== 'string')
    return `tried to change the ${label}, but ${later} was kept`;
  const tried = wanted
    ? `tried to change the ${label} to “${wanted}”`
    : `tried to clear the ${label}`;
  return `${tried}, but ${later}${stays ? ` to “${stays}”` : ', which cleared it,'} was kept`;
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
  // The AI teammate's entries wear its violet (an undelivered message still shows red).
  if (aiTeammateOf(e) && !undelivered(e)) return 'bg-[color-mix(in_oklab,#7c3aed_85%,var(--text))]';
  if (e.subtype === 'lead_qualified') return 'bg-success';
  if (e.kind === 'sms' || e.kind === 'email' || e.kind === 'chat')
    return undelivered(e) ? 'bg-danger' : 'bg-accent';
  if (e.kind === 'note') return 'bg-accent';
  if (e.kind === 'call' && ['missed', 'outbound_missed', 'voicemail'].includes(e.subtype ?? ''))
    return 'bg-warning';
  if (e.kind === 'call' || e.kind === 'visit') return 'bg-success';
  if (e.subtype === 'file_added') return 'bg-warning';
  if (e.subtype === 'appointment_booked_online') return 'bg-warning';
  if (
    e.subtype === 'appointment_booked' ||
    e.subtype === 'appointment_booked_waitlist' ||
    e.subtype === 'appointment_rescheduled'
  )
    return 'bg-accent';
  if (e.subtype === 'appointment_cancelled') return 'bg-danger';
  if (e.subtype === 'appointment_completed' || e.subtype === 'appointment_confirmed')
    return 'bg-success';
  if (e.subtype === 'won') return 'bg-success';
  if (e.subtype === 'lost') return 'bg-danger';
  return 'bg-card-3';
}
