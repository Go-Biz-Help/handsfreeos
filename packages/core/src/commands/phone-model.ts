/**
 * The model a business's calls think with (the phone model): support picks one in /admin to hear how it sounds on
 * that business's calls and in its test console, without a redeploy, and puts it back just as fast. Null is the
 * worker's VOICE_MODEL.
 *
 * Platform-scoped, like everything staff do — and the SQL behind it (`private.set_phone_model`) checks
 * `platform.ai.manage` for itself rather than trusting this caller. A business can't change it.
 */
import { rows, sql } from '@hfos/db/client';
import { PHONE_MODELS } from '../ai-team/config';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { PhoneModelSetInput, PhoneModelSetOutput } from '../schemas/support';

const onPlatform = () => ({ kind: 'platform' as const });

export const phoneModelSet = defineCommand({
  name: 'phone_model.set',
  description:
    'Support: pick the model the AI teammate thinks with on one business’s calls, or put it back on the default.',
  risk: 3,
  input: PhoneModelSetInput,
  output: PhoneModelSetOutput,
  permission: 'platform.ai.manage',
  scope: onPlatform,
  emits: ['phone_model.changed'],
  async handler(ctx, input) {
    const [row] = await rows<{ was: string | null; changed: boolean }>(
      ctx.tx,
      sql`select * from private.set_phone_model(${input.workspaceId}::uuid, ${input.model})`,
    );
    if (!row)
      throw HfosError.notFound(
        'That business isn’t there anymore. It may have been deleted. Refresh the list and pick another.',
      );
    const was = PHONE_MODELS.find((m) => m === row.was) ?? null;
    if (row.changed)
      await ctx.emit({
        type: 'phone_model.changed',
        entityType: 'workspace',
        entityId: input.workspaceId,
        payload: { workspaceId: input.workspaceId, was, model: input.model },
        before: { phoneModel: was },
        after: { phoneModel: input.model },
      });
    return { workspaceId: input.workspaceId, was, model: input.model, changed: row.changed };
  },
});

export const phoneModelCommands = [phoneModelSet];
