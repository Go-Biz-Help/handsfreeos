/**
 * What the team does in a HandsFreeOS video call, carried out by LiveKit (docs/video-calls.md): someone taken out
 * leaves the room, a mute mutes their microphone, and End for everyone closes the room. And when a stretch of the
 * call is over, everyone's minutes go on the business's balance. Each runs from its event, so a retry is safe:
 * taking out someone already gone, muting someone already muted or closing a closed room changes nothing, and the
 * charge is once per stretch.
 */
import { videoCallRoom } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import type { EventHandler, HandlerContext } from '../handlers/types';
import { chargeVideoCall } from '../money/usage-capture';
import { errorMessage } from '../outbox';
import { payloadOf, str } from '../push/moment';
import { tenantOf } from '../services';
import { VideoCallError, type VideoCallProvider } from './provider';

/** Asks LiveKit; tried again later when it didn't answer, and let go once it refused. */
async function tell(
  ctx: HandlerContext,
  what: string,
  ask: (video: VideoCallProvider, room: string) => Promise<unknown>,
): Promise<void> {
  const callId = ctx.event.entityId;
  if (!ctx.videoCalls || !callId) return;
  try {
    await ask(ctx.videoCalls, videoCallRoom(callId));
  } catch (e) {
    if (e instanceof VideoCallError && !e.permanent && ctx.attempt < ctx.maxAttempts) throw e;
    ctx.log.warn({ callId, err: errorMessage(e) }, `LiveKit couldn’t ${what}`);
  }
}

/** Taken out by the team: out of the room too. */
export const onVideoCallPersonRemoved: EventHandler = async (ctx) => {
  const person = str(payloadOf(ctx)['personRowId']);
  if (person)
    await tell(ctx, 'take someone out of a call', (video, room) => video.remove(room, person));
};

/** Muted by the team: their microphone goes off, and only they can turn it back on. */
export const onVideoCallMuteRequested: EventHandler = async (ctx) => {
  const person = str(payloadOf(ctx)['personRowId']);
  if (person) await tell(ctx, 'mute someone', (video, room) => video.mute(room, person));
};

/** End for everyone: the room closes, and LiveKit's word that it did closes the stretch (reports.ts). */
export const onVideoCallEndedByHost: EventHandler = async (ctx) => {
  await tell(ctx, 'close a call', (video, room) => video.close(room));
};

/** A stretch of the call is over: everyone's minutes in it, on the balance. */
export const onVideoCallEnded: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const seconds = Number(p['seconds']);
  const callId = ctx.event.entityId;
  if (!callId || !(seconds > 0)) return;
  const appointmentId = str(p['appointmentId']);
  const [appt] = appointmentId
    ? await rows<{ title: string }>(
        ctx.tx,
        sql`select title from app.appointments where id = ${appointmentId}`,
      )
    : [];
  await chargeVideoCall(ctx.wallet, tenantOf(ctx.scope), {
    // A stretch closed without LiveKit's word has no room id; the event's own is as unique.
    roomSid: str(p['roomSid']) ?? ctx.event.id,
    personSeconds: seconds,
    people: Number(p['people']) || 0,
    title: appt?.title ?? 'HandsFreeOS video call',
    callId,
    occurredAt: new Date(ctx.event.createdAt),
  });
};
