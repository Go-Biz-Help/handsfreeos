/**
 * Values an add-on keeps sealed (round seven): the worker seals them before any command sees them, and showing one
 * again is the worker's too, for someone who may see it. Each time is kept here, in the history of the record it's
 * on, without the value: the add-on declares the label ("Lockbox code") and the event says who saw it.
 */
import { rows, sql } from '@hfos/db/client';
import { findAddon, type Catalog } from '../addons/graph';
import { sealedOf } from '../addons/sealed';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { AddonSealedViewedInput, AddonSealedViewedOutput } from '../schemas/addon-sealed';

export function addonSealedCommands(catalog: Catalog) {
  const viewed = defineCommand({
    name: 'addon_sealed.viewed',
    description:
      'Worker: someone who may was shown a value an add-on keeps sealed (a lockbox code). Kept in the record’s history.',
    risk: 0,
    input: AddonSealedViewedInput,
    output: AddonSealedViewedOutput,
    permission: null,
    actors: ['system'],
    scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
    emits: ['addon_sealed.viewed'],
    async handler(ctx, input) {
      const declared = sealedOf(catalog, input.addonId, input.key);
      const [on] = await rows<{ ok: boolean }>(
        ctx.tx,
        sql`select private.addon_in_use(${input.workspaceId}::uuid, ${input.addonId}, true) as ok`,
      );
      if (!on?.ok) throw HfosError.addonInactive(findAddon(catalog, input.addonId)!);
      await ctx.emit({
        type: 'addon_sealed.viewed',
        entityType: 'custom_record',
        entityId: input.recordId,
        payload: {
          addonId: input.addonId,
          key: input.key,
          itemId: input.itemId,
          viewedBy: input.viewedBy,
        },
        after: { addon: input.addonId, viewed: declared.label },
      });
      return { viewedAt: new Date().toISOString() };
    },
  });
  return { viewed };
}
