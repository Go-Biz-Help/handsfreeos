/**
 * Live polls in a HandsFreeOS video call, carried to the room (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 2;
 * core's commands/video-call-poll.ts).
 *
 * - **A question goes up** (`video_call.poll_opened`): everyone in the room gets it on the polls topic, from the
 *   server, so a page trusts it where it would ignore the same topic from a person. A job closes it when its time is
 *   up.
 * - **It closes** (`video_call.poll_closed`): everyone is told, with the totals when the question shows them.
 * - **The call is over** (`video_call.ended`): the question that's up closes and each person's answers are sent as
 *   their form response, a few seconds later, once any answer still on its way is in.
 */
import {
  VIDEO_CALL_POLLS_TOPIC,
  pollOnScreen,
  pollTotals,
  totalsShown,
  type PollMessage,
} from '@hfos/core';
import {
  bookPathOf,
  executeCommand,
  pollCounts,
  scheduleJob,
  videoCallPollClose,
  videoCallPollQuestion,
  videoCallPollsFinish,
  videoCallRoom,
} from '@hfos/core/server';
import type { EventHandler, HandlerContext } from '../handlers/types';
import { publicOrigin } from '../hosting/origin';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { payloadOf, str } from '../push/moment';
import { systemActor, tenantOf, workerMeta } from '../services';
import { VideoCallError } from './provider';

export const VIDEO_CALL_POLL_CLOSE_JOB = 'video_call.poll_close';
export const VIDEO_CALL_POLLS_FINISH_JOB = 'video_call.polls_finish';
/** Each person's answers are sent this long after a stretch of the call ends, once late answers are in. */
const FINISH_AFTER_MS = 10_000;

/** Tells the room; tried again later when LiveKit didn't answer, and let go once it refused. */
async function tellRoom(ctx: HandlerContext, callId: string, message: PollMessage): Promise<void> {
  if (!ctx.videoCalls) return;
  try {
    await ctx.videoCalls.send(videoCallRoom(callId), VIDEO_CALL_POLLS_TOPIC, message);
  } catch (e) {
    if (e instanceof VideoCallError && !e.permanent && ctx.attempt < ctx.maxAttempts) throw e;
    ctx.log.warn({ callId, err: errorMessage(e) }, 'LiveKit couldn’t show a live poll question');
  }
}

/** A question is up: on everyone's screen, and closed by a job when its time is up. */
export const onVideoCallPollOpened: EventHandler = async (ctx) => {
  const callId = ctx.event.entityId;
  const pollId = str(payloadOf(ctx)['pollId']);
  if (!callId || !pollId) return;
  const scope = tenantOf(ctx.scope);
  const found = await videoCallPollQuestion(ctx.tx, pollId);
  // Closed again already (another question asked straight after): nothing to show.
  if (!found || found.poll.state !== 'open' || !found.poll.closesAt) return;
  const { poll, question } = found;
  const closesAt = found.poll.closesAt;
  const bookPath = await bookPathOf(ctx.tx, scope.workspaceId, question);
  const origin = bookPath
    ? await publicOrigin(ctx.tx, scope.workspaceId, ctx.bookingLinks.webUrl)
    : null;
  await scheduleJob(ctx.tx, {
    kind: VIDEO_CALL_POLL_CLOSE_JOB,
    dedupeKey: `${VIDEO_CALL_POLL_CLOSE_JOB}:${poll.id}:${closesAt.getTime()}`,
    runAt: closesAt,
    payload: { callId, pollId: poll.id },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
  await tellRoom(ctx, callId, {
    t: 'open',
    poll: pollOnScreen(question, {
      pollId: poll.id,
      closesAt: closesAt.toISOString(),
      buttonUrl: bookPath && origin ? `${origin}${bookPath}` : null,
    }),
  });
};

/** A question closed: off everyone's screen, with its totals when the question shows them. */
export const onVideoCallPollClosed: EventHandler = async (ctx) => {
  const callId = ctx.event.entityId;
  const pollId = str(payloadOf(ctx)['pollId']);
  if (!callId || !pollId) return;
  const found = await videoCallPollQuestion(ctx.tx, pollId);
  const shown = found && totalsShown(found.question);
  const totals = shown
    ? pollTotals(
        found.question,
        (await pollCounts(ctx.tx, callId, found.poll.formId)).get(found.question.id) ?? {
          answered: 0,
          byChoice: {},
          byNumber: {},
        },
      )
    : null;
  await tellRoom(ctx, callId, { t: 'close', pollId, totals });
};

/** A stretch of the call is over: the poll's answers are sent a few seconds later. */
export const onVideoCallEndedPolls: EventHandler = async (ctx) => {
  const callId = ctx.event.entityId;
  if (!callId) return;
  const scope = tenantOf(ctx.scope);
  await scheduleJob(ctx.tx, {
    kind: VIDEO_CALL_POLLS_FINISH_JOB,
    dedupeKey: `${VIDEO_CALL_POLLS_FINISH_JOB}:${callId}`,
    runAt: new Date(Date.now() + FINISH_AFTER_MS),
    payload: { callId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
};

/** A question's time is up (core leaves one asked again since alone). */
export const videoCallPollCloseJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const callId = str(ctx.job.payload['callId']);
  const pollId = str(ctx.job.payload['pollId']);
  if (!callId || !pollId) return;
  await executeCommand(
    ctx.db,
    videoCallPollClose,
    { workspaceId: scope.workspaceId, callId, pollId },
    systemActor(scope),
    workerMeta(),
  );
};

/** Each person's answers in a call that's over, sent as their form response. */
export const videoCallPollsFinishJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const callId = str(ctx.job.payload['callId']);
  if (!callId) return;
  const { output } = await executeCommand(
    ctx.db,
    videoCallPollsFinish,
    { workspaceId: scope.workspaceId, callId },
    systemActor(scope),
    workerMeta(),
  );
  if (output.sent) ctx.log.info({ callId, sent: output.sent }, 'a call’s live poll answers sent');
};
