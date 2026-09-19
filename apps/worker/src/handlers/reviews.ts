/**
 * The worker's half of reviews: a person asks, and the queue does it.
 *
 * A browser cannot put work on the queue — scheduled jobs belong to the worker — so "read them again now"
 * and "post this reply" arrive as events, and these turn them into jobs.
 */
import { scheduleJob } from '@hfos/core/server';
import type { EventHandler } from './types';
import { tenantOf } from '../services';

/** Bring this place's next read forward, without losing the one already queued. */
export const onReviewSyncWanted: EventHandler = async (ctx) => {
  if (!ctx.event.entityId) return;
  const scope = tenantOf(ctx.scope);
  await scheduleJob(
    ctx.tx,
    {
      kind: 'reviews.sync',
      dedupeKey: `reviews:${ctx.event.entityId}`,
      runAt: new Date(),
      payload: { connectionId: ctx.event.entityId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
};

/** Somebody answered a review. The words are already kept; this is what puts them where people read them. */
export const onReviewReplied: EventHandler = async (ctx) => {
  if (!ctx.event.entityId) return;
  const scope = tenantOf(ctx.scope);
  await scheduleJob(ctx.tx, {
    kind: 'review.reply_post',
    dedupeKey: `review-reply:${ctx.event.entityId}`,
    runAt: new Date(),
    payload: { reviewId: ctx.event.entityId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
};
