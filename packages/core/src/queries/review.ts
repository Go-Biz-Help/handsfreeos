/** What customers said in public, as the Reviews screen reads it. */
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { reviewConnections, reviews } from '@hfos/db/schema';
import { defineQuery } from '../kernel/define';
import { ReviewListInput, ReviewListOutput } from '../schemas/review';

/** Facebook answers a recommendation as a comment on a story, which its API will not let an app post. */
const CAN_REPLY: Record<'google' | 'facebook', boolean> = { google: true, facebook: false };

export const reviewList = defineQuery({
  name: 'review.list',
  description:
    'Reviews from the connected Google Business Profile and Facebook Page, newest first, with what the whole of it looks like and which ones nobody has answered.',
  input: ReviewListInput,
  output: ReviewListOutput,
  // The whole team reads what customers said about them; answering is the business's own decision.
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const where = [eq(reviews.workspaceId, input.workspaceId)];
    if (input.unansweredOnly) where.push(isNull(reviews.replyBody));
    if (input.provider) where.push(eq(reviews.provider, input.provider));
    if (input.before) where.push(lt(reviews.postedAt, new Date(input.before)));
    const list = await ctx.tx
      .select()
      .from(reviews)
      .where(and(...where))
      .orderBy(desc(reviews.postedAt))
      .limit(input.limit);

    /**
     * Named columns, not `*`: a browser is granted the ones a person may read and none of the sign-in, so
     * asking for everything would be asking for the token and being refused — which is the grant working.
     */
    const places = await ctx.tx
      .select({
        id: reviewConnections.id,
        provider: reviewConnections.provider,
        status: reviewConnections.status,
        displayName: reviewConnections.displayName,
        publicUrl: reviewConnections.publicUrl,
        lastSyncedAt: reviewConnections.lastSyncedAt,
        lastError: reviewConnections.lastError,
      })
      .from(reviewConnections)
      .where(
        and(
          eq(reviewConnections.workspaceId, input.workspaceId),
          inArray(reviewConnections.status, ['pending', 'connected', 'needs_attention']),
        ),
      )
      .orderBy(reviewConnections.provider);

    /**
     * Counted across everything, not just this page, because "4.8 from 132" is the sentence a business
     * wants and a page of fifty cannot tell it.
     */
    const [totals] = await ctx.tx
      .select({
        total: sql<number>`count(*)::int`,
        // Only where there are stars to average: a thumb is not a number.
        average: sql<
          string | null
        >`round(avg(${reviews.rating}) filter (where ${reviews.rating} is not null), 2)`,
        recommended: sql<number>`count(*) filter (where ${reviews.sentiment} = 'positive')::int`,
        notRecommended: sql<number>`count(*) filter (where ${reviews.sentiment} = 'negative')::int`,
        unanswered: sql<number>`count(*) filter (where ${reviews.replyBody} is null)::int`,
      })
      .from(reviews)
      .where(eq(reviews.workspaceId, input.workspaceId));

    return {
      reviews: list.map((r) => ({
        id: r.id,
        provider: r.provider,
        authorName: r.authorName,
        authorPhotoUrl: r.authorPhotoUrl,
        rating: r.rating,
        sentiment: r.sentiment,
        body: r.body,
        postedAt: r.postedAt.toISOString(),
        url: r.url,
        personId: r.personId,
        replyBody: r.replyBody,
        replyPostedAt: r.replyPostedAt?.toISOString() ?? null,
        canReply: CAN_REPLY[r.provider],
      })),
      connections: places.map((c) => ({
        id: c.id,
        provider: c.provider,
        status: c.status,
        displayName: c.displayName,
        publicUrl: c.publicUrl,
        lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
        lastError: c.lastError,
      })),
      summary: {
        total: totals?.total ?? 0,
        averageRating:
          totals?.average === null || totals?.average === undefined ? null : Number(totals.average),
        recommended: totals?.recommended ?? 0,
        notRecommended: totals?.notRecommended ?? 0,
        unanswered: totals?.unanswered ?? 0,
      },
    };
  },
});

export const reviewQueries = [reviewList] as const;
