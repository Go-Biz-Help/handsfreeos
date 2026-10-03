/**
 * Reading what a business has (server side): its installation rows, HandsFreeOS's overrides and grants, and the capability
 * context the pure rules in `./capabilities` and `./plan` work from. One query each, whatever the number of add-ons.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import type { CapabilityContext } from './capabilities';
import type { Catalog } from './graph';
import type { InstallationState } from './lifecycle';
import type { OverrideStatus } from './manifest';
import type { AddonKept } from './words';

export interface InstallationRow {
  readonly addonId: string;
  readonly state: InstallationState;
  readonly installedVersion: string;
  readonly dataVersion: number;
  readonly settingsVersion: number;
  readonly generation: number;
  readonly settings: Record<string, unknown>;
  readonly flags: Record<string, boolean>;
  readonly changedAt: Date;
  readonly lastError: string | null;
  readonly verification: Record<string, unknown> | null;
}

/** Every add-on a business has ever installed, in whatever state (as the person, so row security applies). */
export async function loadInstallations(tx: Tx, workspaceId: string): Promise<InstallationRow[]> {
  const found = await rows<{
    addon_id: string;
    state: InstallationState;
    installed_version: string;
    data_version: number;
    settings_version: number;
    generation: number;
    settings: Record<string, unknown>;
    flags: Record<string, boolean>;
    changed_at: Date | string;
    last_error: string | null;
    verification: Record<string, unknown> | null;
  }>(
    tx,
    sql`select addon_id, state, installed_version, data_version, settings_version, generation, settings, flags,
          changed_at, last_error, verification
        from app.addon_installations where workspace_id = ${workspaceId} order by addon_id`,
  );
  return found.map((r) => ({
    addonId: r.addon_id,
    state: r.state,
    installedVersion: r.installed_version,
    dataVersion: r.data_version,
    settingsVersion: r.settings_version,
    generation: r.generation,
    settings: r.settings,
    flags: r.flags,
    changedAt: new Date(r.changed_at),
    lastError: r.last_error,
    verification: r.verification,
  }));
}

/** HandsFreeOS's overrides: add-ons switched off or deprecated everywhere. */
export async function loadOverrides(tx: Tx): Promise<Record<string, OverrideStatus>> {
  const found = await rows<{ addon_id: string; status: OverrideStatus }>(
    tx,
    sql`select addon_id, status from platform.addon_overrides`,
  );
  return Object.fromEntries(found.map((r) => [r.addon_id, r.status]));
}

/** The add-ons HandsFreeOS handed this business to try while they're still being built (`platform.addon_grants`). */
export async function loadGrants(tx: Tx, workspaceId: string): Promise<string[]> {
  const found = await rows<{ addon_id: string }>(
    tx,
    sql`select addon_id from platform.addon_grants where workspace_id = ${workspaceId}::uuid order by addon_id`,
  );
  return found.map((r) => r.addon_id);
}

/** The add-ons running in one business (enabled, not switched off by HandsFreeOS). */
export async function loadActiveAddons(tx: Tx, workspaceId: string): Promise<string[]> {
  const [row] = await rows<{ ids: string[] }>(
    tx,
    sql`select private.active_addons(${workspaceId}::uuid) as ids`,
  );
  return row?.ids ?? [];
}

/** The context the capability sets and transition plans are worked out from. */
export function capabilityContextOf(
  catalog: Catalog,
  installations: readonly InstallationRow[],
  overrides: Readonly<Record<string, OverrideStatus>>,
  permissions: readonly string[] | null,
  grants: readonly string[] = [],
): CapabilityContext {
  return {
    catalog,
    installations: Object.fromEntries(installations.map((i) => [i.addonId, i.state])),
    overrides,
    permissions,
    grants,
  };
}

/**
 * What an add-on's records on hold keep in a business (round six, private.addon_holds), with what its records are
 * called. Records nobody holds any more (a hold lifted, a date passed) aren't counted.
 */
export async function loadKept(tx: Tx, workspaceId: string, addonId: string): Promise<AddonKept> {
  const [h] = await rows<{
    records: number;
    open_records: number;
    held_until: Date | string | null;
    legal: number;
    plural: string | null;
  }>(
    tx,
    sql`select h.records, h.open_records, h.held_until, h.legal,
          (select lower(t.plural) from app.custom_record_types t
           where t.workspace_id = ${workspaceId}::uuid and t.addon_id = ${addonId} and t.kept_to_team
           order by t.created_at limit 1) as plural
        from private.addon_holds(${workspaceId}::uuid, ${addonId}) h`,
  );
  return {
    records: Number(h?.records ?? 0),
    openRecords: Number(h?.open_records ?? 0),
    heldUntil: h?.held_until ? new Date(h.held_until).toISOString() : null,
    legal: Number(h?.legal ?? 0),
    plural: h?.plural ?? null,
  };
}
