/**
 * LiveKit's word on a HandsFreeOS video call, acted on (routes.ts stored it, checked against our key). Someone came
 * in, someone left, or the room closed: core's commands keep who was in and for how long, and close the stretch of
 * the call so its minutes go on the balance. Someone who came in on a ticket they shouldn't use any more (taken
 * out, turned away, or back in a call that ended before the team is) is taken straight out again.
 */
import {
  callIdOfRoom,
  executeCommand,
  HfosError,
  videoCallFinished,
  videoCallJoined,
  videoCallLeft,
} from '@hfos/core/server';
import type { DeliveryProcessor } from '../deliveries';
import { systemActor, workerMeta } from '../services';

/** What routes.ts kept: the report, field by field. */
type Kept = Readonly<Record<string, string | undefined>>;

export const LIVEKIT_KIND = 'video';

/** `livekit:video`: one report about one call's room. */
export const onLiveKitReport: DeliveryProcessor = async (ctx) => {
  const { workspaceId, organizationId } = ctx.delivery;
  if (!workspaceId || !organizationId) return 'ignored';
  const scope = { workspaceId, organizationId };
  const r = (ctx.delivery.params ?? {}) as Kept;
  const callId = callIdOfRoom(r['room']);
  if (!callId || !r['room']) return 'ignored';
  const actor = systemActor(scope);
  const meta = workerMeta(null, ctx.delivery.id);
  const presence = {
    workspaceId,
    callId,
    personId: r['identity'],
    roomSid: r['roomSid'] || null,
    participantSid: r['participantSid'] || null,
    at: r['at'],
  };
  try {
    switch (r['event']) {
      case 'joined': {
        const { output } = await executeCommand(ctx.db, videoCallJoined, presence, actor, meta);
        if (output.kick && ctx.videoCalls) {
          ctx.log.info({ callId, personId: r['identity'] }, 'took someone out of a video call');
          await ctx.videoCalls.remove(r['room'], r['identity']!);
        }
        return;
      }
      case 'left':
        await executeCommand(ctx.db, videoCallLeft, presence, actor, meta);
        return;
      case 'finished':
        await executeCommand(
          ctx.db,
          videoCallFinished,
          { workspaceId, callId, roomSid: r['roomSid'] || null, at: r['at'] },
          actor,
          meta,
        );
        return;
      default:
        return 'ignored';
    }
  } catch (e) {
    // The call went with its appointment, deleted for good: there's nobody left to keep track of.
    if (e instanceof HfosError && e.status === 404) return 'ignored';
    throw e;
  }
};
