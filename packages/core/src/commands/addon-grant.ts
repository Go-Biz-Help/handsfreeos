/**
 * Staff hand an add-on still being built to one business to try it, and take it back (Real Estate, step 2). The
 * business's owners and admins then add it from their own Add-ons page, as they would an available one; taking the
 * grant back stops new installs, and leaves one already added running.
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
        'HandsFreeOS has no add-on by that name. Pick one from the list.',
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
      'Staff: let one business install an add-on that is still being built, to try it. Its owners and admins add it from their Add-ons page.',
    risk: 3,
    input: AddonGrantGiveInput,
    output: AddonGrantOutput,
    permission: 'platform.addons.manage',
    scope: onPlatform,
    emits: ['addon_grant.given'],
    async handler(ctx, input) {
      const m = await grantable(ctx, input.addonId);
      const [row] = await rows<{ changed: boolean }>(
        ctx.tx,
        sql`select * from private.give_addon_grant(${input.workspaceId}::uuid, ${m.id}, ${input.note ?? null})`,
      );
      if (row?.changed)
        await ctx.emit({
          type: 'addon_grant.given',
          entityType: 'workspace',
          entityId: input.workspaceId,
          payload: { workspaceId: input.workspaceId, addonId: m.id, note: input.note ?? null },
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
      'Staff: stop offering a business an add-on it was handed to try. If it already added it, it keeps running.',
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
