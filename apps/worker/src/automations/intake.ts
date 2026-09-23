/**
 * Automations' "Intake questions": right after a customer's first-ever booking, the business's intake form, by
 * text (else email), in the business's own words (`settings.automations.intake`).
 *
 * `appointment.booked` arms one job per booked customer two minutes on, so the booking confirmation lands first.
 * Only a booking the customer is told about arms one: their own online booking, or a staff booking where staff
 * chose to tell them. The job checks everything again when it runs, because two minutes is long enough for a
 * booking to be cancelled or the switch to go off:
 * - the switch is on and a form is chosen, and the form is live on the business's booking site;
 * - the booking is still on and still ahead;
 * - it's the customer's first: no other booking of theirs made before this one (a cancelled one doesn't count);
 * - they haven't already filled that form in.
 * A text waits out quiet hours; nothing goes to someone who said STOP or never agreed to texts (email instead).
 */
import {
  automationSettingsOf,
  intakeFormOf,
  renderIntakeMessage,
  scheduleJob,
  STOP_WORDING,
  workspaceMessaging,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { clientIdFor, quietEndAt, reachOf, sendEmail, sendText, wasSent } from '../booking/deliver';
import type { EventHandler } from '../handlers/types';
import { publicOrigin } from '../hosting/origin';
import type { JobHandler } from '../jobs';
import { tenantOf, workerMeta } from '../services';

export const INTAKE_JOB = 'automations.intake';
export const intakeJobKey = (attendeeId: string): string => `intake:${attendeeId}`;
/** After the booking confirmation, which goes at once. */
export const INTAKE_DELAY_MS = 2 * 60_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** appointment.booked: arm the intake form for each customer on it who is told about the booking. */
export const onBookedIntake: EventHandler = async (ctx) => {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const appointmentId = ctx.event.entityId;
  if (!appointmentId || p['notify'] === false) return;
  const scope = tenantOf(ctx.scope);
  const [ws] = await rows<{ settings: Record<string, unknown> | null }>(
    ctx.tx,
    sql`select settings from app.workspaces where id = ${scope.workspaceId}`,
  );
  // Off, or no form chosen yet: nothing to arm.
  if (!intakeFormOf(automationSettingsOf(ws?.settings))) return;
  const one = str(p['attendeeId']);
  const seats = await rows<{ id: string; source: string }>(
    ctx.tx,
    sql`select id, source::text as source from app.appointment_attendees
        where workspace_id = ${scope.workspaceId} and status = 'booked'
          and ${one ? sql`id = ${one}` : sql`appointment_id = ${appointmentId}`}`,
  );
  const runAt = new Date(ctx.event.createdAt.getTime() + INTAKE_DELAY_MS);
  for (const seat of seats) {
    // Told about the booking: they booked online, or staff chose to tell them.
    const told =
      seat.source === 'booking_page' || seat.source === 'ai_teammate' || p['notify'] === true;
    if (!told) continue;
    await scheduleJob(ctx.tx, {
      kind: INTAKE_JOB,
      dedupeKey: intakeJobKey(seat.id),
      runAt,
      payload: { attendeeId: seat.id },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    });
  }
};

interface Seat extends Record<string, unknown> {
  status: string;
  appointment_status: string;
  starts_at: Date;
  person_id: string;
  first_name: string | null;
  phone: string | null;
  email: string | null;
  sms_ok: boolean;
  sms_consent: 'unknown' | 'opted_in' | 'opted_out';
  earlier: boolean;
}

/** `automations.intake`: one customer's intake form, if it's still theirs to get. */
export const intakeJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const attendeeId = str((ctx.job.payload as Record<string, unknown>)['attendeeId']);
  if (!attendeeId) return;
  const now = ctx.now;
  const plan = await asWorker(ctx.db, scope, async (tx) => {
    const [ws] = await rows<{ name: string; settings: Record<string, unknown> | null }>(
      tx,
      sql`select name, settings from app.workspaces where id = ${scope.workspaceId}`,
    );
    const settings = automationSettingsOf(ws?.settings);
    const formId = intakeFormOf(settings);
    if (!ws || !formId) return null;
    const [seat] = await rows<Seat>(
      tx,
      sql`select aa.status::text as status, a.status::text as appointment_status, a.starts_at,
            aa.person_id, p.first_name,
            coalesce(aa.contact_phone_e164, p.phone_e164) as phone,
            coalesce(aa.contact_email, p.email::text) as email,
            aa.sms_ok, p.sms_consent::text as sms_consent,
            exists (select 1 from app.appointment_attendees o
              where o.workspace_id = aa.workspace_id and o.person_id = aa.person_id and o.id <> aa.id
                and o.status <> 'cancelled' and o.created_at < aa.created_at) as earlier
          from app.appointment_attendees aa
          join app.appointments a on a.id = aa.appointment_id
          join app.people p on p.id = aa.person_id
          where aa.workspace_id = ${scope.workspaceId} and aa.id = ${attendeeId}`,
    );
    if (!seat || seat.status !== 'booked' || seat.appointment_status !== 'scheduled') return null;
    if (new Date(seat.starts_at).getTime() <= now || seat.earlier) return null;
    const [form] = await rows<{ slug: string; site: string | null; status: string; done: boolean }>(
      tx,
      sql`select f.slug, bs.slug::text as site, f.status::text as status,
            exists (select 1 from app.form_responses r where r.form_id = f.id
              and r.person_id = ${seat.person_id} and r.status = 'completed') as done
          from app.forms f
          left join app.booking_sites bs on bs.workspace_id = f.workspace_id
          where f.id = ${formId} and f.workspace_id = ${scope.workspaceId}`,
    );
    // A form that isn't live anywhere has nothing to send; one they've filled in needn't go again.
    if (!form || form.status !== 'live' || !form.site || form.done) return null;
    const link = `${await publicOrigin(tx, scope.workspaceId, ctx.webUrl)}/f/${form.site}/${form.slug}`;
    const reach = await reachOf(
      tx,
      scope.workspaceId,
      {
        phone: seat.phone,
        email: seat.email,
        smsOk: seat.sms_ok,
        personConsent: seat.sms_consent,
      },
      { text: true, email: true },
    );
    const messaging = await workspaceMessaging(tx, scope.workspaceId);
    return {
      seat,
      reach,
      messaging,
      body: renderIntakeMessage(settings.intake.message, {
        firstName: seat.first_name,
        businessName: ws.name,
        link,
      }),
    };
  });
  if (!plan) return;
  const meta = workerMeta(null, ctx.job.id);
  const clientId = clientIdFor('intake', attendeeId);
  if (plan.reach.text === null && plan.seat.phone) {
    const end = quietEndAt(
      plan.messaging.settings.quietHours,
      plan.messaging.timezone || 'UTC',
      now,
    );
    if (end !== null) return { rescheduleAt: new Date(end + 60_000) };
    const text =
      plan.reach.firstText && !/\bSTOP\b/.test(plan.body)
        ? `${plan.body} ${STOP_WORDING}`
        : plan.body;
    const sent = await sendText(ctx, scope, plan.seat.phone, text, clientId, meta);
    if (wasSent(sent)) return;
  }
  if (plan.reach.email === null && plan.seat.email)
    await sendEmail(
      ctx,
      scope,
      plan.seat.email,
      { subject: 'A few questions before your visit', body: plan.body },
      clientIdFor('intake', attendeeId, 'email'),
      meta,
    );
};
