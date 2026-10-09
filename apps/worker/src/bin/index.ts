/**
 * The Deleted bin (20261027000400; the owner's decisions of 2026-10-08 are in docs/deleting.md): what a delete asks
 * of the world outside the database, and emptying the bin.
 *
 * - person.deleted, appointment.deleted: the bookings that went in come out of people's Google and Outlook calendars
 *   now (calendar/sync.ts reads a booking in the bin as taken out).
 * - bin.restored: the bookings that came back go back in, unless they were cancelled.
 * - bin.emptied: "Delete now" (or the whole bin) starts emptying at once.
 * - bin.sweep, daily across every business: what's been in the bin 30 days starts emptying (private.bin_due), and
 *   one that started a day ago without finishing starts again.
 * - bin.purge: one thing emptied, a batch of rows at a time (private.purge_bin_batch), with the files, photos and
 *   recordings they held removed from storage after each batch. Its bookings' calendar events go first: it waits up
 *   to an hour for them, then lets go of any it can't reach (a calendar disconnected meanwhile).
 */
import { scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { queueCalendarSync } from '../calendar/sync';
import type { EventHandler } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { tenantOf, type TenantScope } from '../services';

export const BIN_JOBS = { sweep: 'bin.sweep', purge: 'bin.purge' } as const;
export const BIN_SWEEP_KEY = 'sweep:bin';

const DAY = 86_400_000;
/** Things started emptying at a time by the daily sweep; a full batch comes back in ten minutes for the rest. */
const SWEEP_BATCH = 100;
/** Batches of rows in one run of a purge, and rows in a batch; a bigger one comes straight back for the rest. */
const PURGE_RUNS = 20;
const PURGE_BATCH = 500;
/** How long emptying waits for its bookings to come out of people's calendars, and how often it looks. */
const CALENDAR_WAIT_MS = 60 * 60_000;
const CALENDAR_LOOK_MS = 2 * 60_000;

/**
 * Reads what's in the bin for `fn` alone: the worker sees a booking in the bin only while it tells a customer it's
 * cancelled or takes it off a calendar (private.reading_bin). Handlers of one event share a transaction, so it is
 * turned back off after.
 */
export async function readingBin<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await tx.execute(sql`select set_config('app.read_bin', 'on', true)`);
  try {
    return await fn();
  } finally {
    await tx.execute(sql`select set_config('app.read_bin', 'off', true)`);
  }
}

const purgeKey = (binItemId: string) => `bin.purge:${binItemId}`;

async function queuePurge(tx: Tx, scope: TenantScope, binItemId: string): Promise<void> {
  await scheduleJob(
    tx,
    {
      kind: BIN_JOBS.purge,
      dedupeKey: purgeKey(binItemId),
      runAt: new Date(),
      payload: { binItemId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
}

const payloadOf = (e: { payload: unknown }) =>
  (e.payload ?? {}) as { binItemId?: unknown; kind?: unknown };

/** person.deleted, appointment.deleted: the bookings that went in come out of people's calendars. */
export const onBinned: EventHandler = async (ctx) => {
  const binItemId = payloadOf(ctx.event).binItemId;
  if (typeof binItemId !== 'string') return;
  const scope = tenantOf(ctx.scope);
  const booked = await readingBin(ctx.tx, () =>
    rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.appointments where bin_item_id = ${binItemId}::uuid limit 500`,
    ),
  );
  for (const { id } of booked) await queueCalendarSync(ctx.tx, scope, id);
};

/** bin.restored: the bookings that came back go back in people's calendars (calendar/sync.ts skips cancelled ones). */
export const onBinRestored: EventHandler = async (ctx) => {
  const kind = payloadOf(ctx.event).kind;
  const id = ctx.event.entityId;
  if (!id) return;
  const scope = tenantOf(ctx.scope);
  const booked =
    kind === 'appointment'
      ? [{ id }]
      : kind === 'person'
        ? await rows<{ id: string }>(
            ctx.tx,
            sql`select distinct t.appointment_id as id from app.appointment_attendees t
                where t.workspace_id = ${scope.workspaceId}::uuid and t.person_id = ${id}::uuid
                limit 500`,
          )
        : [];
  for (const b of booked) await queueCalendarSync(ctx.tx, scope, b.id);
};

/** bin.emptied: "Delete now" empties it at once rather than in 30 days. */
export const onBinEmptied: EventHandler = async (ctx) => {
  const binItemId = payloadOf(ctx.event).binItemId;
  if (typeof binItemId === 'string') await queuePurge(ctx.tx, tenantOf(ctx.scope), binItemId);
};

/** Daily, across every business: what's been in the bin 30 days starts emptying, each as a purge of its own. */
export const binSweep: JobHandler = async (ctx) => {
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{ bin_item_id: string; workspace_id: string; organization_id: string }>(
      tx,
      sql`select bin_item_id, workspace_id, organization_id from private.bin_due(${SWEEP_BATCH})`,
    ),
  );
  for (const d of due) {
    const scope = { workspaceId: d.workspace_id, organizationId: d.organization_id };
    await asWorker(ctx.db, scope, (tx) => queuePurge(tx, scope, d.bin_item_id));
  }
  return { rescheduleAt: new Date(Date.now() + (due.length === SWEEP_BATCH ? 10 * 60_000 : DAY)) };
};

type Removed = { bucket?: string; objectPath?: string };

/** One thing in the bin, emptied for good. */
export const binPurge: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const binItemId = String(ctx.job.payload['binItemId'] ?? '');
  if (!binItemId) return;

  // Its bookings' events come out of people's calendars first, while the rows that say where they are still exist.
  const inCalendars = await asWorker(ctx.db, scope, (tx) =>
    readingBin(tx, () =>
      rows<{ appointment_id: string; purging_since: Date | string }>(
        tx,
        sql`select distinct e.appointment_id, b.purging_since
            from app.appointment_calendar_events e
            join app.appointments a on a.id = e.appointment_id
            join app.bin_items b on b.id = a.bin_item_id
            where a.bin_item_id = ${binItemId}::uuid and e.provider_event_id is not null
            limit 100`,
      ),
    ),
  );
  if (inCalendars.length > 0) {
    const since = new Date(inCalendars[0]!.purging_since).getTime();
    if (Date.now() - since < CALENDAR_WAIT_MS) {
      await asWorker(ctx.db, scope, async (tx) => {
        for (const c of inCalendars) await queueCalendarSync(tx, scope, c.appointment_id);
      });
      return { rescheduleAt: new Date(Date.now() + CALENDAR_LOOK_MS) };
    }
    ctx.log.warn(
      { binItemId, bookings: inCalendars.length },
      'emptying the bin left bookings in calendars it could not reach',
    );
  }

  for (let run = 0; run < PURGE_RUNS; run++) {
    const [r] = await asWorker(ctx.db, scope, (tx) =>
      rows<{ r: { more: boolean; objects: Removed[] } }>(
        tx,
        sql`select private.purge_bin_batch(${scope.workspaceId}::uuid, ${binItemId}::uuid, ${PURGE_BATCH}) as r`,
      ),
    );
    for (const o of r?.r.objects ?? [])
      // Only what this business stored, in its own folders.
      if (o.bucket && o.objectPath?.startsWith(`${scope.workspaceId}/`))
        await ctx.store.remove(o.bucket, o.objectPath).catch((e: unknown) => {
          ctx.log.warn(
            { err: String(e), bucket: o.bucket, objectPath: o.objectPath },
            'a deleted file could not be removed from storage',
          );
        });
    if (!r?.r.more) return;
  }
  return { rescheduleAt: new Date() };
};

export const binJobs: JobMap = {
  [BIN_JOBS.sweep]: binSweep,
  [BIN_JOBS.purge]: binPurge,
};
