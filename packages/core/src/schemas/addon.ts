/**
 * Add-ons (0108): what the lifecycle commands take and give back, and what the add-on queries show. Browser-safe, so
 * the screens build the same requests the Assistant and the tests do. See docs/addon-architecture.md.
 */
import { z } from 'zod';
import { CATALOG_STATUSES } from '../addons/manifest';
import { INSTALLATION_STATES, LIFECYCLE_ACTIONS } from '../addons/lifecycle';
import { isoDateTime, uuid } from './common';

export const addonId = z.string().regex(/^[a-z]{2,16}$/, 'Not an add-on.');
export const installationState = z.enum(INSTALLATION_STATES);
export const lifecycleAction = z.enum(LIFECYCLE_ACTIONS);

/**
 * A move on one add-on. `include` is the person's answer to "Turn off both?" (or "Install both?"): the other add-ons
 * they agreed to move with it. Without it, a move that would break a required dependency is refused with the list
 * to ask about (rule `addon_required_by` or `addon_needs`, disposition `ask`).
 */
export const AddonMoveInput = z.object({
  workspaceId: uuid,
  addonId,
  include: z.array(addonId).max(30).default([]),
});
export const AddonMoveOutput = z.object({
  /** Every add-on that moved, in the order it moved. Empty when it was already there. */
  moved: z.array(
    z.object({
      addonId,
      action: lifecycleAction,
      from: installationState.nullable(),
      to: installationState,
      generation: z.number().int(),
    }),
  ),
});

/** Permanently deleting an add-on's data: its name typed out, the way deleting a business asks for its name. */
export const AddonPurgeInput = z.object({
  workspaceId: uuid,
  addonId,
  confirmName: z.string().trim().min(1, 'Type the add-on’s name.').max(80),
});

export const AddonSaveSettingsInput = z.object({
  workspaceId: uuid,
  addonId,
  settings: z.record(z.string(), z.unknown()).optional(),
  flags: z.record(z.string(), z.boolean()).optional(),
});
export const AddonSaveMySettingsInput = z.object({
  workspaceId: uuid,
  addonId,
  settings: z.record(z.string(), z.unknown()),
});
export const AddonSettingsSaved = z.object({ addonId, saved: z.literal(true) });

export const AddonListInput = z.object({ workspaceId: uuid });

const CapabilityRow = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  provider: z.string(),
  providerName: z.string(),
});

export const AddonListOutput = z.object({
  /** Add-ons this business has, whatever state they are in, with where they stand. */
  installed: z.array(
    z.object({
      addonId,
      name: z.string(),
      summary: z.string(),
      state: installationState,
      installedVersion: z.string(),
      /** The code's version now: different from installedVersion after an update, until the worker catches up. */
      latestVersion: z.string().nullable(),
      generation: z.number().int(),
      changedAt: isoDateTime,
      /** Trouble finishing the last move, if any. */
      lastError: z.string().nullable(),
      /** Checks that failed the last time the worker looked (empty: nothing left behind). */
      failedChecks: z.array(z.string()),
      /** The add-on's code is gone from HandsFreeOS (a retired add-on): its data can still be deleted. */
      retired: z.boolean(),
    }),
  ),
  /** What this person can do here now, and what's installed but not theirs, or turned off. */
  capabilities: z.object({
    current: z.array(CapabilityRow),
    restricted: z.array(CapabilityRow),
    turnedOff: z.array(CapabilityRow),
    /** Only for people who may install add-ons: available ones this business doesn't have. */
    installable: z.array(CapabilityRow),
    /** Only for people who may install add-ons: what is planned. Never installable. */
    planned: z.array(CapabilityRow),
  }),
  catalog: z.array(
    z.object({
      addonId,
      name: z.string(),
      summary: z.string(),
      category: z.string(),
      status: z.enum(CATALOG_STATUSES),
    }),
  ),
});

export const AddonImpactInput = z.object({
  workspaceId: uuid,
  addonId,
  action: lifecycleAction,
});
export const AddonImpactOutput = z.object({
  addonId,
  action: lifecycleAction,
  /**
   * What would happen: `plan` lists every move in order (and `needsAgreement` names the ones the person must agree
   * to, which is the simple question to ask), `already` means nothing would change, `refused` says why it can't.
   */
  outcome: z.enum(['plan', 'already', 'refused']),
  moves: z.array(z.object({ addonId, action: lifecycleAction, name: z.string() })),
  needsAgreement: z.array(addonId),
  question: z.string().nullable(),
  refusal: z.object({ rule: z.string(), message: z.string() }).nullable(),
  /** Add-ons that use it when it's there and would lose those features. */
  optionalFor: z.array(z.object({ addonId, name: z.string() })),
  /** Capabilities that would stop. */
  capabilitiesLost: z.array(z.object({ id: z.string(), label: z.string() })),
  /** What it holds here now. */
  holds: z.object({
    records: z.number().int(),
    relationships: z.number().int(),
    pendingJobs: z.number().int(),
    heldResources: z.number().int(),
    ownRows: z.number().int(),
    usageEvents: z.number().int(),
  }),
});

export const AddonSettingsInput = z.object({ workspaceId: uuid, addonId });
export const AddonSettingsOutput = z.object({
  addonId,
  /** The business's settings, when this person may see them (the add-on's settings permission). */
  settings: z.record(z.string(), z.unknown()).nullable(),
  flags: z.record(z.string(), z.boolean()).nullable(),
  mySettings: z.record(z.string(), z.unknown()),
});
