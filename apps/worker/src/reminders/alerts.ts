/**
 * Alerts (the owner, 25 Nov 2026: "tell me when Bob replies, a 1-star review comes in, or a big invoice gets paid"):
 * when what someone asked the Assistant to watch for happens, a push to them alone (`assistant_alert`).
 *
 * - **Only what they can see.** Each is read again as the person before it goes, so a private conversation, an
 *   invoice their role can't see or a business they've left tells them nothing.
 * - **Once, or every time.** One that tells once pauses after it has (`assistant_routine.record_alert`), and their
 *   Notifications list says so; they can turn it on again there.
 * - **What it watches:** a customer writing (`message.received`), a customer booking (`appointment.booked`), an
 *   invoice paid (`invoice.paid`), and a new review (read in by reviews/sync.ts, which calls `alertOnReview`).
 */
import {
  assistantRoutineRecordAlert,
  executeCommandIn,
  money,
  RoutineWatch,
  whenLabel,
  type RoutineWatchKind,
} from '@hfos/core/server';
import { asUser, rows, sql, type Db, type Tx } from '@hfos/db/client';
import type { EventHandler, EventRow } from '../handlers/types';
import { queuePush } from '../push/queue';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

interface Alert {
  id: string;
  userId: string;
  watch: RoutineWatch;
  once: boolean;
}

/**
 * The alerts in this business watching for this kind of thing, that are on. `doneBy`, the person who did it (an
 * invoice they marked paid, a visit they booked for the customer): they don't need telling about their own doing.
 */
async function alertsFor(
  tx: Tx,
  workspaceId: string,
  on: RoutineWatchKind,
  doneBy: string | null = null,
): Promise<Alert[]> {
  const found = await rows<{ id: string; user_id: string; watch: unknown; once: boolean }>(
    tx,
    sql`select id, user_id, watch, once from app.assistant_routines
        where workspace_id = ${workspaceId} and kind = 'alert' and paused_at is null
          and watch ->> 'on' = ${on}
        order by created_at, id`,
  );
  return found.flatMap((r) => {
    const watch = RoutineWatch.safeParse(r.watch);
    return watch.success && r.user_id !== doneBy
      ? [{ id: r.id, userId: r.user_id, watch: watch.data, once: r.once }]
      : [];
  });
}

/** Whether the person sees it: one look as them, under their own row security. */
async function sees(
  db: Db,
  userId: string,
  look: (tx: Tx) => Promise<unknown[]>,
): Promise<boolean> {
  try {
    return (await asUser(db, { sub: userId }, look)).length > 0;
  } catch {
    return false;
  }
}

interface Telling {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly path: string;
  readonly refs: Parameters<typeof queuePush>[2]['refs'];
}

/** Tells them, and notes it on the alert: one that tells once stops here. */
async function tell(tx: Tx, scope: TenantScope, alert: Alert, t: Telling): Promise<void> {
  await queuePush(tx, scope, {
    key: `alert:${alert.id}:${t.key}`,
    category: 'assistant_alert',
    userIds: [alert.userId],
    title: t.title,
    about: 'You asked',
    body: t.body,
    path: t.path,
    refs: t.refs,
    // Two alerts on one moment (a payment both of theirs watch for) show once. Ids hold 64 characters.
    collapseId: `alert-${t.key}`,
  });
  await executeCommandIn(
    tx,
    assistantRoutineRecordAlert,
    {
      workspaceId: scope.workspaceId,
      routineId: alert.id,
      firedAt: new Date().toISOString(),
      stop: alert.once,
    },
    systemActor(scope),
    workerMeta(),
  );
}

/** The person whose own doing the event is, when a person's. */
const doneBy = (e: EventRow): string | null => (e.actorType === 'human' ? e.actorId : null);

const nameOf = (first: string | null, last: string | null) =>
  `${first ?? ''} ${last ?? ''}`.trim() || 'A customer';

/** `message.received`: a customer someone watches wrote, on a conversation that person can see. */
export const onAlertReply: EventHandler = async (ctx) => {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const personId = str(p['personId']);
  const conversationId = str(p['conversationId']);
  if (!personId || !conversationId) return;
  const scope = tenantOf(ctx.scope);
  const alerts = (await alertsFor(ctx.tx, scope.workspaceId, 'reply')).filter(
    (a) => a.watch.on === 'reply' && a.watch.personId === personId,
  );
  if (!alerts.length) return;
  const [c] = await rows<{
    preview: string | null;
    first_name: string | null;
    last_name: string | null;
  }>(
    ctx.tx,
    sql`select c.last_preview as preview, p.first_name, p.last_name
        from app.conversations c join app.people p on p.id = ${personId}
        where c.id = ${conversationId} and c.workspace_id = ${scope.workspaceId}`,
  );
  if (!c) return;
  const name = nameOf(c.first_name, c.last_name);
  for (const alert of alerts) {
    const visible = await sees(ctx.db, alert.userId, (tx) =>
      rows(tx, sql`select 1 from app.conversations where id = ${conversationId}`),
    );
    if (!visible) continue;
    await tell(ctx.tx, scope, alert, {
      key: ctx.event.id,
      title: `${name} wrote`,
      body: c.preview?.trim() || 'Open the conversation to see it.',
      path: `/app/w/${scope.workspaceId}/inbox/${conversationId}`,
      refs: { conversationId, personId },
    });
  }
};

/** `appointment.booked`: a customer someone watches booked, on an appointment that person can see. */
export const onAlertBooking: EventHandler = async (ctx) => {
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  const scope = tenantOf(ctx.scope);
  const alerts = await alertsFor(ctx.tx, scope.workspaceId, 'booking', doneBy(ctx.event));
  if (!alerts.length) return;
  const people = await rows<{
    person_id: string;
    first_name: string | null;
    last_name: string | null;
    title: string;
    starts_at: Date;
    tz: string | null;
  }>(
    ctx.tx,
    sql`select aa.person_id, p.first_name, p.last_name, a.title, a.starts_at,
          coalesce(c.timezone, w.timezone) as tz
        from app.appointment_attendees aa
        join app.appointments a on a.id = aa.appointment_id
        join app.calendars c on c.id = a.calendar_id
        join app.workspaces w on w.id = a.workspace_id
        join app.people p on p.id = aa.person_id
        where aa.appointment_id = ${appointmentId} and a.workspace_id = ${scope.workspaceId}
          and aa.status <> 'cancelled'`,
  );
  for (const alert of alerts) {
    if (alert.watch.on !== 'booking') continue;
    const watched = alert.watch.personId;
    const who = people.find((x) => x.person_id === watched);
    if (!who) continue;
    const visible = await sees(ctx.db, alert.userId, (tx) =>
      rows(tx, sql`select 1 from app.appointments where id = ${appointmentId}`),
    );
    if (!visible) continue;
    await tell(ctx.tx, scope, alert, {
      key: ctx.event.id,
      title: `${nameOf(who.first_name, who.last_name)} booked`,
      body: `${who.title} · ${whenLabel(new Date(who.starts_at).getTime(), who.tz || 'UTC')}`,
      path: `/app/w/${scope.workspaceId}/calendar?appt=${appointmentId}`,
      refs: { appointmentId, personId: watched },
    });
  }
};

/** `invoice.paid`: an invoice of at least what someone said was paid in full, and they see the money. */
export const onAlertPayment: EventHandler = async (ctx) => {
  const invoiceId = ctx.event.entityId;
  if (!invoiceId) return;
  const scope = tenantOf(ctx.scope);
  const alerts = await alertsFor(ctx.tx, scope.workspaceId, 'payment', doneBy(ctx.event));
  if (!alerts.length) return;
  const [inv] = await rows<{
    number: string | null;
    total_cents: number;
    person_id: string;
    first_name: string | null;
    last_name: string | null;
  }>(
    ctx.tx,
    sql`select i.number, i.total_cents::float8 as total_cents, i.person_id, p.first_name, p.last_name
        from app.invoices i join app.people p on p.id = i.person_id
        where i.id = ${invoiceId} and i.workspace_id = ${scope.workspaceId}`,
  );
  if (!inv) return;
  const total = Number(inv.total_cents);
  for (const alert of alerts) {
    if (alert.watch.on !== 'payment' || total < alert.watch.atLeastCents) continue;
    const visible = await sees(ctx.db, alert.userId, (tx) =>
      rows(tx, sql`select 1 from app.invoices where id = ${invoiceId}`),
    );
    if (!visible) continue;
    await tell(ctx.tx, scope, alert, {
      key: ctx.event.id,
      title: `Paid · ${nameOf(inv.first_name, inv.last_name)}`,
      body: `${inv.number ?? 'An invoice'} · ${money(total)}`,
      path: `/app/w/${scope.workspaceId}/money/invoices/${invoiceId}`,
      refs: { invoiceId, personId: inv.person_id },
    });
  }
};

/** A review newly read in (reviews/sync.ts): someone asked to hear about one of this many stars or fewer. */
export async function alertOnReview(
  db: Db,
  tx: Tx,
  scope: TenantScope,
  review: {
    readonly id: string;
    readonly rating: number | null;
    readonly authorName: string | null;
    readonly body: string | null;
  },
): Promise<void> {
  if (review.rating === null) return;
  const alerts = await alertsFor(tx, scope.workspaceId, 'review');
  const rating = review.rating;
  for (const alert of alerts) {
    if (alert.watch.on !== 'review' || rating > alert.watch.atMost) continue;
    const visible = await sees(db, alert.userId, (t) =>
      rows(t, sql`select 1 from app.reviews where id = ${review.id}`),
    );
    if (!visible) continue;
    const body = review.body?.replace(/\s+/g, ' ').trim();
    await tell(tx, scope, alert, {
      key: review.id,
      title: `${rating}-star review${review.authorName ? ` from ${review.authorName}` : ''}`,
      body: body
        ? body.length > 160
          ? `${body.slice(0, 159)}…`
          : body
        : 'No words, just the stars.',
      path: `/app/w/${scope.workspaceId}/reviews`,
      refs: {},
    });
  }
}
