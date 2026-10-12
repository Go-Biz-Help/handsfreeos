/**
 * Bringing one add-on in one business in line with its state (0108, docs/addon-architecture.md). The lifecycle
 * commands only move the state and record an event; that event queues this job (and so does the hourly sweep, for
 * any move left unfinished), which does the slow part of each state and proves it:
 *
 * - **installing**: its kinds of records and relationship types made, or found again after a reinstall; its
 *   settings and data brought up to this version's shape, a data version at a time; its `onInstall`; then on,
 *   and its `onEnable`.
 * - **enabled**: its records shown, and its `onEnable`.
 * - **disabled**: its queued work cancelled and its records hidden, then its `onDisable`. Its data and settings
 *   stay as they are.
 * - **uninstalling**: the same, then everything it holds outside HandsFreeOS let go of, its `onUninstall`, and
 *   uninstalled. Its data stays until an owner deletes it (the owner's decision, 2026-09-28).
 * - **purging**: its data deleted in batches (private.purge_addon_batch), each its own transaction, then purged.
 * - **uninstalled**, **purged**: its work cancelled and its records hidden again, in case anything slipped in.
 *
 * Each ends with private.addon_verify, stored on the installation. A move is finished only when every check
 * passes: until then the installation keeps its state and says what's wrong (`last_error`), the job retries, and
 * the sweep queues it again. Every step is safe to repeat, and a move a person makes meanwhile (turning it off
 * while it arrives) is never written over: each step locks the installation and stops if its state or
 * generation moved, and that move's own event queues the next reconcile.
 */
import {
  findAddon,
  scheduleJob,
  type AddonManifest,
  type Catalog,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { JobContext, JobHandler, JobResult } from '../jobs';
import { errorMessage } from '../outbox';
import { tenantOf, workerMeta, type TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';
import { addonScope } from './context';
import { ADDON_JOBS, addonReconcileKey } from './queue';
import type { AddonResource, AddonScopeContext, AddonWorkerModule } from './types';

/** Rows a purge batch removes, and batches per run: a bigger purge carries on in the next run, a second later. */
const PURGE_BATCH = 2000;
const PURGE_ROUNDS = 50;
const HOUR = 60 * 60_000;
/** How long an arriving add-on waits before looking again at an add-on it requires that is still arriving. */
const DEPENDENCY_WAIT_MS = 5_000;
/** Managed kinds and types sort after a business's own. */
const MANAGED_POSITION = 900;

type State =
  'installing' | 'enabled' | 'disabled' | 'uninstalling' | 'uninstalled' | 'purging' | 'purged';

interface Installation {
  readonly state: State;
  readonly generation: number;
  readonly dataVersion: number;
  readonly settingsVersion: number;
  readonly settings: Record<string, unknown>;
}

export interface AddonCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly found: number;
}

/** A move a person made while this job ran: it stops here, and that move's event queues the next reconcile. */
class Superseded extends Error {}

/** Checks that failed: the move isn't finished. */
class ChecksFailed extends Error {
  constructor(readonly checks: readonly AddonCheck[]) {
    super(
      `Not finished: ${checks
        .filter((c) => !c.ok)
        .map((c) => `${c.name} (${c.found})`)
        .join(', ')}`,
    );
  }
}

interface Run {
  readonly ctx: JobContext;
  readonly scope: TenantScope;
  readonly addonId: string;
  readonly inst: Installation;
  readonly manifest: AddonManifest | null;
  readonly module: AddonWorkerModule | null;
  readonly meta: RequestMeta;
}

const uuidOrNull = (v: unknown): string | null =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ? v
    : null;

async function readInstallation(
  tx: Tx,
  workspaceId: string,
  addonId: string,
  lock: boolean,
): Promise<Installation | null> {
  const [r] = await rows<{
    state: State;
    generation: number;
    data_version: number;
    settings_version: number;
    settings: Record<string, unknown>;
  }>(
    tx,
    // `for no key update`: serialized with a person's moves (private.addon_move takes the row for update) and
    // with another reconcile, without holding up the kernel's add-on check (a key-share lock).
    sql`select state, generation, data_version, settings_version, settings from app.addon_installations
        where workspace_id = ${workspaceId} and addon_id = ${addonId}
        ${lock ? sql`for no key update` : sql``}`,
  );
  return r
    ? {
        state: r.state,
        generation: r.generation,
        dataVersion: r.data_version,
        settingsVersion: r.settings_version,
        settings: r.settings,
      }
    : null;
}

/** One step in its own transaction, for as long as the add-on is still in the state and generation it started in. */
function within<T>(run: Run, fn: (tx: Tx, now: Installation) => Promise<T>): Promise<T> {
  return asWorker(run.ctx.db, run.scope, async (tx) => {
    const now = await readInstallation(tx, run.scope.workspaceId, run.addonId, true);
    if (!now || now.state !== run.inst.state || now.generation !== run.inst.generation)
      throw new Superseded();
    return fn(tx, now);
  });
}

const where = (run: Run) =>
  sql`workspace_id = ${run.scope.workspaceId} and addon_id = ${run.addonId}`;

async function verify(tx: Tx, run: Run): Promise<AddonCheck[]> {
  const found = await rows<{ check_name: string; ok: boolean; found: string | number }>(
    tx,
    sql`select check_name, ok, found from private.addon_verify(${run.scope.workspaceId}::uuid, ${run.addonId})`,
  );
  return found.map((c) => ({ name: c.check_name, ok: c.ok, found: Number(c.found) }));
}

/** What the checks found. The state counts as proved (`verified_at`) only when every one passed. */
async function storeChecks(tx: Tx, run: Run, checks: readonly AddonCheck[]): Promise<void> {
  const ok = checks.every((c) => c.ok);
  await tx.execute(
    sql`update app.addon_installations set verification = ${JSON.stringify({ checks })}::jsonb,
          verified_at = case when ${ok} then now() end,
          last_error = ${ok ? null : new ChecksFailed(checks).message}
        where ${where(run)}`,
  );
}

async function record(tx: Tx, run: Run, type: string, action: string): Promise<void> {
  await recordSystemEvent(tx, {
    type,
    action,
    organizationId: run.scope.organizationId,
    workspaceId: run.scope.workspaceId,
    entityType: 'addon',
    entityId: null,
    payload: {
      addonId: run.addonId,
      name: run.manifest?.name ?? run.addonId,
      version: run.manifest?.version ?? null,
      generation: run.inst.generation,
    },
    correlationId: run.meta.correlationId,
    causationId: run.meta.causationId ?? run.ctx.job.id,
  });
}

/**
 * Proves the state, and with `to` finishes the move into it: in one transaction, so a move whose checks fail is
 * never made, and the event says it happened only when it did.
 */
async function settle(
  run: Run,
  move?: { readonly to: State; readonly event: string; readonly action: string },
): Promise<void> {
  const checks = await within(run, async (tx) => {
    if (move)
      await tx.execute(
        sql`update app.addon_installations set state = ${move.to}, last_error = null where ${where(run)}`,
      );
    const found = await verify(tx, run);
    if (move && !found.every((c) => c.ok)) throw new ChecksFailed(found);
    await storeChecks(tx, run, found);
    if (move) await record(tx, run, move.event, move.action);
    return found;
  });
  // Stored, and retried: a settled state that doesn't check out is healed by running its steps again.
  if (!checks.every((c) => c.ok)) throw new ChecksFailed(checks);
}

/** Its queued work cancelled and its records hidden, in one transaction. */
const stopAndHide = (run: Run) =>
  within(run, async (tx) => {
    await tx.execute(
      sql`select private.addon_cancel_work(${run.scope.workspaceId}::uuid, ${run.addonId})`,
    );
    await tx.execute(
      sql`select private.addon_hide_records(${run.scope.workspaceId}::uuid, ${run.addonId})`,
    );
  });

const hookContext = (run: Run): AddonScopeContext | null =>
  run.manifest ? addonScope(run.ctx, run.manifest, run.scope, run.inst.generation, run.meta) : null;

/**
 * Its kinds of records and relationship types, as this version declares them. Found again by key after a
 * reinstall; only what the add-on decides (the permission its records are written with) is brought up to date,
 * and what the business chose (a kind's labels and icon, a type's labels) is left as they chose it.
 */
async function seedRecordKinds(tx: Tx, run: Run, m: AddonManifest): Promise<void> {
  const ids = new Map<string, string>();
  for (const [i, k] of (m.recordKinds ?? []).entries()) {
    const [row] = await rows<{ id: string }>(
      tx,
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, name_label, icon, position,
            addon_id, write_permission, kept_to_team, see_all_permission)
          values (${run.scope.workspaceId}, ${k.key}, ${k.singular}, ${k.plural}, ${k.nameLabel ?? 'Name'},
            ${k.icon ?? 'box'}, ${MANAGED_POSITION + i}, ${m.id}, ${k.writePermission},
            ${k.keptToTeam !== undefined}, ${k.keptToTeam?.seeAllPermission ?? null})
          on conflict (workspace_id, addon_id, key) where addon_id is not null
            do update set write_permission = excluded.write_permission
          returning id`,
    );
    if (row) ids.set(k.key, row.id);
  }
  const end = (e: NonNullable<AddonManifest['relationshipTypes']>[number]['a']) =>
    e.kind === 'record'
      ? { end: 'custom_record', kind: ids.get(e.recordKind) ?? null }
      : { end: e.kind, kind: null };
  for (const [i, t] of (m.relationshipTypes ?? []).entries()) {
    const a = end(t.a);
    const b = end(t.b);
    await tx.execute(
      sql`insert into app.relationship_types (workspace_id, a_end, a_record_type_id, a_label, b_end,
            b_record_type_id, b_label, cardinality, position, addon_id, addon_key, portal_visible)
          values (${run.scope.workspaceId}, ${a.end}::app.relationship_end, ${a.kind}, ${t.aLabel},
            ${b.end}::app.relationship_end, ${b.kind}, ${t.bLabel},
            ${t.cardinality ?? 'many_to_many'}::app.relationship_cardinality, ${MANAGED_POSITION + i}, ${m.id},
            ${t.key}, ${t.portal === true})
          on conflict (workspace_id, addon_key) where addon_key is not null
            -- Whether its customers see it in their portal is the add-on's to say, and may change with a version.
            do update set portal_visible = excluded.portal_visible`,
    );
  }
}

async function arrive(run: Run): Promise<JobResult> {
  const { manifest: m, module } = run;
  if (!m)
    throw new Error(`${run.addonId} isn’t in this version of HandsFreeOS, so it can’t be set up.`);
  if (run.inst.dataVersion > m.dataVersion)
    throw new Error(
      `Its data is at version ${run.inst.dataVersion}, newer than this version of HandsFreeOS knows (${m.dataVersion}).`,
    );
  // What it requires comes on first: arriving together (installed with `include`), it waits for them.
  const required = (m.requires ?? []).filter((d) => d.kind === 'required').map((d) => d.addon);
  if (required.length > 0) {
    const states = await asWorker(run.ctx.db, run.scope, (tx) =>
      rows<{ addon_id: string; state: State; last_error: string | null }>(
        tx,
        sql`select addon_id, state, last_error from app.addon_installations
            where workspace_id = ${run.scope.workspaceId}
              and addon_id = any (${`{${required.join(',')}}`}::text[])`,
      ),
    );
    const stateOf = (id: string) => states.find((r) => r.addon_id === id);
    const off = required.filter(
      (id) => !['installing', 'enabled'].includes(stateOf(id)?.state ?? ''),
    );
    if (off.length > 0) throw new Error(`It needs ${off.join(', ')}, which isn’t on here.`);
    // One whose own setting up is failing won't come on by waiting: this one fails too, and says why, until the
    // retries and the sweep bring both in.
    const stuck = required.filter(
      (id) => stateOf(id)?.state === 'installing' && stateOf(id)?.last_error,
    );
    if (stuck.length > 0)
      throw new Error(`It needs ${stuck.join(', ')}, which couldn’t be set up yet.`);
    if (required.some((id) => stateOf(id)?.state !== 'enabled'))
      return { rescheduleAt: new Date(Date.now() + DEPENDENCY_WAIT_MS) };
  }
  const hooks = hookContext(run)!;
  // 1. Its kinds of records, and its settings in this version's shape.
  await within(run, async (tx, now) => {
    await seedRecordKinds(tx, run, m);
    const version = m.settings?.version ?? 1;
    if (now.settingsVersion < version) {
      const settings = module?.migrateSettings
        ? module.migrateSettings(now.settings, now.settingsVersion)
        : now.settings;
      await tx.execute(
        sql`update app.addon_installations set settings = ${JSON.stringify(settings)}::jsonb,
              settings_version = ${version} where ${where(run)}`,
      );
    }
  });
  // 2. Its data, a version at a time, each step with the version it reaches.
  for (let v = run.inst.dataVersion + 1; v <= m.dataVersion; v++) {
    const step = module?.dataMigrations?.[v];
    await within(run, async (tx, now) => {
      if (now.dataVersion >= v) return;
      if (step) await step({ ...hooks, tx });
      await tx.execute(
        sql`update app.addon_installations set data_version = ${v} where ${where(run)}`,
      );
    });
  }
  // 3. Its own setting up: while it arrives it may write its own tables, but runs nothing through the kernel.
  await module?.onInstall?.(hooks);
  // 4. On, and proved; then its onEnable, which a retry (in the `enabled` state) runs again until it succeeds.
  await within(run, (tx) =>
    tx.execute(
      sql`select private.addon_show_records(${run.scope.workspaceId}::uuid, ${run.addonId})`,
    ),
  );
  await settle(run, { to: 'enabled', event: 'addon.installed', action: 'addon.install' });
  await module?.onEnable?.(hooks);
}

async function turnedOn(run: Run): Promise<JobResult> {
  await within(run, (tx) =>
    tx.execute(
      sql`select private.addon_show_records(${run.scope.workspaceId}::uuid, ${run.addonId})`,
    ),
  );
  const hooks = hookContext(run);
  if (hooks) await run.module?.onEnable?.(hooks);
  await settle(run);
}

async function turnedOff(run: Run): Promise<JobResult> {
  await stopAndHide(run);
  const hooks = hookContext(run);
  if (hooks) await run.module?.onDisable?.(hooks);
  await settle(run);
}

/** Lets go of each thing it holds outside HandsFreeOS; throws, after trying them all, if any is still held. */
async function letGo(run: Run): Promise<void> {
  const held = await asWorker(run.ctx.db, run.scope, (tx) =>
    rows<{ id: string; kind: string; external_id: string; label: string | null }>(
      tx,
      sql`select id, kind, external_id, label from app.addon_resources
          where ${where(run)} and status <> 'released' order by created_at`,
    ),
  );
  const hooks = hookContext(run);
  let stuck = 0;
  for (const r of held) {
    const resource: AddonResource = {
      id: r.id,
      kind: r.kind,
      externalId: r.external_id,
      label: r.label,
    };
    try {
      if (!hooks || !run.module?.releaseResource)
        throw new Error('No code in this version of HandsFreeOS can let go of it.');
      await run.module.releaseResource(hooks, resource);
      await asWorker(run.ctx.db, run.scope, (tx) =>
        tx.execute(
          sql`update app.addon_resources set status = 'released', released_at = now(), last_error = null
              where id = ${r.id}`,
        ),
      );
    } catch (e) {
      stuck++;
      await asWorker(run.ctx.db, run.scope, (tx) =>
        tx.execute(
          sql`update app.addon_resources set status = 'failed', attempts = attempts + 1,
                last_error = ${errorMessage(e).slice(0, 2000)}
              where id = ${r.id}`,
        ),
      );
    }
  }
  if (stuck > 0)
    throw new Error(
      `It still holds ${stuck} thing${stuck === 1 ? '' : 's'} outside HandsFreeOS it couldn’t let go of.`,
    );
}

async function leave(run: Run): Promise<JobResult> {
  await stopAndHide(run);
  await letGo(run);
  const hooks = hookContext(run);
  if (hooks) await run.module?.onUninstall?.(hooks);
  await settle(run, { to: 'uninstalled', event: 'addon.uninstalled', action: 'addon.uninstall' });
  return freshOn(run, 'uninstalled');
}

/**
 * Starting fresh (an owner asked: `fresh_at`, set by `addon.start_fresh`): the next move, made here as the owner would
 * make it on Settings → Add-ons. Uninstalled, its data is deleted; deleted, it's installed again as a new generation,
 * at this version, and the mark goes. The job runs again straight away for the new state. Nothing when it isn't
 * starting fresh, or a move was made meanwhile.
 */
async function freshOn(run: Run, from: 'uninstalled' | 'purged'): Promise<JobResult> {
  const m = run.manifest;
  const moved = await asWorker(run.ctx.db, run.scope, async (tx) => {
    const [r] = await rows<{ state: State; generation: number; fresh_by: string | null }>(
      tx,
      sql`select state, generation, fresh_by from app.addon_installations
          where ${where(run)} and fresh_at is not null for no key update`,
    );
    if (!r || r.state !== from || r.generation !== run.inst.generation) return false;
    if (from === 'uninstalled') {
      await tx.execute(
        sql`update app.addon_installations set state = 'purging', changed_by = ${r.fresh_by},
              changed_at = now(), last_error = null
            where ${where(run)}`,
      );
      await record(
        tx,
        { ...run, inst: { ...run.inst, state: 'purging' } },
        'addon.purge_started',
        'addon.purge',
      );
      return true;
    }
    // Its code gone from HandsFreeOS: it stays deleted, with nothing to install.
    if (!m) {
      await tx.execute(
        sql`update app.addon_installations set fresh_by = null, fresh_at = null where ${where(run)}`,
      );
      return false;
    }
    await tx.execute(
      sql`update app.addon_installations set state = 'installing', generation = generation + 1,
            installed_version = ${m.version}, data_version = ${m.dataVersion},
            settings_version = ${m.settings?.version ?? 1}, installed_by = ${r.fresh_by}, installed_at = now(),
            changed_by = ${r.fresh_by}, changed_at = now(), last_error = null, verification = null,
            verified_at = null, fresh_by = null, fresh_at = null
          where ${where(run)}`,
    );
    await record(
      tx,
      { ...run, inst: { ...run.inst, state: 'installing', generation: r.generation + 1 } },
      'addon.install_started',
      'addon.install',
    );
    return true;
  });
  return moved ? { rescheduleAt: new Date() } : undefined;
}

async function purge(run: Run): Promise<JobResult> {
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    const [batch] = await asWorker(run.ctx.db, run.scope, (tx) =>
      rows<{ more: boolean }>(
        tx,
        sql`select private.purge_addon_batch(${run.scope.workspaceId}::uuid, ${run.addonId}, ${PURGE_BATCH}) as more`,
      ),
    );
    if (batch?.more) continue;
    // The last batch marked it purged. The data is gone whatever the checks say, so the line saying so is
    // recorded; the checks are stored beside it.
    const done: Run = { ...run, inst: { ...run.inst, state: 'purged' } };
    await within(done, (tx) => record(tx, done, 'addon.purged', 'addon.purge'));
    await settle(done);
    return freshOn(done, 'purged');
  }
  return { rescheduleAt: new Date(Date.now() + 1000) };
}

async function settled(run: Run): Promise<JobResult> {
  await stopAndHide(run);
  await settle(run);
  // Part way through starting fresh, when a job was lost: it carries on (the sweep queues it).
  if (run.inst.state === 'uninstalled' || run.inst.state === 'purged')
    return freshOn(run, run.inst.state);
}

/** `addon.reconcile`: one add-on in one business, whatever state it's in. */
export function addonReconcileJob(
  catalog: Catalog,
  modules: readonly AddonWorkerModule[],
): JobHandler {
  return async (ctx) => {
    const addonId = String(ctx.job.payload['addonId'] ?? '');
    const scope = tenantOf(ctx.scope);
    const inst = await asWorker(ctx.db, scope, (tx) =>
      readInstallation(tx, scope.workspaceId, addonId, false),
    );
    if (!inst) return;
    const run: Run = {
      ctx,
      scope,
      addonId,
      inst,
      manifest: findAddon(catalog, addonId) ?? null,
      module: modules.find((m) => m.manifest.id === addonId) ?? null,
      meta: workerMeta(
        uuidOrNull(ctx.job.payload['correlationId']),
        uuidOrNull(ctx.job.payload['causationId']),
      ),
    };
    try {
      switch (inst.state) {
        case 'installing':
          return await arrive(run);
        case 'enabled':
          return await turnedOn(run);
        case 'disabled':
          return await turnedOff(run);
        case 'uninstalling':
          return await leave(run);
        case 'purging':
          return await purge(run);
        default:
          return await settled(run);
      }
    } catch (e) {
      if (e instanceof Superseded) return;
      await troubled(run, e);
      throw e;
    }
  };
}

/**
 * What went wrong, on the installation, for the owner to see, and never counted as proved, so the sweep queues it
 * again. Only for the installation this job worked on (its generation): a person's move since clears it, and the
 * reconcile that move queues writes its own.
 */
async function troubled(run: Run, e: unknown): Promise<void> {
  try {
    await asWorker(run.ctx.db, run.scope, (tx) =>
      tx.execute(
        sql`update app.addon_installations set last_error = ${errorMessage(e).slice(0, 2000)}, verified_at = null
              ${e instanceof ChecksFailed ? sql`, verification = ${JSON.stringify({ checks: e.checks })}::jsonb` : sql``}
            where ${where(run)} and generation = ${run.inst.generation}`,
      ),
    );
  } catch (err) {
    run.ctx.log.warn(
      { addonId: run.addonId, err: errorMessage(err) },
      'could not record an add-on’s trouble',
    );
  }
}

/**
 * `addon.sweep`, hourly: a reconcile for every add-on, in every business, whose last move isn't finished and
 * proved (private.addon_installations_to_reconcile). The safety net behind a lost event and a reconcile that ran
 * out of retries; with nothing unsettled it reads one index and queues nothing.
 */
export const addonSweepJob: JobHandler = async (ctx) => {
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string; addon_id: string }>(
      tx,
      sql`select workspace_id, organization_id, addon_id from private.addon_installations_to_reconcile()
          limit 2000`,
    ),
  );
  if (due.length > 0)
    await asWorker(ctx.db, {}, async (tx) => {
      for (const d of due)
        await scheduleJob(tx, {
          kind: ADDON_JOBS.reconcile,
          dedupeKey: addonReconcileKey(d.workspace_id, d.addon_id),
          runAt: new Date(),
          payload: { addonId: d.addon_id },
          workspaceId: d.workspace_id,
          organizationId: d.organization_id,
        });
    });
  return { rescheduleAt: new Date(Date.now() + HOUR) };
};
