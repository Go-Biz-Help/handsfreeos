/**
 * What the team does in a HandsFreeOS video call, carried out by LiveKit (docs/video-calls.md): someone taken out
 * leaves the room, a mute mutes their microphone, and End for everyone closes the room. And when a stretch of the
 * call is over, everyone's minutes go on the business's balance, the coach's notes on it are finished, and what the AI
 * heard becomes the appointment's transcript. Each runs from its event, so a retry is safe: taking out someone already gone, muting someone already
 * muted or closing a closed room changes nothing, and the charge and the transcript are once per stretch.
 *
 * In a webinar, the team's camera choice and bringing someone on stage change what attendees in the room may send:
 * LiveKit stops a camera or microphone they may no longer use, and every page reads the new attributes.
 */
import {
  ATTENDEE_VIDEO_CHOICES,
  mayPublish,
  videoCallAttributes,
  type AttendeeVideo,
  type VideoCallKind,
} from '@hfos/core';
import { executeCommand, videoCallKeepWords, videoCallRoom } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import type { EventHandler, HandlerContext } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { chargeVideoCall } from '../money/usage-capture';
import { errorMessage } from '../outbox';
import { payloadOf, str } from '../push/moment';
import { systemActor, tenantOf, workerMeta } from '../services';
import { finishCoaching } from './coach';
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

/** LiveKit asked about this many people at once when a webinar's camera choice changes for everyone in it. */
const PERMIT_AT_ONCE = 10;

/** What each attendee in the room may now send, from the call as it stands (a retry reads it again). */
async function permitAttendees(ctx: HandlerContext, only?: string): Promise<void> {
  const callId = ctx.event.entityId;
  if (!ctx.videoCalls || !callId) return;
  const [call] = await rows<{ format: string; attendee_video: string }>(
    ctx.tx,
    sql`select format, attendee_video from app.video_calls where id = ${callId}`,
  );
  if (call?.format !== 'webinar') return;
  const attendeeVideo: AttendeeVideo = (ATTENDEE_VIDEO_CHOICES as readonly string[]).includes(
    call.attendee_video,
  )
    ? (call.attendee_video as AttendeeVideo)
    : 'off';
  // Only who's in the room now: anyone who comes in later gets a ticket that already says so.
  const people = await rows<{ id: string; kind: VideoCallKind; on_stage: boolean }>(
    ctx.tx,
    sql`select id, kind, on_stage from app.video_call_people
        where video_call_id = ${callId} and kind <> 'team'
          and last_joined_at is not null and (left_at is null or left_at < last_joined_at)
          and (${only ?? null}::uuid is null or id = ${only ?? null}::uuid)`,
  );
  const room = videoCallRoom(callId);
  const video = ctx.videoCalls;
  for (let i = 0; i < people.length; i += PERMIT_AT_ONCE) {
    const said = await Promise.allSettled(
      people.slice(i, i + PERMIT_AT_ONCE).map((p) =>
        video.permit(room, p.id, {
          publish: mayPublish({
            format: 'webinar',
            kind: p.kind,
            onStage: p.on_stage,
            attendeeVideo,
          }),
          attributes: videoCallAttributes({
            format: 'webinar',
            attendeeVideo,
            onStage: p.on_stage,
          }),
        }),
      ),
    );
    for (const r of said) {
      if (r.status === 'fulfilled') continue;
      const e: unknown = r.reason;
      if (e instanceof VideoCallError && !e.permanent && ctx.attempt < ctx.maxAttempts) throw e;
      ctx.log.warn(
        { callId, err: errorMessage(e) },
        'LiveKit couldn’t change what someone may send',
      );
    }
  }
}

/** A webinar's camera choice changed: every attendee in the room may (or may no longer) use their camera. */
export const onVideoCallAttendeeVideoChanged: EventHandler = async (ctx) => {
  await permitAttendees(ctx);
};

/** Brought on stage, or sent back to the audience: their microphone and camera follow. */
export const onVideoCallStageChanged: EventHandler = async (ctx) => {
  const person = str(payloadOf(ctx)['personRowId']);
  if (person) await permitAttendees(ctx, person);
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

/**
 * What the AI heard in a stretch of a call, made the appointment's transcript (core's `video_call.keep_words`). The
 * coaching still live in the stretch is finished first, from the same lines (coach.ts).
 */
export const videoCallKeepWordsJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = ctx.job.payload;
  const callId = str(p['callId']);
  const until = str(p['until']);
  const stretch = str(p['stretch']);
  if (!callId || !until || !stretch) return;
  await finishCoaching(ctx, scope, { callId, stretch, until });
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
