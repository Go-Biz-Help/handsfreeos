/**
 * The push when someone is waiting in a HandsFreeOS video call (docs/video-calls.md): a customer on their own link
 * waiting for the team ("Ana is waiting in the video call"), or anyone else asking to be let in. It goes to the
 * call's host and everyone working the appointment, under Your appointments (`booking`), and a later one about the
 * same call replaces the one showing. Tapping it opens the call: the phone's call screen, or the call's page on the
 * web. A webinar, where hundreds may wait for the team, gets one push for the crowd every ten minutes at most.
 */
import {
  videoCallAppPath,
  videoCallWaitingPushWords,
  WEBINAR_WAITING_PUSH_MS,
  webinarWaitingPushWords,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { managerIds, payloadOf, pushMoment, str } from '../push/moment';
import { queuePush } from '../push/queue';

/** video_call.waiting and video_call.knocked. */
export const onVideoCallWaitingPush = pushMoment('booking', async (ctx, scope) => {
  const callId = ctx.event.entityId;
  if (!callId) return;
  const ws = scope.workspaceId;
  const p = payloadOf(ctx);
  const appointmentId = str(p['appointmentId']);
  const [call] = await rows<{ host_user_id: string | null; format: string }>(
    ctx.tx,
    sql`select host_user_id, format from app.video_calls where id = ${callId} and workspace_id = ${ws}`,
  );
  if (!call) return;
  const staff = appointmentId
    ? await rows<{ user_id: string }>(
        ctx.tx,
        sql`select user_id from app.appointment_staff
            where appointment_id = ${appointmentId} and active
            order by created_at, user_id`,
      )
    : [];
  const people = [call.host_user_id, ...staff.map((s) => s.user_id)].filter(
    (id): id is string => !!id,
  );
  const title = str(p['title']) ?? 'Video call';
  const webinar = call.format === 'webinar' && ctx.event.eventType === 'video_call.waiting';
  const [{ n } = { n: 1 }] = webinar
    ? await rows<{ n: number }>(
        ctx.tx,
        sql`select count(*)::int as n from app.video_call_people
            where video_call_id = ${callId} and kind = 'customer' and state = 'waiting'`,
      )
    : [];
  const words = webinar
    ? webinarWaitingPushWords({ waiting: n, title })
    : videoCallWaitingPushWords({
        name: str(p['name']) ?? 'Someone',
        kind: ctx.event.eventType === 'video_call.waiting' ? 'customer' : 'guest',
        title,
      });
  const at = new Date(ctx.event.occurredAt ?? Date.now()).getTime();
  await queuePush(ctx.tx, scope, {
    key: webinar
      ? `video_call:${callId}:waiting:${Math.floor(at / WEBINAR_WAITING_PUSH_MS)}`
      : `video_call:${ctx.event.id}`,
    category: 'booking',
    userIds: people.length ? people : await managerIds(ctx.tx, ws),
    title: words.title,
    body: words.body,
    path: videoCallAppPath(ws, callId),
    refs: appointmentId ? { appointmentId } : {},
    collapseId: `video-call-${callId}`,
  });
});
