/**
 * Queuing an add-on's work (docs/addon-architecture.md). An add-on's job row carries the add-on and the generation it
 * was queued for, so turning the add-on off cancels it in one statement (private.addon_cancel_work), the runner
 * refuses one whose add-on is off or was reinstalled since (processJobs), and history can say whose it was.
 */
import { rows, sql, type Tx } from '@hfos/db/client';

/** Core's own jobs for add-ons. None of them is an add-on's: they run whether or not it's on. */
export const ADDON_JOBS = {
  /** Brings one add-on in one business in line with its state (./reconcile.ts). */
  reconcile: 'addon.reconcile',
  /** Hands one event to one add-on's subscriber, in a job of its own so one add-on's trouble is its own. */
  deliver: 'addon.deliver',
  /** Hourly: a reconcile for every add-on whose last move isn't finished and proved. */
  sweep: 'addon.sweep',
} as const;

export const addonReconcileKey = (workspaceId: string, addonId: string): string =>
  `addon:${workspaceId}:${addonId}`;
export const ADDON_SWEEP_KEY = 'sweep:addons';

/**
 * Queues one of an add-on's jobs in one business: only while the add-on is arriving or on there (and, when
 * `generation` is given, only for that installation), and stamped with the add-on and its generation. The dedupe
 * key is the add-on's own within the business: it's stored after the business's id, so two businesses never share
 * one. Returns whether the add-on took the work; a job already pending under the key stays as it is, unless
 * `pullEarlier` moves it sooner, as core's scheduleJob does.
 *
 * Runs in the worker's transaction scoped to the business (asWorker with its scope): anywhere else it finds no
 * installation, and queues nothing.
 */
export async function scheduleAddonJob(
  tx: Tx,
  addon: { readonly id: string; readonly generation?: number | null },
  job: {
    readonly kind: string;
    readonly dedupeKey: string | null;
    readonly runAt: Date;
    readonly payload: Record<string, unknown>;
    readonly workspaceId: string;
    readonly organizationId: string;
  },
  opts: { readonly pullEarlier?: boolean } = {},
): Promise<boolean> {
  const onConflict = opts.pullEarlier
    ? sql`do update set run_at = least(app.scheduled_jobs.run_at, excluded.run_at),
          payload = case when app.scheduled_jobs.locked_at is not null and app.scheduled_jobs.run_at <= now()
            then app.scheduled_jobs.payload || jsonb_build_object('_wakeAt', least(
              coalesce((app.scheduled_jobs.payload ->> '_wakeAt')::timestamptz, excluded.run_at), excluded.run_at))
            else app.scheduled_jobs.payload end`
    : sql`do nothing`;
  const [row] = await rows<{ accepted: boolean }>(
    tx,
    sql`with live as (
          select i.workspace_id, i.addon_id, i.generation from app.addon_installations i
          where i.workspace_id = ${job.workspaceId}::uuid and i.addon_id = ${addon.id}
            and i.state in ('installing', 'enabled')
            and (${addon.generation ?? null}::integer is null or i.generation = ${addon.generation ?? null}::integer)),
        queued as (
          insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload,
            addon_id, addon_generation)
          select ${job.organizationId}::uuid, live.workspace_id, ${job.kind},
            ${job.dedupeKey === null ? null : `${job.workspaceId}:${job.dedupeKey}`},
            ${job.runAt.toISOString()}::timestamptz, ${JSON.stringify(job.payload)}::jsonb,
            live.addon_id, live.generation
          from live
          on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null ${onConflict}
          returning 1)
        select exists (select 1 from live) as accepted`,
  );
  return row?.accepted === true;
}
