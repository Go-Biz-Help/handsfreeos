/**
 * Add-ons in the worker (docs/addon-architecture.md): the lifecycle's slow half, each add-on's subscribers and jobs,
 * and the guards that keep an add-on that is off from doing anything at all.
 *
 * - **Lifecycle.** Every `addon.*` move a person makes queues one reconcile per add-on and business
 *   (./reconcile.ts), and an hourly sweep queues one for any move left unfinished.
 * - **What happens in a business** reaches an add-on only while it's on there, and never inside the event's own
 *   transaction: the event's handler queues one `addon.deliver` job per add-on that subscribes and runs there, and
 *   each runs on its own, with its own retries. One add-on's trouble never holds up core, or another add-on.
 * - **Its jobs** carry the add-on and its generation (scheduleAddonJob); the job runner cancels one whose add-on is
 *   off or was reinstalled since, before it runs (jobs.ts), as the webhook runner sets aside what arrives for an
 *   add-on that is off (deliveries.ts).
 *
 * Everything is built from the catalogue and the worker modules given (the real ones here; the tests' own over
 * their made-up catalogue), and a module that doesn't match its manifest stops the worker starting.
 */
import {
  ADDON_CATALOG,
  ADDON_MOVE_EVENTS,
  findAddon,
  scheduleJob,
  type Catalog,
} from '@hfos/core/server';
import { eq } from 'drizzle-orm';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { events } from '@hfos/db/schema';
import { handlersFor, type EventHandler, type HandlerMap } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { tenantOf, workerMeta } from '../services';
import { addonScope } from './context';
import { ADDON_WORKER_MODULES } from './modules';
import { ADDON_JOBS, ADDON_SWEEP_KEY, addonReconcileKey, scheduleAddonJob } from './queue';
import { addonReconcileJob, addonSweepJob } from './reconcile';
import type { AddonJobHandler, AddonWorkerModule } from './types';

export { ADDON_JOBS, ADDON_SWEEP_KEY, addonReconcileKey, scheduleAddonJob } from './queue';
export { addonActor, addonScope } from './context';
export type * from './types';

/** Everything wrong with how the worker modules match the catalogue. Empty when they can be registered. */
export function addonWorkerModuleIssues(
  catalog: Catalog,
  modules: readonly AddonWorkerModule[],
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const {
    manifest: m,
    subscribers = {},
    jobs = {},
    dataMigrations = {},
    ...rest
  } of modules) {
    if (seen.has(m.id)) issues.push(`${m.id} has two worker modules`);
    seen.add(m.id);
    if (findAddon(catalog, m.id) !== m)
      issues.push(`${m.id}'s worker module isn't for the catalogue's manifest`);
    const consumes = new Set(m.events?.consumes ?? []);
    for (const t of Object.keys(subscribers))
      if (!consumes.has(t))
        issues.push(`${m.id} subscribes to ${t}, which its manifest doesn't consume`);
    for (const t of consumes)
      if (!(t in subscribers)) issues.push(`${m.id} consumes ${t} but has no subscriber for it`);
    const declared = new Set(m.jobs ?? []);
    for (const k of Object.keys(jobs))
      if (!declared.has(k)) issues.push(`${m.id} has a job ${k} its manifest doesn't declare`);
    for (const k of declared)
      if (!(k in jobs)) issues.push(`${m.id} declares job ${k} but has no handler for it`);
    for (const v of Object.keys(dataMigrations).map(Number))
      if (!Number.isInteger(v) || v < 2 || v > m.dataVersion)
        issues.push(`${m.id} has a data step for version ${v}, outside 2–${m.dataVersion}`);
    if ((m.resources ?? []).length > 0 && !rest.releaseResource)
      issues.push(`${m.id} holds resources outside HandsFreeOS but can't let go of them`);
  }
  return issues;
}

/** An add-on's own job, handed its add-on's context. The runner has already checked the add-on runs. */
function addonJob(module: AddonWorkerModule, handler: AddonJobHandler): JobHandler {
  return async (ctx) => {
    const generation = ctx.job.addonGeneration;
    if (ctx.job.addonId !== module.manifest.id || generation === null) {
      ctx.log.error({ kind: ctx.job.kind }, 'an add-on job was queued without its add-on');
      return;
    }
    return handler({
      ...addonScope(ctx, module.manifest, tenantOf(ctx.scope), generation, workerMeta(null, null)),
      job: ctx.job,
      attempt: ctx.attempt,
      now: ctx.now,
    });
  };
}

/** The add-on work of one catalogue and its worker modules: event handlers to add, and jobs. */
export function addonWorker(catalog: Catalog, modules: readonly AddonWorkerModule[]) {
  const issues = addonWorkerModuleIssues(catalog, modules);
  if (issues.length > 0)
    throw new Error(`Add-on worker modules can't be registered:\n${issues.join('\n')}`);

  /** A person moved an add-on: its reconcile, now (or straight after the one running). */
  const onMoved: EventHandler = async (ctx) => {
    const { workspaceId, organizationId } = ctx.scope;
    const addonId = (ctx.event.payload as Record<string, unknown> | null)?.['addonId'];
    if (!workspaceId || !organizationId || typeof addonId !== 'string') return;
    await scheduleJob(
      ctx.tx,
      {
        kind: ADDON_JOBS.reconcile,
        dedupeKey: addonReconcileKey(workspaceId, addonId),
        runAt: new Date(),
        payload: {
          addonId,
          correlationId: ctx.event.correlationId,
          causationId: ctx.event.id,
        },
        workspaceId,
        organizationId,
      },
      { pullEarlier: true },
    );
  };

  /** The add-ons subscribed to an event type that run in the event's business: one delivery job each. */
  const fanOut =
    (eventType: string, addonIds: readonly string[]): EventHandler =>
    async (ctx) => {
      const { workspaceId, organizationId } = ctx.scope;
      if (!workspaceId || !organizationId) return;
      const running = await rows<{ addon_id: string; generation: number }>(
        ctx.tx,
        sql`select i.addon_id, i.generation from app.addon_installations i
            where i.workspace_id = ${workspaceId} and i.state = 'enabled'
              and i.addon_id = any (${`{${addonIds.join(',')}}`}::text[])
              and not exists (select 1 from platform.addon_overrides o
                              where o.addon_id = i.addon_id and o.status = 'unavailable')`,
      );
      for (const r of running)
        await scheduleAddonJob(
          ctx.tx,
          { id: r.addon_id, generation: r.generation },
          {
            kind: ADDON_JOBS.deliver,
            dedupeKey: `deliver:${ctx.event.id}:${r.addon_id}`,
            runAt: new Date(),
            payload: { eventId: ctx.event.id, eventType },
            workspaceId,
            organizationId,
          },
        );
    };

  const subscribedBy = new Map<string, string[]>();
  for (const m of modules)
    for (const t of Object.keys(m.subscribers ?? {}))
      subscribedBy.set(t, [...(subscribedBy.get(t) ?? []), m.manifest.id]);

  /** `addon.deliver`: one event, to one add-on's subscriber, as the system acting for it. */
  const deliver: JobHandler = async (ctx) => {
    const eventId = String(ctx.job.payload['eventId'] ?? '');
    const eventType = String(ctx.job.payload['eventType'] ?? '');
    const module = modules.find((m) => m.manifest.id === ctx.job.addonId);
    const subscriber = module?.subscribers?.[eventType];
    const generation = ctx.job.addonGeneration;
    if (!module || !subscriber || generation === null) return;
    const scope = tenantOf(ctx.scope);
    const [event] = await asWorker(ctx.db, scope, (tx) =>
      tx.select().from(events).where(eq(events.id, eventId)),
    );
    if (!event) return;
    await subscriber({
      ...addonScope(
        ctx,
        module.manifest,
        scope,
        generation,
        workerMeta(event.correlationId, event.id),
      ),
      event,
      attempt: ctx.attempt,
    });
  };

  return {
    /** Adds the lifecycle's handlers, and each subscribed event's delivery, to a handler map (last, after its own). */
    withAddons(map: HandlerMap): HandlerMap {
      const out: Record<string, EventHandler | readonly EventHandler[]> = { ...map };
      for (const t of new Set(Object.values(ADDON_MOVE_EVENTS)))
        out[t] = [...handlersFor(out, t), onMoved];
      for (const [t, ids] of subscribedBy) out[t] = [...handlersFor(out, t), fanOut(t, ids)];
      return out;
    },
    jobs: {
      [ADDON_JOBS.reconcile]: addonReconcileJob(catalog, modules),
      [ADDON_JOBS.deliver]: deliver,
      [ADDON_JOBS.sweep]: addonSweepJob,
      ...Object.fromEntries(
        modules.flatMap((m) =>
          Object.entries(m.jobs ?? {}).map(([kind, handler]) => [kind, addonJob(m, handler)]),
        ),
      ),
    } satisfies JobMap as JobMap,
  };
}

/** The real catalogue's, for the worker's own handler and job maps. */
const real = addonWorker(ADDON_CATALOG, ADDON_WORKER_MODULES);
export const withAddons = real.withAddons;
export const addonJobs: JobMap = real.jobs;

/** The hourly sweep exists exactly once; its first pass an hour after the worker starts. */
export async function ensureAddonSweep(tx: Tx, runAt: Date): Promise<void> {
  await scheduleJob(tx, {
    kind: ADDON_JOBS.sweep,
    dedupeKey: ADDON_SWEEP_KEY,
    runAt,
    payload: {},
    workspaceId: null,
    organizationId: null,
  });
}
