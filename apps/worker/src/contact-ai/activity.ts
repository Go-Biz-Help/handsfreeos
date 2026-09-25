/**
 * Settings → Automations' "Tag customers for you" and "Keep contact details up to date" (0107): when something
 * happens with a customer — a message either way, a call's transcript, a visit booked, done or cancelled, a deal
 * opened, won or lost, a quote answered, a bill paid, a plan started, a form filled in, a new customer — the AI takes
 * a look at them a few minutes later, once things have settled (one job per customer, pushed back by each new event),
 * and at most every half hour per customer.
 *
 * Its own changes (`_contactAi` on the event) never bring on another look, and neither do the things that come by
 * the thousand: each row of a spreadsheet import, and reminders, campaigns and other automatic texts. Those are a
 * pass over the list's job, started by a person.
 */
import { automationSettingsOf } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { AiAskError } from '../ai/ask';
import { handlersFor, type EventHandler, type EventRow, type HandlerMap } from '../handlers/types';
import { scheduleDebouncedJob, type JobHandler } from '../jobs';
import { tenantOf } from '../services';
import { reviewPerson } from './review';

export const CONTACT_AI_REVIEW_JOB = 'contact_ai.review';
export const contactAiReviewKey = (personId: string): string => `contact_ai:${personId}`;
/** How long after the last thing that happened it looks, so a burst of messages is one look. */
export const CONTACT_AI_SETTLE_MS = 3 * 60_000;
/** The least time between two looks at one customer on its own. */
export const CONTACT_AI_COOLDOWN_MS = 30 * 60_000;

/** The events that bring on a look. */
export const CONTACT_AI_EVENTS: readonly string[] = [
  'person.created',
  'message.received',
  'message.queued',
  'call.transcribed',
  'call.completed',
  'appointment.booked',
  'appointment.completed',
  'appointment.cancelled',
  'attendee.added',
  'lead.created',
  'lead.stage_changed',
  'lead.won',
  'lead.lost',
  'estimate.accepted',
  'estimate.declined',
  'invoice.paid',
  'subscription.started',
  'form.submitted',
  'job.status_changed',
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** The customers an event is about. */
export async function peopleOf(tx: Tx, workspaceId: string, e: EventRow): Promise<string[]> {
  const p = isRecord(e.payload) ? e.payload : {};
  const out = new Set<string>();
  if (isUuid(p['personId'])) out.add(p['personId']);
  const id = isUuid(e.entityId) ? e.entityId : null;
  if (id) {
    const found = await rows<{ person_id: string | null }>(
      tx,
      e.entityType === 'person'
        ? sql`select id as person_id from app.people where workspace_id = ${workspaceId} and id = ${id}`
        : e.entityType === 'lead'
          ? sql`select person_id from app.leads where workspace_id = ${workspaceId} and id = ${id}`
          : e.entityType === 'message'
            ? sql`select c.person_id from app.messages m join app.conversations c on c.id = m.conversation_id
                  where m.workspace_id = ${workspaceId} and m.id = ${id}`
            : e.entityType === 'call'
              ? sql`select person_id from app.calls where workspace_id = ${workspaceId} and id = ${id}`
              : e.entityType === 'appointment'
                ? sql`select person_id from app.appointment_attendees
                      where workspace_id = ${workspaceId} and appointment_id = ${id} limit 20`
                : e.entityType === 'invoice'
                  ? sql`select person_id from app.invoices where workspace_id = ${workspaceId} and id = ${id}`
                  : e.entityType === 'estimate'
                    ? sql`select person_id from app.estimates where workspace_id = ${workspaceId} and id = ${id}`
                    : e.entityType === 'subscription'
                      ? sql`select person_id from app.subscriptions
                            where workspace_id = ${workspaceId} and id = ${id}`
                      : sql`select null::uuid as person_id where false`,
    );
    for (const r of found) if (r.person_id) out.add(r.person_id);
  }
  return [...out];
}

/** Something happened with a customer: a look at them once things settle, if either switch is on. */
export const onContactActivity: EventHandler = async (ctx) => {
  const p = isRecord(ctx.event.payload) ? ctx.event.payload : {};
  if (p['_contactAi']) return;
  if (!ctx.ai.provider) return;
  // Someone a person typed in; never each row of a spreadsheet import, or a customer HandsFreeOS filed itself
  // (their message or booking brings the look).
  if (ctx.event.eventType === 'person.created' && ctx.event.actorType !== 'human') return;
  const scope = tenantOf(ctx.scope);
  // What someone on the team wrote; never a reminder, a campaign's text or another automatic message.
  if (ctx.event.eventType === 'message.queued') {
    const [m] = await rows<{ by_person: boolean }>(
      ctx.tx,
      sql`select sent_by is not null as by_person from app.messages
          where workspace_id = ${scope.workspaceId} and id = ${ctx.event.entityId}`,
    );
    if (!m?.by_person) return;
  }
  const [ws] = await rows<{ settings: Record<string, unknown> | null }>(
    ctx.tx,
    sql`select settings from app.workspaces where id = ${scope.workspaceId}`,
  );
  const { switches } = automationSettingsOf(ws?.settings);
  if (!switches.aiTags && !switches.aiDetails) return;
  for (const personId of await peopleOf(ctx.tx, scope.workspaceId, ctx.event))
    await scheduleDebouncedJob(ctx.tx, {
      kind: CONTACT_AI_REVIEW_JOB,
      dedupeKey: contactAiReviewKey(personId),
      runAt: new Date(Date.now() + CONTACT_AI_SETTLE_MS),
      payload: { personId, eventId: ctx.event.id },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
      mergePayload: true,
    });
};

/** Appends the look to every event that brings one on, after the event's own handlers. */
export function withContactAi(handlers: HandlerMap): HandlerMap {
  const out: Record<string, EventHandler | readonly EventHandler[]> = { ...handlers };
  for (const type of CONTACT_AI_EVENTS)
    out[type] = [...handlersFor(handlers, type), onContactActivity];
  return out;
}

/** `contact_ai.review`: the look, with the switches as they are now. */
export const contactAiReviewJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = isRecord(ctx.job.payload) ? ctx.job.payload : {};
  const personId = isUuid(p['personId']) ? p['personId'] : null;
  if (!personId || !ctx.ai.provider) return;
  const state = await asWorker(ctx.db, scope, async (tx) => {
    const [ws] = await rows<{ settings: Record<string, unknown> | null }>(
      tx,
      sql`select settings from app.workspaces where id = ${scope.workspaceId}`,
    );
    const [last] = await rows<{ at: Date }>(
      tx,
      sql`select created_at as at from app.contact_ai_reviews
          where workspace_id = ${scope.workspaceId} and person_id = ${personId}
            and trigger = 'activity' and outcome in ('changed', 'unchanged')
          order by created_at desc limit 1`,
    );
    return { switches: automationSettingsOf(ws?.settings).switches, last: last?.at ?? null };
  });
  if (!state.switches.aiTags && !state.switches.aiDetails) return;
  const next = state.last ? new Date(state.last).getTime() + CONTACT_AI_COOLDOWN_MS : 0;
  if (next > ctx.now) return { rescheduleAt: new Date(next) };
  try {
    await reviewPerson(ctx, scope, personId, {
      trigger: 'activity',
      sweepId: null,
      causeEventId: isUuid(p['eventId']) ? p['eventId'] : null,
      tags: state.switches.aiTags,
      tagIds: null,
      details: state.switches.aiDetails,
      instructions: '',
    });
  } catch (e) {
    // A provider that may answer later is tried again; no AI, today's limit or the balance just skip this one.
    if (e instanceof AiAskError && !e.retryable) {
      ctx.log.info({ code: e.code, personId }, 'no AI look at a customer’s tags');
      return;
    }
    throw e;
  }
};
