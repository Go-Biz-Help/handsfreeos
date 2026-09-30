/**
 * HandsFreeOS's own business (M19): the one workspace that may send and receive on handsfreeos.com, so the people
 * who run HandsFreeOS have real mailboxes like chris@handsfreeos.com. A staff admin marks it in /admin; every other
 * business is still refused handsfreeos.com.
 *
 * Platform-scoped, like everything staff do. The SQL behind it (`private.set_platform_workspace`) checks
 * `platform.own_business.manage` for itself rather than trusting this caller, and a business can't set it.
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { OwnBusinessSetInput, OwnBusinessSetOutput } from '../schemas/support';

const onPlatform = () => ({ kind: 'platform' as const });

export const ownBusinessSet = defineCommand({
  name: 'own_business.set',
  description:
    'Support: mark one business as HandsFreeOS’s own, so it can use handsfreeos.com for its email, or unmark it.',
  risk: 3,
  input: OwnBusinessSetInput,
  output: OwnBusinessSetOutput,
  permission: 'platform.own_business.manage',
  scope: onPlatform,
  emits: ['own_business.changed'],
  async handler(ctx, input) {
    // Unmarking a business that still holds handsfreeos.com is the SQL's refusal (pg-errors has the words).
    const [row] = await rows<{ was: boolean; changed: boolean }>(
      ctx.tx,
      sql`select * from private.set_platform_workspace(${input.workspaceId}::uuid, ${input.on})`,
    );
    if (!row) throw HfosError.forbidden();
    if (row.changed)
      await ctx.emit({
        type: 'own_business.changed',
        entityType: 'workspace',
        entityId: input.workspaceId,
        payload: { workspaceId: input.workspaceId, on: input.on },
        before: { isPlatform: row.was },
        after: { isPlatform: input.on },
      });
    return { workspaceId: input.workspaceId, was: row.was, on: input.on, changed: row.changed };
  },
});

export const ownBusinessCommands = [ownBusinessSet];
