/**
 * Moving a business here from another CRM (M11).
 *
 * The shape of the day: connect, scan, point each sub-account at a business, choose, review, import, catch up,
 * finish. Every one of those is a command here, and every one of them is refused in the wrong order rather
 * than half-done — a migration that started before anybody chose anything is not a migration, it is a mess
 * somebody has to unpick.
 *
 * Three lines this file holds:
 *
 * 1. **A scan never writes to the business.** `migration.scan` reads and counts. Nothing a person has not
 *    agreed to can reach a customer record, which is why the scan is safe to run again as often as you like.
 * 2. **Chris allowed several sub-accounts in one business.** `migration.map_scopes` therefore has no
 *    one-business rule — it has a finding instead, which says in words what that mixes, and the review step
 *    shows it before anybody presses Import.
 * 3. **Everything the old system decides is the worker's.** Tokens, counts, capabilities, progress: people
 *    start things and choose things; they never write a count. The column grants in 0064 hold the same line.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  migrationConnections,
  migrationFindings,
  migrationInventory,
  migrationJobs,
  migrationMergeCandidates,
  migrationReconnectTasks,
  migrationScans,
  migrationScopes,
  migrationSelections,
  migrations,
  workspaces,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { slugify } from '../slug';
import {
  FINDING_CODES,
  isImportable,
  mayActForWorkspace,
  migrationAccess,
  MIGRATION_NOT_YOURS,
  type MigrationAccess,
  migrationCategory,
  resolveSelection,
  sharedWorkspaceFinding,
  dependencyReason,
} from '../migrations/index';
import {
  MigrationConnectInput,
  MigrationConnectionRefInput,
  MigrationConnectionRenameInput,
  MigrationConnectionStateOutput,
  MigrationConnectOutput,
  MigrationCreateInput,
  MigrationCreateOutput,
  MigrationExtendTransitionInput,
  MigrationExtendTransitionOutput,
  MigrationFinalizeInput,
  MigrationMapScopesInput,
  MigrationMapScopesOutput,
  MigrationMergeResolveInput,
  MigrationMergeResolveOutput,
  MigrationRefInput,
  MigrationRetryInput,
  MigrationRetryOutput,
  MigrationRollbackInput,
  MigrationScanInput,
  MigrationScanOutput,
  MigrationSelectInput,
  MigrationSelectOutput,
  MigrationStartInput,
  MigrationStateOutput,
  MigrationTaskDoneInput,
  MigrationTaskDoneOutput,
  LIVE_SOURCES,
  SOURCE_LABELS,
  type MigrationLifecycle,
  type MigrationSourceSystem,
} from '../schemas/migration';

/** `app.migration_connection_status`, as the state helper below returns it. */
type MigrationConnectionState = (typeof migrationConnections.$inferSelect)['status'];

const inOrganization = (i: { organizationId: string }) => ({
  kind: 'organization' as const,
  organizationId: i.organizationId,
});

/**
 * Either door (M11, 2026-09-18). Naming a business addresses the migration as that business and reaches only
 * its own part; naming none addresses it as the agency and reaches all of it. The organization is read off
 * the resolved scope afterwards, never off the input, so naming somebody else's organization gets nobody
 * anywhere.
 */
const eitherDoor = (i: { organizationId: string; workspaceId?: string | null }) =>
  i.workspaceId
    ? { kind: 'workspace' as const, workspaceId: i.workspaceId }
    : { kind: 'organization' as const, organizationId: i.organizationId };

/**
 * Which door this person came in through, or a refusal.
 *
 * These commands declare no permission and ask here instead, because the kernel picks the role to test from
 * the permission's name and these genuinely take either an organization permission or a workspace one. The
 * refusal is the same sentence both ways: that a migration exists but is not yours is not a fact anybody
 * needs.
 */
function requireAccess(ctx: CommandContext): MigrationAccess {
  requireHuman(ctx);
  const access = migrationAccess({
    orgRole: ctx.scope.orgRole,
    workspaceRole: ctx.scope.workspaceRole,
    workspaceId: ctx.scope.workspaceId,
  });
  if (!access) throw HfosError.notFound(MIGRATION_NOT_YOURS);
  return access;
}

/**
 * The migration, as this person may see it. A business's door opens only onto migrations that actually reach
 * its own business — the database says the same thing row by row, and this says it in a sentence.
 */
async function loadMigrationFor(
  ctx: CommandContext,
  migrationId: string,
  access: MigrationAccess,
): Promise<LoadedMigration> {
  const m = await loadMigration(ctx, migrationId);
  if (access.onlyWorkspaceId) {
    const [reaches] = await rows<{ ok: boolean }>(
      ctx.tx,
      sql`select true as ok from app.migration_scopes
          where migration_id = ${m.id} and workspace_id = ${access.onlyWorkspaceId} limit 1`,
    );
    if (!reaches) throw HfosError.notFound(MIGRATION_NOT_YOURS);
  }
  return m;
}

/** How long a sign-in state stays good, as mailboxes, calendars and payment accounts use. */
const STATE_TTL_MS = 10 * 60_000;
/** Chris's answer: thirty days of catching up, extendable, with a reminder at seven left. */
export const TRANSITION_DAYS = 30;
export const TRANSITION_WARN_DAYS = 7;
/** A connection that has not ended: the unique index per account counts these. */
export const LIVE_SOURCE_STATUSES = ['pending', 'active', 'reauth_required', 'error'] as const;

const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');

/** A Postgres `text[]` from a list, empty included. */
const textArray = (values: readonly string[]) =>
  values.length === 0
    ? sql`'{}'::text[]`
    : sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;

/** The columns a person may read on a connection (0064's column grants); never a token or a sign-in secret. */
const CONNECTION_COLUMNS = {
  id: migrationConnections.id,
  sourceSystem: migrationConnections.sourceSystem,
  installKind: migrationConnections.installKind,
  status: migrationConnections.status,
  externalAccountId: migrationConnections.externalAccountId,
  displayName: migrationConnections.displayName,
  scopes: migrationConnections.scopes,
  missingScopes: migrationConnections.missingScopes,
  adapterVersion: migrationConnections.adapterVersion,
  lastError: migrationConnections.lastError,
  connectedAt: migrationConnections.connectedAt,
  disconnectedAt: migrationConnections.disconnectedAt,
} as const;

type LoadedConnection = Pick<
  typeof migrationConnections.$inferSelect,
  keyof typeof CONNECTION_COLUMNS
>;

async function loadConnection(ctx: CommandContext, id: string): Promise<LoadedConnection> {
  const [c] = await ctx.tx
    .select(CONNECTION_COLUMNS)
    .from(migrationConnections)
    .where(
      and(
        eq(migrationConnections.id, id),
        eq(migrationConnections.organizationId, ctx.scope.organizationId!),
      ),
    );
  if (!c) throw HfosError.notFound('That source isn’t connected here.');
  return c as LoadedConnection;
}

type LoadedMigration = typeof migrations.$inferSelect;

async function loadMigration(ctx: CommandContext, id: string): Promise<LoadedMigration> {
  const [m] = await ctx.tx
    .select()
    .from(migrations)
    .where(and(eq(migrations.id, id), eq(migrations.organizationId, ctx.scope.organizationId!)));
  if (!m) throw HfosError.notFound('That migration isn’t there.');
  return m;
}

/**
 * Refuses a step taken out of order, and says which step comes first. Written as a list rather than a state
 * machine because the list is the thing a person is actually being told.
 */
function requireStatus(
  m: LoadedMigration,
  allowed: readonly MigrationLifecycle[],
  what: string,
): void {
  if (!allowed.includes(m.status as MigrationLifecycle))
    throw HfosError.rule('migration_wrong_step', 409, what);
}

const sourceLabel = (s: string) => SOURCE_LABELS[s as MigrationSourceSystem] ?? s;

/** The little answers every state-changing command gives back, typed so a literal stays a literal. */
const connectionState = (
  connectionId: string,
  status: MigrationConnectionState,
  changed: boolean,
) => ({ connectionId, status, changed });
const migrationState = (migrationId: string, status: MigrationLifecycle, changed: boolean) => ({
  migrationId,
  status,
  changed,
});

// ---------- connecting ----------

export const migrationConnect = defineCommand({
  name: 'migration.connect',
  description:
    'Start connecting the CRM a business is leaving. Returns a one-time state; the browser signs in at that system through the worker. The scan that follows only ever reads.',
  risk: 2,
  input: MigrationConnectInput,
  output: MigrationConnectOutput,
  permission: null,
  scope: eitherDoor,
  emits: ['migration_connection.connect_started'],
  // A one-time secret: never kept in a stored answer.
  shownOnce: ['state'],
  async handler(ctx, input) {
    if (!LIVE_SOURCES.includes(input.source))
      throw HfosError.rule(
        'migration_source_unavailable',
        409,
        `${sourceLabel(input.source)} isn’t ready to migrate from yet.`,
      );
    const access = requireAccess(ctx);
    const state = randomBytes(32).toString('base64url');
    const [row] = await ctx.tx
      .insert(migrationConnections)
      .values({
        organizationId: ctx.scope.organizationId!,
        // Set when a business connected its own source. That is what later lets it claim the sub-accounts
        // this sign-in reaches, and nobody else's.
        workspaceId: access.onlyWorkspaceId,
        sourceSystem: input.source,
        installKind: input.installKind,
        status: 'pending',
        oauthStateHash: sha256Hex(state),
        oauthStateExpiresAt: new Date(Date.now() + STATE_TTL_MS),
        createdBy: requireHuman(ctx).userId,
      })
      .returning({ id: migrationConnections.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'migration_connection.connect_started',
      entityType: 'migration_connection',
      entityId: row.id,
      payload: { source: input.source, installKind: input.installKind },
      after: { source: sourceLabel(input.source), reaches: input.installKind },
      broadcast: false,
    });
    return {
      connectionId: row.id,
      state,
      // The source is not in the address: the one-time state already says which system this is, and a name
      // in two places is a name that can disagree with itself.
      startPath: `/migrations/start?state=${encodeURIComponent(state)}`,
    };
  },
});

export const migrationConnectionRename = defineCommand({
  name: 'migration_connection.rename',
  description: 'Rename a connected source, so an agency tells two of them apart.',
  risk: 1,
  input: MigrationConnectionRenameInput,
  output: MigrationConnectionStateOutput,
  permission: 'org.migrations.manage',
  scope: inOrganization,
  emits: ['migration_connection.renamed'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const c = await loadConnection(ctx, input.connectionId);
    const name = input.displayName?.trim() || null;
    if (c.displayName === name) return connectionState(c.id, c.status, false);
    if (c.status === 'disconnected')
      throw HfosError.rule(
        'migration_connection_disconnected',
        409,
        'That source has been disconnected.',
      );
    await ctx.tx
      .update(migrationConnections)
      .set({ displayName: name })
      .where(eq(migrationConnections.id, c.id));
    await ctx.emit({
      type: 'migration_connection.renamed',
      entityType: 'migration_connection',
      entityId: c.id,
      payload: { source: c.sourceSystem },
      before: { name: c.displayName ?? sourceLabel(c.sourceSystem) },
      after: { name: name ?? sourceLabel(c.sourceSystem) },
    });
    return connectionState(c.id, c.status, true);
  },
});

export const migrationConnectionDisconnect = defineCommand({
  name: 'migration_connection.disconnect',
  description:
    'Disconnect the old system. Everything already brought across stays; any migration still catching up stops catching up. The old account itself is never touched.',
  risk: 3,
  input: MigrationConnectionRefInput,
  output: MigrationConnectionStateOutput,
  permission: 'org.migrations.manage',
  scope: inOrganization,
  emits: ['migration_connection.disconnected', 'migration.needs_attention'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const c = await loadConnection(ctx, input.connectionId);
    if (c.status === 'disconnected') return connectionState(c.id, c.status, false);
    // The trigger in 0064 destroys the tokens on the way out; this only asks for the change of state.
    await ctx.tx
      .update(migrationConnections)
      .set({ status: 'disconnected' })
      .where(eq(migrationConnections.id, c.id));
    // A migration still catching up cannot, without a source. It says so rather than going quiet.
    const stranded = await ctx.tx
      .update(migrations)
      .set({ status: 'needs_attention', lastError: 'The old system was disconnected.' })
      .where(
        and(
          eq(migrations.connectionId, c.id),
          inArray(migrations.status, [
            'scanning',
            'importing',
            'paused',
            'transition',
            'verifying',
          ]),
        ),
      )
      .returning({ id: migrations.id, name: migrations.name });
    for (const m of stranded)
      await ctx.emit({
        type: 'migration.needs_attention',
        entityType: 'migration',
        entityId: m.id,
        payload: { reason: 'source_disconnected' },
        after: { migration: m.name, reason: 'The old system was disconnected.' },
      });
    await ctx.emit({
      type: 'migration_connection.disconnected',
      entityType: 'migration_connection',
      entityId: c.id,
      payload: { source: c.sourceSystem, stranded: stranded.length },
      before: { status: c.status },
      after: { source: sourceLabel(c.sourceSystem), status: 'disconnected' },
    });
    return connectionState(c.id, 'disconnected', true);
  },
});

// ---------- the migration ----------

export const migrationCreate = defineCommand({
  name: 'migration.create',
  description:
    'Start a migration from a connected source. Nothing is read or written until it is scanned and somebody chooses what to bring.',
  risk: 1,
  input: MigrationCreateInput,
  output: MigrationCreateOutput,
  permission: null,
  scope: eitherDoor,
  emits: ['migration.created'],
  async handler(ctx, input) {
    requireAccess(ctx);
    const c = await loadConnection(ctx, input.connectionId);
    if (c.status !== 'active')
      throw HfosError.rule('migration_connection_not_active', 409, 'Connect the old system first.');
    const [row] = await ctx.tx
      .insert(migrations)
      .values({
        organizationId: ctx.scope.organizationId!,
        connectionId: c.id,
        sourceSystem: c.sourceSystem,
        status: 'connected',
        name: input.name,
        transitionEnabled: input.transition,
        includeDeleted: input.includeDeleted,
        adapterVersion: c.adapterVersion,
        createdBy: requireHuman(ctx).userId,
      })
      .returning({ id: migrations.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'migration.created',
      entityType: 'migration',
      entityId: row.id,
      payload: { source: c.sourceSystem, connectionId: c.id, transition: input.transition },
      after: {
        migration: input.name,
        source: sourceLabel(c.sourceSystem),
        keepsCatchingUp: input.transition,
        includesDeleted: input.includeDeleted,
      },
    });
    return { migrationId: row.id };
  },
});

export const migrationScan = defineCommand({
  name: 'migration.scan',
  description:
    'Look at the old system and count what is there. Read-only, and safe to run again: nothing it does can change a customer record.',
  risk: 1,
  input: MigrationScanInput,
  output: MigrationScanOutput,
  permission: null,
  scope: eitherDoor,
  emits: ['migration.scan_requested'],
  async handler(ctx, input) {
    const access = requireAccess(ctx);
    const m = await loadMigrationFor(ctx, input.migrationId, access);
    requireStatus(
      m,
      ['connected', 'scanned', 'ready', 'needs_attention', 'imported', 'transition'],
      'This migration is busy. Wait for it to finish, or pause it first.',
    );
    const [scan] = await ctx.tx
      .insert(migrationScans)
      .values({
        migrationId: m.id,
        organizationId: m.organizationId,
        scopeId: input.scopeId ?? null,
        status: 'scanning',
        adapterVersion: m.adapterVersion,
        requestedBy: requireHuman(ctx).userId,
      })
      .returning({ id: migrationScans.id });
    if (!scan) throw HfosError.forbidden();
    // Only the whole-migration scan moves the migration itself; re-scanning one sub-account leaves it alone.
    if (!input.scopeId)
      await ctx.tx.update(migrations).set({ status: 'scanning' }).where(eq(migrations.id, m.id));
    await ctx.tx.insert(migrationJobs).values({
      migrationId: m.id,
      organizationId: m.organizationId,
      scopeId: input.scopeId ?? null,
      kind: input.scopeId ? 'scan' : 'discover',
      category: 'locations',
      pass: 0,
      input: { scanId: scan.id },
    });
    await ctx.emit({
      type: 'migration.scan_requested',
      entityType: 'migration',
      entityId: m.id,
      payload: { scanId: scan.id, scopeId: input.scopeId ?? null },
      after: { migration: m.name, scanning: input.scopeId ? 'one business' : 'everything' },
    });
    return { migrationId: m.id, scanId: scan.id };
  },
});

export const migrationMapScopes = defineCommand({
  name: 'migration.map_scopes',
  description:
    'Say where each sub-account of the old system lands: a new business here, one that already exists, or nowhere. Several may land in the same business, and the plan says what that mixes.',
  risk: 3,
  input: MigrationMapScopesInput,
  output: MigrationMapScopesOutput,
  permission: null,
  scope: eitherDoor,
  emits: ['migration.scopes_mapped'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const m = await loadMigration(ctx, input.migrationId);
    requireStatus(
      m,
      ['connected', 'scanned', 'ready', 'needs_attention'],
      'This migration has already started. Pause it before changing where anything lands.',
    );
    const existing = await ctx.tx
      .select()
      .from(migrationScopes)
      .where(eq(migrationScopes.migrationId, m.id));
    const byId = new Map(existing.map((s) => [s.id, s]));
    let mapped = 0;
    let skipped = 0;

    for (const choice of input.scopes) {
      const scope = byId.get(choice.scopeId);
      if (!scope) throw HfosError.notFound('That business from the old system isn’t in this scan.');
      if (choice.skip) {
        await ctx.tx
          .update(migrationScopes)
          .set({ selected: false, status: 'skipped', workspaceId: null, createsWorkspace: false })
          .where(eq(migrationScopes.id, scope.id));
        skipped += 1;
        continue;
      }
      if (!choice.workspaceId && !choice.createWorkspace)
        throw HfosError.validation([
          { path: 'scopes', message: 'Choose a business for each one, or skip it.' },
        ]);
      let workspaceId = choice.workspaceId ?? null;
      let creates = false;
      if (!workspaceId) {
        // Made here so the rest of the migration has somewhere to land, and so rollback knows it made it.
        const name = choice.createWorkspace!.name;
        const [ws] = await ctx.tx
          .insert(workspaces)
          .values({
            organizationId: m.organizationId,
            name,
            slug: `${slugify(name)}-${randomUUID().slice(0, 6)}`,
            timezone: choice.createWorkspace!.timezone ?? scope.timezone ?? 'America/Chicago',
            createdBy: me,
          })
          .returning({ id: workspaces.id, slug: workspaces.slug });
        if (!ws) throw HfosError.forbidden();
        workspaceId = ws.id;
        creates = true;
        // The same event a person adding a business by hand raises, so everything downstream behaves.
        await ctx.emit({
          type: 'workspace.created',
          entityType: 'workspace',
          entityId: ws.id,
          workspaceId: ws.id,
          payload: { name, slug: ws.slug, madeBy: 'migration', migrationId: m.id },
          after: { name, slug: ws.slug, madeBy: `the migration ${m.name}` },
        });
      } else {
        const [ws] = await ctx.tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(
            and(eq(workspaces.id, workspaceId), eq(workspaces.organizationId, m.organizationId)),
          );
        if (!ws) throw HfosError.notFound('That business isn’t in this organization.');
      }
      await ctx.tx
        .update(migrationScopes)
        .set({ workspaceId, createsWorkspace: creates, selected: true, status: 'mapped' })
        .where(eq(migrationScopes.id, scope.id));
      mapped += 1;
    }

    // Chris allowed many-to-one. This is the page saying what it mixes, before anybody presses Import.
    const after = await ctx.tx
      .select({
        workspaceId: migrationScopes.workspaceId,
        name: migrationScopes.name,
        workspaceName: workspaces.name,
      })
      .from(migrationScopes)
      .leftJoin(workspaces, eq(workspaces.id, migrationScopes.workspaceId))
      .where(
        and(
          eq(migrationScopes.migrationId, m.id),
          eq(migrationScopes.selected, true),
          isNotNull(migrationScopes.workspaceId),
        ),
      );
    const grouped = new Map<string, { workspaceName: string; scopeNames: string[] }>();
    for (const row of after) {
      const key = row.workspaceId!;
      const g = grouped.get(key) ?? {
        workspaceName: row.workspaceName ?? 'this business',
        scopeNames: [],
      };
      g.scopeNames.push(row.name);
      grouped.set(key, g);
    }
    const shared = [...grouped.values()].filter((g) => g.scopeNames.length > 1);

    await ctx.tx
      .delete(migrationFindings)
      .where(
        and(
          eq(migrationFindings.migrationId, m.id),
          eq(migrationFindings.code, FINDING_CODES.scopesShareWorkspace),
        ),
      );
    for (const g of shared) {
      const f = sharedWorkspaceFinding(g);
      await ctx.tx.insert(migrationFindings).values({
        migrationId: m.id,
        organizationId: m.organizationId,
        code: f.code,
        capability: f.capability,
        severity: f.severity,
        summary: f.summary,
        whatImports: f.whatImports ?? null,
        whatChanges: f.whatChanges ?? null,
        recommendedAction: f.recommendedAction ?? null,
        affectedCount: f.affectedCount ?? 0,
        detail: f.detail ?? {},
      });
    }

    await ctx.emit({
      type: 'migration.scopes_mapped',
      entityType: 'migration',
      entityId: m.id,
      payload: { mapped, skipped, shared: shared.length },
      after: {
        migration: m.name,
        businesses: mapped,
        skipped,
        sharingOneBusiness: shared.map((s) => s.workspaceName),
      },
    });
    return { migrationId: m.id, mapped, skipped, shared };
  },
});

export const migrationSelect = defineCommand({
  name: 'migration.select',
  description:
    'Choose what to bring across. Anything a choice needs is added automatically and locked, with a line saying which choice asked for it.',
  risk: 1,
  input: MigrationSelectInput,
  output: MigrationSelectOutput,
  permission: null,
  scope: eitherDoor,
  emits: ['migration.selection_changed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const access = requireAccess(ctx);
    const m = await loadMigrationFor(ctx, input.migrationId, access);
    requireStatus(
      m,
      ['connected', 'scanned', 'ready', 'needs_attention'],
      'This migration has already started. Pause it before changing what it brings.',
    );
    const scopes = await ctx.tx
      .select({ id: migrationScopes.id })
      .from(migrationScopes)
      .where(
        and(
          eq(migrationScopes.migrationId, m.id),
          eq(migrationScopes.selected, true),
          input.scopeId ? eq(migrationScopes.id, input.scopeId) : dsql`true`,
          // A business chooses for its own businesses. An agency's choice, made with no business named,
          // covers every one in the migration.
          access.onlyWorkspaceId
            ? eq(migrationScopes.workspaceId, access.onlyWorkspaceId)
            : dsql`true`,
        ),
      );
    if (scopes.length === 0)
      throw HfosError.rule(
        'migration_no_scopes',
        409,
        'Say where each business from the old system lands first.',
      );

    for (const scope of scopes) {
      for (const choice of input.choices) {
        if (!migrationCategory(choice.category))
          throw HfosError.validation([
            { path: 'choices', message: `There is nothing called ${choice.category}.` },
          ]);
        await ctx.tx.execute(sql`
          insert into app.migration_selections
            (migration_id, organization_id, scope_id, category, resource_id, selected, auto_added,
             required_by, chosen_by)
          values (${m.id}, ${m.organizationId}, ${scope.id}, ${choice.category},
            ${choice.resourceId ?? null}, ${choice.selected}, false, '{}', ${me})
          on conflict (scope_id, category, coalesce(resource_id, '')) do update set
            selected = excluded.selected, auto_added = false, required_by = '{}',
            chosen_by = excluded.chosen_by`);
      }
    }

    // What is now chosen, per sub-account, plus whatever that needs. The categories the old system cannot
    // give us are the ones the scan marked unreadable — a choice that depends on one of those is dropped
    // rather than started and abandoned half way.
    const chosenRows = await ctx.tx
      .select({ category: migrationSelections.category })
      .from(migrationSelections)
      .where(
        and(
          eq(migrationSelections.migrationId, m.id),
          eq(migrationSelections.selected, true),
          dsql`${migrationSelections.resourceId} is null`,
        ),
      );
    const unreadable = await ctx.tx
      .selectDistinct({ category: migrationInventory.category })
      .from(migrationInventory)
      .where(
        and(
          eq(migrationInventory.migrationId, m.id),
          inArray(migrationInventory.capability, ['not_available']),
        ),
      );
    const resolved = resolveSelection({
      chosen: [...new Set(chosenRows.map((r) => r.category))].filter(isImportable),
      unavailable: unreadable.map((r) => r.category),
    });

    // Write the automatic ones so the screen can lock them and say who asked.
    for (const scope of scopes) {
      for (const add of resolved.added) {
        await ctx.tx.execute(sql`
          insert into app.migration_selections
            (migration_id, organization_id, scope_id, category, resource_id, selected, auto_added,
             required_by, chosen_by)
          values (${m.id}, ${m.organizationId}, ${scope.id}, ${add.category}, null, true, true,
            ${textArray(add.requiredBy)}, ${me})
          on conflict (scope_id, category, coalesce(resource_id, '')) do update set
            selected = true, auto_added = true, required_by = excluded.required_by`);
      }
    }

    const selectedCategories = resolved.categories.map((c) => c.id);
    await ctx.tx
      .update(migrations)
      .set({ status: m.status === 'connected' ? 'connected' : 'ready' })
      .where(eq(migrations.id, m.id));
    await ctx.emit({
      type: 'migration.selection_changed',
      entityType: 'migration',
      entityId: m.id,
      payload: { categories: selectedCategories, added: resolved.added.map((a) => a.category) },
      after: {
        migration: m.name,
        bringing: selectedCategories.length,
        addedAutomatically: resolved.added.map(
          (a) => migrationCategory(a.category)?.label ?? a.category,
        ),
      },
      broadcast: false,
    });
    return {
      migrationId: m.id,
      added: resolved.added.map((a) => ({
        category: a.category,
        requiredBy: [...a.requiredBy],
        reason: dependencyReason(a.category, a.requiredBy),
      })),
      blocked: resolved.blocked.map((b) => ({ category: b.category, missing: [...b.missing] })),
      selectedCategories,
    };
  },
});

export const migrationStart = defineCommand({
  name: 'migration.start',
  description:
    'Bring it across. Queues the work in dependency order; nothing outside this business is ever contacted, and no message, invoice or reminder goes out because of it.',
  risk: 4,
  input: MigrationStartInput,
  output: MigrationStateOutput,
  permission: null,
  scope: eitherDoor,
  emits: ['migration.started'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const access = requireAccess(ctx);
    const m = await loadMigrationFor(ctx, input.migrationId, access);
    requireStatus(
      m,
      ['connected', 'scanned', 'ready', 'paused', 'needs_attention'],
      'This migration is already running.',
    );

    // Anything that blocks has to have been seen. Everything else is information, not a gate.
    const blocking = await ctx.tx
      .select({ id: migrationFindings.id, summary: migrationFindings.summary })
      .from(migrationFindings)
      .where(
        and(
          eq(migrationFindings.migrationId, m.id),
          eq(migrationFindings.blocksImport, true),
          dsql`${migrationFindings.acknowledgedAt} is null`,
        ),
      );
    const seen = new Set(input.acknowledgedFindingIds);
    const unseen = blocking.filter((b) => !seen.has(b.id));
    if (unseen.length > 0)
      throw HfosError.rule(
        'migration_findings_unacknowledged',
        409,
        `Read this first: ${unseen[0]!.summary}`,
      );
    if (blocking.length > 0)
      await ctx.tx
        .update(migrationFindings)
        .set({ acknowledgedAt: new Date(), acknowledgedBy: me })
        .where(
          inArray(
            migrationFindings.id,
            blocking.map((b) => b.id),
          ),
        );

    const scopes = await ctx.tx
      .select({ id: migrationScopes.id, workspaceId: migrationScopes.workspaceId })
      .from(migrationScopes)
      .where(
        and(
          eq(migrationScopes.migrationId, m.id),
          eq(migrationScopes.selected, true),
          isNotNull(migrationScopes.workspaceId),
          // Pressing the button on one business's page brings that business across, not the other
          // nineteen sharing the migration.
          access.onlyWorkspaceId
            ? eq(migrationScopes.workspaceId, access.onlyWorkspaceId)
            : dsql`true`,
        ),
      )
      .orderBy(asc(migrationScopes.name), asc(migrationScopes.id));
    if (scopes.length === 0)
      throw HfosError.rule(
        'migration_no_scopes',
        409,
        'Say where each business from the old system lands first.',
      );

    let queued = 0;
    // Always in the same order, by name. Two runs of one migration should do the same thing, and when two
    // sub-accounts hold the same customer, which one is read first decides which record the other joins.
    let position = 0;
    for (const scope of scopes) {
      const chosen = await ctx.tx
        .select({ category: migrationSelections.category })
        .from(migrationSelections)
        .where(
          and(
            eq(migrationSelections.scopeId, scope.id),
            eq(migrationSelections.selected, true),
            dsql`${migrationSelections.resourceId} is null`,
          ),
        );
      const resolved = resolveSelection({
        chosen: [...new Set(chosen.map((c) => c.category))].filter(isImportable),
      });
      for (const cat of resolved.categories) {
        await ctx.tx.insert(migrationJobs).values({
          migrationId: m.id,
          organizationId: m.organizationId,
          scopeId: scope.id,
          workspaceId: scope.workspaceId,
          kind: 'fetch',
          category: cat.id,
          pass: cat.pass,
          // A millisecond apart, in name order, so the batches are claimed in that order too.
          runAt: new Date(Date.now() + position),
          input: {},
        });
        queued += 1;
      }
      await ctx.tx
        .update(migrationScopes)
        .set({ status: 'importing', startedAt: new Date() })
        .where(eq(migrationScopes.id, scope.id));
      position += 1;
    }
    if (queued === 0)
      throw HfosError.rule('migration_nothing_selected', 409, 'Choose something to bring first.');

    await ctx.tx
      .update(migrations)
      .set({ status: 'importing', startedAt: m.startedAt ?? new Date(), lastError: null })
      .where(eq(migrations.id, m.id));
    await ctx.emit({
      type: 'migration.started',
      entityType: 'migration',
      entityId: m.id,
      payload: { scopes: scopes.length, queued },
      after: { migration: m.name, businesses: scopes.length, categories: queued },
    });
    return migrationState(m.id, 'importing', true);
  },
});

export const migrationPause = defineCommand({
  name: 'migration.pause',
  description:
    'Stop after the batch that is running. Nothing already brought across is undone, and resuming carries on from the same place.',
  risk: 2,
  input: MigrationRefInput,
  output: MigrationStateOutput,
  permission: null,
  scope: eitherDoor,
  emits: ['migration.paused'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const m = await loadMigration(ctx, input.migrationId);
    if (m.status !== 'importing' && m.status !== 'scanning')
      return migrationState(m.id, m.status as MigrationLifecycle, false);
    await ctx.tx.update(migrations).set({ status: 'paused' }).where(eq(migrations.id, m.id));
    await ctx.emit({
      type: 'migration.paused',
      entityType: 'migration',
      entityId: m.id,
      payload: {},
      before: { status: m.status },
      after: { migration: m.name, status: 'paused' },
    });
    return migrationState(m.id, 'paused', true);
  },
});

export const migrationResume = defineCommand({
  name: 'migration.resume',
  description: 'Carry on from the last place that was safely saved.',
  risk: 2,
  input: MigrationRefInput,
  output: MigrationStateOutput,
  permission: null,
  scope: eitherDoor,
  emits: ['migration.resumed'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const m = await loadMigration(ctx, input.migrationId);
    if (m.status !== 'paused' && m.status !== 'needs_attention')
      return migrationState(m.id, m.status as MigrationLifecycle, false);
    const [pending] = await rows<{ count: number }>(
      ctx.tx,
      sql`select count(*)::int as count from app.migration_jobs
          where migration_id = ${m.id} and state in ('pending', 'retry', 'leased')`,
    );
    const count = pending?.count ?? 0;
    // Nothing left to fetch: the checks are what is missing, so they are queued rather than the migration
    // declaring itself finished. Whether it is finished is the engine's answer, never a button's.
    if (count === 0)
      await ctx.tx.insert(migrationJobs).values({
        migrationId: m.id,
        organizationId: m.organizationId,
        kind: 'verify',
        category: 'locations',
        pass: 9,
        input: {},
      });
    await ctx.tx
      .update(migrations)
      .set({ status: 'importing', lastError: null })
      .where(eq(migrations.id, m.id));
    await ctx.emit({
      type: 'migration.resumed',
      entityType: 'migration',
      entityId: m.id,
      payload: { pending: count },
      after: { migration: m.name, carryingOn: count > 0 ? `${count} batches` : 'the checks' },
    });
    return migrationState(m.id, 'importing', true);
  },
});

export const migrationRetry = defineCommand({
  name: 'migration.retry',
  description:
    'Try the failures again. Records that already came across are not brought twice — the source identity sees to that.',
  risk: 2,
  input: MigrationRetryInput,
  output: MigrationRetryOutput,
  permission: null,
  scope: eitherDoor,
  emits: ['migration.retry_requested'],
  async handler(ctx, input) {
    const access = requireAccess(ctx);
    const m = await loadMigrationFor(ctx, input.migrationId, access);
    const requeued = await ctx.tx
      .update(migrationJobs)
      .set({
        state: 'retry',
        runAt: new Date(),
        lastError: null,
        leasedBy: null,
        leasedUntil: null,
      })
      .where(
        and(
          eq(migrationJobs.migrationId, m.id),
          inArray(migrationJobs.state, ['failed', 'quarantined']),
          input.category ? eq(migrationJobs.category, input.category) : dsql`true`,
          input.scopeId ? eq(migrationJobs.scopeId, input.scopeId) : dsql`true`,
          // Trying again from one business's page tries that business's failures again.
          access.onlyWorkspaceId
            ? eq(migrationJobs.workspaceId, access.onlyWorkspaceId)
            : dsql`true`,
        ),
      )
      .returning({ id: migrationJobs.id });
    if (requeued.length > 0 && m.status !== 'importing')
      await ctx.tx
        .update(migrations)
        .set({ status: 'importing', lastError: null })
        .where(eq(migrations.id, m.id));
    await ctx.emit({
      type: 'migration.retry_requested',
      entityType: 'migration',
      entityId: m.id,
      payload: { category: input.category ?? null, requeued: requeued.length },
      after: { migration: m.name, tryingAgain: requeued.length },
    });
    return { migrationId: m.id, requeued: requeued.length };
  },
});

export const migrationExtendTransition = defineCommand({
  name: 'migration.extend_transition',
  description:
    'Keep catching up with the old system for longer. It never stops quietly: when the time runs out the migration asks.',
  risk: 2,
  input: MigrationExtendTransitionInput,
  output: MigrationExtendTransitionOutput,
  permission: 'org.migrations.manage',
  scope: inOrganization,
  emits: ['migration.transition_extended'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const m = await loadMigration(ctx, input.migrationId);
    if (!m.transitionEnabled)
      throw HfosError.rule(
        'migration_no_transition',
        409,
        'This migration brought the history once and stopped.',
      );
    const from =
      m.transitionEndsAt && m.transitionEndsAt > new Date() ? m.transitionEndsAt : new Date();
    const endsAt = new Date(from.getTime() + input.days * 86_400_000);
    await ctx.tx
      .update(migrations)
      .set({
        transitionEndsAt: endsAt,
        transitionExtendedCount: m.transitionExtendedCount + 1,
        status: m.status === 'needs_attention' ? 'transition' : m.status,
      })
      .where(eq(migrations.id, m.id));
    await ctx.emit({
      type: 'migration.transition_extended',
      entityType: 'migration',
      entityId: m.id,
      payload: { days: input.days, endsAt: endsAt.toISOString() },
      before: { until: m.transitionEndsAt?.toISOString() ?? null },
      after: { migration: m.name, until: endsAt.toISOString(), days: input.days },
    });
    return { migrationId: m.id, transitionEndsAt: endsAt.toISOString() };
  },
});

export const migrationFinalize = defineCommand({
  name: 'migration.finalize',
  description:
    'Finish the move: one last catch-up, the checks, and then the old system stops being asked. It never cancels the old account for you.',
  risk: 3,
  input: MigrationFinalizeInput,
  output: MigrationStateOutput,
  permission: 'org.migrations.manage',
  scope: inOrganization,
  emits: ['migration.finalize_requested'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const m = await loadMigration(ctx, input.migrationId);
    requireStatus(
      m,
      ['imported', 'transition', 'needs_attention'],
      'Bring the records across first.',
    );
    const [tasks] = await rows<{ open: number }>(
      ctx.tx,
      sql`select count(*)::int as open from app.migration_reconnect_tasks
          where migration_id = ${m.id} and state in ('todo', 'in_progress', 'blocked') and blocks_live_use`,
    );
    const open = tasks?.open ?? 0;
    if (open > 0 && !input.acknowledgeOpenTasks)
      throw HfosError.rule(
        'migration_tasks_open',
        409,
        `${open} setup ${open === 1 ? 'step' : 'steps'} still need doing before this business can take money or send mail. Finish them, or say you know.`,
      );
    await ctx.tx
      .update(migrations)
      .set({ status: 'finalizing', lastError: null })
      .where(eq(migrations.id, m.id));
    await ctx.tx.insert(migrationJobs).values({
      migrationId: m.id,
      organizationId: m.organizationId,
      kind: 'verify',
      category: 'locations',
      pass: 9,
      input: { finalize: true, acknowledgedOpenTasks: input.acknowledgeOpenTasks },
    });
    await ctx.emit({
      type: 'migration.finalize_requested',
      entityType: 'migration',
      entityId: m.id,
      payload: { openTasks: open },
      after: { migration: m.name, setupStepsStillOpen: open },
    });
    return migrationState(m.id, 'finalizing', true);
  },
});

export const migrationRollback = defineCommand({
  name: 'migration.rollback',
  description:
    'Take back what this migration put here. Customers who were already here are never deleted, and anything somebody has changed since is left exactly as they left it.',
  risk: 4,
  input: MigrationRollbackInput,
  output: MigrationStateOutput,
  permission: null,
  scope: eitherDoor,
  emits: ['migration.rollback_requested'],
  async handler(ctx, input) {
    const access = requireAccess(ctx);
    const m = await loadMigrationFor(ctx, input.migrationId, access);
    if (access.onlyWorkspaceId) {
      // Rolling back is all or nothing across a migration: the journal is unwound in one pass. So a business
      // may take back a move that is only its own, and a move carrying other businesses stays the agency's —
      // otherwise one client's change of mind would undo nineteen others' imports.
      const [others] = await rows<{ count: number }>(
        ctx.tx,
        sql`select count(*)::int as count from app.migration_scopes
            where migration_id = ${m.id} and selected and workspace_id is not null
              and workspace_id <> ${access.onlyWorkspaceId}`,
      );
      if ((others?.count ?? 0) > 0)
        throw HfosError.forbidden(
          'This move brought other businesses across as well, so only your agency can take it back.',
        );
    }
    if (m.status === 'rolling_back' || m.status === 'rolled_back')
      return migrationState(m.id, m.status as MigrationLifecycle, false);
    requireStatus(
      m,
      ['imported', 'transition', 'completed', 'needs_attention', 'failed', 'paused'],
      'Pause the migration before taking it back.',
    );
    // Whatever was still queued stops; the rollback is the only work left.
    await ctx.tx
      .update(migrationJobs)
      .set({ state: 'cancelled', finishedAt: new Date() })
      .where(
        and(
          eq(migrationJobs.migrationId, m.id),
          inArray(migrationJobs.state, ['pending', 'retry', 'leased']),
        ),
      );
    await ctx.tx
      .update(migrations)
      .set({ status: 'rolling_back', lastError: null })
      .where(eq(migrations.id, m.id));
    await ctx.tx.insert(migrationJobs).values({
      migrationId: m.id,
      organizationId: m.organizationId,
      kind: 'rollback',
      category: 'locations',
      pass: 0,
      input: {},
    });
    await ctx.emit({
      type: 'migration.rollback_requested',
      entityType: 'migration',
      entityId: m.id,
      payload: {},
      before: { status: m.status },
      after: { migration: m.name, status: 'rolling back' },
    });
    return migrationState(m.id, 'rolling_back', true);
  },
});

export const migrationResolveMerge = defineCommand({
  name: 'migration.resolve_merge',
  description:
    'Say whether somebody arriving from the old system is somebody already here, or a different person.',
  risk: 2,
  input: MigrationMergeResolveInput,
  output: MigrationMergeResolveOutput,
  permission: null,
  scope: eitherDoor,
  emits: ['migration.merge_resolved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const access = requireAccess(ctx);
    const [c] = await ctx.tx
      .select()
      .from(migrationMergeCandidates)
      .where(
        and(
          eq(migrationMergeCandidates.id, input.candidateId),
          eq(migrationMergeCandidates.organizationId, ctx.scope.organizationId!),
        ),
      );
    if (!c) throw HfosError.notFound('That one has already been decided.');
    if (!mayActForWorkspace(access, c.workspaceId)) throw HfosError.notFound(MIGRATION_NOT_YOURS);
    if (c.resolution !== 'pending') return { candidateId: c.id, resolution: c.resolution };
    if (input.decision === 'remap' && !input.targetId)
      throw HfosError.validation([{ path: 'targetId', message: 'Choose who it is.' }]);
    const resolution =
      input.decision === 'merge'
        ? 'merged'
        : input.decision === 'separate'
          ? 'separate'
          : 'remapped';
    await ctx.tx
      .update(migrationMergeCandidates)
      .set({
        resolution,
        targetId: input.decision === 'remap' ? input.targetId! : c.targetId,
        resolvedAt: new Date(),
        resolvedBy: me,
        autoResolved: false,
      })
      .where(eq(migrationMergeCandidates.id, c.id));
    // The import picks the decision up on its next pass over this record.
    await ctx.tx.insert(migrationJobs).values({
      migrationId: c.migrationId,
      organizationId: c.organizationId,
      scopeId: c.scopeId,
      workspaceId: c.workspaceId,
      kind: 'import',
      category: 'contacts',
      pass: 3,
      input: {
        sourceObjectType: c.sourceObjectType,
        sourceObjectId: c.sourceObjectId,
        resolvedCandidateId: c.id,
      },
    });
    await ctx.emit({
      type: 'migration.merge_resolved',
      entityType: 'migration',
      entityId: c.migrationId,
      workspaceId: c.workspaceId,
      payload: { candidateId: c.id, resolution },
      after: { decision: resolution },
      broadcast: false,
    });
    return { candidateId: c.id, resolution };
  },
});

export const migrationTaskDone = defineCommand({
  name: 'migration.task_done',
  description: 'Tick off a setup step, such as reconnecting Stripe or changing a DNS record.',
  risk: 1,
  input: MigrationTaskDoneInput,
  output: MigrationTaskDoneOutput,
  permission: null,
  scope: eitherDoor,
  emits: ['migration.task_changed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const access = requireAccess(ctx);
    const [t] = await ctx.tx
      .select()
      .from(migrationReconnectTasks)
      .where(
        and(
          eq(migrationReconnectTasks.id, input.taskId),
          eq(migrationReconnectTasks.organizationId, ctx.scope.organizationId!),
        ),
      );
    if (!t) throw HfosError.notFound('That setup step isn’t there.');
    // A step with no business named belongs to the move as a whole — reconnecting the source itself, say —
    // so it stays the agency's to tick off. A business ticks off its own.
    if (access.onlyWorkspaceId && (!t.workspaceId || !mayActForWorkspace(access, t.workspaceId)))
      throw HfosError.notFound('That setup step isn’t there.');
    const state = input.done ? 'done' : 'todo';
    if (t.state === state) return { taskId: t.id, state };
    await ctx.tx
      .update(migrationReconnectTasks)
      .set({
        state,
        completedAt: input.done ? new Date() : null,
        completedBy: input.done ? me : null,
      })
      .where(eq(migrationReconnectTasks.id, t.id));
    await ctx.emit({
      type: 'migration.task_changed',
      entityType: 'migration',
      entityId: t.migrationId,
      workspaceId: t.workspaceId,
      payload: { taskId: t.id, state },
      before: { state: t.state },
      after: { step: t.label, state },
      broadcast: false,
    });
    return { taskId: t.id, state };
  },
});

/** Everything a migration can be told to do. Registered in one list, as the other milestones are. */
export const migrationCommands = [
  migrationConnect,
  migrationConnectionRename,
  migrationConnectionDisconnect,
  migrationCreate,
  migrationScan,
  migrationMapScopes,
  migrationSelect,
  migrationStart,
  migrationPause,
  migrationResume,
  migrationRetry,
  migrationExtendTransition,
  migrationFinalize,
  migrationRollback,
  migrationResolveMerge,
  migrationTaskDone,
] as const;
