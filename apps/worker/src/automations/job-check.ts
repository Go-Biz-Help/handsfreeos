/**
 * Automations' "Did the job happen?": half an hour after a visit ends, whoever was on it gets a push, "How did it
 * go?", with Done, Didn't happen and Still there. Still there asks again an hour later. Nobody answered: one more
 * push that evening. Still nothing by the next morning: a card on Home and a line in the owner's morning email
 * (`job_unconfirmed`, from the Action Center).
 *
 * Every run reads the visit again, so a visit marked, cancelled or moved in the meantime stops it or moves it.
 * Only bookings with a customer on them are checked, never classes.
 */
import { automationSettingsOf, localDateOf, localInstant, scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { standIns } from '../booking/team-email';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { queuePush } from '../push/queue';
import { tenantOf, type TenantScope } from '../services';

export const JOB_CHECK_JOB = 'automations.job_check';
export const jobCheckJobKey = (appointmentId: string, round: 1 | 2): string =>
  round === 1 ? `job-check:${appointmentId}` : `job-check-evening:${appointmentId}`;
/** After the visit's end: a little slack for jobs that run over. */
export const JOB_CHECK_DELAY_MS = 30 * 60_000;
/** "Still there": ask again this much later. */
export const JOB_CHECK_AGAIN_MS = 60 * 60_000;
/** The evening push, where the business is; never before two hours after the first, never after the latest. */
export const JOB_CHECK_EVENING = '19:00';
export const JOB_CHECK_LATEST = '21:00';
const EVENING_GAP_MS = 2 * 60 * 60_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

async function jobCheckOn(tx: Tx, workspaceId: string): Promise<boolean> {
  const [ws] = await rows<{ settings: Record<string, unknown> | null }>(
    tx,
    sql`select settings from app.workspaces where id = ${workspaceId}`,
  );
  return automationSettingsOf(ws?.settings).switches.jobCheck;
}

async function arm(
  tx: Tx,
  scope: TenantScope,
  appointmentId: string,
  round: 1 | 2,
  runAt: Date,
): Promise<void> {
  await scheduleJob(
    tx,
    {
      kind: JOB_CHECK_JOB,
      dedupeKey: jobCheckJobKey(appointmentId, round),
      runAt,
      payload: { appointmentId, round },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
}

/** A visit booked or moved: the first push half an hour after it ends (the job reads the time again when it runs). */
export const onArmJobCheck: EventHandler = async (ctx) => {
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  const scope = tenantOf(ctx.scope);
  if (!(await jobCheckOn(ctx.tx, scope.workspaceId))) return;
  const [a] = await rows<{ ends_at: Date; status: string; kind: string }>(
    ctx.tx,
    sql`select ends_at, status::text as status, kind::text as kind from app.appointments
        where id = ${appointmentId} and workspace_id = ${scope.workspaceId}`,
  );
  if (!a || a.status !== 'scheduled' || a.kind !== 'booking') return;
  await arm(
    ctx.tx,
    scope,
    appointmentId,
    1,
    new Date(new Date(a.ends_at).getTime() + JOB_CHECK_DELAY_MS),
  );
};

/** "Still there": ask again in an hour. */
export const onStillGoing: EventHandler = async (ctx) => {
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  await arm(
    ctx.tx,
    tenantOf(ctx.scope),
    appointmentId,
    1,
    new Date(ctx.event.createdAt.getTime() + JOB_CHECK_AGAIN_MS),
  );
};

interface Visit extends Record<string, unknown> {
  status: string;
  kind: string;
  title: string;
  ends_at: Date;
  owner_user_id: string | null;
  tz: string | null;
  person_id: string | null;
  customer: string | null;
  staff: string[] | null;
}

/** When the evening push goes for a first push at `firstAt`, or null when that would be too late in the day. */
export function eveningAfter(firstAt: number, timeZone: string): number | null {
  const day = localDateOf(firstAt, timeZone);
  const at = Math.max(localInstant(day, JOB_CHECK_EVENING, timeZone), firstAt + EVENING_GAP_MS);
  return at <= localInstant(day, JOB_CHECK_LATEST, timeZone) ? at : null;
}

export const jobCheckJob: JobHandler = async (ctx) => {
  const p = (ctx.job.payload ?? {}) as Record<string, unknown>;
  const appointmentId = str(p['appointmentId']);
  const round = p['round'] === 2 ? 2 : 1;
  if (!appointmentId) return;
  const scope = tenantOf(ctx.scope);
  return asWorker(ctx.db, scope, async (tx) => {
    if (!(await jobCheckOn(tx, scope.workspaceId))) return;
    const [v] = await rows<Visit>(
      tx,
      sql`select a.status::text as status, a.kind::text as kind, a.title, a.ends_at, a.owner_user_id,
            coalesce(c.timezone, w.timezone) as tz,
            first.person_id, first.customer,
            array(select s.user_id from app.appointment_staff s where s.appointment_id = a.id
              order by (s.role = 'host') desc, s.created_at, s.user_id) as staff
          from app.appointments a
          join app.calendars c on c.id = a.calendar_id
          join app.workspaces w on w.id = a.workspace_id
          left join lateral (
            select aa.person_id, btrim(coalesce(pp.first_name, '') || ' ' || coalesce(pp.last_name, '')) as customer
            from app.appointment_attendees aa join app.people pp on pp.id = aa.person_id
            where aa.appointment_id = a.id and aa.status <> 'cancelled'
            order by aa.created_at limit 1
          ) first on true
          where a.id = ${appointmentId} and a.workspace_id = ${scope.workspaceId}`,
    );
    if (!v || v.status !== 'scheduled' || v.kind !== 'booking' || !v.person_id) return;
    const due = new Date(v.ends_at).getTime() + JOB_CHECK_DELAY_MS;
    // Moved later since it was armed: wait for the new time.
    if (round === 1 && ctx.now < due - 60_000) return { rescheduleAt: new Date(due) };
    const staff = v.staff ?? [];
    const userIds = staff.length ? staff : await standIns(tx, scope, v.owner_user_id);
    const tz = v.tz || 'UTC';
    const customer = v.customer?.trim() || 'your customer';
    await queuePush(tx, scope, {
      key: `${jobCheckJobKey(appointmentId, round)}:${ctx.job.id}`,
      category: 'job_check',
      userIds,
      title: round === 1 ? 'How did it go?' : 'Still not marked: how did it go?',
      about: v.title,
      body: `${v.title} with ${customer}. Mark it done so the invoice and thank-you can follow.`,
      path: `/app/w/${scope.workspaceId}/calendar?appt=${appointmentId}`,
      refs: { appointmentId, personId: v.person_id },
      collapseId: `job-check-${appointmentId}`,
    });
    if (round === 1) {
      const evening = eveningAfter(ctx.now, tz);
      if (evening !== null) await arm(tx, scope, appointmentId, 2, new Date(evening));
    }
  });
};
