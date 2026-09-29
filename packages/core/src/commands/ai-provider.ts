/**
 * Which AI answers: Claude, or OpenAI while Claude is in trouble. On auto the worker decides, from Claude's status
 * page and from its own calls failing; support keeps it on either one from /admin when the checks get it wrong, and
 * puts it back on auto.
 *
 * Platform-scoped, like everything staff do — and the SQL behind it (`private.set_ai_provider_mode`) checks
 * `platform.ai.manage` for itself rather than trusting this caller. A business can't change it.
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import {
  AiProviderModeValue,
  AiProviderSetModeInput,
  AiProviderSetModeOutput,
} from '../schemas/support';

const onPlatform = () => ({ kind: 'platform' as const });

export const aiProviderSetMode = defineCommand({
  name: 'ai_provider.set_mode',
  description:
    'Support: let the checks choose which AI answers every business (auto), or keep it on Claude or on OpenAI whatever they say.',
  risk: 3,
  input: AiProviderSetModeInput,
  output: AiProviderSetModeOutput,
  permission: 'platform.ai.manage',
  scope: onPlatform,
  emits: ['ai_provider.mode_changed'],
  async handler(ctx, input) {
    const [row] = await rows<{ was: string | null; changed: boolean }>(
      ctx.tx,
      sql`select * from private.set_ai_provider_mode(${input.mode})`,
    );
    // The one row is made by the migration and nothing deletes it, so no `was` means it's gone.
    const was = AiProviderModeValue.options.find((m) => m === row?.was);
    if (!row || !was) throw HfosError.internal();
    if (row.changed)
      await ctx.emit({
        type: 'ai_provider.mode_changed',
        entityType: 'ai_provider',
        payload: { was, mode: input.mode },
        before: { mode: was },
        after: { mode: input.mode },
      });
    return { was, mode: input.mode, changed: row.changed };
  },
});

export const aiProviderCommands = [aiProviderSetMode];
