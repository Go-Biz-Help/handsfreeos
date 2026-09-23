/**
 * Automations' "Maintenance due": once a day at 10 AM where the business is, a text to each customer whose
 * regular service comes round within two weeks (`settings.automations.maintenance`), in the business's words,
 * with a link that opens the booking page on that service. A second a week later; a week after that, a card on
 * Home asks a person to call them. Booking the service at any point ends it.
 *
 * Who's due comes from core's `maintenanceLines`: the last completed visit for the service plus how often
 * (their own schedule, their plan's, the service's). A customer already booked for it, one overdue by more
 * than a year, and anyone who can't be reached are left alone. Customers already overdue when a service is
 * first set to repeat go a few a day (`maxPerDay`), most overdue first.
 *
 * Each customer, service and due day is one row of app.maintenance_reminders: how many texts went and where
 * it stands, so nobody is asked twice about the same visit.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  automationSettingsOf,
  localDateOf,
  localInstant,
  maintenanceLines,
  renderMaintenance,
  STOP_WORDING,
  uuidArray,
  workspaceMessaging,
  type MaintenanceLine,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { BusinessPlanner } from '../attention/jobs';
import {
  clientIdFor,
  quietEndAt,
  reachOf,
  sendEmail,
  sendText,
  wasSent,
  type Sent,
} from '../booking/deliver';
import { publicOrigin } from '../hosting/origin';
import type { JobContext, JobHandler } from '../jobs';
import { tenantOf, workerMeta, type TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';

export const MAINTENANCE_JOB = 'automations.maintenance';
export const maintenanceJobKey = (workspaceId: string): string => `maintenance:${workspaceId}`;
/** When it goes, where the business is: mid-morning, well clear of quiet hours. */
export const MAINTENANCE_AT = '10:00';
/** Nobody overdue by more than this is reminded: a visit that long gone isn't "due" any more. */
export const MAINTENANCE_MAX_OVERDUE_DAYS = 365;
const DAY = 86_400_000;
const PLAN_CHUNK = 2000;

/** The next 10 AM where the business is, after `now`. */
export function nextMaintenanceAt(now: number, timeZone: string): number {
  const today = localDateOf(now, timeZone);
  const at = localInstant(today, MAINTENANCE_AT, timeZone);
  return at > now ? at : localInstant(addDays(today, 1), MAINTENANCE_AT, timeZone);
}

/** Every business has its daily maintenance job waiting (it does nothing while the switch is off). */
export const ensureMaintenance: BusinessPlanner = async (tx, businesses, now) => {
  for (let i = 0; i < businesses.length; i += PLAN_CHUNK) {
    const chunk = businesses.slice(i, i + PLAN_CHUNK);
    const keys = chunk.map((b) => sql`${maintenanceJobKey(b.workspaceId)}`);
    const times = chunk.map(
      (b) => sql`${new Date(nextMaintenanceAt(now, b.timeZone)).toISOString()}`,
    );
    await tx.execute(
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          select b.org, b.ws, ${MAINTENANCE_JOB}, b.key, b.at::timestamptz, '{}'::jsonb
          from unnest(${uuidArray(chunk.map((b) => b.workspaceId))},
            ${uuidArray(chunk.map((b) => b.organizationId))},
            array[${sql.join(keys, sql`, `)}]::text[],
            array[${sql.join(times, sql`, `)}]::text[]) as b(ws, org, key, at)
          on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
    );
  }
};

interface Open extends Record<string, unknown> {
  id: string;
  person_id: string;
  service_id: string;
  due_on: string;
  sent_count: number;
  first_sent_at: Date | null;
  second_sent_at: Date | null;
  status: 'reminding' | 'card';
  booked_id: string | null;
}

interface Contact extends Record<string, unknown> {
  id: string;
  first_name: string | null;
  phone_e164: string | null;
  email: string | null;
  sms_consent: 'unknown' | 'opted_in' | 'opted_out';
  sms_ok: boolean;
}

/** One reminder to send: a new one (no row yet) or the second (its row). */
interface Send {
  readonly line: MaintenanceLine;
  readonly rowId: string | null;
  readonly n: 1 | 2;
}

const pairKey = (personId: string, serviceId: string) => `${personId}|${serviceId}`;

/** A system event on a reminder, so the Action Center looks at its card again. */
async function tell(
  tx: Tx,
  scope: TenantScope,
  type: string,
  id: string,
  personId: string,
  causationId: string,
): Promise<void> {
  await recordSystemEvent(tx, {
    type,
    action: 'automations.maintenance',
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    entityType: 'maintenance_reminder',
    entityId: id,
    payload: { personId, _broadcast: false },
    after: { status: type.split('.')[1] },
    correlationId: randomUUID(),
    causationId,
  });
}

/** Where to book each service: a public calendar that offers it (else any public one), with it chosen. */
async function bookingLinks(
  tx: Tx,
  workspaceId: string,
  serviceIds: readonly string[],
  webUrl: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!serviceIds.length) return out;
  const cals = await rows<{ slug: string; site: string; service_id: string | null }>(
    tx,
    sql`select c.slug, bs.slug::text as site, cs.service_id
        from app.calendars c
        join app.booking_sites bs on bs.workspace_id = c.workspace_id and bs.enabled
        left join app.calendar_services cs on cs.calendar_id = c.id
          and cs.service_id = any(${uuidArray([...serviceIds])})
        where c.workspace_id = ${workspaceId} and c.status = 'active' and c.public
        order by cs.position nulls last, c.created_at`,
  );
  if (!cals.length) return out;
  const origin = await publicOrigin(tx, workspaceId, webUrl);
  const any = cals[0]!;
  for (const id of serviceIds) {
    const c = cals.find((x) => x.service_id === id);
    out.set(
      id,
      c
        ? `${origin}/book/${c.site}/${c.slug}?service=${id}`
        : `${origin}/book/${any.site}/${any.slug}`,
    );
  }
  return out;
}

/** `automations.maintenance`: one business's reminders for the day, then the next 10 AM. */
export const maintenanceJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const now = ctx.now;
  const plan = await asWorker(ctx.db, scope, async (tx) => {
    const [ws] = await rows<{
      name: string;
      timezone: string;
      settings: Record<string, unknown> | null;
    }>(
      tx,
      sql`select name, timezone, settings from app.workspaces where id = ${scope.workspaceId}`,
    );
    if (!ws) return null;
    const timeZone = ws.timezone || 'UTC';
    const s = automationSettingsOf(ws.settings);
    const next = new Date(nextMaintenanceAt(now, timeZone));
    if (!s.switches.maintenance) return { next, sends: [] as Send[], ws, settings: s, timeZone };
    const m = s.maintenance;
    const lines = await maintenanceLines(tx, scope.workspaceId, { timeZone, now });
    const byPair = new Map(lines.map((l) => [pairKey(l.personId, l.serviceId), l]));

    // What's still going: booked since (it ends), a schedule that moved (it stops), the next step due.
    const open = await rows<Open>(
      tx,
      sql`select r.id, r.person_id, r.service_id, r.due_on::text as due_on, r.sent_count, r.first_sent_at,
            r.second_sent_at, r.status,
            (select a.id from app.appointment_attendees aa join app.appointments a on a.id = aa.appointment_id
              where aa.person_id = r.person_id and a.service_id = r.service_id
                and aa.status in ('booked', 'attended') and a.status in ('scheduled', 'completed')
                and a.id is distinct from r.last_visit_id
                and a.starts_at > coalesce((select lv.starts_at from app.appointments lv
                  where lv.id = r.last_visit_id), r.created_at)
              order by aa.created_at limit 1) as booked_id
          from app.maintenance_reminders r
          where r.workspace_id = ${scope.workspaceId} and r.status in ('reminding', 'card')`,
    );
    const sends: Send[] = [];
    const cutoff = now - m.secondAfterDays * DAY;
    for (const r of open) {
      const line = byPair.get(pairKey(r.person_id, r.service_id));
      if (r.booked_id) {
        await tx.execute(
          sql`update app.maintenance_reminders set status = 'booked', booked_appointment_id = ${r.booked_id}
              where id = ${r.id}`,
        );
        if (r.status === 'card')
          await tell(tx, scope, 'maintenance.booked', r.id, r.person_id, ctx.job.id);
        continue;
      }
      if (r.status === 'card') continue;
      if (!line || line.dueOn !== r.due_on) {
        await tx.execute(
          sql`update app.maintenance_reminders set status = 'stopped', reason = 'The schedule changed'
              where id = ${r.id}`,
        );
        continue;
      }
      if (r.sent_count === 1 && r.first_sent_at && new Date(r.first_sent_at).getTime() <= cutoff)
        sends.push({ line, rowId: r.id, n: 2 });
      else if (
        r.sent_count === 2 &&
        r.second_sent_at &&
        new Date(r.second_sent_at).getTime() <= cutoff
      ) {
        await tx.execute(
          sql`update app.maintenance_reminders set status = 'card', card_at = ${new Date(now).toISOString()}::timestamptz
              where id = ${r.id}`,
        );
        await tell(tx, scope, 'maintenance.card', r.id, r.person_id, ctx.job.id);
      }
    }

    // New ones: due within the lead days (and not too long overdue), not booked, never asked about this visit.
    const today = localDateOf(now, timeZone);
    const until = addDays(today, m.leadDays);
    const oldest = addDays(today, -MAINTENANCE_MAX_OVERDUE_DAYS);
    const going = new Set(open.map((r) => pairKey(r.person_id, r.service_id)));
    const asked = new Set(
      (
        await rows<{ person_id: string; service_id: string; due_on: string }>(
          tx,
          sql`select person_id, service_id, due_on::text as due_on from app.maintenance_reminders
              where workspace_id = ${scope.workspaceId}`,
        )
      ).map((r) => `${pairKey(r.person_id, r.service_id)}|${r.due_on}`),
    );
    const [today1] = await rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from app.maintenance_reminders
          where workspace_id = ${scope.workspaceId}
            and first_sent_at > ${new Date(now - DAY).toISOString()}::timestamptz`,
    );
    const room = Math.max(0, m.maxPerDay - (today1?.n ?? 0));
    const fresh = lines
      .filter(
        (l) =>
          l.dueOn !== null &&
          l.lastVisitId !== null &&
          !l.bookedAhead &&
          l.dueOn <= until &&
          l.dueOn >= oldest &&
          !going.has(pairKey(l.personId, l.serviceId)) &&
          !asked.has(`${pairKey(l.personId, l.serviceId)}|${l.dueOn}`),
      )
      .sort((a, b) => (a.dueOn! < b.dueOn! ? -1 : a.dueOn! > b.dueOn! ? 1 : 0))
      .slice(0, room);
    for (const line of fresh) sends.push({ line, rowId: null, n: 1 });
    return { next, sends, ws, settings: s, timeZone };
  });
  if (!plan) return;
  const done = { rescheduleAt: plan.next };
  if (!plan.sends.length) return done;

  const messaging = await asWorker(ctx.db, scope, (tx) =>
    workspaceMessaging(tx, scope.workspaceId),
  );
  const end = quietEndAt(messaging.settings.quietHours, messaging.timezone || 'UTC', now);
  // Quiet hours at 10 AM means a business with unusual hours: try again when they end.
  if (end !== null) return { rescheduleAt: new Date(end + 15 * 60_000) };

  const { contacts, links } = await asWorker(ctx.db, scope, async (tx) => {
    const personIds = [...new Set(plan.sends.map((x) => x.line.personId))];
    const list = await rows<Contact>(
      tx,
      sql`select p.id, p.first_name, p.phone_e164, p.email::text as email, p.sms_consent::text as sms_consent,
            coalesce((select aa.sms_ok from app.appointment_attendees aa where aa.person_id = p.id
              order by aa.created_at desc limit 1), false) as sms_ok
          from app.people p where p.id = any(${uuidArray(personIds)})`,
    );
    return {
      contacts: new Map(list.map((c) => [c.id, c])),
      links: await bookingLinks(
        tx,
        scope.workspaceId,
        [...new Set(plan.sends.map((x) => x.line.serviceId))],
        ctx.webUrl,
      ),
    };
  });
  for (const send of plan.sends) await remind(ctx, scope, plan, send, contacts, links);
  return done;
};

async function remind(
  ctx: JobContext,
  scope: TenantScope,
  plan: {
    readonly ws: { readonly name: string };
    readonly settings: ReturnType<typeof automationSettingsOf>;
  },
  send: Send,
  contacts: ReadonlyMap<string, Contact>,
  links: ReadonlyMap<string, string>,
): Promise<void> {
  const { line } = send;
  const c = contacts.get(line.personId);
  const link = links.get(line.serviceId);
  const stop = (reason: string) =>
    asWorker(ctx.db, scope, (tx) =>
      send.rowId
        ? tx.execute(
            sql`update app.maintenance_reminders set status = 'stopped', reason = ${reason}
                where id = ${send.rowId}`,
          )
        : tx.execute(
            sql`insert into app.maintenance_reminders (workspace_id, person_id, service_id, due_on,
                  last_visit_id, subscription_id, status, reason)
                values (${scope.workspaceId}, ${line.personId}, ${line.serviceId}, ${line.dueOn}::date,
                  ${line.lastVisitId}, ${line.plan?.subscriptionId ?? null}, 'stopped', ${reason})
                on conflict (person_id, service_id, due_on) do nothing`,
          ),
    );
  if (!c) return;
  if (!link) {
    await stop('No booking page to send them to');
    return;
  }
  const reach = await asWorker(ctx.db, scope, (tx) =>
    reachOf(
      tx,
      scope.workspaceId,
      { phone: c.phone_e164, email: c.email, smsOk: c.sms_ok, personConsent: c.sms_consent },
      { text: true, email: true },
    ),
  );
  const m = plan.settings.maintenance;
  const body = renderMaintenance(line.plan ? m.planTemplate : m.template, {
    firstName: c.first_name,
    businessName: plan.ws.name,
    service: line.serviceName,
    link,
    plan: line.plan?.name ?? null,
  });
  const meta = workerMeta(null, ctx.job.id);
  const clientId = clientIdFor('maintenance', line.personId, line.serviceId, line.dueOn!, send.n);
  let sent: Sent | null = null;
  if (reach.text === null && c.phone_e164) {
    const text = reach.firstText && !/\bSTOP\b/.test(body) ? `${body} ${STOP_WORDING}` : body;
    sent = await sendText(ctx, scope, c.phone_e164, text, clientId, meta);
  }
  if ((!sent || !wasSent(sent)) && reach.email === null && c.email)
    sent = await sendEmail(
      ctx,
      scope,
      c.email,
      { subject: `Time for your ${line.serviceName}`, body },
      `${clientId}-email`,
      meta,
    );
  if (!sent || !wasSent(sent)) {
    await stop('No way to reach them');
    return;
  }
  await asWorker(ctx.db, scope, (tx) =>
    send.rowId
      ? tx.execute(
          sql`update app.maintenance_reminders set sent_count = 2, second_sent_at = now()
              where id = ${send.rowId}`,
        )
      : tx.execute(
          sql`insert into app.maintenance_reminders (workspace_id, person_id, service_id, due_on,
                last_visit_id, subscription_id, sent_count, first_sent_at)
              values (${scope.workspaceId}, ${line.personId}, ${line.serviceId}, ${line.dueOn}::date,
                ${line.lastVisitId}, ${line.plan?.subscriptionId ?? null}, 1, now())
              on conflict (person_id, service_id, due_on) do nothing`,
        ),
  );
}
