/**
 * Who hears a business's callers (the phone listener): support picks Nova-3 or Flux in /admin to hear how each does
 * on that business's calls and in its test console, without a restart, and puts it back just as fast. Null is the
 * worker's VOICE_LISTENER. The twin of the phone model (phone-model.ts).
 *
 * Platform-scoped, like everything staff do — and the SQL behind it (`private.set_phone_listener`) checks
 * `platform.ai.manage` for itself rather than trusting this caller. A business can't change it.
 */
import { rows, sql } from '@hfos/db/client';
import { PHONE_LISTENERS } from '../ai-team/config';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { PhoneListenerSetInput, PhoneListenerSetOutput } from '../schemas/support';

const onPlatform = () => ({ kind: 'platform' as const });

export const phoneListenerSet = defineCommand({
  name: 'phone_listener.set',
  description:
    'Support: pick who hears the caller on one business’s calls (Nova-3 or Flux), or put it back on the default.',
  risk: 3,
  input: PhoneListenerSetInput,
  output: PhoneListenerSetOutput,
  permission: 'platform.ai.manage',
  scope: onPlatform,
  emits: ['phone_listener.changed'],
  async handler(ctx, input) {
    const [row] = await rows<{ was: string | null; changed: boolean }>(
      ctx.tx,
      sql`select * from private.set_phone_listener(${input.workspaceId}::uuid, ${input.listener})`,
    );
    if (!row)
      throw HfosError.notFound(
        'That business isn’t there anymore. It may have been deleted. Refresh the list and pick another.',
      );
    const was = PHONE_LISTENERS.find((l) => l === row.was) ?? null;
    if (row.changed)
      await ctx.emit({
        type: 'phone_listener.changed',
        entityType: 'workspace',
        entityId: input.workspaceId,
        payload: { workspaceId: input.workspaceId, was, listener: input.listener },
        before: { phoneListener: was },
        after: { phoneListener: input.listener },
      });
    return { workspaceId: input.workspaceId, was, listener: input.listener, changed: row.changed };
  },
});

export const phoneListenerCommands = [phoneListenerSet];
