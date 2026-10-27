/**
 * The push when someone is waiting in a HandsFreeOS video call (docs/video-calls.md): a customer on their own link
 * waiting for the team ("Ana is waiting in the video call"), or anyone else asking to be let in. It goes to the
 * call's host and everyone working the appointment, under Your appointments (`booking`), and a later one about the
 * same call replaces the one showing.
 */
import { videoCallWaitingPushWords } from '@hfos/core/server';
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
  const [call] = await rows<{ host_user_id: string | null }>(
    ctx.tx,
    sql`select host_user_id from app.video_calls where id = ${callId} and workspace_id = ${ws}`,
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
  const words = videoCallWaitingPushWords({
    name: str(p['name']) ?? 'Someone',
    kind: ctx.event.eventType === 'video_call.waiting' ? 'customer' : 'guest',
    title: str(p['title']) ?? 'Video call',
  });
  await queuePush(ctx.tx, scope, {
    key: `video_call:${ctx.event.id}`,
    category: 'booking',
    userIds: people.length ? people : await managerIds(ctx.tx, ws),
    title: words.title,
    body: words.body,
    path: appointmentId ? `/app/w/${ws}/calendar?appt=${appointmentId}` : `/app/w/${ws}/calendar`,
    refs: appointmentId ? { appointmentId } : {},
    collapseId: `video-call-${callId}`,
  });
});
