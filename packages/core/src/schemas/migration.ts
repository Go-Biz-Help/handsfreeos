/**
 * Moving a business here from another CRM (M11): the commands and queries. Browser-safe.
 *
 * The vocabularies are `app.*`'s enums to the word, and the category names come from core's own catalog rather
 * than being written out again, so a category added there is usable here the same day.
 */
import { z } from 'zod';
import { COUNT_QUALITIES, MIGRATION_CAPABILITIES } from '../migrations/capability';
import { isoDateTime, timezone, uuid } from './common';

// ---------- vocabularies ----------

/** The CRMs an adapter exists for, or is being written for. */
export const MIGRATION_SOURCES = [
  'gohighlevel',
  'hubspot',
  'salesforce',
  'jobber',
  'housecall_pro',
  'servicetitan',
  'follow_up_boss',
] as const;
export type MigrationSourceSystem = (typeof MIGRATION_SOURCES)[number];
export const migrationSource = z.enum(MIGRATION_SOURCES);

/** What a business calls each one. */
export const SOURCE_LABELS: Record<MigrationSourceSystem, string> = {
  gohighlevel: 'GoHighLevel',
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  jobber: 'Jobber',
  housecall_pro: 'Housecall Pro',
  servicetitan: 'ServiceTitan',
  follow_up_boss: 'Follow Up Boss',
};

/** The adapters that actually work today. The rest are named so the seam is the same when they arrive. */
export const LIVE_SOURCES: readonly MigrationSourceSystem[] = ['gohighlevel'];

export const MIGRATION_INSTALL_KINDS = ['agency', 'location'] as const;
export const migrationInstallKind = z.enum(MIGRATION_INSTALL_KINDS);

/**
 * The two doors onto a source (0069). `oauth` is a sign-in: the person approves what we may reach and the
 * source tells us what it granted. `private_token` is a token the business made inside one sub-account and
 * pasted here — it reaches that sub-account only, it says nothing about what it may read, and it does not
 * expire. The second door exists because a marketplace app has to be approved and installable, and neither
 * is true of every account.
 */
export const MIGRATION_AUTH_KINDS = ['oauth', 'private_token'] as const;
export type MigrationAuthKind = (typeof MIGRATION_AUTH_KINDS)[number];
export const migrationAuthKind = z.enum(MIGRATION_AUTH_KINDS);

/** The sources a private token can be pasted for. GoHighLevel calls its own "private integrations". */
export const PRIVATE_TOKEN_SOURCES: readonly MigrationSourceSystem[] = ['gohighlevel'];

export const MIGRATION_CONNECTION_STATUSES = [
  'pending',
  'active',
  'reauth_required',
  'error',
  'disconnected',
] as const;
export const migrationConnectionStatus = z.enum(MIGRATION_CONNECTION_STATUSES);

export const MIGRATION_STATUSES = [
  'draft',
  'connected',
  'scanning',
  'scanned',
  'ready',
  'importing',
  'paused',
  'verifying',
  'imported',
  'transition',
  'finalizing',
  'completed',
  'needs_attention',
  'failed',
  'cancelling',
  'cancelled',
  'rolling_back',
  'rolled_back',
] as const;
export type MigrationLifecycle = (typeof MIGRATION_STATUSES)[number];
export const migrationStatus = z.enum(MIGRATION_STATUSES);

export const MIGRATION_SCOPE_STATUSES = [
  'discovered',
  'skipped',
  'mapped',
  'scanning',
  'scanned',
  'ready',
  'importing',
  'paused',
  'verifying',
  'imported',
  'transition',
  'completed',
  'needs_attention',
  'failed',
  'rolling_back',
  'rolled_back',
] as const;
export const migrationScopeStatus = z.enum(MIGRATION_SCOPE_STATUSES);

export const migrationCapability = z.enum(MIGRATION_CAPABILITIES);
export const migrationCountQuality = z.enum(COUNT_QUALITIES);
export const findingSeverity = z.enum(['info', 'review', 'action', 'blocking']);

const category = z.string().trim().min(1).max(60);
const resourceId = z.string().trim().min(1).max(200);
const migrationName = z.string().trim().min(1).max(120);

const inOrg = { organizationId: uuid };
/**
 * Either door onto a migration (M11, 2026-09-18). An agency addresses one by its organization; a business
 * addresses it by itself, and then reaches only its own part. `organizationId` stays required because the
 * screens always know it, but a handler reads the organization off the resolved scope rather than off the
 * input — naming a workspace is what decides which door was used.
 */
const inOrgOrWorkspace = { organizationId: uuid, workspaceId: uuid.nullish() };

// ---------- connecting ----------

export const MigrationConnectInput = z.object({
  ...inOrgOrWorkspace,
  source: migrationSource,
  /**
   * An agency sign-in reaches every sub-account; a single-business sign-in reaches one. Which one is offered
   * depends on what the source supports, and the wrong choice is caught at the callback rather than guessed.
   */
  installKind: migrationInstallKind.default('agency'),
  /**
   * Which door (0069). A private token is always one sub-account, so `installKind` is ignored for it rather
   * than argued with. No token is ever sent to this command: it is pasted straight to the worker, which is
   * the only place that can seal one.
   */
  authKind: migrationAuthKind.default('oauth'),
});
export const MigrationConnectOutput = z.object({
  connectionId: uuid,
  /** A one-time state. Shown once, never stored in a command's answer. */
  state: z.string().min(16).max(200),
  authKind: migrationAuthKind,
  /**
   * Where the browser goes next, on the worker. A sign-in is followed (`GET`); a private token is posted to
   * it with the state, the token and the sub-account's id, and never passes through this API.
   */
  startPath: z.string().min(1).max(400),
});

export const MigrationConnectionRefInput = z.object({ ...inOrg, connectionId: uuid });

export const MigrationConnectionRenameInput = z.object({
  ...inOrg,
  connectionId: uuid,
  displayName: z.string().trim().min(1).max(200).nullable(),
});

export const MigrationConnectionStateOutput = z.object({
  connectionId: uuid,
  status: migrationConnectionStatus,
  changed: z.boolean(),
});

/** The worker, after the sign-in comes back. */
export const MigrationConnectionActivateInput = z.object({
  connectionId: uuid,
  externalAccountId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200).nullish(),
  installKind: migrationInstallKind,
  scopes: z.array(z.string().min(1).max(120)).max(200).default([]),
  missingScopes: z.array(z.string().min(1).max(120)).max(200).default([]),
  adapterVersion: z.string().trim().min(1).max(40),
});

// ---------- the migration ----------

export const MigrationCreateInput = z.object({
  ...inOrgOrWorkspace,
  connectionId: uuid,
  name: migrationName,
  /** Keep catching up with the old system until cutover, or bring the history once and stop. */
  transition: z.boolean().default(true),
  /** The advanced switch: bring what the old system has in its trash too. Off by default. */
  includeDeleted: z.boolean().default(false),
});
export const MigrationCreateOutput = z.object({ migrationId: uuid });

/** Naming one migration. Either door: pause, carry on, the report and the rollback preview all take both. */
export const MigrationRefInput = z.object({ ...inOrgOrWorkspace, migrationId: uuid });

export const MigrationStateOutput = z.object({
  migrationId: uuid,
  status: migrationStatus,
  changed: z.boolean(),
});

/** Where each sub-account lands. Several may name one business: the review step says what that mixes. */
export const MigrationMapScopesInput = z.object({
  ...inOrgOrWorkspace,
  migrationId: uuid,
  scopes: z
    .array(
      z.object({
        scopeId: uuid,
        /** Skip this sub-account entirely. */
        skip: z.boolean().default(false),
        /** Land it in a business that already exists. */
        workspaceId: uuid.nullish(),
        /** Or make one, with this name and time zone. */
        createWorkspace: z
          .object({ name: z.string().trim().min(1).max(120), timezone: timezone.nullish() })
          .nullish(),
      }),
    )
    .min(1)
    .max(500),
});
export const MigrationMapScopesOutput = z.object({
  migrationId: uuid,
  mapped: z.number().int().min(0),
  skipped: z.number().int().min(0),
  /** Businesses that more than one sub-account now points at, so the screen can say so plainly. */
  shared: z
    .array(z.object({ workspaceName: z.string(), scopeNames: z.array(z.string()) }))
    .default([]),
});

export const MigrationScanInput = z.object({
  ...inOrgOrWorkspace,
  migrationId: uuid,
  /** Scan one sub-account again rather than all of them. */
  scopeId: uuid.nullish(),
});
export const MigrationScanOutput = z.object({ migrationId: uuid, scanId: uuid });

export const MigrationSelectInput = z.object({
  ...inOrgOrWorkspace,
  migrationId: uuid,
  /** Left out, the choice applies to every sub-account that is coming across. */
  scopeId: uuid.nullish(),
  choices: z
    .array(
      z.object({
        category,
        resourceId: resourceId.nullish(),
        selected: z.boolean(),
      }),
    )
    .min(1)
    .max(2000),
});
export const MigrationSelectOutput = z.object({
  migrationId: uuid,
  /** What was added because something chosen needs it, and who asked for it. */
  added: z
    .array(z.object({ category, requiredBy: z.array(z.string()), reason: z.string() }))
    .default([]),
  /** Chosen, but dropped because the old system will not give us what it needs. */
  blocked: z.array(z.object({ category, missing: z.array(z.string()) })).default([]),
  selectedCategories: z.array(z.string()).default([]),
});

export const MigrationStartInput = z.object({
  ...inOrgOrWorkspace,
  migrationId: uuid,
  /** Findings that block have to be seen before anything is written. */
  acknowledgedFindingIds: z.array(uuid).max(200).default([]),
});

export const MigrationRetryInput = z.object({
  ...inOrgOrWorkspace,
  migrationId: uuid,
  /** One category, or everything that failed. */
  category: category.nullish(),
  scopeId: uuid.nullish(),
});
export const MigrationRetryOutput = z.object({
  migrationId: uuid,
  requeued: z.number().int().min(0),
});

/** Keeping the catch-up running longer than the thirty days it starts with. */
export const MigrationExtendTransitionInput = z.object({
  ...inOrg,
  migrationId: uuid,
  days: z.number().int().min(1).max(90),
});
export const MigrationExtendTransitionOutput = z.object({
  migrationId: uuid,
  transitionEndsAt: isoDateTime,
});

export const MigrationFinalizeInput = z.object({
  ...inOrg,
  migrationId: uuid,
  /** Setup items still open are acknowledged rather than ignored. */
  acknowledgeOpenTasks: z.boolean().default(false),
});

export const MigrationRollbackPreviewInput = MigrationRefInput;
export const MigrationRollbackPreviewOutput = z.object({
  migrationId: uuid,
  /** Records this migration made and nothing here depends on: they can go. */
  removable: z.number().int().min(0),
  /** Customers who were already here and were joined: never deleted, only their fields put back. */
  restorable: z.number().int().min(0),
  /** Left alone because somebody has changed them here since. */
  protected: z.number().int().min(0),
  /** Real-world things a rollback cannot undo. */
  external: z.array(z.string()).default([]),
});

export const MigrationRollbackInput = z.object({
  ...inOrgOrWorkspace,
  migrationId: uuid,
  /** Typed to confirm, because this removes records. */
  confirm: z.literal(true),
});

export const MigrationMergeResolveInput = z.object({
  ...inOrgOrWorkspace,
  candidateId: uuid,
  decision: z.enum(['merge', 'separate', 'remap']),
  /** For 'remap': the customer here it should point at instead. */
  targetId: uuid.nullish(),
});
export const MigrationMergeResolveOutput = z.object({ candidateId: uuid, resolution: z.string() });

export const MigrationTaskDoneInput = z.object({
  ...inOrgOrWorkspace,
  taskId: uuid,
  done: z.boolean().default(true),
});
export const MigrationTaskDoneOutput = z.object({ taskId: uuid, state: z.string() });

// ---------- reading ----------

export const MigrationListInput = z.object({ ...inOrgOrWorkspace });
export const MigrationListOutput = z.object({
  migrations: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      source: migrationSource,
      sourceLabel: z.string(),
      status: migrationStatus,
      scopes: z.number().int().min(0),
      startedAt: isoDateTime.nullable(),
      importedAt: isoDateTime.nullable(),
      transitionEndsAt: isoDateTime.nullable(),
      createdAt: isoDateTime,
    }),
  ),
  connections: z.array(
    z.object({
      id: uuid,
      source: migrationSource,
      sourceLabel: z.string(),
      installKind: migrationInstallKind,
      authKind: migrationAuthKind,
      status: migrationConnectionStatus,
      displayName: z.string().nullable(),
      /** Always empty for a private token, which never says what it may read. */
      missingScopes: z.array(z.string()),
      connectedAt: isoDateTime.nullable(),
    }),
  ),
});

const InventoryRow = z.object({
  category,
  categoryLabel: z.string(),
  blurb: z.string(),
  resourceId: z.string().nullable(),
  resourceName: z.string().nullable(),
  found: z.number().int().min(0),
  countQuality: migrationCountQuality,
  /** The words to show instead of a bare number when the count does not mean what a count means. */
  countLabel: z.string(),
  capability: migrationCapability,
  capabilityLabel: z.string(),
  estimatedBytes: z.number().int().min(0),
  dependsOn: z.array(z.string()),
  selected: z.boolean(),
  autoAdded: z.boolean(),
  requiredBy: z.array(z.string()),
  /** Whether a person may untick it (an automatically added requirement may not be). */
  locked: z.boolean(),
  notes: z.string().nullable(),
});

const FindingRow = z.object({
  id: uuid,
  code: z.string(),
  category: z.string().nullable(),
  scopeName: z.string().nullable(),
  capability: migrationCapability,
  severity: findingSeverity,
  group: z.string(),
  groupTitle: z.string(),
  summary: z.string(),
  whatImports: z.string().nullable(),
  whatChanges: z.string().nullable(),
  recommendedAction: z.string().nullable(),
  blocksImport: z.boolean(),
  affectedCount: z.number().int().min(0),
  acknowledged: z.boolean(),
});

export const MigrationGetInput = MigrationRefInput;
export const MigrationGetOutput = z.object({
  migration: z.object({
    id: uuid,
    name: z.string(),
    source: migrationSource,
    sourceLabel: z.string(),
    status: migrationStatus,
    transitionEnabled: z.boolean(),
    transitionEndsAt: isoDateTime.nullable(),
    includeDeleted: z.boolean(),
    startedAt: isoDateTime.nullable(),
    importedAt: isoDateTime.nullable(),
    finalizedAt: isoDateTime.nullable(),
    totals: z.record(z.string(), z.unknown()),
    lastError: z.string().nullable(),
  }),
  connection: z.object({
    id: uuid,
    status: migrationConnectionStatus,
    installKind: migrationInstallKind,
    displayName: z.string().nullable(),
    missingScopes: z.array(z.string()),
  }),
  scopes: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      externalScopeId: z.string(),
      timezone: z.string().nullable(),
      status: migrationScopeStatus,
      selected: z.boolean(),
      workspaceId: uuid.nullable(),
      workspaceName: z.string().nullable(),
      createsWorkspace: z.boolean(),
      /** Set when another sub-account lands in the same business. */
      sharesWorkspaceWith: z.array(z.string()).default([]),
      totals: z.record(z.string(), z.unknown()),
      lastError: z.string().nullable(),
    }),
  ),
  inventory: z.array(InventoryRow),
  findings: z.array(FindingRow),
  /** Setup steps left: reconnect Stripe, change the DNS, finish a port. Never counted as failures. */
  tasks: z.array(
    z.object({
      id: uuid,
      kind: z.string(),
      provider: z.string(),
      label: z.string(),
      state: z.string(),
      instructions: z.string().nullable(),
      settingsPath: z.string().nullable(),
      workspaceId: uuid.nullable(),
      blocksLiveUse: z.boolean(),
    }),
  ),
  progress: z.array(
    z.object({
      category,
      categoryLabel: z.string(),
      scopeId: uuid.nullable(),
      found: z.number().int().min(0),
      imported: z.number().int().min(0),
      merged: z.number().int().min(0),
      skipped: z.number().int().min(0),
      failed: z.number().int().min(0),
      complete: z.boolean(),
    }),
  ),
  /** How many customers are waiting on somebody to say whether they are the same person. */
  needsReview: z.number().int().min(0),
  /** Failures that can be tried again without duplicating anything. */
  retryable: z.number().int().min(0),
});

export const MigrationReviewQueueInput = z.object({
  ...inOrgOrWorkspace,
  migrationId: uuid,
  limit: z.number().int().min(1).max(100).default(25),
});
export const MigrationReviewQueueOutput = z.object({
  candidates: z.array(
    z.object({
      id: uuid,
      scopeName: z.string(),
      matchRule: z.string(),
      score: z.number().int(),
      reason: z.string(),
      incoming: z.object({
        name: z.string(),
        email: z.string().nullable(),
        phone: z.string().nullable(),
      }),
      here: z
        .array(
          z.object({
            id: uuid,
            name: z.string(),
            email: z.string().nullable(),
            phone: z.string().nullable(),
          }),
        )
        .default([]),
    }),
  ),
  remaining: z.number().int().min(0),
});

export const MigrationReportInput = MigrationRefInput;
export const MigrationReportOutput = z.object({
  migrationId: uuid,
  name: z.string(),
  sourceLabel: z.string(),
  status: migrationStatus,
  /** The headline: how many records are now here. */
  recordsMigrated: z.number().int().min(0),
  byCategory: z.array(
    z.object({
      category,
      categoryLabel: z.string(),
      found: z.number().int().min(0),
      imported: z.number().int().min(0),
      merged: z.number().int().min(0),
      skipped: z.number().int().min(0),
      failed: z.number().int().min(0),
      verified: z.boolean(),
    }),
  ),
  checks: z.array(
    z.object({
      kind: z.string(),
      category: z.string().nullable(),
      result: z.string(),
      expected: z.number().nullable(),
      actual: z.number().nullable(),
      summary: z.string().nullable(),
    }),
  ),
  findings: z.array(FindingRow),
  openTasks: z.number().int().min(0),
  failedItems: z.number().int().min(0),
  /** Where the downloadable file is, once the worker has written it. */
  reportPath: z.string().nullable(),
});
