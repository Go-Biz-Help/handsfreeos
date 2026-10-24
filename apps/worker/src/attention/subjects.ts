/**
 * Which events can change what needs attention, and the subjects each one touches: a lead, a customer (their
 * leads and conversations), a conversation, a booked seat, an approval or draft, a task. Reconcile widens a lead
 * or a conversation to the customer's other leads and conversations itself (one card per lead).
 */
import { uuidArray, type AttentionSubjectRef } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import type { EventRow } from '../handlers/types';

/**
 * The events reconciled at once (withAttention). Beyond the plan's list: `message.queued`, because a person's (or
 * the AI teammate's, or a workflow's) text or email is queued, not "sent", and it is the lead's contact;
 * `message.media_attached`, because a picture message's photos are copied in after the message itself, and a card
 * quoting the customer says "Sent a photo." once they are; `conversation.linked`, because a conversation that
 * finds its customer folds into their lead card; the seat's `attendee.reminder_recorded` (a confirmation asked
 * for); and a person's `attention.restored` and `attention.unsnoozed`, so an item brought back whose facts are
 * gone clears at once.
 */
export const ATTENTION_EVENTS: readonly string[] = [
  // Leads: every change to one.
  'lead.created',
  'lead.updated',
  'lead.assigned',
  'lead.stage_changed',
  'lead.qualified',
  'lead.answers_recorded',
  'lead.next_action_set',
  'lead.next_action_cleared',
  'lead.won',
  'lead.lost',
  'lead.reopened',
  'lead.archived',
  'lead.restored',
  // Deleted for good: its cards already went with it (private.bin_let_go), and this clears anything left.
  'lead.deleted',
  // Messages, calls and logged activity: a customer waiting, a first response, a contact.
  'message.received',
  'message.sent',
  'message.queued',
  'message.media_attached',
  'call.started',
  'call.received',
  'call.answered',
  'call.completed',
  'call.missed',
  // A call through someone's own cell that never reached the customer (M10): it changes nothing for them, but
  // every call event is looked at, so a card never waits on one it didn't hear about.
  'call.bridge_unanswered',
  // Cancelled before the customer answered: the same, and a customer whose phone was already ringing gets call.missed.
  'call.bridge_cancelled',
  'call.voicemail_left',
  'call.transcribed',
  'activity.logged',
  // Conversations.
  'conversation.assigned',
  'conversation.snoozed',
  'conversation.reopened',
  'conversation.closed',
  'conversation.handed_off',
  'conversation.taken_over',
  'conversation.handed_to_ai',
  'conversation.linked',
  // Appointments and their seats.
  'appointment.booked',
  'appointment.updated',
  'appointment.rescheduled',
  'appointment.reassigned',
  'appointment.cancelled',
  'appointment.completed',
  'appointment.no_show',
  // Deleted for good: its cards already went with it (private.bin_let_go), and this clears anything left.
  'appointment.deleted',
  'attendee.added',
  'attendee.removed',
  'attendee.rescheduled',
  'attendee.cancelled',
  'attendee.confirmed',
  'attendee.confirmation_removed',
  'attendee.reminder_recorded',
  // Who joined, attended or missed a session (funnels): a seat marked on its own.
  'attendee.joined',
  'attendee.attended',
  'attendee.no_show',
  // Workflow approvals and the AI teammate's drafts.
  'workflow.approval_requested',
  'workflow.approval_decided',
  'workflow.approval_expired',
  'ai_teammate.drafted',
  'ai_teammate.draft_decided',
  'ai_teammate.draft_sent',
  'ai_teammate.draft_expired',
  // Tasks.
  'task.created',
  'task.updated',
  'task.completed',
  'task.reopened',
  'task.deleted',
  // Money (M9): an estimate nobody answered and an invoice nobody paid. The document's own events are what
  // open and close these cards — the hourly sweep is the safety net, not the mechanism. A payment matters
  // whatever it did: succeeded pays the invoice off, processing means a bank transfer is on its way (never
  // late while one is), failed puts it back where it was, and a refund makes it owed again.
  'estimate.created',
  'estimate.updated',
  'estimate.sent',
  'estimate.viewed',
  'estimate.accepted',
  'estimate.declined',
  'estimate.expired',
  'estimate.voided',
  'estimate.converted',
  'invoice.created',
  'invoice.updated',
  'invoice.sent',
  'invoice.viewed',
  'invoice.paid',
  'invoice.overdue',
  'invoice.voided',
  'payment.recorded',
  'payment.updated',
  'payment.failed',
  'refund.recorded',
  // After the job (Automations): a thank-you that couldn't go, and a referral found or turned into a lead.
  'thank_you.recorded',
  'referral.mentioned',
  'referral.lead_created',
  'maintenance.card',
  'maintenance.booked',
  // Pipeline and jobs (Automations): a customer's address, which a visit at their place needs; and a visit
  // someone said was still going, whose card waits.
  'person.updated',
  'appointment.still_going',
  // Video meetings: Make link pressed on an online visit.
  'appointment.meeting_link_requested',
  'appointment.transcript_ready',
  // Service (Automations 4a): a promise the team made, and a hand-off the owners were told about.
  'promise.found',
  'conversation.handoff_escalated',
  // Health and quality (Automations 4b): a connection that broke, came back or went away; the AI teammate's
  // mode; a lesson from its corrections; the website's re-read and the questions it can't answer.
  'payment_connection.reauth_required',
  'payment_connection.failed',
  'payment_connection.revoked',
  'payment_connection.disconnected',
  'payment_connection.connected',
  'calendar_connection.reauth_required',
  'calendar_connection.failed',
  'calendar_connection.disconnected',
  'calendar_connection.connected',
  'mailbox.reauth_required',
  'mailbox.failed',
  'mailbox.disconnected',
  'mailbox.connected',
  'review_connection.needs_attention',
  'review_connection.disconnected',
  'review_connection.connected',
  'phone_number.purchase_failed',
  'phone_number.released',
  // A Facebook Page or Instagram account that stopped answering, works again, or was let go.
  'meta_account.needs_attention',
  'meta_account.recovered',
  'meta_account.disconnected',
  'meta_account.connected',
  'ai_teammate.status_changed',
  'teammate_lesson.found',
  'teammate_lesson.applied',
  'teammate_lesson.dismissed',
  'knowledge_scan.finished',
  'knowledge_suggestion.proposed',
  'knowledge_suggestion.accepted',
  'knowledge_suggestion.rejected',
  // Promotions: an offer's end date changed, or it was archived.
  'offer.created',
  'offer.updated',
  'offer.archived',
  // Texting turned down: the carriers answered, or the details were sent again.
  'registration.submitted',
  'registration.status_changed',
  // An add-on's alert raised, changed, acknowledged or cleared (Real Estate step 5).
  'addon_alert.raised',
  'addon_alert.updated',
  'addon_alert.acknowledged',
  'addon_alert.cleared',
  // A person brought an item back (Undo, or "show it now").
  'attention.restored',
  'attention.unsnoozed',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

const SUBJECT_TYPES: ReadonlySet<string> = new Set<AttentionSubjectRef['type']>([
  'lead',
  'person',
  'conversation',
  'attendee',
  'approval',
  'task',
  'estimate',
  'invoice',
  'thank_you',
  'referral',
  'maintenance',
  'appointment',
  'promise',
  'payment_connection',
  'calendar_connection',
  'mailbox',
  'review_connection',
  'phone_number',
  'meta_account',
  'teammate',
  'lesson',
  'scan',
  'suggestion',
  'offer',
  'registration',
  'addon_alert',
]);

/** A subject from loose values (a job's payload, an item's row), or null. */
export function subjectRefOf(type: unknown, id: unknown): AttentionSubjectRef | null {
  return typeof type === 'string' && SUBJECT_TYPES.has(type) && isUuid(id)
    ? { type: type as AttentionSubjectRef['type'], id }
    : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The subjects one event touches (none for an event that isn't about them). */
export async function subjectsOf(
  tx: Tx,
  workspaceId: string,
  event: EventRow,
): Promise<AttentionSubjectRef[]> {
  const p = isRecord(event.payload) ? event.payload : {};
  const id = event.entityId;
  const out: AttentionSubjectRef[] = [];
  const add = (type: string, value: unknown) => {
    const ref = subjectRefOf(type, value);
    if (ref && !out.some((o) => o.type === ref.type && o.id === ref.id)) out.push(ref);
  };
  switch (event.entityType) {
    case 'lead':
      add('lead', id);
      break;
    case 'task':
      add('task', id);
      break;
    case 'workflow_approval':
      add('approval', id);
      break;
    case 'ai_teammate_draft':
      add('approval', id);
      add('conversation', p['conversationId']);
      // Deciding a draft is someone reviewing the AI.
      add('teammate', p['teammateId']);
      break;
    case 'conversation':
      add('conversation', id);
      add('person', p['personId']);
      break;
    case 'message':
      add('conversation', p['conversationId']);
      add('person', p['personId']);
      break;
    case 'call': {
      add('conversation', p['conversationId']);
      add('person', p['personId']);
      if (isUuid(id)) {
        const [c] = await rows<{ conversation_id: string | null; person_id: string | null }>(
          tx,
          sql`select conversation_id, person_id from app.calls
              where workspace_id = ${workspaceId} and id = ${id}`,
        );
        add('conversation', c?.conversation_id);
        add('person', c?.person_id);
      }
      break;
    }
    case 'activity': {
      add('lead', p['leadId']);
      add('person', p['personId']);
      // Logged against a company: its open leads' last contact moved.
      if (isUuid(p['companyId'])) {
        const theirs = await rows<{ id: string }>(
          tx,
          sql`select id from app.leads
              where workspace_id = ${workspaceId} and company_id = ${p['companyId']}
                and status = 'open' and archived_at is null
              limit 200`,
        );
        for (const l of theirs) add('lead', l.id);
      }
      break;
    }
    case 'appointment': {
      // Every seat on the appointment (and on both ends of a seat that moved), and the seats the event names
      // (one that was removed is still an item to clear).
      const appointments = [id, p['fromAppointmentId'], p['toAppointmentId']].filter(isUuid);
      const named = [p['attendeeId'], p['fromAttendeeId'], p['toAttendeeId']].filter(isUuid);
      for (const a of named) add('attendee', a);
      const seats = await rows<{ id: string }>(
        tx,
        sql`select id from app.appointment_attendees
            where workspace_id = ${workspaceId}
              and (appointment_id = any(${uuidArray(appointments)}) or id = any(${uuidArray(named)}))`,
      );
      for (const s of seats) add('attendee', s.id);
      // The visit itself: whether it happened, and where (Automations' job cards).
      for (const a of appointments) add('appointment', a);
      // A booking of a service a card asks about settles that card (Automations' "Maintenance due").
      const cards = await rows<{ id: string }>(
        tx,
        sql`select r.id from app.maintenance_reminders r
            join app.appointment_attendees aa on aa.person_id = r.person_id
            join app.appointments a on a.id = aa.appointment_id and a.service_id = r.service_id
            where r.workspace_id = ${workspaceId} and r.status = 'card'
              and (a.id = any(${uuidArray(appointments)}) or aa.id = any(${uuidArray(named)}))`,
      );
      for (const c of cards) add('maintenance', c.id);
      break;
    }
    // A money document is its own subject; reconcile widens it to the lead and the customer behind it, so an
    // estimate that is answered lets that lead's own card come back in the same pass.
    case 'estimate':
      add('estimate', id);
      // Approving one raises the invoice that collects the money.
      add('invoice', p['invoiceId']);
      break;
    case 'invoice':
      add('invoice', id);
      add('estimate', p['estimateId']);
      break;
    case 'payment':
    case 'refund':
      add('invoice', p['invoiceId']);
      break;
    case 'thank_you':
      add('thank_you', id);
      break;
    case 'referral':
      add('referral', id);
      add('lead', p['leadId']);
      break;
    case 'maintenance_reminder':
      add('maintenance', id);
      break;
    case 'promise':
      add('promise', id);
      add('person', p['personId']);
      break;
    // Health and quality: each connection's card is stored under its own table's type.
    case 'payment_connection':
    case 'calendar_connection':
    case 'mailbox':
    case 'review_connection':
    case 'phone_number':
    case 'meta_account':
      add(event.entityType, id);
      break;
    case 'ai_teammate':
      add('teammate', id);
      break;
    case 'lesson':
      add('lesson', id);
      break;
    case 'knowledge_scan':
      add('scan', id);
      break;
    case 'offer':
      add('offer', id);
      break;
    case 'addon_alert':
      add('addon_alert', id);
      break;
    case 'registration':
      add('registration', id);
      // Sending again names the last row of the chain; the rest are in the payload.
      if (Array.isArray(p['registrationIds']))
        for (const r of p['registrationIds'].slice(0, 10)) add('registration', r);
      break;
    case 'knowledge_suggestion':
      add('suggestion', id);
      if (Array.isArray(p['suggestionIds']))
        for (const s of p['suggestionIds'].slice(0, 50)) add('suggestion', s);
      break;
    // Their address may be what a visit at their place was missing; reconcile widens a customer to their visits.
    case 'person':
      add('person', id);
      break;
    case 'attention_item':
      add(String(p['subjectType'] ?? ''), p['subjectId']);
      break;
  }
  return out;
}
