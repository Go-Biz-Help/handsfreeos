/**
 * Reading a migration (M11).
 *
 * The one thing these queries do that an ordinary list does not: they turn counts into words. A category the
 * sign-in could not reach never comes back as `0`, because "0" honestly reads as "there are none" and that is
 * the single most misleading thing a migration screen could say. `countLabel` carries the honest version, and
 * the screen shows that rather than the number.
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import type { QueryContext } from '../kernel/types';
import {
  CAPABILITY_WORDS,
  countWords,
  migrationAccess,
  MIGRATION_NOT_YOURS,
  MIGRATION_ROLLBACK_LEAVES,
  type MigrationAccess,
  FINDING_GROUPS,
  findingGroupOf,
  migrationCategory,
  type CountQuality,
  type MigrationCapability,
} from '../migrations/index';
import {
  MigrationGetInput,
  MigrationGetOutput,
  MigrationListInput,
  MigrationListOutput,
  MigrationReportInput,
  MigrationReportOutput,
  MigrationReviewQueueInput,
  MigrationReviewQueueOutput,
  MigrationRollbackPreviewInput,
  MigrationRollbackPreviewOutput,
  SOURCE_LABELS,
  type MigrationSourceSystem,
} from '../schemas/migration';

/**
 * Either door (M11, 2026-09-18). Naming a business reads the migration as that business: the row policies in
 * 0068 then show it its own sub-account, its own counts and its own findings, and none of the other
 * businesses a migration may carry. Naming none reads it as the agency, which sees all of them.
 *
 * The organization is taken off the resolved scope either way, so the `organization_id = …` filters below
 * hold for both — a workspace resolves to the organization it belongs to.
 */
const eitherDoor = (i: { organizationId: string; workspaceId?: string | null }) =>
  i.workspaceId
    ? { kind: 'workspace' as const, workspaceId: i.workspaceId }
    : { kind: 'organization' as const, organizationId: i.organizationId };

/** The same guard the commands use, and the same refusal. */
function readerAccess(ctx: QueryContext): MigrationAccess {
  const access = migrationAccess({
    orgRole: ctx.scope.orgRole,
    workspaceRole: ctx.scope.workspaceRole,
    workspaceId: ctx.scope.workspaceId,
  });
  if (!access) throw HfosError.notFound(MIGRATION_NOT_YOURS);
  return access;
}

const sourceLabel = (s: string) => SOURCE_LABELS[s as MigrationSourceSystem] ?? s;
const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;
const groupTitle = (id: string) => FINDING_GROUPS.find((g) => g.id === id)?.title ?? id;

export const migrationList = defineQuery({
  name: 'migration.list',
  description:
    'The migrations this organization has run or is running, and the sources it has connected.',
  input: MigrationListInput,
  output: MigrationListOutput,
  permission: null,
  scope: eitherDoor,
  async handler(ctx) {
    const access = readerAccess(ctx);
    const org = ctx.scope.organizationId!;
    // Row policies would hide the rest anyway; saying it in the query keeps the list honest about what it
    // is — a business's own moves, not a filtered view of its agency's.
    const mine = access.onlyWorkspaceId;
    const list = await rows<{
      id: string;
      name: string;
      source: string;
      status: string;
      scopes: number;
      started_at: Date | null;
      imported_at: Date | null;
      transition_ends_at: Date | null;
      created_at: Date;
    }>(
      ctx.tx,
      sql`select m.id, m.name, m.source_system::text as source, m.status::text as status,
            (select count(*)::int from app.migration_scopes s
             where s.migration_id = m.id and s.selected) as scopes,
            m.started_at, m.imported_at, m.transition_ends_at, m.created_at
          from app.migrations m
          where m.organization_id = ${org}
            and (${mine}::uuid is null or exists (
              select 1 from app.migration_scopes s
              where s.migration_id = m.id and s.workspace_id = ${mine}::uuid))
          order by m.created_at desc
          limit 100`,
    );
    const connections = await rows<{
      id: string;
      source: string;
      install_kind: string;
      auth_kind: string;
      status: string;
      display_name: string | null;
      missing_scopes: string[];
      connected_at: Date | null;
    }>(
      ctx.tx,
      sql`select c.id, c.source_system::text as source, c.install_kind::text as install_kind,
            c.auth_kind::text as auth_kind, c.status::text as status, c.display_name, c.missing_scopes,
            c.connected_at
          from app.migration_connections c
          where c.organization_id = ${org} and c.status <> 'disconnected'
            and (${mine}::uuid is null or c.workspace_id = ${mine}::uuid or exists (
              select 1 from app.migrations m
              join app.migration_scopes s on s.migration_id = m.id
              where m.connection_id = c.id and s.workspace_id = ${mine}::uuid))
          order by c.created_at desc
          limit 50`,
    );
    return {
      migrations: list.map((m) => ({
        id: m.id,
        name: m.name,
        source: m.source as MigrationSourceSystem,
        sourceLabel: sourceLabel(m.source),
        status: m.status as never,
        scopes: m.scopes,
        startedAt: iso(m.started_at),
        importedAt: iso(m.imported_at),
        transitionEndsAt: iso(m.transition_ends_at),
        createdAt: iso(m.created_at)!,
      })),
      connections: connections.map((c) => ({
        id: c.id,
        source: c.source as MigrationSourceSystem,
        sourceLabel: sourceLabel(c.source),
        installKind: c.install_kind as never,
        authKind: c.auth_kind as never,
        status: c.status as never,
        displayName: c.display_name,
        missingScopes: c.missing_scopes ?? [],
        connectedAt: iso(c.connected_at),
      })),
    };
  },
});

export const migrationGet = defineQuery({
  name: 'migration.get',
  description:
    'Everything one migration knows about itself: where each business lands, what was found, what was chosen, what will not fit, what is left to do, and how far it has got.',
  input: MigrationGetInput,
  output: MigrationGetOutput,
  permission: null,
  scope: eitherDoor,
  async handler(ctx, input) {
    readerAccess(ctx);
    const org = ctx.scope.organizationId!;
    const [m] = await rows<{
      id: string;
      name: string;
      source: string;
      status: string;
      transition_enabled: boolean;
      transition_ends_at: Date | null;
      include_deleted: boolean;
      started_at: Date | null;
      imported_at: Date | null;
      finalized_at: Date | null;
      totals: Record<string, unknown>;
      last_error: string | null;
      connection_id: string;
      connection_status: string;
      install_kind: string;
      display_name: string | null;
      missing_scopes: string[];
    }>(
      ctx.tx,
      sql`select m.id, m.name, m.source_system::text as source, m.status::text as status,
            m.transition_enabled, m.transition_ends_at, m.include_deleted, m.started_at, m.imported_at,
            m.finalized_at, m.totals, m.last_error,
            c.id as connection_id, c.status::text as connection_status,
            c.install_kind::text as install_kind, c.display_name, c.missing_scopes
          from app.migrations m join app.migration_connections c on c.id = m.connection_id
          where m.id = ${input.migrationId} and m.organization_id = ${org}`,
    );
    if (!m) return { migration: null } as never;

    const scopes = await rows<{
      id: string;
      name: string;
      external_scope_id: string;
      timezone: string | null;
      status: string;
      selected: boolean;
      workspace_id: string | null;
      workspace_name: string | null;
      creates_workspace: boolean;
      totals: Record<string, unknown>;
      last_error: string | null;
    }>(
      ctx.tx,
      sql`select s.id, s.name, s.external_scope_id, s.timezone, s.status::text as status, s.selected,
            s.workspace_id, w.name as workspace_name, s.creates_workspace, s.totals, s.last_error
          from app.migration_scopes s
          left join app.workspaces w on w.id = s.workspace_id
          where s.migration_id = ${m.id}
          order by s.name`,
    );
    // Several sub-accounts may point at one business (Chris allowed it), and each of them says so.
    const sharing = new Map<string, string[]>();
    for (const s of scopes) {
      if (!s.workspace_id || !s.selected) continue;
      sharing.set(s.workspace_id, [...(sharing.get(s.workspace_id) ?? []), s.name]);
    }

    const inventory = await rows<{
      category: string;
      resource_id: string | null;
      resource_name: string | null;
      found: number;
      count_quality: string;
      capability: string;
      estimated_bytes: number;
      depends_on: string;
      notes: string | null;
      selected: boolean | null;
      auto_added: boolean | null;
      required_by: string;
    }>(
      ctx.tx,
      // Summed across the sub-accounts, because the choice a person makes is per category, not per
      // sub-account. The worst count quality across them wins: one sub-account we could not read makes the
      // whole number a floor rather than a total.
      sql`select i.category, i.resource_id, max(i.resource_name) as resource_name,
            sum(i.found_count)::bigint as found,
            (array_agg(i.count_quality::text order by
              case i.count_quality when 'permission_limited' then 0 when 'not_enumerable' then 1
                when 'unknown' then 2 when 'estimated' then 3 else 4 end))[1] as count_quality,
            (array_agg(i.capability::text order by
              case i.capability when 'not_available' then 0 when 'not_supported' then 1
                when 'needs_review' then 2 when 'action_required' then 3 else 9 end))[1] as capability,
            sum(i.estimated_bytes)::bigint as estimated_bytes,
            -- Aggregated as text: array_agg refuses to accumulate empty arrays, and most categories need
            -- nothing at all.
            coalesce(max(array_to_string(i.depends_on, ',')), '') as depends_on,
            (array_agg(i.notes) filter (where i.notes is not null))[1] as notes,
            bool_or(coalesce(sel.selected, false)) as selected,
            bool_or(coalesce(sel.auto_added, false)) as auto_added,
            coalesce(max(array_to_string(sel.required_by, ',')), '') as required_by
          from app.migration_inventory i
          left join app.migration_selections sel
            on sel.scope_id = i.scope_id and sel.category = i.category
            and coalesce(sel.resource_id, '') = coalesce(i.resource_id, '')
          where i.migration_id = ${m.id}
          group by i.category, i.resource_id
          order by i.category, i.resource_id nulls first`,
    );

    const findings = await rows<{
      id: string;
      code: string;
      category: string | null;
      scope_name: string | null;
      capability: string;
      severity: string;
      summary: string;
      what_imports: string | null;
      what_changes: string | null;
      recommended_action: string | null;
      blocks_import: boolean;
      affected_count: number;
      acknowledged_at: Date | null;
    }>(
      ctx.tx,
      sql`select f.id, f.code, f.category, s.name as scope_name, f.capability::text as capability,
            f.severity::text as severity, f.summary, f.what_imports, f.what_changes,
            f.recommended_action, f.blocks_import, f.affected_count, f.acknowledged_at
          from app.migration_findings f
          left join app.migration_scopes s on s.id = f.scope_id
          where f.migration_id = ${m.id}
          order by case f.severity when 'blocking' then 0 when 'action' then 1
                     when 'review' then 2 else 3 end, f.code
          limit 500`,
    );

    const tasks = await rows<{
      id: string;
      kind: string;
      provider: string;
      label: string;
      state: string;
      instructions: string | null;
      settings_path: string | null;
      workspace_id: string | null;
      blocks_live_use: boolean;
    }>(
      ctx.tx,
      sql`select id, kind::text as kind, provider, label, state::text as state, instructions,
            settings_path, workspace_id, blocks_live_use
          from app.migration_reconnect_tasks
          where migration_id = ${m.id}
          order by blocks_live_use desc, state, label
          limit 200`,
    );

    const progress = await rows<{
      category: string;
      scope_id: string | null;
      found: number;
      imported: number;
      merged: number;
      skipped: number;
      failed: number;
      complete: boolean;
    }>(
      ctx.tx,
      sql`select c.category, c.scope_id,
            coalesce((c.counts ->> 'found')::bigint, 0) as found,
            coalesce((c.counts ->> 'imported')::bigint, 0) as imported,
            coalesce((c.counts ->> 'merged')::bigint, 0) as merged,
            coalesce((c.counts ->> 'skipped')::bigint, 0) as skipped,
            coalesce((c.counts ->> 'failed')::bigint, 0) as failed,
            c.complete
          from app.migration_checkpoints c
          where c.migration_id = ${m.id}
          order by c.category`,
    );

    const [counts] = await rows<{
      needs_review: number;
      retryable: number;
      put_records_here: boolean;
    }>(
      ctx.tx,
      sql`select
            (select count(*)::int from app.migration_merge_candidates
             where migration_id = ${m.id} and resolution = 'pending') as needs_review,
            (select count(*)::int from app.migration_errors
             where migration_id = ${m.id} and resolved_at is null and retryable) as retryable,
            -- The journal is what a rollback reads to put records back, so its being empty is exactly what
            -- "this move has changed nothing here" means. An existence test rather than a count: the screen
            -- asks whether, never how many, and the journal of a finished move is long (0088).
            exists (select 1 from app.migration_change_journal
                    where migration_id = ${m.id}) as put_records_here`,
    );

    return {
      migration: {
        id: m.id,
        name: m.name,
        source: m.source as MigrationSourceSystem,
        sourceLabel: sourceLabel(m.source),
        status: m.status as never,
        transitionEnabled: m.transition_enabled,
        transitionEndsAt: iso(m.transition_ends_at),
        includeDeleted: m.include_deleted,
        startedAt: iso(m.started_at),
        importedAt: iso(m.imported_at),
        finalizedAt: iso(m.finalized_at),
        totals: m.totals ?? {},
        lastError: m.last_error,
        putRecordsHere: counts?.put_records_here ?? false,
      },
      connection: {
        id: m.connection_id,
        status: m.connection_status as never,
        installKind: m.install_kind as never,
        displayName: m.display_name,
        missingScopes: m.missing_scopes ?? [],
      },
      scopes: scopes.map((s) => ({
        id: s.id,
        name: s.name,
        externalScopeId: s.external_scope_id,
        timezone: s.timezone,
        status: s.status as never,
        selected: s.selected,
        workspaceId: s.workspace_id,
        workspaceName: s.workspace_name,
        createsWorkspace: s.creates_workspace,
        sharesWorkspaceWith: (s.workspace_id ? (sharing.get(s.workspace_id) ?? []) : []).filter(
          (n) => n !== s.name,
        ),
        totals: s.totals ?? {},
        lastError: s.last_error,
      })),
      inventory: inventory.map((i) => {
        const cat = migrationCategory(i.category);
        const capability = i.capability as MigrationCapability;
        const quality = i.count_quality as CountQuality;
        return {
          category: i.category,
          categoryLabel: cat?.label ?? i.category,
          blurb: cat?.blurb ?? '',
          resourceId: i.resource_id,
          resourceName: i.resource_name,
          found: Number(i.found ?? 0),
          countQuality: quality,
          countLabel: countWords(Number(i.found ?? 0), quality),
          capability,
          capabilityLabel: CAPABILITY_WORDS[capability].label,
          estimatedBytes: Number(i.estimated_bytes ?? 0),
          dependsOn: i.depends_on ? i.depends_on.split(',') : [],
          selected: i.selected ?? false,
          autoAdded: i.auto_added ?? false,
          requiredBy: i.required_by ? i.required_by.split(',') : [],
          locked: (i.auto_added ?? false) || cat?.release !== 'ready',
          // Why it is not coming (or not coming yet) is said once, under the blurb — never twice.
          notes: i.notes ?? cat?.releaseNote ?? null,
        };
      }),
      findings: findings.map((f) => {
        const capability = f.capability as MigrationCapability;
        const group = findingGroupOf(capability);
        return {
          id: f.id,
          code: f.code,
          category: f.category,
          scopeName: f.scope_name,
          capability,
          severity: f.severity as never,
          group,
          groupTitle: groupTitle(group),
          summary: f.summary,
          whatImports: f.what_imports,
          whatChanges: f.what_changes,
          recommendedAction: f.recommended_action,
          blocksImport: f.blocks_import,
          affectedCount: Number(f.affected_count ?? 0),
          acknowledged: f.acknowledged_at !== null,
        };
      }),
      tasks: tasks.map((t) => ({
        id: t.id,
        kind: t.kind,
        provider: t.provider,
        label: t.label,
        state: t.state,
        instructions: t.instructions,
        settingsPath: t.settings_path,
        workspaceId: t.workspace_id,
        blocksLiveUse: t.blocks_live_use,
      })),
      progress: progress.map((p) => ({
        category: p.category,
        categoryLabel: migrationCategory(p.category)?.label ?? p.category,
        scopeId: p.scope_id,
        found: Number(p.found),
        imported: Number(p.imported),
        merged: Number(p.merged),
        skipped: Number(p.skipped),
        failed: Number(p.failed),
        complete: p.complete,
      })),
      needsReview: counts?.needs_review ?? 0,
      retryable: counts?.retryable ?? 0,
    };
  },
});

export const migrationReviewQueue = defineQuery({
  name: 'migration.review_queue',
  description:
    'The customers a migration is not sure about: somebody arriving who might be somebody already here.',
  input: MigrationReviewQueueInput,
  output: MigrationReviewQueueOutput,
  permission: null,
  scope: eitherDoor,
  async handler(ctx, input) {
    readerAccess(ctx);
    const org = ctx.scope.organizationId!;
    const list = await rows<{
      id: string;
      scope_name: string;
      match_rule: string;
      score: number;
      evidence: Record<string, unknown>;
      payload: Record<string, unknown>;
      target_id: string | null;
    }>(
      ctx.tx,
      sql`select c.id, s.name as scope_name, c.match_rule, c.score, c.evidence,
            coalesce(o.payload, '{}'::jsonb) as payload, c.target_id
          from app.migration_merge_candidates c
          join app.migration_scopes s on s.id = c.scope_id
          left join app.migration_source_objects o
            on o.scope_id = c.scope_id and o.source_object_type = c.source_object_type
            and o.source_object_id = c.source_object_id
          where c.migration_id = ${input.migrationId} and c.organization_id = ${org}
            and c.resolution = 'pending'
          order by c.score desc, c.created_at
          limit ${input.limit}`,
    );
    // Everyone each candidate could be. The evidence names them; this fetches the names to show.
    const ids = [
      ...new Set(
        list.flatMap((c) => {
          const e = c.evidence as { phoneMatch?: string; emailMatch?: string };
          return [c.target_id, e.phoneMatch, e.emailMatch].filter(Boolean) as string[];
        }),
      ),
    ];
    const people = ids.length
      ? await rows<{ id: string; name: string; email: string | null; phone: string | null }>(
          ctx.tx,
          sql`select id, btrim(first_name || ' ' || last_name) as name, email::text as email,
                phone_e164 as phone
              from app.people where id = any(${ids}::uuid[])`,
        )
      : [];
    const byId = new Map(people.map((p) => [p.id, p]));
    const [remaining] = await rows<{ count: number }>(
      ctx.tx,
      sql`select count(*)::int as count from app.migration_merge_candidates
          where migration_id = ${input.migrationId} and resolution = 'pending'`,
    );
    return {
      candidates: list.map((c) => {
        const e = c.evidence as { reason?: string; phoneMatch?: string; emailMatch?: string };
        const p = c.payload as Record<string, unknown>;
        const here = [c.target_id, e.phoneMatch, e.emailMatch]
          .filter((x): x is string => !!x)
          .filter((x, i, a) => a.indexOf(x) === i)
          .map((id) => byId.get(id))
          .filter((x): x is NonNullable<typeof x> => !!x);
        return {
          id: c.id,
          scopeName: c.scope_name,
          matchRule: c.match_rule,
          score: c.score,
          reason: e.reason ?? 'This one needs a person to decide.',
          incoming: {
            name:
              [p['firstName'], p['lastName']].filter(Boolean).join(' ').trim() ||
              String(p['name'] ?? 'Someone with no name'),
            email: (p['email'] as string) ?? null,
            phone: (p['phone'] as string) ?? null,
          },
          here,
        };
      }),
      remaining: remaining?.count ?? 0,
    };
  },
});

export const migrationRollbackPreview = defineQuery({
  name: 'migration.rollback_preview',
  description:
    'What taking this migration back would do: what goes, what is put back, and what is left alone because somebody has changed it here since.',
  input: MigrationRollbackPreviewInput,
  output: MigrationRollbackPreviewOutput,
  permission: null,
  scope: eitherDoor,
  async handler(ctx, input) {
    readerAccess(ctx);
    const org = ctx.scope.organizationId!;
    const [row] = await rows<{ removable: number; restorable: number; guarded: number }>(
      ctx.tx,
      // `created_here` is the whole rule for what may be removed: a record this migration made, and nothing
      // else. A customer who was already here was joined, never created, so they can only be put back.
      //
      // Minus the kinds a rollback deliberately leaves where they are, or this would promise to remove
      // records that are never going anywhere: a tag is the business's own label, a user was recognised and
      // never made, and a stage belongs to the board it is on rather than being a record of its own.
      sql`select
            (select count(*)::int from app.migration_source_mappings sm
             where sm.first_migration_id = ${input.migrationId} and sm.created_here
               and sm.organization_id = ${org}
               and sm.target_type not in (${sql.join(
                 MIGRATION_ROLLBACK_LEAVES.map((t) => sql`${t}`),
                 sql`, `,
               )})) as removable,
            (select count(*)::int from app.migration_change_journal j
             where j.migration_id = ${input.migrationId} and j.action in ('update', 'merge')
               and j.reverted_at is null) as restorable,
            (select count(*)::int from app.migration_change_journal j
             where j.migration_id = ${input.migrationId} and j.revert_skipped_reason is not null) as guarded`,
    );
    const external = await rows<{ label: string }>(
      ctx.tx,
      sql`select 'A phone number already with the carrier: ' || e164 as label
          from app.migration_port_requests
          where migration_id = ${input.migrationId}
            and state in ('submitted', 'carrier_review', 'scheduled', 'complete')
          union all
          select 'Something already reconnected: ' || label
          from app.migration_reconnect_tasks
          where migration_id = ${input.migrationId} and state = 'done'
          limit 50`,
    );
    return {
      migrationId: input.migrationId,
      removable: row?.removable ?? 0,
      restorable: row?.restorable ?? 0,
      protected: row?.guarded ?? 0,
      external: external.map((e) => e.label),
    };
  },
});

export const migrationReport = defineQuery({
  name: 'migration.report',
  description:
    'The completion report: what came across, what was checked, what will not fit, and what is left for a person to do.',
  input: MigrationReportInput,
  output: MigrationReportOutput,
  permission: null,
  scope: eitherDoor,
  async handler(ctx, input) {
    readerAccess(ctx);
    const org = ctx.scope.organizationId!;
    const [m] = await rows<{
      id: string;
      name: string;
      source: string;
      status: string;
      totals: Record<string, unknown>;
    }>(
      ctx.tx,
      sql`select id, name, source_system::text as source, status::text as status, totals
          from app.migrations where id = ${input.migrationId} and organization_id = ${org}`,
    );
    if (!m) return { migrationId: input.migrationId } as never;

    const byCategory = await rows<{
      category: string;
      found: number;
      imported: number;
      merged: number;
      skipped: number;
      failed: number;
      verified: boolean;
    }>(
      ctx.tx,
      sql`select c.category,
            sum(coalesce((c.counts ->> 'found')::bigint, 0))::bigint as found,
            sum(coalesce((c.counts ->> 'imported')::bigint, 0))::bigint as imported,
            sum(coalesce((c.counts ->> 'merged')::bigint, 0))::bigint as merged,
            sum(coalesce((c.counts ->> 'skipped')::bigint, 0))::bigint as skipped,
            sum(coalesce((c.counts ->> 'failed')::bigint, 0))::bigint as failed,
            bool_and(c.complete) as verified
          from app.migration_checkpoints c
          where c.migration_id = ${m.id}
          group by c.category order by c.category`,
    );
    const checks = await rows<{
      kind: string;
      category: string | null;
      result: string;
      expected: number | null;
      actual: number | null;
      summary: string | null;
    }>(
      ctx.tx,
      sql`select kind::text as kind, category, result::text as result, expected_count as expected,
            actual_count as actual, summary
          from app.migration_verifications
          where migration_id = ${m.id}
          order by case result when 'failed' then 0 when 'warned' then 1 else 2 end, kind
          limit 200`,
    );
    const findings = await rows<{
      id: string;
      code: string;
      category: string | null;
      capability: string;
      severity: string;
      summary: string;
      what_imports: string | null;
      what_changes: string | null;
      recommended_action: string | null;
      blocks_import: boolean;
      affected_count: number;
      acknowledged_at: Date | null;
    }>(
      ctx.tx,
      sql`select id, code, category, capability::text as capability, severity::text as severity, summary,
            what_imports, what_changes, recommended_action, blocks_import, affected_count, acknowledged_at
          from app.migration_findings where migration_id = ${m.id}
          order by case severity when 'blocking' then 0 when 'action' then 1
                     when 'review' then 2 else 3 end, code
          limit 500`,
    );
    const [tail] = await rows<{ open_tasks: number; failed_items: number }>(
      ctx.tx,
      sql`select
            (select count(*)::int from app.migration_reconnect_tasks
             where migration_id = ${m.id} and state in ('todo', 'in_progress', 'blocked')) as open_tasks,
            (select count(*)::int from app.migration_errors
             where migration_id = ${m.id} and resolved_at is null) as failed_items`,
    );

    const imported = byCategory.reduce((t, c) => t + Number(c.imported) + Number(c.merged), 0);
    return {
      migrationId: m.id,
      name: m.name,
      sourceLabel: sourceLabel(m.source),
      status: m.status as never,
      recordsMigrated: imported,
      byCategory: byCategory.map((c) => ({
        category: c.category,
        categoryLabel: migrationCategory(c.category)?.label ?? c.category,
        found: Number(c.found),
        imported: Number(c.imported),
        merged: Number(c.merged),
        skipped: Number(c.skipped),
        failed: Number(c.failed),
        verified: c.verified,
      })),
      checks: checks.map((c) => ({
        kind: c.kind,
        category: c.category,
        result: c.result,
        expected: c.expected === null ? null : Number(c.expected),
        actual: c.actual === null ? null : Number(c.actual),
        summary: c.summary,
      })),
      findings: findings.map((f) => {
        const capability = f.capability as MigrationCapability;
        const group = findingGroupOf(capability);
        return {
          id: f.id,
          code: f.code,
          category: f.category,
          scopeName: null,
          capability,
          severity: f.severity as never,
          group,
          groupTitle: groupTitle(group),
          summary: f.summary,
          whatImports: f.what_imports,
          whatChanges: f.what_changes,
          recommendedAction: f.recommended_action,
          blocksImport: f.blocks_import,
          affectedCount: Number(f.affected_count ?? 0),
          acknowledged: f.acknowledged_at !== null,
        };
      }),
      openTasks: tail?.open_tasks ?? 0,
      failedItems: tail?.failed_items ?? 0,
      reportPath: (m.totals as { reportPath?: string })?.reportPath ?? null,
    };
  },
});

export const migrationQueries = [
  migrationList,
  migrationGet,
  migrationReviewQueue,
  migrationRollbackPreview,
  migrationReport,
] as const;
