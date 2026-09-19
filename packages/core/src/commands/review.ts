/**
 * Connecting the places a business's public reviews actually live, and answering them.
 *
 * The reviews a CRM shows are never the CRM's: they belong to Google and to Facebook. So none of this
 * copies reviews from anywhere — it connects to the source, and a business that leaves HandsFreeOS one day
 * takes nothing away from Google either. No token ever reaches a browser: the sign-in happens on the
 * worker, and everything here only ever names a place and a state.
 */
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { reviewConnections, reviews } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { scheduleJob } from '../messaging/store';
import {
  ReviewActivateInput,
  ReviewConnectInput,
  ReviewConnectOutput,
  ReviewConnectionOutput,
  ReviewDisconnectInput,
  ReviewFailInput,
  ReviewReplyInput,
  ReviewReplyOutput,
  ReviewSyncNowInput,
} from '../schemas/review';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
/** A sign-in link lasts ten minutes, the same as every other one here. */
const STATE_TTL_MS = 10 * 60_000;
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export const reviewConnectionConnect = defineCommand({
  name: 'review_connection.connect',
  description:
    'Start connecting a Google Business Profile or a Facebook Page, so the reviews people leave show here and can be answered from here. Returns a one-time state; the browser signs in through the worker.',
  risk: 2,
  input: ReviewConnectInput,
  output: ReviewConnectOutput,
  permission: 'reviews.manage',
  scope: inWorkspace,
  emits: ['review_connection.connect_started'],
  // The state is a one-time secret: never kept in a stored answer.
  shownOnce: ['state'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const state = randomBytes(32).toString('base64url');
    const [row] = await ctx.tx
      .insert(reviewConnections)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        provider: input.provider,
        status: 'pending',
        oauthStateHash: sha256Hex(state),
        oauthStateExpiresAt: new Date(Date.now() + STATE_TTL_MS),
        createdBy: me.userId,
      })
      .returning({ id: reviewConnections.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'review_connection.connect_started',
      entityType: 'review_connection',
      entityId: row.id,
      payload: { provider: input.provider },
      broadcast: false,
    });
    return { connectionId: row.id, state };
  },
});

export const reviewConnectionActivate = defineCommand({
  name: 'review_connection.activate',
  description:
    'Worker: somebody signed in and chose which place. Any earlier connection to the same place steps down, so reviews never arrive twice.',
  risk: 1,
  input: ReviewActivateInput,
  output: ReviewConnectionOutput,
  permission: 'reviews.manage',
  scope: inWorkspace,
  emits: ['review_connection.connected'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [c] = await ctx.tx
      .select()
      .from(reviewConnections)
      .where(
        and(
          eq(reviewConnections.id, input.connectionId),
          eq(reviewConnections.workspaceId, workspaceId),
        ),
      );
    if (!c) throw HfosError.notFound('That connection is not here.');
    if (c.status !== 'pending')
      throw HfosError.rule(
        'review_connection_not_pending',
        409,
        'This place is not waiting to connect.',
      );
    const now = new Date();
    // The same place connected twice would read every review twice. The older one steps down first.
    await ctx.tx
      .update(reviewConnections)
      .set({
        status: 'disconnected',
        disconnectedAt: now,
        disconnectedReason: 'replaced',
        tokenEnc: null,
        pkceVerifierEnc: null,
        nextSyncAt: null,
      })
      .where(
        and(
          eq(reviewConnections.workspaceId, workspaceId),
          eq(reviewConnections.provider, c.provider),
          eq(reviewConnections.externalAccountId, input.externalAccountId),
          sql`${reviewConnections.status} <> 'disconnected'`,
          sql`${reviewConnections.id} <> ${c.id}`,
        ),
      );
    await ctx.tx
      .update(reviewConnections)
      .set({
        status: 'connected',
        externalAccountId: input.externalAccountId,
        displayName: input.displayName,
        publicUrl: input.publicUrl,
        scopes: input.scopes,
        oauthStateHash: null,
        oauthStateExpiresAt: null,
        pkceVerifierEnc: null,
        failures: 0,
        lastError: null,
        connectedAt: now,
        // Read straight away, so the list is not empty the moment somebody connects it.
        nextSyncAt: now,
      })
      .where(eq(reviewConnections.id, c.id));
    await scheduleJob(ctx.tx, {
      kind: 'reviews.sync',
      dedupeKey: `reviews:${c.id}`,
      runAt: now,
      payload: { connectionId: c.id },
      workspaceId,
      organizationId: ctx.scope.organizationId,
    });
    // Never the token: the event names the place and the provider only.
    await ctx.emit({
      type: 'review_connection.connected',
      entityType: 'review_connection',
      entityId: c.id,
      payload: { provider: c.provider, displayName: input.displayName },
    });
    return { connectionId: c.id };
  },
});

export const reviewConnectionFail = defineCommand({
  name: 'review_connection.fail',
  description:
    'Worker: reading reviews from this place stopped working. A sign-in that has expired asks to be connected again rather than retrying forever.',
  risk: 1,
  input: ReviewFailInput,
  output: ReviewConnectionOutput,
  permission: 'reviews.manage',
  scope: inWorkspace,
  emits: ['review_connection.needs_attention'],
  actors: ['system'],
  async handler(ctx, input) {
    await ctx.tx
      .update(reviewConnections)
      .set({
        status: input.needsPerson ? 'needs_attention' : 'connected',
        lastError: input.reason.slice(0, 2000),
        ...(input.needsPerson ? { nextSyncAt: null } : {}),
      })
      .where(
        and(
          eq(reviewConnections.id, input.connectionId),
          eq(reviewConnections.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (input.needsPerson)
      await ctx.emit({
        type: 'review_connection.needs_attention',
        entityType: 'review_connection',
        entityId: input.connectionId,
        payload: { reason: input.reason.slice(0, 200) },
      });
    return { connectionId: input.connectionId };
  },
});

export const reviewConnectionDisconnect = defineCommand({
  name: 'review_connection.disconnect',
  description:
    'Stop reading reviews from this place. HandsFreeOS forgets the sign-in; the reviews already here stay, and so does every one of them on Google or Facebook.',
  risk: 2,
  input: ReviewDisconnectInput,
  output: ReviewConnectionOutput,
  permission: 'reviews.manage',
  scope: inWorkspace,
  emits: ['review_connection.disconnected'],
  async handler(ctx, input) {
    const [c] = await ctx.tx
      .update(reviewConnections)
      .set({
        status: 'disconnected',
        disconnectedAt: new Date(),
        disconnectedReason: 'person',
        tokenEnc: null,
        tokenKeyId: null,
        pkceVerifierEnc: null,
        oauthStateHash: null,
        oauthStateExpiresAt: null,
        nextSyncAt: null,
      })
      .where(
        and(
          eq(reviewConnections.id, input.connectionId),
          eq(reviewConnections.workspaceId, ctx.scope.workspaceId!),
          sql`${reviewConnections.status} <> 'disconnected'`,
        ),
      )
      .returning({ id: reviewConnections.id });
    if (!c) throw HfosError.notFound('That connection is not here.');
    await ctx.emit({
      type: 'review_connection.disconnected',
      entityType: 'review_connection',
      entityId: c.id,
      payload: {},
    });
    return { connectionId: c.id };
  },
});

export const reviewConnectionSyncNow = defineCommand({
  name: 'review_connection.sync_now',
  description: 'Ask this place for new reviews now, instead of waiting for the next hourly read.',
  risk: 1,
  input: ReviewSyncNowInput,
  output: ReviewConnectionOutput,
  permission: 'reviews.manage',
  scope: inWorkspace,
  emits: ['review_connection.sync_requested'],
  async handler(ctx, input) {
    const [c] = await ctx.tx
      .select({ id: reviewConnections.id, status: reviewConnections.status })
      .from(reviewConnections)
      .where(
        and(
          eq(reviewConnections.id, input.connectionId),
          eq(reviewConnections.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (!c) throw HfosError.notFound('That connection is not here.');
    if (c.status === 'disconnected')
      throw HfosError.rule('review_connection_gone', 409, 'That place is not connected.');
    // The worker brings the read forward when it sees this: the queue is the worker's, not a browser's.
    await ctx.emit({
      type: 'review_connection.sync_requested',
      entityType: 'review_connection',
      entityId: c.id,
      payload: {},
      broadcast: false,
    });
    return { connectionId: c.id };
  },
});

export const reviewReply = defineCommand({
  name: 'review.reply',
  description:
    'Answer a review where people will read it. The words are kept here first and posted after, so a provider having a bad morning delays the answer rather than losing it.',
  risk: 2,
  input: ReviewReplyInput,
  output: ReviewReplyOutput,
  permission: 'reviews.manage',
  scope: inWorkspace,
  emits: ['review.replied'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [row] = await ctx.tx
      .update(reviews)
      .set({ replyBody: input.body, replyPostedAt: new Date(), replyBy: requireHuman(ctx).userId })
      .where(and(eq(reviews.id, input.reviewId), eq(reviews.workspaceId, workspaceId)))
      .returning({ id: reviews.id, provider: reviews.provider });
    if (!row) throw HfosError.notFound('That review is not here.');
    // Kept here first and posted after: the worker takes it from this event.
    await ctx.emit({
      type: 'review.replied',
      entityType: 'review',
      entityId: row.id,
      payload: { provider: row.provider },
    });
    return { reviewId: row.id };
  },
});

export const reviewCommands = [
  reviewConnectionConnect,
  reviewConnectionActivate,
  reviewConnectionFail,
  reviewConnectionDisconnect,
  reviewConnectionSyncNow,
  reviewReply,
] as const;
