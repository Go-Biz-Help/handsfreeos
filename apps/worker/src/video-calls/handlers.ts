/**
 * What the team does in a HandsFreeOS video call, carried out by LiveKit (docs/video-calls.md): someone taken out
 * leaves the room, a mute mutes their microphone, and End for everyone closes the room. And when a stretch of the
 * call is over, everyone's minutes go on the business's balance, and what the AI heard becomes the appointment's
 * transcript. Each runs from its event, so a retry is safe: taking out someone already gone, muting someone already
 * muted or closing a closed room changes nothing, and the charge and the transcript are once per stretch.
 */
import { executeCommand, videoCallKeepWords, videoCallRoom } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import type { EventHandler, HandlerContext } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { chargeVideoCall } from '../money/usage-capture';
import { errorMessage } from '../outbox';
import { payloadOf, str } from '../push/moment';
import { systemActor, tenantOf, workerMeta } from '../services';
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

/** AI notes turned off for one call: the room stops saying the AI is on (the listener leaves on its own). */
export const onVideoCallAiChanged: EventHandler = async (ctx) => {
  if (payloadOf(ctx)['on'] === false)
    await tell(ctx, 'say the AI is off', (video, room) => video.markAi(room, false));
};

export const VIDEO_CALL_KEEP_WORDS_JOB = 'video_call.keep_words';
/** What the AI heard becomes the transcript this long after the stretch ends, once its last lines are in. */
const KEEP_WORDS_AFTER_MS = 20_000;

/** A stretch of the call is over: everyone's minutes in it, on the balance, and what the AI heard, kept. */
export const onVideoCallEnded: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const seconds = Number(p['seconds']);
  const callId = ctx.event.entityId;
  if (!callId) return;
  // A stretch closed without LiveKit's word has no room id; the event's own is as unique.
  const stretch = str(p['roomSid']) ?? ctx.event.id;
  const scope = tenantOf(ctx.scope);
  const until = str(p['endedAt']) ?? new Date(ctx.event.createdAt).toISOString();
  await ctx.tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${scope.organizationId}, ${scope.workspaceId}, ${VIDEO_CALL_KEEP_WORDS_JOB},
          ${`${VIDEO_CALL_KEEP_WORDS_JOB}:${stretch}`},
          now() + ${KEEP_WORDS_AFTER_MS}::int * interval '1 millisecond',
          ${JSON.stringify({ callId, until, stretch })}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
  );
  if (!(seconds > 0)) return;
  const appointmentId = str(p['appointmentId']);
  const [appt] = appointmentId
    ? await rows<{ title: string }>(
        ctx.tx,
        sql`select title from app.appointments where id = ${appointmentId}`,
      )
    : [];
  await chargeVideoCall(ctx.wallet, scope, {
    roomSid: stretch,
    personSeconds: seconds,
    people: Number(p['people']) || 0,
    title: appt?.title ?? 'HandsFreeOS video call',
    callId,
    occurredAt: new Date(ctx.event.createdAt),
  });
};

/** What the AI heard in a stretch of a call, made the appointment's transcript (core's `video_call.keep_words`). */
export const videoCallKeepWordsJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = ctx.job.payload;
  const callId = str(p['callId']);
  const until = str(p['until']);
  const stretch = str(p['stretch']);
  if (!callId || !until || !stretch) return;
  const { output } = await executeCommand(
    ctx.db,
    videoCallKeepWords,
    { workspaceId: scope.workspaceId, callId, until, stretch },
    systemActor(scope),
    workerMeta(),
  );
  if (output.lines)
    ctx.log.info(
      { callId, lines: output.lines, transcriptId: output.transcriptId },
      'a video call’s words kept',
    );
};
