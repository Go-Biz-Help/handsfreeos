/**
 * Staff give one business an add-on free, and take it back (Real Estate, step 2; free, with an end date, since
 * 20261027028500). The business's owners and admins then add it from their own Add-ons page, as they would an
 * available one, even while it's still being built, and nothing is charged for it. Taking it back (or its end date
 * passing) stops new installs, and a paid add-on still running that nobody pays for is turned off by the worker, its
 * data kept; the business can keep it paying from its Add-ons page first, when it's on sale.
 *
 * Platform-scoped, like everything staff do. The SQL behind each (`private.give_addon_grant`,
 * `private.take_back_addon_grant`) checks `platform.addons.manage` for itself rather than trusting this caller.
 */
import { rows, sql } from '@hfos/db/client';
import { effectiveStatus } from '../addons/capabilities';
import { findAddon, type Catalog } from '../addons/graph';
import { loadOverrides } from '../addons/load';
import type { AddonManifest } from '../addons/manifest';
import { HfosError } from '../errors';
import type { CommandContext } from '../kernel/types';
import { defineCommand } from '../kernel/define';
import { AddonGrantGiveInput, AddonGrantOutput, AddonGrantTakeBackInput } from '../schemas/addon';

const onPlatform = () => ({ kind: 'platform' as const });

/** The grant commands, over a catalogue. */
export function addonGrantCommands(catalog: Catalog) {
  /** An add-on a grant can hand out: one this build has, still being built or available, not switched off. */
  async function grantable(ctx: CommandContext, addonId: string): Promise<AddonManifest> {
    const m = findAddon(catalog, addonId);
    if (!m)
      throw HfosError.rule(
        'addon_unknown',
        404,
        'HandsFreeOS has no add-on by that name. Pick one from Add-ons in testing, on the business’s page in the Admin area (Businesses, then the business).',
      );
    const status = effectiveStatus(m, await loadOverrides(ctx.tx));
    if (status === 'planned')
      throw HfosError.rule(
        'addon_not_grantable',
        409,
        `${m.name} is only planned, so there’s nothing to try yet.`,
      );
    if (status === 'deprecated' || status === 'unavailable')
      throw HfosError.rule(
        'addon_not_grantable',
        409,
        `${m.name} is switched off or on its way out, so it can’t be handed out. Undo that on the Add-ons page in /admin first.`,
      );
    return m;
  }

  const give = defineCommand({
    name: 'addon_grant.give',
    description:
      'Staff: give one business an add-on free, until taken back or until `freeUntil` (the last free day). It can install it even while still being built; its owners and admins add it from their Add-ons page. Anything the business was paying for it stops.',
    risk: 3,
    input: AddonGrantGiveInput,
    output: AddonGrantOutput,
    permission: 'platform.addons.manage',
    scope: onPlatform,
    emits: ['addon_grant.given'],
    async handler(ctx, input) {
      const m = await grantable(ctx, input.addonId);
      // Free through the whole of the last day it names, in UTC: it ends at the next midnight.
      const freeUntil = input.freeUntil
        ? new Date(Date.parse(`${input.freeUntil}T00:00:00Z`) + 86_400_000).toISOString()
        : null;
      const [row] = await rows<{ changed: boolean; organization_id: string | null }>(
        ctx.tx,
        sql`select * from private.give_addon_grant(${input.workspaceId}::uuid, ${m.id}, ${input.note ?? null},
              ${freeUntil}::timestamptz)`,
      );
      if (row?.changed)
        await ctx.emit({
          type: 'addon_grant.given',
          entityType: 'workspace',
          entityId: input.workspaceId,
          payload: {
            workspaceId: input.workspaceId,
            organizationId: row.organization_id,
            addonId: m.id,
            note: input.note ?? null,
            freeUntil,
          },
        });
      return {
        workspaceId: input.workspaceId,
        addonId: m.id,
        granted: true,
        changed: row?.changed ?? false,
      };
    },
  });

  const takeBack = defineCommand({
    name: 'addon_grant.take_back',
    description:
      'Staff: take back an add-on given to one business. A paid one it still runs is turned off within the hour unless it pays for it (its data is kept); a free one keeps running.',
    risk: 3,
    input: AddonGrantTakeBackInput,
    output: AddonGrantOutput,
    permission: 'platform.addons.manage',
    scope: onPlatform,
    emits: ['addon_grant.taken_back'],
    async handler(ctx, input) {
      const [row] = await rows<{ changed: boolean }>(
        ctx.tx,
        sql`select * from private.take_back_addon_grant(${input.workspaceId}::uuid, ${input.addonId})`,
      );
      if (row?.changed)
        await ctx.emit({
          type: 'addon_grant.taken_back',
          entityType: 'workspace',
          entityId: input.workspaceId,
          payload: { workspaceId: input.workspaceId, addonId: input.addonId },
        });
      return {
        workspaceId: input.workspaceId,
        addonId: input.addonId,
        granted: false,
        changed: row?.changed ?? false,
      };
    },
  });

  return { give, takeBack };
}
