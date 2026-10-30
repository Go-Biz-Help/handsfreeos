/**
 * A live poll's slides in a HandsFreeOS video call, carried to the room (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md,
 * part 4; core's `video_call.slide` and meetings/slides.ts).
 *
 * - **The slide changed** (`video_call.slide_changed`): everyone in the room is told on the slides topic, from the
 *   server, with a link to a picture of the slide and of the next one. Each page is drawn once and kept beside the PDF
 *   (documents/pages.ts), the next one with it, so turning on is quick.
 * - **A question goes with the slide that came up**: the team alone is offered it ("Ask now?"), as the AI offers one
 *   (part 3), unless the AI is off for the call, a question is up, or it was asked.
 * - **Someone comes in** (LiveKit's report, reports.ts): they alone are told the slide that's up.
 */
import {
  POLL_SUGGEST_MS,
  SLIDE_PICTURE_SECONDS,
  SLIDE_WORDS,
  VIDEO_CALL_POLLS_TOPIC,
  VIDEO_CALL_SLIDES_TOPIC,
  type SlideMessage,
} from '@hfos/core';
import { videoCallPollCueState, videoCallRoom, videoCallSlideNow } from '@hfos/core/server';
import { asWorker, type Tx } from '@hfos/db/client';
import { drawnPages, drawnPicturePath } from '../documents/pages';
import type { EventHandler } from '../handlers/types';
import { errorMessage } from '../outbox';
import { payloadOf } from '../push/moment';
import type { TenantScope, WorkerServices } from '../services';
import type { ObjectStore } from '../storage';
import { VideoCallError } from './provider';

/** What the room is told now: the slide showing with its pictures, or that the slides are down. */
export async function slideMessage(
  store: ObjectStore,
  tx: Tx,
  callId: string,
  of = 0,
): Promise<SlideMessage> {
  const now = await videoCallSlideNow(tx, callId);
  if (!now)
    return { t: 'slide', slide: null, of, picture: null, next: null, at: new Date().toISOString() };
  const source = { bucket: now.bucket, objectPath: now.objectPath };
  // This slide and the next, drawn now or kept from before.
  const drawn = await drawnPages(store, source, now.slide - 1, 2);
  const picture = async (page: number) =>
    drawn.pages.some((p) => p.page === page)
      ? store.signedUrl(source.bucket, drawnPicturePath(source, page), SLIDE_PICTURE_SECONDS)
      : null;
  return {
    t: 'slide',
    slide: now.slide,
    of: now.of,
    picture: await picture(now.slide - 1),
    next: now.slide < now.of ? await picture(now.slide) : null,
    at: now.at.toISOString(),
  };
}

/** The slide showing changed: everyone told, and the team offered a question that goes with it. */
export const onVideoCallSlideChanged: EventHandler = async (ctx) => {
  const callId = ctx.event.entityId;
  if (!callId || !ctx.videoCalls) return;
  const of = Number(payloadOf(ctx)['of'] ?? 0) || 0;
  const room = videoCallRoom(callId);
  let message: SlideMessage;
  try {
    message = await slideMessage(ctx.store, ctx.tx, callId, of);
  } catch (e) {
    // A PDF that won't draw: the team still has their screen share; nothing to show.
    ctx.log.warn({ callId, err: errorMessage(e) }, 'a live poll’s slide couldn’t be drawn');
    return;
  }
  try {
    await ctx.videoCalls.send(room, VIDEO_CALL_SLIDES_TOPIC, message);
    if (message.slide) await offerSlideQuestion(ctx, ctx.tx, callId, message.slide);
  } catch (e) {
    if (e instanceof VideoCallError && !e.permanent && ctx.attempt < ctx.maxAttempts) throw e;
    ctx.log.warn({ callId, err: errorMessage(e) }, 'LiveKit couldn’t show a live poll’s slide');
  }
};

/** A question not asked yet that goes with the slide that came up: offered to the team. */
async function offerSlideQuestion(
  services: WorkerServices,
  tx: Tx,
  callId: string,
  slide: number,
): Promise<void> {
  const cue = await videoCallPollCueState(tx, callId);
  if (!cue || cue.openNow || !cue.team.length) return;
  const question = cue.questions.find((q) => q.state === 'waiting' && q.slide === slide);
  if (!question) return;
  await services.videoCalls?.send(
    videoCallRoom(callId),
    VIDEO_CALL_POLLS_TOPIC,
    {
      t: 'suggest',
      questionId: question.id,
      title: question.title,
      why: SLIDE_WORDS.goesWith,
      until: new Date(Date.now() + POLL_SUGGEST_MS).toISOString(),
    },
    cue.team,
  );
}

/** Someone just came into a call: told the slide that's up, if one is. Trouble here never stops their joining. */
export async function tellSlideTo(
  services: WorkerServices,
  scope: TenantScope,
  callId: string,
  identity: string,
): Promise<void> {
  if (!services.videoCalls) return;
  try {
    const message = await asWorker(services.db, scope, (tx) =>
      slideMessage(services.store, tx, callId),
    );
    if (!message.slide) return;
    await services.videoCalls.send(videoCallRoom(callId), VIDEO_CALL_SLIDES_TOPIC, message, [
      identity,
    ]);
  } catch (e) {
    services.log.warn(
      { callId, err: errorMessage(e) },
      'couldn’t show someone coming in the slide that’s up',
    );
  }
}
