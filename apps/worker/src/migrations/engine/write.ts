/**
 * The three things every importer does, in one place.
 *
 * 1. **Ask the mapping first.** Before any matching, any merging, any thinking: has this exact source record
 *    already landed here? If it has, this is the same record, whatever it looks like now. That single lookup
 *    is what makes replaying a page, retrying a batch and a catch-up sync months later all free.
 * 2. **Write the mapping in the same transaction as the record.** Not after. A crash between the two would
 *    be the one way to create a duplicate, so there is no between.
 * 3. **Write down what was written.** Every create, every field, every join goes in the journal, because
 *    rollback is only as honest as its record of what it did — and because "what did the import actually do
 *    to my data?" deserves a real answer.
 */
import { sql, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';

export interface ImportScope {
  readonly migrationId: string;
  readonly organizationId: string;
  readonly scopeId: string;
  readonly workspaceId: string;
  readonly installationId: string;
  readonly sourceSystem: string;
  readonly sourceLocationId: string;
  readonly timezone: string;
  /** Where phone numbers with no country code belong. */
  readonly defaultCountry: string;
  readonly log: Logger;
}

export interface Mapped {
  readonly targetType: string;
  readonly targetId: string;
  readonly createdHere: boolean;
}

/** Has this exact source record already landed here? The first question, always. */
export async function existingMapping(
  tx: Tx,
  scope: ImportScope,
  sourceObjectType: string,
  sourceObjectId: string,
): Promise<Mapped | null> {
  // The aliases are quoted on purpose. These rows come back with the database's own column names, and the
  // type here says camelCase, so without them `targetType` was quietly `undefined` on every caller that read
  // it — which meant every relationship this engine resolves (a customer's owner, their company, the thread a
  // message belongs to) failed to find anything while looking as though it had asked. Nothing caught it
  // because the one caller that mattered until now only ever tested the row for truthiness.
  const [row] = await tx
    .execute(
      sql`select target_type as "targetType", target_id::text as "targetId",
            created_here as "createdHere"
          from app.migration_source_mappings
          where workspace_id = ${scope.workspaceId} and source_system = ${scope.sourceSystem}::app.migration_source
            and installation_id = ${scope.installationId}
            and source_location_id = ${scope.sourceLocationId}
            and source_object_type = ${sourceObjectType}
            and source_object_id = ${sourceObjectId}`,
    )
    .then((r) => Array.from(r as unknown as Iterable<Mapped>));
  return row ?? null;
}

/**
 * Records the link. `on conflict` rather than an insert, because the same record arriving twice in one run
 * (two sub-accounts holding the same customer) has to be the same answer both times.
 */
export async function putMapping(
  tx: Tx,
  scope: ImportScope,
  input: {
    readonly sourceObjectType: string;
    readonly sourceObjectId: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly createdHere: boolean;
    readonly checksum?: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into app.migration_source_mappings
      (workspace_id, organization_id, source_system, installation_id, source_location_id,
       source_object_type, source_object_id, target_type, target_id, created_here,
       first_migration_id, last_migration_id, source_checksum, last_synced_at)
    values (${scope.workspaceId}, ${scope.organizationId}, ${scope.sourceSystem}::app.migration_source,
      ${scope.installationId}, ${scope.sourceLocationId}, ${input.sourceObjectType},
      ${input.sourceObjectId}, ${input.targetType}, ${input.targetId}::uuid, ${input.createdHere},
      ${scope.migrationId}, ${scope.migrationId}, ${input.checksum ?? null}, now())
    on conflict (workspace_id, source_system, installation_id, source_location_id, source_object_type,
                 source_object_id)
    do update set target_type = excluded.target_type, target_id = excluded.target_id,
      last_migration_id = excluded.last_migration_id, source_checksum = excluded.source_checksum,
      last_synced_at = now()`);
}

export type JournalAction = 'create' | 'update' | 'link' | 'merge';

export async function journal(
  tx: Tx,
  scope: ImportScope,
  entry: {
    readonly action: JournalAction;
    readonly targetType: string;
    readonly targetId: string;
    readonly sourceObjectType?: string | null;
    readonly sourceObjectId?: string | null;
    readonly changedFields?: Record<string, { before: unknown; after: unknown }>;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into app.migration_change_journal
      (migration_id, organization_id, scope_id, workspace_id, action, target_type, target_id,
       source_object_type, source_object_id, changed_fields)
    values (${scope.migrationId}, ${scope.organizationId}, ${scope.scopeId}, ${scope.workspaceId},
      ${entry.action}, ${entry.targetType}, ${entry.targetId}::uuid,
      ${entry.sourceObjectType ?? null}, ${entry.sourceObjectId ?? null},
      ${JSON.stringify(entry.changedFields ?? {})}::jsonb)`);
}

/** A record that could not be brought, kept with a reason rather than dropped. */
export async function quarantine(
  tx: Tx,
  scope: ImportScope,
  input: {
    readonly category: string;
    readonly sourceObjectType: string;
    readonly sourceObjectId: string;
    readonly kind:
      | 'transient'
      | 'permission'
      | 'mapping'
      | 'dependency'
      | 'conflict'
      | 'source_gone'
      | 'policy'
      | 'target';
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly detail?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into app.migration_errors
      (migration_id, organization_id, scope_id, workspace_id, category, source_object_type,
       source_object_id, kind, code, message, retryable, detail)
    values (${scope.migrationId}, ${scope.organizationId}, ${scope.scopeId}, ${scope.workspaceId},
      ${input.category}, ${input.sourceObjectType}, ${input.sourceObjectId},
      ${input.kind}::app.migration_error_kind, ${input.code}, ${input.message.slice(0, 2000)},
      ${input.retryable ?? true}, ${JSON.stringify(input.detail ?? {})}::jsonb)
    on conflict (migration_id, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), code,
                 coalesce(source_object_type, ''), coalesce(source_object_id, ''))
    do update set attempts = app.migration_errors.attempts + 1, last_seen_at = now(),
      message = excluded.message, detail = excluded.detail`);
}

/** A finding raised while importing rather than while scanning. Counted up rather than repeated. */
export async function finding(
  tx: Tx,
  scope: ImportScope,
  f: {
    readonly code: string;
    readonly category?: string | null;
    readonly capability: string;
    readonly severity: 'info' | 'review' | 'action' | 'blocking';
    readonly summary: string;
    readonly whatImports?: string | null;
    readonly whatChanges?: string | null;
    readonly recommendedAction?: string | null;
    readonly sourceCapability?: string | null;
    readonly affected?: number;
    readonly detail?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into app.migration_findings
      (migration_id, organization_id, scope_id, category, code, capability, severity, summary,
       what_imports, what_changes, recommended_action, source_capability, affected_count, detail)
    values (${scope.migrationId}, ${scope.organizationId}, ${scope.scopeId}, ${f.category ?? null},
      ${f.code}, ${f.capability}::app.migration_capability, ${f.severity}::app.migration_finding_severity,
      ${f.summary}, ${f.whatImports ?? null}, ${f.whatChanges ?? null}, ${f.recommendedAction ?? null},
      ${f.sourceCapability ?? null}, ${f.affected ?? 0}, ${JSON.stringify(f.detail ?? {})}::jsonb)
    on conflict (migration_id, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), code,
                 coalesce(category, ''), coalesce(source_capability, ''))
    do update set affected_count = app.migration_findings.affected_count + excluded.affected_count,
      last_seen_at = now(), summary = excluded.summary`);
}

/** What one page of one category did. Summed into the checkpoint, and shown as the progress bar. */
export interface ImportCounts {
  found: number;
  imported: number;
  merged: number;
  skipped: number;
  needsReview: number;
  failed: number;
}

export const emptyCounts = (): ImportCounts => ({
  found: 0,
  imported: 0,
  merged: 0,
  skipped: 0,
  needsReview: 0,
  failed: 0,
});

export const addCounts = (a: ImportCounts, b: Partial<ImportCounts>): ImportCounts => ({
  found: a.found + (b.found ?? 0),
  imported: a.imported + (b.imported ?? 0),
  merged: a.merged + (b.merged ?? 0),
  skipped: a.skipped + (b.skipped ?? 0),
  needsReview: a.needsReview + (b.needsReview ?? 0),
  failed: a.failed + (b.failed ?? 0),
});
