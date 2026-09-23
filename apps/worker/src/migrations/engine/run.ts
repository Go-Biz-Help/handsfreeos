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
import type { SQL } from 'drizzle-orm';
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

/** A journalled value that belongs in a `jsonb` column rather than a scalar one. */
const isObject = (v: unknown): boolean => v !== null && typeof v === 'object';

/** How long a worker holds a batch before another may take it. Longer than any single page should take. */
const LEASE_SECONDS = 300;
/** Records read per batch. Small, so a lease is never the thing that decides whether work is lost. */
const PAGE_SIZE = 100;
/** Copied files looked at per page while a rollback tidies storage up behind itself. */
const MEDIA_REAP_PAGE = 200;
/** How many batches one pass of the loop claims. */
export const MIGRATION_BATCH = 4;

/** How long a category keeps reading pages in one turn, and the most pages it takes, before it yields. */
const PAGE_BUDGET_MS = 10_000;
const MAX_PAGES_PER_TURN = 50;

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
  /** How long one category may keep reading pages in a turn before it yields (`PAGE_BUDGET_MS`). */
  readonly pageBudgetMs?: number;
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
    case 'import':
      return importDecided(deps, job);
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

/**
 * Put the batch back to carry on: its page is saved, or it is waiting its turn.
 *
 * Neither is a failure, so the count of tries starts again. Claiming counts a try every time, and a category
 * is one batch claimed once per page — so without this, the messages of 800 conversations had used up every
 * try by the seventh conversation, and the first hiccup after that (one 429, one timeout) failed the whole
 * category for good, with no retry at all. `attempts` is what `failJob` reads as "tries in a row that went
 * wrong", and now it is.
 */
async function requeueJob(
  deps: MigrationDeps,
  job: JobRow,
  input: Record<string, unknown>,
  delayMs = 0,
): Promise<void> {
  await asWorker(deps.db, { workspaceId: null, organizationId: job.organization_id }, (tx) =>
    tx.execute(sql`
      update app.migration_jobs
         set state = 'pending', leased_by = null, leased_until = null, attempts = 0,
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

  /**
   * Page after page for a few seconds, then back in the queue behind everyone else. One page a turn cost a
   * whole worker pass and its pause for every page, and a GoHighLevel account reads its messages one
   * conversation to a page: 778 turns for the first real account, most of an hour on their own. Nothing about
   * a page changes — each is still read from the checkpoint and saved with it, alone — only how many a turn
   * may take before it yields.
   */
  const turnStarted = Date.now();
  for (let pagesThisTurn = 1; ; pagesThisTurn++) {
    /**
     * Where to start: the checkpoint, not the batch.
     *
     * The checkpoint is saved in the same transaction as the page it describes, so it is the one place that
     * cannot be behind. The batch's own copy is written afterwards and can be, and there can be more than one
     * batch for a category: every press of "Bring it across" on a stopped move used to queue a whole new set,
     * each starting from the top, each adding what it read to the same count. That is what "12 of 4
     * calendars" was — the same four read three times — and why the customers never finished. So a batch that
     * finds its category already complete stops, and every other one carries on from the one true mark.
     */
    const mark = await asWorker(
      deps.db,
      { workspaceId: null, organizationId: job.organization_id },
      (tx) =>
        rows<{ cursor: Record<string, unknown> | null; complete: boolean }>(
          tx,
          sql`select cursor, complete from app.migration_checkpoints
            where scope_id = ${job.scope_id} and category = ${job.category}`,
        ),
    );
    if (mark[0]?.complete) {
      await finishJob(deps, job, { skipped: 'already read' });
      return 'done';
    }
    const saved = mark[0]?.cursor;
    const cursor = saved && Object.keys(saved).length > 0 ? saved : null;
    const page = await opened.adapter.list(opened.connection, scope, job.category, {
      cursor,
      limit: PAGE_SIZE,
      includeDeleted: migration.include_deleted,
    });

    const counts = await asWorker(
      deps.db,
      { workspaceId: job.workspace_id, organizationId: job.organization_id },
      async (tx) => {
        /**
         * Nobody else has saved this page first. Two batches for one category can read the same mark at the
         * same moment; the row lock makes them take turns, and the second finds the mark has moved on and
         * leaves without writing or counting anything.
         */
        await tx.execute(sql`
        insert into app.migration_checkpoints
          (migration_id, organization_id, scope_id, category, cursor, counts, complete, adapter_version)
        values (${importScope.migrationId}, ${importScope.organizationId}, ${importScope.scopeId},
          ${job.category}, '{}'::jsonb, '{}'::jsonb, false, ${opened.adapter.adapterVersion})
        on conflict (scope_id, category) do nothing`);
        const [held] = await rows<{ same: boolean }>(
          tx,
          sql`select (not complete and cursor = ${JSON.stringify(cursor ?? {})}::jsonb) as same
            from app.migration_checkpoints
            where scope_id = ${importScope.scopeId} and category = ${job.category}
            for update`,
        );
        if (!held?.same) return null;

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
            const importer = IMPORTERS[envelope.canonicalType];
            if (!importer) {
              totals = addCounts(totals, { skipped: 1 });
              continue;
            }
            /**
             * One record at a time, each behind its own savepoint. A record the database refuses — a customer
             * with no name at all, a value too long for its column — used to take the whole transaction with
             * it, so the page of a hundred failed, was tried again, failed the same way, and the category never
             * finished. Now that one record is set aside with the database's reason on it, and the other
             * ninety-nine come across.
             */
            try {
              const result = await tx.transaction(async (one) => {
                // Whatever the adapter could not map is recorded beside the record; it is never dropped.
                for (const w of envelope.warnings)
                  await finding(one, importScope, {
                    code: w.code,
                    category: job.category,
                    capability: 'needs_review',
                    severity: 'info',
                    summary: w.message,
                    sourceCapability: w.field ?? null,
                    affected: 1,
                  });
                return importer(one, importScope, { ...envelope, data: checked.data });
              });
              totals = addCounts(totals, result.counts);
            } catch (e) {
              const err = e as Error & { cause?: { message?: string } };
              await quarantine(tx, importScope, {
                category: job.category,
                sourceObjectType: envelope.source.objectType,
                sourceObjectId: envelope.source.objectId,
                kind: 'target',
                code: 'import_refused',
                // The database's own reason, not the statement: the statement carries the record's values.
                message: (err.cause?.message ?? err.message.split('\n')[0] ?? 'refused').slice(
                  0,
                  500,
                ),
                retryable: false,
              });
              totals = addCounts(totals, { failed: 1 });
            }
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

    // Another batch saved this page first: it carries on from here, and this one has nothing left to do.
    if (!counts) {
      await finishJob(deps, job, { skipped: 'another batch read this page' });
      return 'done';
    }
    if (!page.done && page.cursor) {
      const budget = deps.pageBudgetMs ?? PAGE_BUDGET_MS;
      if (Date.now() - turnStarted < budget && pagesThisTurn < MAX_PAGES_PER_TURN) continue;
      await requeueJob(deps, job, { ...job.input, cursor: page.cursor });
      return 'again';
    }
    await finishJob(deps, job, { ...counts });
    await afterCategory(deps, job);
    return 'done';
  }
}

/**
 * One record, brought across the way a person said.
 *
 * The customer importer never guesses: a record that might be somebody already here waits in the review
 * queue, and the import carries on around it. When somebody answers, `migration.resolve_merge` queues one of
 * these with the record's identity and the decision on it. Until 0091 nothing handled the job — it was
 * finished as "nothing handles import yet" — so the queue asked and the answer went nowhere. The customer
 * stayed in the old system and the screen kept saying one person was waiting.
 *
 * Nothing is read from the old system: the record was staged when it was first seen, and it is normalized
 * and imported again from that copy with the decision in the scope, in one transaction, exactly as a page
 * of them would be. The checkpoint's counts move with it, so "99 of 100" becomes "100 of 100".
 */
async function importDecided(deps: MigrationDeps, job: JobRow): Promise<Outcome> {
  if (!job.scope_id || !job.workspace_id) {
    await finishJob(deps, job, { skipped: 'nowhere to put it' });
    return 'done';
  }
  const candidateId = job.input['resolvedCandidateId'];
  const sourceObjectType = job.input['sourceObjectType'];
  const sourceObjectId = job.input['sourceObjectId'];
  if (
    typeof candidateId !== 'string' ||
    typeof sourceObjectType !== 'string' ||
    typeof sourceObjectId !== 'string'
  ) {
    await finishJob(deps, job, { skipped: 'no record named' });
    return 'done';
  }
  const migration = await loadMigration(deps, job.migration_id, job.organization_id);
  const scopeRow = await loadScope(deps, job.scope_id, job.organization_id);
  // The adapter for its mapping only: no connection is opened, because nothing here asks the old system.
  const adapter = deps.adapters.get(migration.source_system);
  if (!adapter) {
    await finishJob(deps, job, { skipped: `nothing here knows ${migration.source_system}` });
    return 'done';
  }
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

  const outcome = await asWorker(
    deps.db,
    { workspaceId: job.workspace_id, organizationId: job.organization_id },
    async (tx): Promise<Record<string, unknown>> => {
      const [candidate] = await rows<{
        resolution: string;
        target_id: string | null;
        category: string;
      }>(
        tx,
        sql`select c.resolution::text as resolution, c.target_id::text as target_id,
              coalesce(o.category, 'contacts') as category
            from app.migration_merge_candidates c
            left join app.migration_source_objects o
              on o.scope_id = c.scope_id and o.source_object_type = c.source_object_type
             and o.source_object_id = c.source_object_id
            where c.id = ${candidateId}::uuid and c.scope_id = ${job.scope_id}`,
      );
      if (!candidate) return { skipped: 'that decision is gone' };
      if (candidate.resolution === 'pending') return { skipped: 'not decided yet' };
      const [staged] = await rows<{
        source_parent_object_id: string | null;
        source_created_at: string | Date | null;
        source_updated_at: string | Date | null;
        source_deleted_at: string | Date | null;
        payload: Record<string, unknown>;
      }>(
        tx,
        sql`select source_parent_object_id, source_created_at, source_updated_at, source_deleted_at, payload
            from app.migration_source_objects
            where scope_id = ${job.scope_id} and source_object_type = ${sourceObjectType}
              and source_object_id = ${sourceObjectId}`,
      );
      if (!staged) return { skipped: 'the old system’s copy of this record is not here' };

      const decided: NonNullable<ImportScope['decided']> = {
        sourceObjectType,
        sourceObjectId,
        resolution:
          candidate.resolution === 'separate'
            ? 'separate'
            : candidate.resolution === 'remapped'
              ? 'remapped'
              : 'merged',
        targetId: candidate.target_id,
      };
      const scope: ImportScope = { ...importScope, decided };
      const context = await mappingContext(tx, scope, adapter);
      const asAt = (v: string | Date | null) => (v ? new Date(v) : null);
      const record = {
        objectType: sourceObjectType,
        objectId: sourceObjectId,
        parentObjectId: staged.source_parent_object_id,
        sourceCreatedAt: asAt(staged.source_created_at),
        sourceUpdatedAt: asAt(staged.source_updated_at),
        sourceDeletedAt: asAt(staged.source_deleted_at),
        payload: staged.payload,
      };
      let totals = emptyCounts();
      let envelopes: readonly CanonicalEnvelope[] = [];
      try {
        envelopes = adapter.normalize(record, context);
      } catch (e) {
        await quarantine(tx, scope, {
          category: candidate.category,
          sourceObjectType,
          sourceObjectId,
          kind: 'mapping',
          code: 'normalize_failed',
          message: (e as Error).message,
          retryable: false,
        });
        totals = addCounts(totals, { failed: 1 });
      }
      for (const envelope of envelopes) {
        const checked = parseCanonical(envelope);
        if (!checked.ok) {
          await quarantine(tx, scope, {
            category: candidate.category,
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
        const importer = IMPORTERS[envelope.canonicalType];
        if (!importer) {
          totals = addCounts(totals, { skipped: 1 });
          continue;
        }
        const result = await importer(tx, scope, { ...envelope, data: checked.data });
        totals = addCounts(totals, result.counts);
      }
      // The record was counted as waiting when it went into the queue; now it is counted as what it became.
      await adjustCounts(tx, scope, candidate.category, {
        ...totals,
        needsReview: totals.needsReview - 1,
      });
      return { ...totals };
    },
  );
  await finishJob(deps, job, outcome);
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

/**
 * Move a category's counts without touching where it has got to. For the one record a person decided
 * about after the page it was on had been saved: the cursor and whether the category is complete stay as
 * they are, and only the numbers change.
 */
async function adjustCounts(
  tx: Tx,
  scope: ImportScope,
  category: string,
  delta: ImportCounts,
): Promise<void> {
  await tx.execute(sql`
    update app.migration_checkpoints set counts = jsonb_build_object(
        'found', greatest(0, coalesce((counts ->> 'found')::bigint, 0) + ${delta.found}),
        'imported', greatest(0, coalesce((counts ->> 'imported')::bigint, 0) + ${delta.imported}),
        'merged', greatest(0, coalesce((counts ->> 'merged')::bigint, 0) + ${delta.merged}),
        'skipped', greatest(0, coalesce((counts ->> 'skipped')::bigint, 0) + ${delta.skipped}),
        'needsReview', greatest(0, coalesce((counts ->> 'needsReview')::bigint, 0) + ${delta.needsReview}),
        'failed', greatest(0, coalesce((counts ->> 'failed')::bigint, 0) + ${delta.failed}))
     where scope_id = ${scope.scopeId} and category = ${category}`);
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
          where migration_id = ${job.migration_id} and kind in ('fetch', 'import', 'media', 'link')
            and state in ('pending', 'retry', 'leased')`,
      );
      if ((rest?.count ?? 0) > 0) return;
      // Everything is in. Queue the checks; the migration is not "imported" until they have run. A move that
      // was finished and put back to work for one decided record is finishing again, so its checks finish.
      await tx.execute(sql`
      insert into app.migration_jobs (migration_id, organization_id, kind, category, pass, input)
      select ${job.migration_id}, ${job.organization_id}, 'verify', 'locations', 9,
        case when m.status = 'finalizing' then '{"finalize": true}'::jsonb else '{}'::jsonb end
      from app.migrations m
      where m.id = ${job.migration_id}
        and not exists (select 1 from app.migration_jobs j
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
      const perCategory = await rows<{
        category: string;
        expected: number;
        actual: number;
        failed: number;
      }>(
        tx,
        sql`select c.category,
            sum(coalesce((c.counts ->> 'failed')::bigint, 0))::bigint as failed,
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
        const failed = Number(row.failed);
        const label = migrationCategory(row.category)?.label ?? row.category;
        // The ones set aside with a reason are known, not a mystery: saying they "may have been added or
        // removed while we read" sent people looking for a problem that was already written down.
        const short = expected - actual;
        const explained = Math.min(failed, short);
        await put(
          'counts',
          row.category,
          actual >= expected ? 'passed' : 'warned',
          expected,
          actual,
          actual >= expected
            ? `${label}: everything the old system listed is here.`
            : explained === short
              ? `${label}: ${short} could not be brought across, each listed with the reason.`
              : `${label}: ${short} fewer than the old system listed${
                  explained > 0 ? ` (${explained} listed with the reason)` : ''
                }. The rest may have been added or removed while we read.`,
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
 * What taking one kind of record back means.
 *
 * **Put it away where the table has somewhere to put it**, because the first rule of a rollback is that
 * pressing it by mistake costs a click, not a customer. **Delete it where the table has not**: a text, a call,
 * a booking, an invoice, a form answer and a note have no archived state, and leaving them is what used to
 * happen — a business that took its import back got its customer list back and kept an inbox, a calendar and
 * a billing history full of the old system's records, with nothing left to say which was which because the
 * rollback had already dropped the mappings that said.
 *
 * `keepWhen` is the second rule, asked per kind: has this record since become something the business made its
 * own? When it has, the record stays, its mapping stays with it so a later import still recognises it, and the
 * journal says `depended_on` rather than claiming it was put back.
 *
 * Three kinds are deliberately absent, the three in `MIGRATION_ROLLBACK_LEAVES`. **Tags**, for the reason they
 * have always been absent: a tag is the business's own label, and by now people here have put "VIP" on
 * customers of their own, so taking the tag away would strip it off those too. **Users**, who are never made
 * by an import, only recognised. And the **stages of a board**, which are part of the board and go with it.
 */
type TakeBack = {
  /** The table, under `app.`. */
  readonly table: string;
  /** How one is put away, or `'delete'` where the table has nowhere to put it. */
  readonly away: 'delete' | SQL;
  /** Not already put away: so a record somebody here has archived themselves is left as they left it. */
  readonly untouched?: SQL;
  /** The record is the business's own work now, so it stays. Asked of the row, `t`. */
  readonly keepWhen?: (workspaceId: string) => SQL;
};

/** True where this migration is the one that made the record named by `column`. */
const madeHere = (migrationId: string, type: string, column: SQL) =>
  sql`exists (select 1 from app.migration_change_journal j
              where j.migration_id = ${migrationId} and j.action = 'create'
                and j.target_type = ${type} and j.target_id = ${column})`;

/**
 * Dependents first, and parents last: a text before the thread it is in, a booking before the calendar it
 * sits on, a deal before its board, and the customers everything above points at right at the end. Children
 * of these rows — invoice lines, form answers, attendees, the stages of a board — go with their parent on the
 * foreign key and are not listed here.
 */
const takeBackPlan = (migrationId: string): ReadonlyArray<readonly [string, TakeBack]> => [
  // The inbox. Texts and calls go; the thread goes with them unless it also holds messages that were not
  // ours, which is a thread the business has used since.
  ['message', { table: 'messages', away: 'delete' }],
  ['call', { table: 'calls', away: 'delete' }],
  [
    'conversation',
    {
      table: 'conversations',
      away: sql`archived_at = now()`,
      untouched: sql`t.archived_at is null`,
      keepWhen: (ws) => sql`
        exists (select 1 from app.messages m
                 where m.conversation_id = t.id and m.workspace_id = ${ws}
                   and not ${madeHere(migrationId, 'message', sql`m.id`)})
        or exists (select 1 from app.calls c
                    where c.conversation_id = t.id and c.workspace_id = ${ws}
                      and not ${madeHere(migrationId, 'call', sql`c.id`)})`,
    },
  ],
  // The calendar. Imported bookings are never pushed out to anybody's Google calendar — nothing gives them
  // staff, and that is what the sync follows — so deleting one leaves nothing behind it.
  ['appointment', { table: 'appointments', away: 'delete' }],
  // A calendar is archived rather than deleted: recurring bookings and a waitlist hold it in place, and
  // `status` is where a calendar goes to be out of the way.
  [
    'calendar',
    {
      table: 'calendars',
      away: sql`status = 'archived'`,
      untouched: sql`t.status <> 'archived'`,
      keepWhen: (ws) => sql`
        exists (select 1 from app.appointments a
                 where a.calendar_id = t.id and a.workspace_id = ${ws})
        or exists (select 1 from app.waitlist_entries w
                    where w.calendar_id = t.id and w.workspace_id = ${ws})`,
    },
  ],
  // The money. An invoice that money really reached here is history and not the import's record to destroy:
  // a card payment carries its provider, a cash one carries the person who wrote it down, and the import's
  // own record of "it was paid over there" carries neither.
  [
    'invoice',
    {
      table: 'invoices',
      away: 'delete',
      keepWhen: (ws) => sql`
        exists (select 1 from app.payments p
                 where p.invoice_id = t.id and p.workspace_id = ${ws} and p.status <> 'failed'
                   and (p.provider is not null or p.connection_id is not null
                        or p.provider_payment_id is not null or p.recorded_by is not null))`,
    },
  ],
  [
    'estimate',
    {
      table: 'estimates',
      away: 'delete',
      keepWhen: (ws) => sql`
        exists (select 1 from app.invoices i
                 where i.estimate_id = t.id and i.workspace_id = ${ws}
                   and not ${madeHere(migrationId, 'invoice', sql`i.id`)})`,
    },
  ],
  ['subscription', { table: 'subscriptions', away: 'delete' }],
  [
    'product',
    { table: 'products', away: sql`archived_at = now()`, untouched: sql`t.archived_at is null` },
  ],
  // The work. A task and a note are the import's own rows, and nothing hangs off them.
  ['task', { table: 'tasks', away: 'delete' }],
  ['activity', { table: 'activities', away: 'delete' }],
  // The board. Deals are archived like the customers they belong to; the board goes with them unless
  // somebody has put a deal of their own on it.
  [
    'lead',
    { table: 'leads', away: sql`archived_at = now()`, untouched: sql`t.archived_at is null` },
  ],
  [
    'pipeline',
    {
      table: 'pipelines',
      away: sql`archived_at = now()`,
      untouched: sql`t.archived_at is null`,
      keepWhen: (ws) => sql`
        exists (select 1 from app.leads l
                 where l.pipeline_id = t.id and l.workspace_id = ${ws}
                   and not ${madeHere(migrationId, 'lead', sql`l.id`)})`,
    },
  ],
  // Forms. Answers go with their response; a form that has taken a real submission since stays published.
  ['form_response', { table: 'form_responses', away: 'delete' }],
  [
    'form',
    {
      table: 'forms',
      // A form's `status` and its `archived_at` are one fact, and the table says so
      // (`(status = 'archived') = (archived_at is not null)`), so both are written or neither is.
      away: sql`status = 'archived', archived_at = now()`,
      untouched: sql`t.archived_at is null`,
      keepWhen: (ws) => sql`
        exists (select 1 from app.form_responses r
                 where r.form_id = t.id and r.workspace_id = ${ws}
                   and not ${madeHere(migrationId, 'form_response', sql`r.id`)})`,
    },
  ],
  [
    'message_template',
    {
      table: 'message_templates',
      away: sql`archived_at = now()`,
      untouched: sql`t.archived_at is null`,
    },
  ],
  // A custom field is archived, never dropped: the answers live in the `custom` object on the records
  // themselves, so putting the field away takes nobody's answers with it.
  [
    'custom_field',
    {
      table: 'custom_fields',
      away: sql`archived_at = now()`,
      untouched: sql`t.archived_at is null`,
    },
  ],
  // Last, the records everything above pointed at.
  //
  // Archived rather than destroyed: somebody who rolls a migration back by mistake should not lose the
  // records twice over, and an archived customer comes back in one click. Finishing them off is the separate
  // act of deleting the migration (0086), which comes after somebody has looked at what came back.
  [
    'person',
    { table: 'people', away: sql`archived_at = now()`, untouched: sql`t.archived_at is null` },
  ],
  [
    'company',
    { table: 'companies', away: sql`archived_at = now()`, untouched: sql`t.archived_at is null` },
  ],
];

/**
 * Rollback removes what this migration made and nothing else.
 *
 * The two lines it will not cross: a record that was already here is never deleted, and a field somebody has
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

  const plan = takeBackPlan(job.migration_id);
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
          // A merge writes into a record that was already here, and the import joins two kinds of record:
          // a customer and a company. Companies used to fall out here, which left a merged company wearing
          // the old system's name and address after the rollback had said it put everything back.
          if (entry.target_type !== 'person' && entry.target_type !== 'company') continue;
          const table = entry.target_type === 'person' ? 'people' : 'companies';
          const columns = Object.keys(entry.changed_fields);
          if (columns.length === 0) continue;
          // Only where the value is still the one we wrote. Anything else is somebody's work, and it stands.
          let restored = 0;
          for (const [column, change] of Object.entries(entry.changed_fields)) {
            if (!/^[a-z_]+$/.test(column)) continue;
            // A field whose values are an object is compared and written as JSON. Comparing those as text
            // would never match: `custom::text` is Postgres's own spacing and key order, not the shape this
            // came back as, so every custom value would read as somebody's later work and stay.
            const asJson = isObject(change.before) || isObject(change.after);
            const before = asJson
              ? sql`${JSON.stringify(change.before ?? {})}::jsonb`
              : sql`${(change.before ?? null) as never}`;
            const unchanged = asJson
              ? sql`${sql.raw(column)} is not distinct from ${JSON.stringify(change.after ?? {})}::jsonb`
              : sql`${sql.raw(column)}::text is not distinct from ${(change.after ?? null) as never}::text`;
            const same = asJson
              ? sql`${sql.raw(column)} is not distinct from ${JSON.stringify(change.before ?? {})}::jsonb`
              : sql`${sql.raw(column)}::text is not distinct from ${(change.before ?? null) as never}::text`;
            // One field the column will not take is one field left alone, not a rollback that dies. A merge
            // journalled before 0092 wrote the words 'kept' and 'filled in' where `custom`'s own values
            // belonged, and writing either of those to a `jsonb` column is an error the whole business's
            // rollback used to fail on. The savepoint keeps it to the field it is about.
            try {
              await tx.transaction(async (step) => {
                await step.execute(sql`
                  update app.${sql.raw(table)} set ${sql.raw(column)} = ${before}
                   where id = ${entry.target_id}::uuid and workspace_id = ${workspaceId}
                     and ${unchanged}`);
                const [still] = await rows<{ same: boolean }>(
                  step,
                  sql`select (${same}) as same
                      from app.${sql.raw(table)} where id = ${entry.target_id}::uuid`,
                );
                if (still?.same) restored += 1;
              });
            } catch (err) {
              deps.log.warn(
                { err, migrationId: job.migration_id, target: entry.target_id, column },
                'a field could not be put back the way the journal recorded it',
              );
            }
          }
          if (restored < columns.length) kept += 1;
          await tx.execute(sql`
            update app.migration_change_journal
               set reverted_at = now(),
                   revert_skipped_reason = ${restored === columns.length ? null : 'changed_since'}
             where id = ${entry.id}::bigint`);
        }

        // The threads that are about to lose messages, remembered while their messages are still here: one
        // that was already the business's own keeps its place in the list, and its summary has to be worked
        // out again from what is left in it rather than pointing at a text that has gone.
        const threads = await rows<{ id: string }>(
          tx,
          sql`select distinct m.conversation_id::text as id
              from app.messages m
              join app.migration_change_journal j on j.target_id = m.id
              where j.migration_id = ${job.migration_id} and j.workspace_id = ${workspaceId}
                and j.action = 'create' and j.target_type = 'message' and j.reverted_at is null
                and m.workspace_id = ${workspaceId}`,
        );

        // Then the records this migration made, and only those, in the order the plan lists them — so
        // nothing is asked to go while something that points at it is still here.
        for (const [type, how] of plan) {
          // **The journal, not the mappings.** Both say what the import made, but the rollback deletes the
          // mappings as it goes, so a rollback that stopped half way — or one that ran before this engine knew
          // about this kind of record at all — has nothing left to read there. The journal is never deleted,
          // and `reverted_at` is exactly "this one has been dealt with", which makes a second pass pick up
          // where the first left off and makes an old, half-done rollback finishable.
          const ours = sql`
            select j.target_id from app.migration_change_journal j
             where j.migration_id = ${job.migration_id} and j.workspace_id = ${workspaceId}
               and j.action = 'create' and j.target_type = ${type} and j.reverted_at is null`;
          // What stays, written down first: the question can only be asked while the record is still here,
          // and writing the answer down is what takes the record out of everything below.
          if (how.keepWhen) {
            const [staying] = await rows<{ n: number }>(
              tx,
              sql`with staying as (
                    update app.migration_change_journal j
                       set reverted_at = now(), revert_skipped_reason = 'depended_on'
                     where j.migration_id = ${job.migration_id} and j.workspace_id = ${workspaceId}
                       and j.action = 'create' and j.target_type = ${type} and j.reverted_at is null
                       and exists (select 1 from app.${sql.raw(how.table)} t
                                    where t.id = j.target_id and t.workspace_id = ${workspaceId}
                                      and (${how.keepWhen(workspaceId)}))
                     returning 1)
                  select count(*)::int as n from staying`,
            );
            kept += staying?.n ?? 0;
          }
          if (how.away === 'delete')
            await tx.execute(sql`
              delete from app.${sql.raw(how.table)} as t
               where t.workspace_id = ${workspaceId} and t.id in (${ours})`);
          else
            await tx.execute(sql`
              update app.${sql.raw(how.table)} as t set ${how.away}
               where t.workspace_id = ${workspaceId} and t.id in (${ours})
                 and ${how.untouched ?? sql`true`}`);
          // The mapping goes with the record. One that stayed keeps its mapping, so a second import
          // recognises it instead of making the business another copy of it.
          await tx.execute(sql`
            delete from app.migration_source_mappings sm
             where sm.first_migration_id = ${job.migration_id} and sm.created_here
               and sm.workspace_id = ${workspaceId} and sm.target_type = ${type}
               and sm.target_id in (${ours})`);
          const [went] = await rows<{ n: number }>(
            tx,
            sql`with went as (
                  update app.migration_change_journal j
                     set reverted_at = now(), revert_skipped_reason = null
                   where j.migration_id = ${job.migration_id} and j.workspace_id = ${workspaceId}
                     and j.action = 'create' and j.target_type = ${type} and j.reverted_at is null
                   returning 1)
                select count(*)::int as n from went`,
          );
          gone += went?.n ?? 0;
        }

        // A stage belongs to the board it is on: the row stays inside the archived board, and its mapping
        // goes with the board's, or a second import would sort new deals into the old board's columns.
        await tx.execute(sql`
          delete from app.migration_source_mappings sm
           where sm.first_migration_id = ${job.migration_id} and sm.created_here
             and sm.workspace_id = ${workspaceId} and sm.target_type = 'pipeline_stage'
             and exists (select 1 from app.pipeline_stages s
                          join app.pipelines p on p.id = s.pipeline_id
                          where s.id = sm.target_id and p.archived_at is not null)`);

        if (threads.length > 0)
          await tx.execute(sql`
            update app.conversations c set
              last_message_at = l.at,
              last_direction = l.direction,
              last_preview = l.preview,
              last_inbound_at = l.inbound_at,
              last_outbound_at = l.outbound_at
            from (
              select v.id,
                (select max(x.occurred_at) from app.messages x where x.conversation_id = v.id) as at,
                (select x.direction from app.messages x where x.conversation_id = v.id
                  order by x.occurred_at desc, x.id desc limit 1) as direction,
                (select nullif(left(coalesce(x.body_text, x.subject, ''), 200), '') from app.messages x
                  where x.conversation_id = v.id
                  order by x.occurred_at desc, x.id desc limit 1) as preview,
                (select max(x.occurred_at) from app.messages x
                  where x.conversation_id = v.id and x.direction = 'inbound') as inbound_at,
                (select max(x.occurred_at) from app.messages x
                  where x.conversation_id = v.id and x.direction = 'outbound') as outbound_at
              from unnest(${textArray(threads.map((t) => t.id))}::uuid[]) as v (id)
            ) l
            where c.id = l.id and c.workspace_id = ${workspaceId}`);
        return { gone, kept };
      },
    );
    removed += result.gone;
    guarded += result.kept;
  }

  const files = await reapMedia(
    deps,
    job,
    workspaces.map((w) => w.workspace_id),
  );

  await asWorker(deps.db, { workspaceId: null, organizationId: job.organization_id }, (tx) =>
    tx.execute(sql`
      update app.migrations set status = 'rolled_back', last_error = null
       where id = ${job.migration_id}`),
  );
  await finishJob(deps, job, { removed, leftAlone: guarded, files });
  return 'done';
}

/**
 * The photos and recordings the import copied in, once the records that carried them have gone.
 *
 * Only the ones nothing points at any more: the same bytes under two records are one copy in storage
 * (media.ts), so a file goes when no surviving message or call names it, and stays where it is when one does.
 *
 * Business by business, like everything above, and for a harder reason than tidiness: the worker's own policy
 * on `app.migration_media` is `workspace_id = private.system_scope_workspace()`, so a read outside a business
 * matches nothing at all. Asked once for the whole organization, this found no files, removed none, and said
 * so — which is the quietest way possible to keep paying to store a cancelled system's photos for ever.
 */
async function reapMedia(
  deps: MigrationDeps,
  job: JobRow,
  workspaces: readonly string[],
): Promise<number> {
  let removed = 0;
  for (const workspaceId of workspaces) {
    const scope = { workspaceId, organizationId: job.organization_id };
    // Paged by id rather than by state, so a file that has to stay is passed over once and not asked about
    // again on the next page.
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const stored = await asWorker(deps.db, scope, (tx) =>
        rows<{ id: string; bucket: string; object_path: string }>(
          tx,
          sql`select id::text as id, bucket, object_path
              from app.migration_media
              where migration_id = ${job.migration_id} and workspace_id = ${workspaceId}
                and state = 'stored' and bucket is not null and object_path is not null
                and id > ${after}::uuid
              order by id limit ${MEDIA_REAP_PAGE}`,
        ),
      );
      if (stored.length === 0) break;
      after = stored[stored.length - 1]!.id;
      for (const file of stored) {
        const [held] = await asWorker(deps.db, scope, (tx) =>
          rows<{ still: boolean }>(
            tx,
            sql`select (
                  exists (select 1 from app.calls c
                           where c.workspace_id = ${workspaceId}
                             and c.recording_object_path = ${file.object_path})
                  or exists (select 1 from app.messages m
                              where m.workspace_id = ${workspaceId}
                                and m.media @> jsonb_build_array(
                                      jsonb_build_object('objectPath', ${file.object_path}::text)))
                ) as still`,
          ),
        );
        if (held?.still) continue;
        try {
          await deps.store.remove(file.bucket, file.object_path);
        } catch (err) {
          // A file that will not go is worth saying out loud and not worth failing a rollback over: the
          // records are already back the way they were, and a copy left behind costs storage, not
          // correctness.
          deps.log.warn(
            { err, migrationId: job.migration_id, objectPath: file.object_path },
            'could not remove a copied file while rolling a migration back',
          );
          continue;
        }
        await asWorker(deps.db, scope, (tx) =>
          tx.execute(sql`
            update app.migration_media
               set state = 'skipped', bucket = null, object_path = null, stored_at = null,
                   last_error = 'Removed when the migration was taken back.'
             where id = ${file.id}::uuid and workspace_id = ${workspaceId}`),
        );
        removed += 1;
      }
    }
  }
  return removed;
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

/**
 * Every kind of record a rollback takes back, in the order it takes them. Exported so a spec can hold the
 * plan against the catalogue and catch the next kind of record somebody teaches an importer to write.
 */
export const TAKE_BACK_TYPES: readonly string[] = takeBackPlan(
  '00000000-0000-0000-0000-000000000000',
).map(([type]) => type);

export { CANONICAL_SCHEMA_VERSION, categoriesInOrder };
