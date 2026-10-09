/**
 * Keeping people's calendars in step. `calendar.refresh` runs per connection (every 10 minutes by default): it
 * keeps the sign-in fresh, reads the next 60 days of busy times (times only), takes HandsFreeOS's own events
 * back out, and brings the stored blocks in line in one transaction (writing only what changed); then it
 * queues a fix for any appointment the calendar shows wrongly. `appointment.calendar_sync` runs per appointment: it writes the appointment into each
 * assigned person's calendar, moves it, or takes it out. Both re-read everything when they run, so a retry, a
 * late run or a run twice is always safe.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  calendarConnectionFail,
  executeCommand,
  intervals,
  parseConfig,
  type Interval,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import {
  appointmentCalendarEvents,
  appointments,
  appointmentStaff,
  calendarBusyBlocks,
  calendarConnections,
  calendars,
  workspaces,
} from '@hfos/db/schema';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import {
  CALENDAR_NAME,
  CalendarAuthError,
  CalendarError,
  type CalendarEvent,
  type CalendarProvider,
  type TokenSet,
} from './provider';

export type CalendarConnection = typeof calendarConnections.$inferSelect;
type Appointment = typeof appointments.$inferSelect;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Busy times are read this far ahead (the booking window's default horizon). */
export const HORIZON_MS = 60 * DAY;
const REFRESH_AHEAD_MS = 5 * 60_000;
/** Failed refreshes in a row before the connection shows "Not syncing" (it keeps trying). */
const FAILURES_BEFORE_ERROR = 5;
const MAX_WAIT_MS = 60 * 60_000;
const MAX_BLOCKS = 5_000;
const INSERT_CHUNK = 500;
/** How many appointments one refresh asks the write-through to fix. */
const RECONCILE_LIMIT = 200;
/** Signed in and in use (maybe failing lately); not waiting on a reconnect. */
const USABLE = ['active', 'error'] as const;
const usable = (c: CalendarConnection) =>
  (c.status === 'active' || c.status === 'error') && !!c.tokenEnc;

/** Brings a connection's next refresh forward (a new connection, Sync now, an event just written). */
export async function scheduleRefresh(
  tx: Tx,
  scope: TenantScope,
  connectionId: string,
  at = new Date(),
): Promise<void> {
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${scope.organizationId}, ${scope.workspaceId}, 'calendar.refresh', ${`calendar.refresh:${connectionId}`},
          ${at.toISOString()}::timestamptz, ${JSON.stringify({ connectionId })}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
        do update set run_at = least(app.scheduled_jobs.run_at, excluded.run_at)`,
  );
}

/**
 * Asks for an appointment's events to be written, moved or taken out of people's calendars. Only queued when
 * someone on it has a connected calendar or an event was written before, so workspaces without connections
 * never run the job.
 */
export async function queueCalendarSync(
  tx: Tx,
  scope: TenantScope,
  appointmentId: string,
): Promise<void> {
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        select ${scope.organizationId}, ${scope.workspaceId}, 'appointment.calendar_sync',
          ${`appointment.calendar_sync:${appointmentId}`}, now(), ${JSON.stringify({ appointmentId })}::jsonb
        where exists (select 1 from app.appointment_staff s
                join app.calendar_connections c on c.workspace_id = s.workspace_id and c.user_id = s.user_id
                  and c.status in ('active', 'reauth_required', 'error')
                where s.appointment_id = ${appointmentId}::uuid)
           or exists (select 1 from app.appointment_calendar_events e
                where e.appointment_id = ${appointmentId}::uuid and e.provider_event_id is not null)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
        do update set run_at = least(app.scheduled_jobs.run_at, excluded.run_at)`,
  );
}

const openTokens = (s: WorkerServices, sealed: string): TokenSet =>
  JSON.parse(s.sealer.open(sealed)) as TokenSet;

/**
 * Calls the provider with a working token: renewed ahead of expiry (and sealed again), and once more when the
 * provider says it stopped working early.
 */
function session(
  s: WorkerServices,
  scope: TenantScope,
  c: CalendarConnection,
  provider: CalendarProvider,
) {
  let tokens: TokenSet | null = null;
  const fresh = async (force: boolean): Promise<TokenSet> => {
    if (!c.tokenEnc) throw new CalendarAuthError('The calendar has no sign-in.', 'missing');
    const current = tokens ?? openTokens(s, c.tokenEnc);
    if (!force && Date.parse(current.expiresAt) - Date.now() > REFRESH_AHEAD_MS)
      return (tokens = current);
    const next = await provider.refresh(current);
    // Only while it's still connected: a disconnect in the meantime cleared the tokens, and they stay cleared.
    await asWorker(s.db, scope, (tx) =>
      tx
        .update(calendarConnections)
        .set({
          tokenEnc: s.sealer.seal(JSON.stringify(next)),
          tokenKeyId: s.sealer.keyId,
          tokenExpiresAt: new Date(next.expiresAt),
        })
        .where(
          and(eq(calendarConnections.id, c.id), inArray(calendarConnections.status, [...USABLE])),
        ),
    );
    return (tokens = next);
  };
  return async <T>(fn: (accessToken: string) => Promise<T>): Promise<T> => {
    const t = await fresh(false);
    try {
      return await fn(t.accessToken);
    } catch (e) {
      if (!(e instanceof CalendarError && e.status === 401)) throw e;
      return fn((await fresh(true)).accessToken);
    }
  };
}

/** Marks the connection as needing a reconnect, or as not syncing; the command tells nobody twice. */
async function failConnection(
  s: WorkerServices,
  scope: TenantScope,
  c: CalendarConnection,
  reason: 'reauth_required' | 'error',
  message: string,
): Promise<void> {
  await executeCommand(
    s.db,
    calendarConnectionFail,
    {
      workspaceId: scope.workspaceId,
      connectionId: c.id,
      reason,
      message: message.slice(0, 2000),
    },
    systemActor(scope),
    workerMeta(),
  );
}

const lostAccess = (c: CalendarConnection) =>
  `${CALENDAR_NAME[c.provider]} stopped accepting HandsFreeOS’s sign-in for ${c.accountEmail ?? 'this calendar'}.`;

/** When HandsFreeOS's own events in this calendar happen: Google's free/busy counts them, so they come back out. */
async function ownEventTimes(
  s: WorkerServices,
  scope: TenantScope,
  c: CalendarConnection,
  from: Date,
  to: Date,
): Promise<Interval[]> {
  const list = await asWorker(s.db, scope, (tx) =>
    rows<{ starts_at: Date | string; ends_at: Date | string }>(
      tx,
      sql`select a.starts_at, a.ends_at from app.appointment_calendar_events e
          join app.appointments a on a.id = e.appointment_id
          where e.connection_id = ${c.id}::uuid and e.provider_event_id is not null
            and a.ends_at > ${from.toISOString()}::timestamptz and a.starts_at < ${to.toISOString()}::timestamptz`,
    ),
  );
  return list.map((r) => ({
    start: new Date(r.starts_at).getTime(),
    end: new Date(r.ends_at).getTime(),
  }));
}

/**
 * Appointments this calendar shows wrongly: booked without an event (connected after the booking, or a write
 * that never finished), changed since their event was written, or cancelled or reassigned with the event still
 * there. Each gets its write-through queued; one that is already right isn't picked.
 */
async function reconcile(
  tx: Tx,
  scope: TenantScope,
  c: CalendarConnection,
  from: Date,
  to: Date,
): Promise<void> {
  const due = await rows<{ id: string }>(
    tx,
    sql`select a.id from app.appointments a
        join app.appointment_staff s on s.appointment_id = a.id and s.user_id = ${c.userId}::uuid
        join app.calendars cal on cal.id = a.calendar_id
        left join app.appointment_calendar_events e on e.appointment_id = a.id and e.user_id = ${c.userId}::uuid
        where a.workspace_id = ${scope.workspaceId}::uuid
          and a.ends_at > ${from.toISOString()}::timestamptz and a.starts_at < ${to.toISOString()}::timestamptz
          and ((a.status = 'scheduled'
                and coalesce((cal.config #>> '{integrations,writeEvents}')::boolean, true)
                and (e.id is null or e.connection_id is distinct from ${c.id}::uuid
                     or e.synced_at is null or e.synced_at < a.updated_at))
            or (a.status in ('cancelled', 'no_show') and e.provider_event_id is not null))
        union
        select e.appointment_id from app.appointment_calendar_events e
        where e.workspace_id = ${scope.workspaceId}::uuid and e.user_id = ${c.userId}::uuid
          and e.provider_event_id is not null
          and not exists (select 1 from app.appointment_staff s
                          where s.appointment_id = e.appointment_id and s.user_id = e.user_id)
        limit ${RECONCILE_LIMIT}`,
  );
  for (const d of due) await queueCalendarSync(tx, scope, d.id);
}

export const calendarRefresh: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const connectionId = String(ctx.job.payload['connectionId'] ?? '');
  const [c] = await asWorker(ctx.db, scope, (tx) =>
    tx.select().from(calendarConnections).where(eq(calendarConnections.id, connectionId)),
  );
  // Disconnected, waiting on a reconnect, or never signed in: nothing to do until that changes.
  if (!c || !usable(c)) return;
  const provider = ctx.calendars.providers[c.provider];
  const every = ctx.calendars.refreshEveryMs;
  try {
    const call = session(ctx, scope, c, provider);
    const [w] = await asWorker(ctx.db, scope, (tx) =>
      tx
        .select({ timezone: workspaces.timezone })
        .from(workspaces)
        .where(eq(workspaces.id, scope.workspaceId)),
    );
    // From the top of the hour, so an unchanged calendar reads back the same blocks all hour.
    const from = new Date(Math.floor(Date.now() / HOUR) * HOUR);
    const to = new Date(from.getTime() + HORIZON_MS);
    const busy = await call((t) => provider.busy(t, from, to, w?.timezone ?? 'America/Chicago'));
    const theirs = intervals.clip(
      busy.map((b) => ({ start: b.start.getTime(), end: b.end.getTime() })),
      from.getTime(),
      to.getTime(),
    );
    const blocks = (
      provider.busyIncludesOwnEvents
        ? intervals.subtract(theirs, await ownEventTimes(ctx, scope, c, from, to))
        : theirs
    ).slice(0, MAX_BLOCKS);
    const next = new Date(Date.now() + every);
    const stored = await asWorker(ctx.db, scope, async (tx) => {
      // Still connected? A disconnect while we were reading leaves nothing behind.
      const [still] = await rows<{ status: string }>(
        tx,
        sql`select status::text as status from app.calendar_connections where id = ${c.id}::uuid for update`,
      );
      if (!still || (still.status !== 'active' && still.status !== 'error')) return false;
      // Only what changed is written: a kept block keeps its row (and every phone keeps its copy).
      const existing = await tx
        .select({
          id: calendarBusyBlocks.id,
          startsAt: calendarBusyBlocks.startsAt,
          endsAt: calendarBusyBlocks.endsAt,
        })
        .from(calendarBusyBlocks)
        .where(eq(calendarBusyBlocks.connectionId, c.id));
      const key = (start: number, end: number) => `${start}:${end}`;
      const want = new Set(blocks.map((b) => key(b.start, b.end)));
      const kept = new Set<string>();
      const gone: string[] = [];
      for (const r of existing) {
        const k = key(r.startsAt.getTime(), r.endsAt.getTime());
        if (want.has(k) && !kept.has(k)) kept.add(k);
        else gone.push(r.id);
      }
      const added = blocks.filter((b) => {
        const k = key(b.start, b.end);
        if (kept.has(k)) return false;
        kept.add(k);
        return true;
      });
      for (let i = 0; i < gone.length; i += INSERT_CHUNK)
        await tx
          .delete(calendarBusyBlocks)
          .where(inArray(calendarBusyBlocks.id, gone.slice(i, i + INSERT_CHUNK)));
      for (let i = 0; i < added.length; i += INSERT_CHUNK)
        await tx.insert(calendarBusyBlocks).values(
          added.slice(i, i + INSERT_CHUNK).map((b) => ({
            workspaceId: scope.workspaceId,
            connectionId: c.id,
            userId: c.userId,
            startsAt: new Date(b.start),
            endsAt: new Date(b.end),
          })),
        );
      await tx
        .update(calendarConnections)
        .set({
          status: 'active',
          busySyncedAt: new Date(),
          nextSyncAt: next,
          failures: 0,
          lastError: null,
        })
        .where(eq(calendarConnections.id, c.id));
      await reconcile(tx, scope, c, from, to);
      return true;
    });
    return stored ? { rescheduleAt: next } : undefined;
  } catch (e) {
    if (e instanceof CalendarAuthError) {
      // Stops here: the person gets one email, and the refresh starts again when they reconnect.
      await failConnection(ctx, scope, c, 'reauth_required', lostAccess(c));
      return;
    }
    const failures = c.failures + 1;
    const message = errorMessage(e);
    ctx.log.warn({ connectionId: c.id, failures, err: message }, 'calendar refresh failed');
    const wait =
      e instanceof CalendarError && e.retryAfterMs
        ? e.retryAfterMs
        : Math.min(MAX_WAIT_MS, every * 2 ** Math.min(failures - 1, 5));
    const next = new Date(Date.now() + wait);
    await asWorker(ctx.db, scope, (tx) =>
      tx
        .update(calendarConnections)
        .set({ failures, lastError: message.slice(0, 2000), nextSyncAt: next })
        .where(
          and(eq(calendarConnections.id, c.id), inArray(calendarConnections.status, [...USABLE])),
        ),
    );
    if (failures >= FAILURES_BEFORE_ERROR) await failConnection(ctx, scope, c, 'error', message);
    return { rescheduleAt: next };
  }
};

// ---------- write-through ----------

const writeEventsOf = (config: unknown): boolean => {
  try {
    return parseConfig(config).integrations.writeEvents;
  } catch {
    // Settings this worker can't read: fall back to the stored switch (on unless turned off).
    const raw = (config ?? {}) as { integrations?: { writeEvents?: unknown } };
    return raw.integrations?.writeEvents !== false;
  }
};

/** Where it happens, as one line: an address, a meeting link, or a phone call. */
function placeOf(location: unknown): string | null {
  const l = (location && typeof location === 'object' ? location : {}) as Record<string, unknown>;
  const text = (v: unknown): string | null => {
    if (typeof v === 'string') return v.trim() || null;
    if (v && typeof v === 'object')
      return (
        Object.values(v)
          .filter((x): x is string => typeof x === 'string' && !!x.trim())
          .join(', ') || null
      );
    return null;
  };
  return (
    text(l['address']) ?? text(l['meetingUrl']) ?? (l['kind'] === 'phone' ? 'Phone call' : null)
  );
}

/** What the person's calendar shows: the appointment, who it's with, where, and a link back. */
function eventFor(
  webUrl: string,
  workspaceId: string,
  a: Appointment,
  people: readonly string[],
): CalendarEvent {
  const single = people.length === 1 ? people[0]! : null;
  const title =
    single && !a.title.toLowerCase().includes(single.toLowerCase())
      ? `${a.title} · ${single}`
      : a.title;
  const withWhom = single
    ? `With ${single}`
    : people.length > 1
      ? `With ${people.slice(0, 5).join(', ')}${people.length > 5 ? ' and others' : ''}`
      : null;
  return {
    appointmentId: a.id,
    title: title.slice(0, 250),
    description: [
      withWhom,
      `Open in HandsFreeOS: ${webUrl}/app/w/${workspaceId}/calendar?appt=${a.id}`,
      'Added by HandsFreeOS. Changes made in this calendar aren’t copied back.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    location: placeOf(a.location),
    start: a.startsAt,
    end: a.endsAt,
  };
}

const fingerprintOf = (a: { updatedAt: Date; status: string }, staff: Iterable<string>) =>
  `${a.updatedAt.toISOString()}|${a.status}|${[...staff].sort().join(',')}`;

/**
 * Everything the write-through needs, read in one go as it is now. A booking in the Deleted bin (20261027000400) is
 * read too, so its events come out of people's calendars.
 */
async function readAppointment(s: WorkerServices, scope: TenantScope, appointmentId: string) {
  return asWorker(s.db, scope, async (tx) => {
    await tx.execute(sql`select set_config('app.read_bin', 'on', true)`);
    const [a] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId));
    if (!a) return null;
    const [cal] = await tx
      .select({ config: calendars.config })
      .from(calendars)
      .where(eq(calendars.id, a.calendarId));
    const staff = new Set(
      (
        await tx
          .select({ userId: appointmentStaff.userId })
          .from(appointmentStaff)
          .where(eq(appointmentStaff.appointmentId, a.id))
      ).map((r) => r.userId),
    );
    const written = await tx
      .select()
      .from(appointmentCalendarEvents)
      .where(eq(appointmentCalendarEvents.appointmentId, a.id));
    const people = [...new Set([...staff, ...written.map((w) => w.userId)])];
    const connections =
      people.length === 0
        ? []
        : await tx
            .select()
            .from(calendarConnections)
            .where(
              and(
                eq(calendarConnections.workspaceId, scope.workspaceId),
                inArray(calendarConnections.userId, people),
                inArray(calendarConnections.status, ['active', 'reauth_required', 'error']),
              ),
            );
    // Connections earlier events went through (a reconnect replaced them): the same account means the same calendar.
    const earlierIds = [
      ...new Set(
        written
          .map((w) => w.connectionId)
          .filter((id): id is string => !!id && !connections.some((c) => c.id === id)),
      ),
    ];
    const earlier =
      earlierIds.length === 0
        ? []
        : await tx
            .select({
              id: calendarConnections.id,
              provider: calendarConnections.provider,
              accountEmail: calendarConnections.accountEmail,
            })
            .from(calendarConnections)
            .where(inArray(calendarConnections.id, earlierIds));
    const attendees = await rows<{ name: string }>(
      tx,
      sql`select btrim(concat_ws(' ', p.first_name, p.last_name)) as name
          from app.appointment_attendees t join app.people p on p.id = t.person_id
          where t.appointment_id = ${a.id}::uuid and t.status = 'booked'
          order by t.created_at limit 6`,
    );
    return {
      a,
      writeEvents: writeEventsOf(cal?.config),
      staff,
      people,
      written,
      connections,
      earlier,
      attendees: attendees.map((r) => r.name).filter(Boolean),
      fingerprint: fingerprintOf(a, staff),
    };
  });
}

async function changedSince(
  s: WorkerServices,
  scope: TenantScope,
  appointmentId: string,
  fingerprint: string,
): Promise<boolean> {
  return asWorker(s.db, scope, async (tx) => {
    const [a] = await tx
      .select({ updatedAt: appointments.updatedAt, status: appointments.status })
      .from(appointments)
      .where(eq(appointments.id, appointmentId));
    if (!a) return false;
    const staff = await tx
      .select({ userId: appointmentStaff.userId })
      .from(appointmentStaff)
      .where(eq(appointmentStaff.appointmentId, appointmentId));
    return (
      fingerprintOf(
        a,
        staff.map((r) => r.userId),
      ) !== fingerprint
    );
  });
}

/** Where one person's event stands. `synced` stamps the time (the database's clock), so the refresh leaves it be. */
async function record(
  s: WorkerServices,
  scope: TenantScope,
  appointmentId: string,
  userId: string,
  connectionId: string | null,
  v: { providerEventId: string | null; error: string | null; synced: boolean },
): Promise<void> {
  const error = v.error?.slice(0, 2000) ?? null;
  await asWorker(s.db, scope, (tx) =>
    tx
      .insert(appointmentCalendarEvents)
      .values({
        workspaceId: scope.workspaceId,
        appointmentId,
        userId,
        connectionId,
        providerEventId: v.providerEventId,
        error,
        syncedAt: v.synced ? sql`now()` : null,
      })
      .onConflictDoUpdate({
        target: [appointmentCalendarEvents.appointmentId, appointmentCalendarEvents.userId],
        set: {
          connectionId,
          providerEventId: v.providerEventId,
          error,
          ...(v.synced ? { syncedAt: sql`now()` } : {}),
        },
      }),
  );
}

export const appointmentCalendarSync: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const appointmentId = String(ctx.job.payload['appointmentId'] ?? '');
  const seen = await readAppointment(ctx, scope, appointmentId);
  // Deleted: its write-through rows went with it.
  if (!seen) return;
  const { a, writeEvents, staff, people, written, connections, earlier } = seen;
  const event = eventFor(ctx.webUrl, scope.workspaceId, a, seen.attendees);
  const refreshes = new Set<string>();
  const transient: string[] = [];
  for (const userId of people) {
    const conn = connections.find((c) => c.userId === userId) ?? null;
    const row = written.find((w) => w.userId === userId) ?? null;
    const onIt = staff.has(userId);
    // A completed visit keeps its event as it is; a cancelled one, a no-show, a reassigned one or one deleted (in
    // the Deleted bin) loses it.
    const binned = a.binItemId !== null;
    const write = onIt && a.status === 'scheduled' && !binned;
    const remove = !onIt || a.status === 'cancelled' || a.status === 'no_show' || binned;
    // The event is in this connection's calendar: written through it, or through an earlier connection to the
    // same account.
    const here =
      !!row &&
      !!conn &&
      (row.connectionId === conn.id ||
        earlier.some(
          (x) =>
            x.id === row.connectionId &&
            x.provider === conn.provider &&
            x.accountEmail === conn.accountEmail,
        ));
    const provider = conn ? ctx.calendars.providers[conn.provider] : null;
    try {
      if (write && writeEvents) {
        // No calendar, or one waiting on a reconnect: the first refresh after connecting catches up.
        if (!conn || !provider || !usable(conn)) continue;
        const call = session(ctx, scope, conn, provider);
        const { providerEventId } = await call((t) =>
          provider.upsertEvent(t, event, here ? (row?.providerEventId ?? null) : null),
        );
        await record(ctx, scope, a.id, userId, conn.id, {
          providerEventId,
          error: null,
          synced: true,
        });
        refreshes.add(conn.id);
      } else if (remove && row?.providerEventId) {
        if (here && conn && provider && usable(conn)) {
          const call = session(ctx, scope, conn, provider);
          await call((t) => provider.deleteEvent(t, row.providerEventId!));
          refreshes.add(conn.id);
        } else if (here && conn?.status === 'reauth_required') continue;
        // Taken out, or out of reach for good (its calendar was disconnected): nothing more to do either way.
        await record(ctx, scope, a.id, userId, conn && here ? conn.id : row.connectionId, {
          providerEventId: null,
          error: null,
          synced: true,
        });
      }
    } catch (e) {
      if (e instanceof CalendarAuthError && conn) {
        await failConnection(ctx, scope, conn, 'reauth_required', lostAccess(conn));
        continue;
      }
      const message = errorMessage(e);
      const permanent = e instanceof CalendarError && e.permanent;
      ctx.log.warn({ appointmentId: a.id, userId, err: message }, 'calendar write-through failed');
      // A permanent refusal is stamped, so the refresh doesn't ask again until the appointment changes.
      await record(ctx, scope, a.id, userId, conn?.id ?? row?.connectionId ?? null, {
        providerEventId: row?.providerEventId ?? null,
        error: message,
        synced: permanent,
      });
      if (!permanent) transient.push(message);
    }
  }
  // Busy times follow: HandsFreeOS's own event is taken back out of them on the next read.
  if (refreshes.size > 0)
    await asWorker(ctx.db, scope, async (tx) => {
      for (const id of refreshes) await scheduleRefresh(tx, scope, id);
    });
  if (transient.length > 0)
    throw new Error(`A calendar didn’t take the change: ${transient.join('; ')}`);
  // Changed while we were writing: go round again with what it is now.
  if (await changedSince(ctx, scope, a.id, seen.fingerprint)) return { rescheduleAt: new Date() };
};
