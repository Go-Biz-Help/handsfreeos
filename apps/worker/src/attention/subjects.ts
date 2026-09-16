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
 * `conversation.linked`, because a conversation that finds its customer folds into their lead card; the seat's
 * `attendee.reminder_recorded` (a confirmation asked for); and a person's `attention.restored` and
 * `attention.unsnoozed`, so an item brought back whose facts are gone clears at once.
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
  // Messages, calls and logged activity: a customer waiting, a first response, a contact.
  'message.received',
  'message.sent',
  'message.queued',
  'call.started',
  'call.received',
  'call.completed',
  'call.missed',
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
  'attendee.added',
  'attendee.removed',
  'attendee.rescheduled',
  'attendee.cancelled',
  'attendee.confirmed',
  'attendee.confirmation_removed',
  'attendee.reminder_recorded',
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
    case 'attention_item':
      add(String(p['subjectType'] ?? ''), p['subjectId']);
      break;
  }
  return out;
}
