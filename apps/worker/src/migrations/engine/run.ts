/**
 * The loop that moves a business.
 *
 * Work is small leased batches, claimed one at a time by whichever worker gets there first. A worker that
 * dies mid-batch loses a lease, not a migration: its job comes back when the lease runs out and starts from
 * the last checkpoint, and the source-identity index makes the overlap free.
 *
 * The order of operations inside a batch is the part worth reading twice:
 *
 *     read a page  →  stage it  →  normalize  →  write  →  save the checkpoint
 *                     └──────────── one transaction ────────────┘
 *
 * The checkpoint is saved *after* the rows, never before, and in the same transaction as them. That is what
 * makes "resume" mean resume: the worst a crash can do is make us read one page twice, and reading a page
 * twice writes nothing new.
 */
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import {
  CANONICAL_SCHEMA_VERSION,
  categoriesInOrder,
  migrationCategory,
  MIGRATION_PASSES,
  parseCanonical,
  releaseCapability,
  type CanonicalEnvelope,
  type CrmSourceAdapter,
  type MappingContext,
  type SourceScope,
} from '@hfos/core/server';
import type { Logger } from 'pino';
import type { Sealer } from '../../crypto';
import type { SafeFetch } from '../../http/safe-fetch';
import type { ObjectStore } from '../../storage';
import { recordSystemEvent } from '../../system-event';
import type { MigrationAdapters } from '../adapters/registry';
import { IMPORTERS } from '../importers/index';
import { openConnection, scopeFor, SourceAuthError } from './connection';
import { copyMediaBatch, MEDIA_BATCH } from './media';
import {
  addCounts,
  emptyCounts,
  finding,
  quarantine,
  type ImportCounts,
  type ImportScope,
} from './write';

/** A Postgres `text[]` from a list, empty included. */
const textArray = (values: readonly string[]) =>
  values.length === 0
    ? sql`'{}'::text[]`
    : sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;

/** How long a worker holds a batch before another may take it. Longer than any single page should take. */
const LEASE_SECONDS = 300;
/** Records read per batch. Small, so a lease is never the thing that decides whether work is lost. */
const PAGE_SIZE = 100;
/** How many batches one pass of the loop claims. */
export const MIGRATION_BATCH = 4;

export interface MigrationDeps {
  readonly db: Db;
  readonly sealer: Sealer;
  readonly log: Logger;
  readonly adapters: MigrationAdapters;
  /** Where the files land: the same storage a photo texted today lands in. */
  readonly store: ObjectStore;
  /** How a file is fetched from the old system: https only, never a private address (http/safe-fetch.ts). */
  readonly fetchUrl: SafeFetch;
  readonly workerId: string;
  /** Tests run the loop until it is quiet; production runs it on a timer. */
  readonly batchSize?: number;
}

type JobRow = {
  id: string;
  migration_id: string;
  organization_id: string;
  scope_id: string | null;
  workspace_id: string | null;
  kind: string;
  category: string;
  input: Record<string, unknown>;
  attempts: number;
};

export interface LoopStats {
  claimed: number;
  done: number;
  requeued: number;
  failed: number;
}

/** One pass: claim what is due, run it, and say what happened. */
export async function processMigrationJobs(deps: MigrationDeps): Promise<LoopStats> {
  const stats: LoopStats = { claimed: 0, done: 0, requeued: 0, failed: 0 };
  const claimed = await asWorker(deps.db, { workspaceId: null, organizationId: null }, (tx) =>
    rows<JobRow>(
      tx,
      sql`select id, migration_id, organization_id, scope_id, workspace_id, kind::text as kind,
            category, input, attempts
          from private.claim_migration_jobs(${deps.workerId}, ${deps.batchSize ?? MIGRATION_BATCH},
            ${LEASE_SECONDS})`,
    ),
  );
  stats.claimed = claimed.length;
  for (const job of claimed) {
    try {
      const outcome = await runJob(deps, job);
      if (outcome === 'again') stats.requeued += 1;
      else stats.done += 1;
    } catch (e) {
      stats.failed += 1;
      await failJob(deps, job, e as Error);
    }
  }
  return stats;
}

type Outcome = 'done' | 'again';

async function runJob(deps: MigrationDeps, job: JobRow): Promise<Outcome> {
  switch (job.kind) {
    case 'discover':
      return discover(deps, job);
    case 'scan':
      return scanScope(deps, job);
    case 'fetch':
      return fetchCategory(deps, job);
    case 'media':
      return copyFiles(deps, job);
    case 'verify':
      return verify(deps, job);
    case 'rollback':
      return rollback(deps, job);
    default:
      // A kind that has no handler yet is finished rather than retried forever.
      await finishJob(deps, job, { skipped: `nothing handles ${job.kind} yet` });
      return 'done';
  }
}

// ---------- claiming, finishing, failing ----------

async function finishJob(
  deps: MigrationDeps,
  job: JobRow,
  result: Record<string, unknown>,
): Promise<void> {
  await asWorker(deps.db, { workspaceId: null, organizationId: job.organization_id }, (tx) =>
    tx.execute(sql`
      update app.migration_jobs
         set state = 'done', finished_at = now(), leased_by = null, leased_until = null,
             result = ${JSON.stringify(result)}::jsonb
       where id = ${job.id}`),
  );
}

/** Put the batch back with a little more delay each time, and give up after enough tries. */
async function requeueJob(
  deps: MigrationDeps,
  job: JobRow,
  input: Record<string, unknown>,
  delayMs = 0,
): Promise<void> {
  await asWorker(deps.db, { workspaceId: null, organizationId: job.organization_id }, (tx) =>
    tx.execute(sql`
      update app.migration_jobs
         set state = 'pending', leased_by = null, leased_until = null,
             run_at = now() + make_interval(secs => ${Math.round(delayMs / 1000)}),
             input = ${JSON.stringify(input)}::jsonb
       where id = ${job.id}`),
  );
}

const MAX_ATTEMPTS = 6;

async function failJob(deps: MigrationDeps, job: JobRow, error: Error): Promise<void> {
  const auth = error instanceof SourceAuthError;
  const permanent = auth || job.attempts >= MAX_ATTEMPTS;
  const message = error.message.slice(0, 2000);
  // Never the token, never the body. A migration's error log is read by people, and by support.
  deps.log.warn({ jobId: job.id, category: job.category, permanent }, 'migration batch failed');
  // The business too, when the batch had one: the error row carries it, and the worker's own policies only
  // admit rows inside the scope it is holding.
  await asWorker(
    deps.db,
    { workspaceId: job.workspace_id, organizationId: job.organization_id },
    async (tx) => {
      await tx.execute(sql`
      update app.migration_jobs
         set state = ${permanent ? 'failed' : 'retry'},
             leased_by = null, leased_until = null,
             run_at = now() + make_interval(secs => ${Math.min(2 ** job.attempts * 10, 900)}),
             last_error = ${message},
             finished_at = ${permanent ? sql`now()` : sql`null`}
       where id = ${job.id}`);
      await tx.execute(sql`
      insert into app.migration_errors
        (migration_id, organization_id, scope_id, workspace_id, category, kind, code, message, retryable)
      values (${job.migration_id}, ${job.organization_id}, ${job.scope_id}, ${job.workspace_id},
        ${job.category}, ${auth ? 'permission' : 'transient'}::app.migration_error_kind,
        ${auth ? 'reauth_required' : 'batch_failed'}, ${message}, ${!permanent})
      on conflict (migration_id, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), code,
                   coalesce(source_object_type, ''), coalesce(source_object_id, ''))
      do update set attempts = app.migration_errors.attempts + 1, last_seen_at = now(),
        message = excluded.message`);
      if (permanent)
        await tx.execute(sql`
        update app.migrations set status = 'needs_attention', last_error = ${message}
         where id = ${job.migration_id}
           and status in ('scanning', 'importing', 'verifying', 'finalizing', 'rolling_back')`);
    },
  );
}

// ---------- the passes ----------

/** Find the sub-accounts the sign-in reaches, and queue a scan of each. */
async function discover(deps: MigrationDeps, job: JobRow): Promise<Outcome> {
  const migration = await loadMigration(deps, job.migration_id, job.organization_id);
  const opened = await openConnection(
    deps,
    deps.adapters,
    migration.connection_id,
    job.organization_id,
  );
  const found = await opened.adapter.discoverScopes(opened.connection);
  await asWorker(
    deps.db,
    { workspaceId: null, organizationId: job.organization_id },
    async (tx) => {
      for (const s of found) {
        await tx.execute(sql`
        insert into app.migration_scopes
          (migration_id, organization_id, external_scope_id, name, timezone, descriptor, status)
        values (${job.migration_id}, ${job.organization_id}, ${s.externalScopeId}, ${s.name},
          ${s.timezone ?? null}, ${JSON.stringify(s.descriptor ?? {})}::jsonb, 'discovered')
        on conflict (migration_id, external_scope_id)
        do update set name = excluded.name, timezone = excluded.timezone,
          descriptor = excluded.descriptor`);
      }
      // One scan job per sub-account, so a business we cannot read never stops the others.
      await tx.execute(sql`
      insert into app.migration_jobs (migration_id, organization_id, scope_id, kind, category, pass, input)
      select ${job.migration_id}, ${job.organization_id}, s.id, 'scan', 'locations', 0,
        ${JSON.stringify(job.input)}::jsonb
      from app.migration_scopes s
      where s.migration_id = ${job.migration_id} and s.selected`);
      await tx.execute(sql`
      update app.migration_connections set adapter_version = ${opened.adapter.adapterVersion}
       where id = ${migration.connection_id}`);
    },
  );
  await finishJob(deps, job, { scopes: found.length });
  return 'done';
}

/** Read-only. Count what is there, say how sure we are, and raise what will not fit. */
async function scanScope(deps: MigrationDeps, job: JobRow): Promise<Outcome> {
  if (!job.scope_id) {
    await finishJob(deps, job, { skipped: 'no sub-account' });
    return 'done';
  }
  const migration = await loadMigration(deps, job.migration_id, job.organization_id);
  const opened = await openConnection(
    deps,
    deps.adapters,
    migration.connection_id,
    job.organization_id,
  );
  const scopeRow = await loadScope(deps, job.scope_id, job.organization_id);
  const scope = await scopeFor(opened, {
    externalScopeId: scopeRow.external_scope_id,
    name: scopeRow.name,
    timezone: scopeRow.timezone,
  });

  let categories = 0;
  const watermark = new Date();
  for await (const result of opened.adapter.scan(opened.connection, scope)) {
    categories += 1;
    const cat = migrationCategory(result.category);
    await asWorker(
      deps.db,
      { workspaceId: null, organizationId: job.organization_id },
      async (tx) => {
        await tx.execute(sql`
          insert into app.migration_inventory
            (migration_id, organization_id, scope_id, category, resource_id, resource_name, found_count,
             count_quality, capability, estimated_bytes, depends_on, notes, scanned_at)
          values (${job.migration_id}, ${job.organization_id}, ${job.scope_id}, ${result.category},
            ${result.resourceId ?? null}, ${result.resourceName ?? null}, ${result.count},
            ${result.countQuality}::app.migration_count_quality,
            ${result.capability}::app.migration_capability, ${result.estimatedBytes ?? 0},
            ${textArray(cat?.dependsOn ?? [])}, ${result.notes ?? null}, now())
          on conflict (scope_id, category, coalesce(resource_id, ''))
          do update set found_count = excluded.found_count, count_quality = excluded.count_quality,
            capability = excluded.capability, estimated_bytes = excluded.estimated_bytes,
            resource_name = excluded.resource_name, depends_on = excluded.depends_on,
            notes = excluded.notes, scanned_at = now()`);
        for (const f of result.findings ?? [])
          await tx.execute(sql`
            insert into app.migration_findings
              (migration_id, organization_id, scope_id, category, code, capability, severity, summary,
               what_imports, what_changes, recommended_action, source_capability, affected_count, detail)
            values (${job.migration_id}, ${job.organization_id}, ${job.scope_id}, ${result.category},
              ${f.code}, ${f.capability}::app.migration_capability,
              ${f.severity}::app.migration_finding_severity, ${f.summary}, ${f.whatImports ?? null},
              ${f.whatChanges ?? null}, ${f.recommendedAction ?? null}, ${f.sourceCapability ?? null},
              ${f.affectedCount ?? 0}, ${JSON.stringify(f.detail ?? {})}::jsonb)
            on conflict (migration_id, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
                         code, coalesce(category, ''), coalesce(source_capability, ''))
            do update set summary = excluded.summary, last_seen_at = now(),
              affected_count = greatest(app.migration_findings.affected_count, excluded.affected_count)`);
      },
    );
  }

  // Everything chosen by default: the happy path is "bring it all", and a person unticks what they do not want.
  await asWorker(
    deps.db,
    { workspaceId: null, organizationId: job.organization_id },
    async (tx) => {
      await tx.execute(sql`
      insert into app.migration_selections
        (migration_id, organization_id, scope_id, category, resource_id, selected, auto_added, required_by)
      select ${job.migration_id}, ${job.organization_id}, i.scope_id, i.category, null, true, false, '{}'
      from app.migration_inventory i
      where i.scope_id = ${job.scope_id} and i.resource_id is null
        and i.capability in ('ready', 'needs_review', 'action_required')
      on conflict (scope_id, category, coalesce(resource_id, '')) do nothing`);
      await tx.execute(sql`
      update app.migration_scopes set status = 'scanned', scanned_at = now()
       where id = ${job.scope_id} and status in ('discovered', 'scanning', 'mapped', 'scanned')`);
      await tx.execute(sql`
      update app.migration_scans set status = 'scanned', finished_at = now(), watermark_at = ${watermark.toISOString()}
       where migration_id = ${job.migration_id} and status = 'scanning'`);
    },
  );
  // Finished first, then asked: several sub-accounts are scanned at once, and each of them holds a lease
  // while it works. Asking before finishing would mean every one of them sees another still running and
  // none of them ever says the scan is done.
  await finishJob(deps, job, { categories });
  await asWorker(deps.db, { workspaceId: null, organizationId: job.organization_id }, (tx) =>
    tx.execute(sql`
      update app.migrations set status = 'scanned'
       where id = ${job.migration_id} and status = 'scanning'
         and not exists (select 1 from app.migration_jobs j
           where j.migration_id = ${job.migration_id} and j.kind in ('discover', 'scan')
             and j.state in ('pending', 'retry', 'leased'))`),
  );
  return 'done';
}

/**
 * The categories this one hangs off that have not finished reading for this sub-account yet.
 *
 * A category is finished when its checkpoint says complete, or when it was never going to run at all — not
 * chosen, or not something this release imports. Anything else is still working, and a child that reads now
 * would look for parents that have not arrived.
 */
async function unfinishedParents(
  deps: MigrationDeps,
  job: JobRow,
  dependsOn: readonly string[],
): Promise<string[]> {
  const wanted = dependsOn.filter((c) => {
    const parent = migrationCategory(c);
    return parent && parent.release === 'ready';
  });
  if (wanted.length === 0) return [];
  const done = await asWorker(
    deps.db,
    { workspaceId: null, organizationId: job.organization_id },
    (tx) =>
      rows<{ category: string }>(
        tx,
        sql`select category from app.migration_checkpoints
            where migration_id = ${job.migration_id} and scope_id = ${job.scope_id} and complete
            union
            select category from app.migration_selections
            where migration_id = ${job.migration_id} and scope_id = ${job.scope_id} and not selected`,
      ),
  );
  const finished = new Set(done.map((d) => d.category));
  return wanted.filter((c) => !finished.has(c));
}

/**
 * One page of one category: read it, keep what came, turn it into HandsFreeOS's shape, write it, and save
 * where to carry on — all in one transaction, so resuming can only ever re-read, never half-write.
 */
async function fetchCategory(deps: MigrationDeps, job: JobRow): Promise<Outcome> {
  if (!job.scope_id || !job.workspace_id) {
    await finishJob(deps, job, { skipped: 'nowhere to put it' });
    return 'done';
  }
  const cat = migrationCategory(job.category);
  if (!cat || cat.release !== 'ready') {
    await finishJob(deps, job, {
      skipped: cat ? releaseCapability(cat.release) : 'unknown category',
    });
    return 'done';
  }
  /**
   * Two kinds of category are ready and yet have no list to page.
   *
   * The files are listed by the records that point at them, as those records arrive, and fetched afterwards
   * by the media job — paging the source's own file library here would stage thousands of brand assets that
   * have no home in HandsFreeOS and spend a business's API budget doing it.
   *
   * The setup steps — their numbers, their sending domains, what they were plugged into — are worked out
   * during the checks from what the imported data leaves behind, because no source will tell us. Both are
   * genuinely imported; neither is read record by record, and asking for a page would be asking a question
   * nobody answers.
   */
  if (cat.targetType === 'file' || cat.targetType === 'reconnect_task') {
    await finishJob(deps, job, {
      skipped:
        cat.targetType === 'file'
          ? 'files are copied as the records that point at them arrive'
          : 'worked out from the imported data, with the checks',
    });
    await afterCategory(deps, job);
    return 'done';
  }
  /**
   * Wait for what this category hangs off.
   *
   * The pass number puts categories in order, but a category is not one job: it is one job per page, requeued
   * until the pages run out. So a claim can hold a customers job with two pages left and an opportunities job
   * from a later pass, run them in pass order, and still read a deal whose customer has not arrived yet. That
   * is how it went wrong: a deal belonging to a customer on page two was quarantined for having no customer,
   * and nothing retried it because the record, not the job, had failed.
   *
   * So the parents have to be *finished*, not merely started, and finished for this sub-account: a checkpoint
   * per category says so. A category still working gets this one put back with a short wait, which costs a
   * second and saves a hand-run retry.
   */
  const waitingFor = await unfinishedParents(deps, job, cat.dependsOn);
  if (waitingFor.length > 0) {
    await requeueJob(deps, job, job.input, 1_000);
    return 'again';
  }

  const migration = await loadMigration(deps, job.migration_id, job.organization_id);
  const opened = await openConnection(
    deps,
    deps.adapters,
    migration.connection_id,
    job.organization_id,
  );
  const scopeRow = await loadScope(deps, job.scope_id, job.organization_id);
  const scope: SourceScope = await scopeFor(opened, {
    externalScopeId: scopeRow.external_scope_id,
    name: scopeRow.name,
    timezone: scopeRow.timezone,
  });

  const cursor = (job.input['cursor'] ?? null) as Record<string, unknown> | null;
  const page = await opened.adapter.list(opened.connection, scope, job.category, {
    cursor,
    limit: PAGE_SIZE,
    includeDeleted: migration.include_deleted,
  });

  const importScope: ImportScope = {
    migrationId: job.migration_id,
    organizationId: job.organization_id,
    scopeId: job.scope_id,
    workspaceId: job.workspace_id,
    installationId: migration.connection_id,
    sourceSystem: migration.source_system,
    sourceLocationId: scopeRow.external_scope_id,
    timezone: scopeRow.timezone ?? 'America/Chicago',
    defaultCountry: 'US',
    log: deps.log,
  };

  const counts = await asWorker(
    deps.db,
    { workspaceId: job.workspace_id, organizationId: job.organization_id },
    async (tx) => {
      const context = await mappingContext(tx, importScope, opened.adapter);
      let totals = emptyCounts();
      for (const record of page.records) {
        totals = addCounts(totals, { found: 1 });
        await stage(tx, importScope, job.category, record, opened.adapter.adapterVersion);
        let envelopes: readonly CanonicalEnvelope[] = [];
        try {
          envelopes = opened.adapter.normalize(record, context);
        } catch (e) {
          await quarantine(tx, importScope, {
            category: job.category,
            sourceObjectType: record.objectType,
            sourceObjectId: record.objectId,
            kind: 'mapping',
            code: 'normalize_failed',
            message: (e as Error).message,
            retryable: false,
          });
          totals = addCounts(totals, { failed: 1 });
          continue;
        }
        for (const envelope of envelopes) {
          const checked = parseCanonical(envelope);
          if (!checked.ok) {
            await quarantine(tx, importScope, {
              category: job.category,
              sourceObjectType: envelope.source.objectType,
              sourceObjectId: envelope.source.objectId,
              kind: 'mapping',
              code: 'shape_not_understood',
              message: checked.issues.join('; '),
              retryable: false,
              detail: { issues: checked.issues },
            });
            totals = addCounts(totals, { failed: 1 });
            continue;
          }
          // Whatever the adapter could not map is already recorded beside the record; it is never dropped.
          for (const w of envelope.warnings)
            await finding(tx, importScope, {
              code: w.code,
              category: job.category,
              capability: 'needs_review',
              severity: 'info',
              summary: w.message,
              sourceCapability: w.field ?? null,
              affected: 1,
            });
          const importer = IMPORTERS[envelope.canonicalType];
          if (!importer) {
            totals = addCounts(totals, { skipped: 1 });
            continue;
          }
          const result = await importer(tx, importScope, { ...envelope, data: checked.data });
          totals = addCounts(totals, result.counts);
        }
      }
      await checkpoint(tx, importScope, job.category, {
        cursor: page.cursor,
        highWaterAt: page.highWaterAt ?? null,
        counts: totals,
        complete: page.done,
        adapterVersion: opened.adapter.adapterVersion,
      });
      return totals;
    },
  );

  if (!page.done && page.cursor) {
    await requeueJob(deps, job, { ...job.input, cursor: page.cursor });
    return 'again';
  }
  await finishJob(deps, job, { ...counts });
  await afterCategory(deps, job);
  return 'done';
}

/**
 * One batch of files: fetch what the importers listed and point the records at our copies.
 *
 * It runs after the records for a sub-account are in, because a file needs the record it belongs to before
 * it has anywhere to be attached, and it runs before the checks, because "is the photo really here?" is one
 * of the things the checks ask.
 */
async function copyFiles(deps: MigrationDeps, job: JobRow): Promise<Outcome> {
  if (!job.scope_id || !job.workspace_id) {
    await finishJob(deps, job, { skipped: 'nowhere to put it' });
    return 'done';
  }
  const migration = await loadMigration(deps, job.migration_id, job.organization_id);
  const opened = await openConnection(
    deps,
    deps.adapters,
    migration.connection_id,
    job.organization_id,
  );
  const scopeRow = await loadScope(deps, job.scope_id, job.organization_id);
  const sourceScope: SourceScope = await scopeFor(opened, {
    externalScopeId: scopeRow.external_scope_id,
    name: scopeRow.name,
    timezone: scopeRow.timezone,
  });
  const result = await copyMediaBatch(
    deps,
    {
      migrationId: job.migration_id,
      organizationId: job.organization_id,
      scopeId: job.scope_id,
      workspaceId: job.workspace_id,
    },
    { adapter: opened.adapter, connection: opened.connection, sourceScope },
    MEDIA_BATCH,
  );
  if (!result.done) {
    await requeueJob(deps, job, job.input);
    return 'again';
  }
  await finishJob(deps, job, { ...result });
  await afterCategory(deps, job);
  return 'done';
}

/** The payload as it came, kept so a mapping can be corrected later without asking the old system again. */
async function stage(
  tx: Tx,
  scope: ImportScope,
  category: string,
  record: {
    objectType: string;
    objectId: string;
    parentObjectId?: string | null;
    sourceCreatedAt?: Date | null;
    sourceUpdatedAt?: Date | null;
    sourceDeletedAt?: Date | null;
    payload: Record<string, unknown>;
  },
  adapterVersion: string,
): Promise<void> {
  const payload = JSON.stringify(record.payload);
  await tx.execute(sql`
    insert into app.migration_source_objects
      (migration_id, organization_id, scope_id, workspace_id, source_object_type, source_object_id,
       source_parent_object_id, category, source_created_at, source_updated_at, source_deleted_at,
       payload, payload_checksum, adapter_version, state)
    values (${scope.migrationId}, ${scope.organizationId}, ${scope.scopeId}, ${scope.workspaceId},
      ${record.objectType}, ${record.objectId}, ${record.parentObjectId ?? null}, ${category},
      ${record.sourceCreatedAt?.toISOString() ?? null}, ${record.sourceUpdatedAt?.toISOString() ?? null},
      ${record.sourceDeletedAt?.toISOString() ?? null},
      ${payload}::jsonb, md5(${payload}), ${adapterVersion}, 'staged')
    on conflict (scope_id, source_object_type, source_object_id)
    do update set payload = excluded.payload, payload_checksum = excluded.payload_checksum,
      source_updated_at = excluded.source_updated_at, retrieved_at = now(),
      payload_version = app.migration_source_objects.payload_version + 1`);
}

/** Where to carry on from, saved only once the rows a page produced are safely here. */
async function checkpoint(
  tx: Tx,
  scope: ImportScope,
  category: string,
  input: {
    readonly cursor: Record<string, unknown> | null;
    readonly highWaterAt: Date | null;
    readonly counts: ImportCounts;
    readonly complete: boolean;
    readonly adapterVersion: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into app.migration_checkpoints
      (migration_id, organization_id, scope_id, category, cursor, high_water_at, counts, complete,
       adapter_version)
    values (${scope.migrationId}, ${scope.organizationId}, ${scope.scopeId}, ${category},
      ${JSON.stringify(input.cursor ?? {})}::jsonb, ${input.highWaterAt?.toISOString() ?? null},
      ${JSON.stringify(input.counts)}::jsonb, ${input.complete}, ${input.adapterVersion})
    on conflict (scope_id, category) do update set
      cursor = excluded.cursor,
      high_water_at = greatest(app.migration_checkpoints.high_water_at, excluded.high_water_at),
      complete = excluded.complete,
      -- Counts add up across the pages of a category rather than replacing each other.
      counts = jsonb_build_object(
        'found', coalesce((app.migration_checkpoints.counts ->> 'found')::bigint, 0) + ${input.counts.found},
        'imported', coalesce((app.migration_checkpoints.counts ->> 'imported')::bigint, 0) + ${input.counts.imported},
        'merged', coalesce((app.migration_checkpoints.counts ->> 'merged')::bigint, 0) + ${input.counts.merged},
        'skipped', coalesce((app.migration_checkpoints.counts ->> 'skipped')::bigint, 0) + ${input.counts.skipped},
        'needsReview', coalesce((app.migration_checkpoints.counts ->> 'needsReview')::bigint, 0) + ${input.counts.needsReview},
        'failed', coalesce((app.migration_checkpoints.counts ->> 'failed')::bigint, 0) + ${input.counts.failed})`);
}

/** When a category finishes: is the whole business done, and is the whole migration? */
async function afterCategory(deps: MigrationDeps, job: JobRow): Promise<void> {
  /**
   * The files, now that the records they hang off are here. Queued only when the importers actually listed
   * some, and only once: a second job while the first is still working would have both of them claiming the
   * same rows.
   *
   * In its own transaction, and a transaction holding this business: the media rows belong to a workspace,
   * and the worker's policy on them admits only the workspace it is currently holding. The rest of this
   * function runs across the whole migration, where a workspace is not held and this query would see
   * nothing at all.
   */
  if (job.scope_id && job.workspace_id)
    await asWorker(
      deps.db,
      { workspaceId: job.workspace_id, organizationId: job.organization_id },
      (tx) =>
        tx.execute(sql`
      insert into app.migration_jobs
        (migration_id, organization_id, scope_id, workspace_id, kind, category, pass, input)
      select ${job.migration_id}, ${job.organization_id}, ${job.scope_id}, ${job.workspace_id},
        'media', 'media', ${MIGRATION_PASSES.media}, '{}'::jsonb
      where exists (select 1 from app.migration_media m
              where m.scope_id = ${job.scope_id} and m.state = 'pending')
        -- Unless the business said not to bring the files. Saying nothing means bring them.
        and not exists (select 1 from app.migration_selections s
              where s.migration_id = ${job.migration_id} and s.scope_id = ${job.scope_id}
                and s.category = 'media' and not s.selected)
        and not exists (select 1 from app.migration_jobs j
              where j.scope_id = ${job.scope_id} and j.kind = 'media'
                and j.state in ('pending', 'retry', 'leased'))
        and not exists (select 1 from app.migration_jobs j
              where j.scope_id = ${job.scope_id} and j.kind = 'fetch'
                and j.state in ('pending', 'retry', 'leased'))`),
    );
  await asWorker(
    deps.db,
    { workspaceId: null, organizationId: job.organization_id },
    async (tx) => {
      await tx.execute(sql`
      update app.migration_scopes set status = 'imported', imported_at = now()
       where id = ${job.scope_id} and status = 'importing'
         and not exists (select 1 from app.migration_jobs j
           where j.scope_id = ${job.scope_id} and j.kind = 'fetch'
             and j.state in ('pending', 'retry', 'leased'))`);
      const [rest] = await rows<{ count: number }>(
        tx,
        sql`select count(*)::int as count from app.migration_jobs
          where migration_id = ${job.migration_id} and kind in ('fetch', 'media', 'link')
            and state in ('pending', 'retry', 'leased')`,
      );
      if ((rest?.count ?? 0) > 0) return;
      // Everything is in. Queue the checks; the migration is not "imported" until they have run.
      await tx.execute(sql`
      insert into app.migration_jobs (migration_id, organization_id, kind, category, pass, input)
      select ${job.migration_id}, ${job.organization_id}, 'verify', 'locations', 9, '{}'::jsonb
      where not exists (select 1 from app.migration_jobs j
        where j.migration_id = ${job.migration_id} and j.kind = 'verify'
          and j.state in ('pending', 'retry', 'leased'))`);
      await tx.execute(sql`
      update app.migrations set status = 'verifying'
       where id = ${job.migration_id} and status = 'importing'`);
    },
  );
}

// ---------- the checks ----------

interface FileTally {
  readonly total: number;
  readonly stored: number;
  /** Asked for and not had: gone from the old system, too big, or broken after every try. */
  readonly gone: number;
  readonly waiting: number;
}

/**
 * How the file copying went, across every business this migration wrote into.
 *
 * One transaction per business, because the worker's own policy on the media rows admits only the business
 * it is currently holding — the same reason the reconnect list is built that way.
 */
async function countFiles(deps: MigrationDeps, job: JobRow): Promise<FileTally> {
  const workspaces = await asWorker(
    deps.db,
    { workspaceId: null, organizationId: job.organization_id },
    (tx) =>
      rows<{ workspace_id: string }>(
        tx,
        sql`select distinct workspace_id::text as workspace_id from app.migration_scopes
            where migration_id = ${job.migration_id} and workspace_id is not null`,
      ),
  );
  let total = 0;
  let stored = 0;
  let gone = 0;
  let waiting = 0;
  for (const { workspace_id: workspaceId } of workspaces) {
    const [row] = await asWorker(
      deps.db,
      { workspaceId, organizationId: job.organization_id },
      (tx) =>
        rows<{ total: number; stored: number; gone: number; waiting: number }>(
          tx,
          sql`select count(*)::int as total,
                count(*) filter (where state = 'stored')::int as stored,
                count(*) filter (where state in ('missing', 'skipped', 'failed'))::int as gone,
                count(*) filter (where state in ('pending', 'copying'))::int as waiting
              from app.migration_media where migration_id = ${job.migration_id}`,
        ),
    );
    total += row?.total ?? 0;
    stored += row?.stored ?? 0;
    gone += row?.gone ?? 0;
    waiting += row?.waiting ?? 0;
  }
  return { total, stored, gone, waiting };
}

/**
 * Counting is not proof, so this does not only count. It checks that every source record has exactly one
 * record here, that nothing points at something that is not there, and that the history really kept its own
 * dates — that last one because it is the promise most easily broken by a careless default.
 */
/**
 * The things nobody can migrate for them, discovered rather than asked for.
 *
 * A sub-account's own phone numbers, sending domains and connected apps are the three things GoHighLevel will
 * not list through the API — the scan says so in as many words. But a migration has just read five years of
 * that business's own records, and the answers are sitting in them: the number a text went out from is a
 * number they use, the address an email was sent from is a domain they send from, and a bill with money
 * against it means somebody took a payment somewhere.
 *
 * So the list is built from what arrived. Each row is one thing a person has to do, in their words, with
 * where to do it — and `blocks_live_use` marks the ones that stop the business working the way it expects
 * (its number, and taking money), which is what `migration.finalize` refuses to finish without.
 *
 * Written at the end of the import and safe to run again: the unique key is the task itself, and a row a
 * person has already ticked off is never reopened.
 */
async function findReconnectTasks(deps: MigrationDeps, job: JobRow): Promise<void> {
  /**
   * The businesses, as the organization: a migration's own rows belong to it rather than to any one of them.
   *
   * By business and not by sub-account, which matters when several sub-accounts land in one: porting a
   * number is one job however many of the old system's accounts the business was spread across, and a list
   * that says it twice is a list somebody stops reading. The rows are written with no sub-account for the
   * same reason, and the unique index then holds one of each per business.
   */
  const workspaces = await asWorker(
    deps.db,
    { workspaceId: null, organizationId: job.organization_id },
    (tx) =>
      rows<{ workspace_id: string }>(
        tx,
        sql`select distinct s.workspace_id::text as workspace_id
            from app.migration_scopes s
            where s.migration_id = ${job.migration_id} and s.workspace_id is not null and s.selected`,
      ),
  );

  const put = async (
    tx: Tx,
    input: {
      workspaceId: string;
      kind: string;
      provider: string;
      label: string;
      instructions: string;
      settingsPath: string | null;
      blocksLiveUse: boolean;
      descriptor?: Record<string, unknown>;
    },
  ) => {
    await tx.execute(sql`
      insert into app.migration_reconnect_tasks (migration_id, organization_id, scope_id, workspace_id,
        kind, provider, label, state, instructions, settings_path, descriptor, blocks_live_use)
      values (${job.migration_id}, ${job.organization_id}, null,
        ${input.workspaceId}::uuid, ${input.kind}::app.reconnect_kind, ${input.provider},
        ${input.label.slice(0, 200)}, 'todo'::app.reconnect_state, ${input.instructions.slice(0, 4000)},
        ${input.settingsPath}, ${JSON.stringify(input.descriptor ?? {})}::jsonb, ${input.blocksLiveUse})
      on conflict (migration_id, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), kind,
                   provider, label)
      do nothing`);
  };

  for (const { workspace_id: workspaceId } of workspaces)
    await asWorker(deps.db, { workspaceId, organizationId: job.organization_id }, async (tx) => {
      // The numbers they text and ring from. A number is the business's identity to its customers, and moving
      // one is the carrier's process rather than a copy — so this is a task, never something we do quietly.
      const numbers = await rows<{ number: string }>(
        tx,
        sql`select distinct number from (
            select c.from_e164 as number from app.calls c
            where c.workspace_id = ${workspaceId}::uuid and c.direction = 'outbound'
              and c.from_e164 is not null
            union
            select m.from_address from app.messages m
            where m.workspace_id = ${workspaceId}::uuid and m.direction = 'outbound'
              and m.channel = 'sms' and m.from_address like '+%'
          ) n
          order by number limit 10`,
      );
      for (const { number } of numbers)
        await put(tx, {
          workspaceId,
          kind: 'messaging',
          provider: 'carrier',
          label: number,
          instructions:
            'Your customers know this number, so it moves rather than being replaced: the carrier ports it, ' +
            'with your say-so and a form. Nothing happens to it until you start that, and your old system keeps ' +
            'working on it until the day it moves. Texts and calls only arrive here once it has.',
          settingsPath: '/settings/phone',
          blocksLiveUse: true,
          descriptor: { number },
        });

      // The domains they send email from. DNS is the business's own, and nobody can set it for them.
      const domains = await rows<{ domain: string }>(
        tx,
        sql`select distinct lower(split_part(m.from_address, '@', 2)) as domain
          from app.messages m
          where m.workspace_id = ${workspaceId}::uuid and m.direction = 'outbound'
            and m.channel = 'email' and position('@' in coalesce(m.from_address, '')) > 1
          order by domain limit 10`,
      );
      for (const { domain } of domains)
        await put(tx, {
          workspaceId,
          kind: 'dns',
          provider: 'email',
          label: domain,
          instructions:
            `You sent email from ${domain}. To send it from here, that domain needs two DNS records so mailboxes ` +
            'trust it — Settings shows them and checks them for you. Until it is set up, email goes out from ' +
            'the HandsFreeOS address instead, which works but does not look like you.',
          settingsPath: '/settings/email',
          blocksLiveUse: false,
          descriptor: { domain },
        });

      // Money moved somewhere. No key, no token and no card ever comes across, so taking payments here is a
      // connection somebody makes on purpose.
      const [tookMoney] = await rows<{ count: number }>(
        tx,
        sql`select count(*)::int as count from app.invoices i
          where i.workspace_id = ${workspaceId}::uuid and i.amount_paid_cents > 0`,
      );
      if ((tookMoney?.count ?? 0) > 0)
        await put(tx, {
          workspaceId,
          kind: 'payments',
          provider: 'payments',
          label: 'The account you take payments into',
          instructions:
            'Your old system took card payments through an account of its own. No key, token or card number ' +
            'comes across — they never do — so connect the account you want to be paid into here, and the ' +
            'bills that are still owed can be paid again. What was already paid is recorded as history and is ' +
            'not charged twice.',
          settingsPath: '/settings/payments',
          blocksLiveUse: true,
        });

      // A calendar came across without the diaries behind it: a person's own busy time is theirs to connect.
      const [calendars] = await rows<{ count: number }>(
        tx,
        sql`select count(*)::int as count from app.calendars c
          where c.workspace_id = ${workspaceId}::uuid`,
      );
      if ((calendars?.count ?? 0) > 0)
        await put(tx, {
          workspaceId,
          kind: 'calendar',
          provider: 'calendar',
          label: 'Everyone’s own calendar',
          instructions:
            'The visits came across, and the diaries behind them did not: HandsFreeOS reads each person’s own ' +
            'calendar to know when they are busy, and that is a sign-in only they can do. Until they do, ' +
            'bookings here cannot see the rest of their day.',
          settingsPath: '/settings/calendars',
          blocksLiveUse: false,
        });

      /**
       * The inbox itself, which is not the same job as the domain.
       *
       * DNS makes mail sent from here look like them. It does nothing about where a *reply* lands: that
       * arrives in whatever mailbox the customer hits reply to, and unless that mailbox is connected, the
       * reply sits in Gmail and the thread here just stops.
       */
      const [sentMail] = await rows<{ count: number }>(
        tx,
        sql`select count(*)::int as count from app.messages m
          where m.workspace_id = ${workspaceId}::uuid and m.channel = 'email'
            and m.direction = 'outbound'`,
      );
      if ((sentMail?.count ?? 0) > 0)
        await put(tx, {
          workspaceId,
          kind: 'mailbox',
          provider: 'mailbox',
          label: 'The inbox your email replies land in',
          instructions:
            'Your email history is here. What is not is the mailbox itself: when a customer hits reply, it ' +
            'goes wherever it always went. Connect that inbox and replies join the conversation here instead ' +
            'of sitting where nobody sees them beside the rest of the thread.',
          settingsPath: '/settings/mailboxes',
          blocksLiveUse: false,
        });

      /**
       * Their reviews, which are the happiest item on this list.
       *
       * They were never the old system's to keep: Google and Facebook hold them, and that system only
       * showed them. Leaving loses nothing — so this is not a warning, it is where to look now.
       */
      const [hadReviews] = await rows<{ count: number }>(
        tx,
        sql`select coalesce(sum(i.found_count), 0)::int as count from app.migration_inventory i
          join app.migration_scopes s on s.id = i.scope_id
          where s.workspace_id = ${workspaceId}::uuid and i.category = 'reviews'`,
      );
      if ((hadReviews?.count ?? 0) > 0)
        await put(tx, {
          workspaceId,
          kind: 'reviews',
          provider: 'reviews',
          label: 'Where your reviews are read from',
          instructions:
            'Your old system showed you your Google and Facebook reviews. It never held them — those live ' +
            'on Google and Facebook, and leaving loses not one of them. Connect the two here and they show ' +
            'in Reviews, with somewhere to write an answer that lands where people will read it.',
          settingsPath: '/reviews',
          blocksLiveUse: false,
        });

      /**
       * The form on their website, which is still posting to the old system.
       *
       * This is the quiet one. Everything else that is left undone is visibly undone — a number that does
       * not ring, mail that goes out looking wrong. A form keeps working perfectly and keeps sending every
       * new enquiry to an account the business is about to close.
       */
      const forms = await rows<{ name: string; slug: string }>(
        tx,
        sql`select f.name, f.slug from app.forms f
          where f.workspace_id = ${workspaceId}::uuid
          order by lower(f.name) limit 10`,
      );
      for (const { name, slug } of forms)
        await put(tx, {
          workspaceId,
          kind: 'other',
          provider: 'website',
          label: name,
          instructions:
            `"${name}" is here with every answer anybody gave it, but the copy on your website is still the ` +
            'old one, and it still sends what people fill in to the old system. Publish this one, then put ' +
            'its link or its embed on your site in place of the old one. Until you do, new enquiries go to ' +
            'the account you are leaving.',
          settingsPath: '/settings/forms',
          blocksLiveUse: false,
          descriptor: { slug },
        });
    });
}

async function verify(deps: MigrationDeps, job: JobRow): Promise<Outcome> {
  const finalize = job.input['finalize'] === true;
  // What nobody can migrate for them, found from what their own data leaves behind. Before the checks, so a
  // migration that is about to be called finished already knows what is still owed.
  await findReconnectTasks(deps, job);
  // The files, counted before the checks start: they belong to a business, and the checks run across the
  // whole migration where no business is held, so counting them there would count nothing.
  const files = await countFiles(deps, job);
  await asWorker(
    deps.db,
    { workspaceId: null, organizationId: job.organization_id },
    async (tx) => {
      const put = async (
        kind: string,
        category: string | null,
        result: 'passed' | 'warned' | 'failed',
        expected: number | null,
        actual: number | null,
        summary: string,
      ) => {
        await tx.execute(sql`
        insert into app.migration_verifications
          (migration_id, organization_id, scope_id, category, kind, result, expected_count, actual_count,
           discrepancy, summary)
        values (${job.migration_id}, ${job.organization_id}, null, ${category},
          ${kind}::app.migration_check_kind, ${result}::app.migration_check_result, ${expected},
          ${actual}, ${(expected ?? 0) - (actual ?? 0)}, ${summary})
        on conflict (migration_id, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), kind,
                     coalesce(category, ''))
        do update set result = excluded.result, expected_count = excluded.expected_count,
          actual_count = excluded.actual_count, discrepancy = excluded.discrepancy,
          summary = excluded.summary, ran_at = now()`);
      };

      // What arrived against what the old system said it had.
      const perCategory = await rows<{ category: string; expected: number; actual: number }>(
        tx,
        sql`select c.category,
            coalesce((select sum(i.found_count) from app.migration_inventory i
                      where i.migration_id = c.migration_id and i.category = c.category
                        and i.resource_id is null), 0)::bigint as expected,
            sum(coalesce((c.counts ->> 'imported')::bigint, 0)
              + coalesce((c.counts ->> 'merged')::bigint, 0)
              + coalesce((c.counts ->> 'skipped')::bigint, 0))::bigint as actual
          from app.migration_checkpoints c
          where c.migration_id = ${job.migration_id}
          group by c.category, c.migration_id`,
      );
      for (const row of perCategory) {
        const expected = Number(row.expected);
        const actual = Number(row.actual);
        const label = migrationCategory(row.category)?.label ?? row.category;
        await put(
          'counts',
          row.category,
          actual >= expected ? 'passed' : 'warned',
          expected,
          actual,
          actual >= expected
            ? `${label}: everything the old system listed is here.`
            : `${label}: ${expected - actual} fewer than the old system listed. They may have been added or removed while we read.`,
        );
      }

      // One record here per source record. A second mapping to the same source id would be the one bug that
      // matters most, so it is checked rather than assumed.
      const [dupes] = await rows<{ count: number }>(
        tx,
        sql`select count(*)::int as count from (
            select workspace_id, source_object_type, source_object_id, count(distinct target_id) as n
            from app.migration_source_mappings where last_migration_id = ${job.migration_id}
            group by 1, 2, 3 having count(distinct target_id) > 1) d`,
      );
      await put(
        'identity',
        null,
        (dupes?.count ?? 0) === 0 ? 'passed' : 'failed',
        0,
        dupes?.count ?? 0,
        (dupes?.count ?? 0) === 0
          ? 'Every record from the old system matches exactly one record here.'
          : `${dupes?.count} records from the old system ended up as more than one here.`,
      );

      // Nothing pointing at something that is not there.
      const [orphans] = await rows<{ count: number }>(
        tx,
        sql`select count(*)::int as count from app.migration_source_mappings m
          where m.last_migration_id = ${job.migration_id} and m.target_type = 'person'
            and not exists (select 1 from app.people p where p.id = m.target_id)`,
      );
      await put(
        'references',
        'contacts',
        (orphans?.count ?? 0) === 0 ? 'passed' : 'failed',
        0,
        orphans?.count ?? 0,
        (orphans?.count ?? 0) === 0
          ? 'Every customer this brought across is still there.'
          : `${orphans?.count} customers this brought across have since gone.`,
      );

      // The promise most easily broken by a careless default: a customer added in 2019 still says 2019.
      const [history] = await rows<{ wrong: number; total: number }>(
        tx,
        sql`select
            count(*) filter (where o.source_created_at is not null
              and abs(extract(epoch from (p.created_at - o.source_created_at))) > 60)::int as wrong,
            count(*)::int as total
          from app.migration_source_mappings m
          join app.people p on p.id = m.target_id
          join app.migration_source_objects o
            on o.source_object_id = m.source_object_id and o.source_object_type = m.source_object_type
           and o.workspace_id = m.workspace_id
          where m.last_migration_id = ${job.migration_id} and m.target_type = 'person' and m.created_here`,
      );
      await put(
        'history',
        'contacts',
        (history?.wrong ?? 0) === 0 ? 'passed' : 'failed',
        history?.total ?? 0,
        (history?.total ?? 0) - (history?.wrong ?? 0),
        (history?.wrong ?? 0) === 0
          ? 'Imported customers show the date the old system first knew them, not today.'
          : `${history?.wrong} customers show the date they were imported instead of the date they were added.`,
      );

      /**
       * The photos, recordings and attachments: not "did we try", but "is it here, and does the record
       * point at our copy rather than at theirs". A file we could not fetch is a warning with a number on
       * it, because the business has to know before it cancels the old account, not after.
       */
      const { total, stored, gone, waiting } = files;
      if (total > 0) {
        await put(
          'media',
          'media',
          waiting > 0 ? 'failed' : gone > 0 ? 'warned' : 'passed',
          total,
          stored,
          waiting > 0
            ? `${waiting} of ${total} files have not been copied yet.`
            : gone > 0
              ? `${stored} of ${total} files are now kept here. The other ${gone} could not be fetched from the old system — open the file list to see which.`
              : `All ${total} photos, recordings and attachments are kept here, so the history still opens after you cancel.`,
        );
      }

      const [failed] = await rows<{ count: number }>(
        tx,
        sql`select count(*)::int as count from app.migration_verifications
          where migration_id = ${job.migration_id} and result = 'failed'`,
      );
      const [review] = await rows<{ count: number }>(
        tx,
        sql`select count(*)::int as count from app.migration_merge_candidates
          where migration_id = ${job.migration_id} and resolution = 'pending'`,
      );
      const ok = (failed?.count ?? 0) === 0;
      const [migration] = await rows<{ transition_enabled: boolean }>(
        tx,
        sql`select transition_enabled from app.migrations where id = ${job.migration_id}`,
      );
      // A check that failed is "needs attention". Customers waiting on a decision are not: the import worked,
      // and somebody has a queue to work through.
      const next = !ok
        ? 'needs_attention'
        : finalize
          ? 'completed'
          : migration?.transition_enabled
            ? 'transition'
            : 'imported';
      await tx.execute(sql`
      update app.migrations
         set status = ${next}::app.migration_status,
             imported_at = coalesce(imported_at, now()),
             finalized_at = ${finalize && ok ? sql`now()` : sql`finalized_at`},
             transition_ends_at = case
               when ${next} = 'transition' and transition_ends_at is null then now() + interval '30 days'
               else transition_ends_at end,
             last_error = ${ok ? null : 'Some checks did not pass.'}
       where id = ${job.migration_id}`);
      await recordSystemEvent(tx, {
        type: 'migration.verified',
        action: 'migration.verify',
        organizationId: job.organization_id,
        workspaceId: null,
        entityType: 'migration',
        entityId: job.migration_id,
        payload: { passed: ok, needsReview: review?.count ?? 0, finalize },
        after: {
          checks: ok ? 'all passed' : 'something needs a look',
          waitingOnSomebody: review?.count ?? 0,
        },
        correlationId: job.id,
        causationId: job.id,
      });
    },
  );
  await finishJob(deps, job, { finalize });
  return 'done';
}

// ---------- taking it back ----------

/**
 * Rollback removes what this migration made and nothing else.
 *
 * The two lines it will not cross: a customer who was already here is never deleted, and a field somebody has
 * changed since is never overwritten — a later edit by a person beats the import that came before it, and the
 * report says which ones were left alone and why.
 */
async function rollback(deps: MigrationDeps, job: JobRow): Promise<Outcome> {
  // A migration can reach several businesses, and the worker is root inside exactly one at a time. So the
  // work is done business by business: that is what keeps one rollback from being able to touch another
  // business's customers even if something above it went wrong.
  const workspaces = await asWorker(
    deps.db,
    { workspaceId: null, organizationId: job.organization_id },
    (tx) =>
      rows<{ workspace_id: string }>(
        tx,
        sql`select distinct workspace_id from app.migration_scopes
            where migration_id = ${job.migration_id} and workspace_id is not null`,
      ),
  );

  let removed = 0;
  let guarded = 0;
  for (const { workspace_id: workspaceId } of workspaces) {
    const result = await asWorker(
      deps.db,
      { workspaceId, organizationId: job.organization_id },
      async (tx) => {
        let gone = 0;
        let kept = 0;
        // Fields first, so a record is put back before anything that referred to it goes.
        const updates = await rows<{
          id: string;
          target_type: string;
          target_id: string;
          changed_fields: Record<string, { before: unknown; after: unknown }>;
        }>(
          tx,
          sql`select id::text as id, target_type, target_id::text as target_id, changed_fields
              from app.migration_change_journal
              where migration_id = ${job.migration_id} and workspace_id = ${workspaceId}
                and action in ('update', 'merge', 'link') and reverted_at is null
              order by id desc`,
        );
        for (const entry of updates) {
          if (entry.target_type !== 'person') continue;
          const columns = Object.keys(entry.changed_fields);
          if (columns.length === 0) continue;
          // Only where the value is still the one we wrote. Anything else is somebody's work, and it stands.
          let restored = 0;
          for (const [column, change] of Object.entries(entry.changed_fields)) {
            if (!/^[a-z_]+$/.test(column)) continue;
            await tx.execute(sql`
              update app.people set ${sql.raw(column)} = ${(change.before ?? null) as never}
               where id = ${entry.target_id}::uuid and workspace_id = ${workspaceId}
                 and ${sql.raw(column)}::text is not distinct from ${(change.after ?? null) as never}::text`);
            const [still] = await rows<{ same: boolean }>(
              tx,
              sql`select (${sql.raw(column)}::text is not distinct from ${(change.before ?? null) as never}::text)
                    as same
                  from app.people where id = ${entry.target_id}::uuid`,
            );
            if (still?.same) restored += 1;
          }
          if (restored < columns.length) kept += 1;
          await tx.execute(sql`
            update app.migration_change_journal
               set reverted_at = now(),
                   revert_skipped_reason = ${restored === columns.length ? null : 'changed_since'}
             where id = ${entry.id}::bigint`);
        }

        // Then the records this migration made, and only those.
        const made = await rows<{ target_type: string; target_id: string }>(
          tx,
          sql`select target_type, target_id::text as target_id
              from app.migration_source_mappings
              where first_migration_id = ${job.migration_id} and created_here
                and workspace_id = ${workspaceId}`,
        );
        for (const m of made) {
          // Archived rather than destroyed: somebody who rolls a migration back by mistake should not lose
          // the records twice over, and an archived customer comes back in one click.
          //
          // Tags are deliberately left alone. A tag is a label the business uses, not a record the migration
          // owns — by now people here have put "VIP" on customers of their own, and taking the tag away
          // would strip it off those too.
          if (m.target_type === 'person')
            await tx.execute(
              sql`update app.people set archived_at = now()
                  where id = ${m.target_id}::uuid and workspace_id = ${workspaceId}
                    and archived_at is null`,
            );
          else if (m.target_type === 'company')
            await tx.execute(
              sql`update app.companies set archived_at = now()
                  where id = ${m.target_id}::uuid and workspace_id = ${workspaceId}
                    and archived_at is null`,
            );
          else continue;
          gone += 1;
        }
        await tx.execute(sql`
          delete from app.migration_source_mappings
           where first_migration_id = ${job.migration_id} and created_here
             and workspace_id = ${workspaceId}`);
        return { gone, kept };
      },
    );
    removed += result.gone;
    guarded += result.kept;
  }

  await asWorker(deps.db, { workspaceId: null, organizationId: job.organization_id }, (tx) =>
    tx.execute(sql`
      update app.migrations set status = 'rolled_back', last_error = null
       where id = ${job.migration_id}`),
  );
  await finishJob(deps, job, { removed, leftAlone: guarded });
  return 'done';
}

// ---------- small loaders ----------

type MigrationRow = {
  id: string;
  connection_id: string;
  source_system: string;
  include_deleted: boolean;
  status: string;
};

async function loadMigration(
  deps: MigrationDeps,
  id: string,
  organizationId: string,
): Promise<MigrationRow> {
  const [row] = await asWorker(deps.db, { workspaceId: null, organizationId }, (tx) =>
    rows<MigrationRow>(
      tx,
      sql`select id, connection_id, source_system::text as source_system, include_deleted,
            status::text as status
          from app.migrations where id = ${id}`,
    ),
  );
  if (!row) throw new Error('that migration is gone');
  return row;
}

type ScopeRow = {
  id: string;
  external_scope_id: string;
  name: string;
  timezone: string | null;
  workspace_id: string | null;
};

async function loadScope(
  deps: MigrationDeps,
  id: string,
  organizationId: string,
): Promise<ScopeRow> {
  const [row] = await asWorker(deps.db, { workspaceId: null, organizationId }, (tx) =>
    rows<ScopeRow>(
      tx,
      sql`select id, external_scope_id, name, timezone, workspace_id
          from app.migration_scopes where id = ${id}`,
    ),
  );
  if (!row) throw new Error('that business is gone from the migration');
  return row;
}

/** What a mapper may look things up in: the custom-field shapes already seen, and nothing else. */
async function mappingContext(
  tx: Tx,
  scope: ImportScope,
  adapter: CrmSourceAdapter,
): Promise<MappingContext> {
  const fields = await rows<{ source_object_id: string; payload: Record<string, unknown> }>(
    tx,
    sql`select source_object_id, payload from app.migration_source_objects
        where scope_id = ${scope.scopeId} and source_object_type = 'custom_field' limit 500`,
  );
  return {
    locationId: scope.sourceLocationId,
    installationId: scope.installationId,
    adapterVersion: adapter.adapterVersion,
    timezone: scope.timezone,
    defaultCountry: scope.defaultCountry,
    customFields: new Map(
      fields.map((f) => [
        f.source_object_id,
        {
          key: String(f.payload['fieldKey'] ?? f.payload['name'] ?? f.source_object_id),
          type: String(f.payload['dataType'] ?? 'text'),
        },
      ]),
    ),
  };
}

export { CANONICAL_SCHEMA_VERSION, categoriesInOrder };
