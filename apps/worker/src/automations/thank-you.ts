/**
 * Automations' "Thank-you after the job": two hours after a job is marked done, a short thank-you to each customer
 * who was there. The AI teammate writes it (a draft to approve while it is training). When it can't — there's
 * no AI teammate, it's off, or someone on the team has their conversation — a card on Home asks a person to
 * thank them instead (`job_not_thanked`). Chris's call: no review ask.
 *
 * It leaves alone a customer who doesn't need one: someone already wrote to them since the job was done, the
 * business has its own workflow that runs when a job is done on that calendar, or they can't be reached. Each
 * customer's outcome is one row of app.thank_yous, so nobody is thanked twice and the card knows to open.
 */
import { randomUUID } from 'node:crypto';
import {
  automationSettingsOf,
  loadTeammate,
  scheduleJob,
  workspaceMessaging,
  type TeammateChannel,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { quietEndAt, reachOf } from '../booking/deliver';
import { runtimeConfigOf } from '../ai-team/config';
import { QUIET_GRACE_MS, RECENT_CONTACT_MS } from '../ai-team/constants';
import { runFirstMessage } from '../ai-team/run';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { tenantOf, type TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';

export const THANK_YOU_JOB = 'automations.thank_you';
export const thankYouJobKey = (attendeeId: string): string => `thank_you:${attendeeId}`;
/** Long enough for the van to have left; soon enough that the job is still fresh in their mind. */
export const THANK_YOU_DELAY_MS = 2 * 3_600_000;
/** The run's `triggered_by`, which is also how the job finds the run it started. */
export const THANK_YOU_TRIGGER = 'automations.thank_you';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** appointment.completed: one thank-you job per customer who was there. */
export const onCompletedThankYou: EventHandler = async (ctx) => {
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  const scope = tenantOf(ctx.scope);
  const [ws] = await rows<{ settings: Record<string, unknown> | null }>(
    ctx.tx,
    sql`select settings from app.workspaces where id = ${scope.workspaceId}`,
  );
  if (!automationSettingsOf(ws?.settings).switches.thankYou) return;
  const seats = await rows<{ id: string }>(
    ctx.tx,
    sql`select id from app.appointment_attendees
        where workspace_id = ${scope.workspaceId} and appointment_id = ${appointmentId}
          and status = 'attended'`,
  );
  const doneAt = ctx.event.createdAt;
  for (const seat of seats)
    await scheduleJob(ctx.tx, {
      kind: THANK_YOU_JOB,
      dedupeKey: thankYouJobKey(seat.id),
      runAt: new Date(doneAt.getTime() + THANK_YOU_DELAY_MS),
      payload: { attendeeId: seat.id, doneAt: doneAt.toISOString() },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    });
};

type Outcome = 'sent' | 'drafted' | 'card' | 'skipped';

/** Writes the customer's outcome once, and tells the Action Center (a `card` opens one). */
async function recordOutcome(
  tx: Tx,
  scope: TenantScope,
  seat: Seat,
  doneAt: Date,
  outcome: Outcome,
  reason: string | null,
  causationId: string,
): Promise<void> {
  const [row] = await rows<{ id: string }>(
    tx,
    sql`insert into app.thank_yous
          (workspace_id, appointment_id, attendee_id, person_id, completed_at, outcome, reason)
        values (${scope.workspaceId}, ${seat.appointment_id}, ${seat.id}, ${seat.person_id},
          ${doneAt.toISOString()}::timestamptz, ${outcome}, ${reason})
        on conflict (attendee_id) do nothing
        returning id`,
  );
  if (!row) return;
  await recordSystemEvent(tx, {
    type: 'thank_you.recorded',
    action: 'automations.thank_you',
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    entityType: 'thank_you',
    entityId: row.id,
    payload: { personId: seat.person_id, outcome, _broadcast: false },
    after: { outcome, reason },
    correlationId: randomUUID(),
    causationId,
  });
}

interface Seat extends Record<string, unknown> {
  id: string;
  appointment_id: string;
  calendar_id: string;
  title: string;
  status: string;
  appointment_status: string;
  person_id: string;
  lead_id: string | null;
  first_name: string | null;
  phone: string | null;
  email: string | null;
  sms_ok: boolean;
  sms_consent: 'unknown' | 'opted_in' | 'opted_out';
  person_archived: boolean;
  recorded: boolean;
  messaged: boolean;
  workflow: boolean;
  someone_has: boolean;
  recent: boolean;
}

type Plan =
  | { readonly done: true }
  | { readonly wait: Date }
  | { readonly card: string; readonly seat: Seat }
  | {
      readonly seat: Seat;
      readonly channel: TeammateChannel;
      readonly stopWording: boolean;
    };

/** `automations.thank_you`: one customer's thank-you, or the card that asks a person for it. */
export const thankYouJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = ctx.job.payload as Record<string, unknown>;
  const attendeeId = str(p['attendeeId']);
  const doneAt = new Date(str(p['doneAt']) ?? ctx.job.createdAt);
  if (!attendeeId || Number.isNaN(doneAt.getTime())) return;
  const resuming = !!str(p['_runId']);
  const plan = await asWorker(ctx.db, scope, async (tx): Promise<Plan> => {
    const done = { done: true } as const;
    const [ws] = await rows<{ settings: Record<string, unknown> | null }>(
      tx,
      sql`select settings from app.workspaces where id = ${scope.workspaceId}`,
    );
    if (!automationSettingsOf(ws?.settings).switches.thankYou) return done;
    const since = doneAt.toISOString();
    const recentSince = new Date(Date.now() - RECENT_CONTACT_MS).toISOString();
    const [seat] = await rows<Seat>(
      tx,
      sql`select aa.id, aa.appointment_id, a.calendar_id, a.title, aa.status::text as status,
            a.status::text as appointment_status, aa.person_id, a.lead_id, p.first_name,
            coalesce(aa.contact_phone_e164, p.phone_e164) as phone,
            coalesce(aa.contact_email, p.email::text) as email,
            aa.sms_ok, p.sms_consent::text as sms_consent, p.archived_at is not null as person_archived,
            exists (select 1 from app.thank_yous t where t.attendee_id = aa.id) as recorded,
            -- Anybody wrote to them since the job was done (a draft of this very job aside).
            exists (select 1 from app.messages m join app.conversations c on c.id = m.conversation_id
              where c.workspace_id = aa.workspace_id and c.person_id = aa.person_id
                and m.direction = 'outbound' and m.occurred_at > ${since}::timestamptz) as messaged,
            -- The business's own "when a job is done" workflow for this calendar says it instead.
            exists (select 1 from app.workflows w
              where w.workspace_id = aa.workspace_id and w.status = 'active'
                and w.trigger_event = 'appointment.completed'
                and (w.all_calendars or a.calendar_id = any(w.calendar_ids))) as workflow,
            exists (select 1 from app.conversations c
              where c.workspace_id = aa.workspace_id and c.person_id = aa.person_id
                and (c.handled_by = 'person' or (c.handled_by = 'none' and c.assignee_user_id is not null)))
              as someone_has,
            exists (select 1 from app.conversations c
              where c.workspace_id = aa.workspace_id and c.person_id = aa.person_id and c.channel = 'sms'
                and c.last_inbound_at > ${recentSince}::timestamptz) as recent
          from app.appointment_attendees aa
          join app.appointments a on a.id = aa.appointment_id
          join app.people p on p.id = aa.person_id
          where aa.workspace_id = ${scope.workspaceId} and aa.id = ${attendeeId}`,
    );
    // Undone since (marked a no-show after all), or already decided.
    if (!seat || seat.status !== 'attended' || seat.appointment_status !== 'completed') return done;
    if (seat.recorded) return done;
    const skip = async (why: string) => {
      await recordOutcome(tx, scope, seat, doneAt, 'skipped', why, ctx.job.id);
      return done;
    };
    if (seat.person_archived) return skip('customer archived');
    if (seat.messaged && !resuming) return skip('someone already wrote to them');
    if (seat.workflow) return skip('a workflow thanks them');
    const teammate = await loadTeammate(tx, scope.workspaceId);
    const config = teammate ? runtimeConfigOf(teammate.config) : null;
    const reach = await reachOf(
      tx,
      scope.workspaceId,
      {
        phone: seat.phone,
        email: seat.email,
        smsOk: seat.sms_ok || seat.recent,
        personConsent: seat.sms_consent,
      },
      { text: config?.channels.sms ?? true, email: config?.channels.email ?? true },
    );
    const channel: TeammateChannel | null =
      reach.text === null ? 'sms' : reach.email === null ? 'email' : null;
    if (!channel) return skip('no way to reach them');
    if (!teammate || teammate.status === 'off')
      return {
        card: teammate ? 'Your AI teammate is off' : 'No AI teammate to thank them',
        seat,
      };
    if (seat.someone_has && !resuming)
      return { card: 'Someone on the team has their conversation', seat };
    if (channel === 'sms') {
      const m = await workspaceMessaging(tx, scope.workspaceId);
      const end = quietEndAt(m.settings.quietHours, m.timezone || 'UTC', Date.now());
      if (end !== null) return { wait: new Date(end + QUIET_GRACE_MS) };
    }
    return {
      seat,
      channel,
      stopWording: channel === 'sms' && reach.firstText,
    };
  });
  if ('done' in plan) return;
  if ('wait' in plan) return { rescheduleAt: plan.wait };
  if ('card' in plan) {
    await asWorker(ctx.db, scope, (tx) =>
      recordOutcome(tx, scope, plan.seat, doneAt, 'card', plan.card, ctx.job.id),
    );
    return;
  }
  const result = await runFirstMessage(
    ctx,
    scope,
    {
      personId: plan.seat.person_id,
      leadId: plan.seat.lead_id,
      channel: plan.channel,
      stopWording: plan.stopWording,
    },
    {
      kind: 'task',
      trigger: THANK_YOU_TRIGGER,
      origin: null,
      handover: null,
      task: { purpose: 'thank_you', visit: plan.seat.title, doneAt: doneAt.getTime() },
    },
  );
  // Waiting (another first message to them is running, or quiet hours came on): it runs again then.
  if (result) return result;
  // What its run did decides: a message or a draft, else a person is asked.
  await asWorker(ctx.db, scope, async (tx) => {
    const [run] = await rows<{ outcome: string | null; summary: string | null }>(
      tx,
      sql`select outcome, summary from app.ai_teammate_runs
          where workspace_id = ${scope.workspaceId} and person_id = ${plan.seat.person_id}
            and triggered_by = ${THANK_YOU_TRIGGER} and started_at >= ${doneAt.toISOString()}::timestamptz
          order by started_at desc limit 1`,
    );
    if (run?.outcome === 'replied')
      await recordOutcome(tx, scope, plan.seat, doneAt, 'sent', null, ctx.job.id);
    else if (run?.outcome === 'drafted')
      await recordOutcome(tx, scope, plan.seat, doneAt, 'drafted', null, ctx.job.id);
    else
      await recordOutcome(
        tx,
        scope,
        plan.seat,
        doneAt,
        'card',
        'Your AI teammate didn’t write one',
        ctx.job.id,
      );
  });
};
