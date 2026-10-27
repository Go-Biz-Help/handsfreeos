/**
 * Whether a business has HandsFreeOS video calls (docs/video-calls.md): support turns them on in /admin, test
 * businesses first (the owner's 16a), and everyone once the call, the AI's notes and the coach are all in.
 *
 * Platform-scoped, like everything staff do. The SQL behind it (`private.set_video_calls`) checks
 * `platform.addons.manage` for itself rather than trusting this caller, and a business can't set it.
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { VideoCallsSetInput, VideoCallsSetOutput } from '../schemas/support';

const onPlatform = () => ({ kind: 'platform' as const });

export const videoCallsSet = defineCommand({
  name: 'video_calls.set',
  description:
    'Support: turn HandsFreeOS video calls on or off for one business, so its Online places can make them.',
  risk: 3,
  input: VideoCallsSetInput,
  output: VideoCallsSetOutput,
  permission: 'platform.addons.manage',
  scope: onPlatform,
  emits: ['video_calls.changed'],
  async handler(ctx, input) {
    const [row] = await rows<{ was: boolean; changed: boolean }>(
      ctx.tx,
      sql`select * from private.set_video_calls(${input.workspaceId}::uuid, ${input.on})`,
    );
    if (!row) throw HfosError.forbidden();
    if (row.changed)
      await ctx.emit({
        type: 'video_calls.changed',
        entityType: 'workspace',
        entityId: input.workspaceId,
        payload: { workspaceId: input.workspaceId, on: input.on },
        before: { videoCalls: row.was },
        after: { videoCalls: input.on },
      });
    return { workspaceId: input.workspaceId, was: row.was, on: input.on, changed: row.changed };
  },
});

export const videoCallsSwitchCommands = [videoCallsSet];
