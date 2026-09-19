/**
 * What customers said in public (M16).
 *
 * Google has stars and Facebook has a thumb, and the shapes here keep them apart on purpose: a made-up four
 * stars beside a real four stars is worse than an honest "recommended".
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

export const reviewProvider = z.enum(['google', 'facebook']);
export type ReviewProviderName = z.infer<typeof reviewProvider>;

export const ReviewConnectInput = z.object({
  workspaceId: uuid,
  provider: reviewProvider,
});
export const ReviewConnectOutput = z.object({ connectionId: uuid, state: z.string() });

/** The worker, once somebody has signed in and chosen which place. */
export const ReviewActivateInput = z.object({
  workspaceId: uuid,
  connectionId: uuid,
  externalAccountId: z.string().min(1).max(200),
  displayName: z.string().max(200).nullable().default(null),
  publicUrl: z.string().max(500).nullable().default(null),
  scopes: z.array(z.string().max(120)).max(50).default([]),
});
export const ReviewConnectionOutput = z.object({ connectionId: uuid });

export const ReviewFailInput = z.object({
  workspaceId: uuid,
  connectionId: uuid,
  reason: z.string().max(2000),
  /** True when only a person can fix it, which is every sign-in that stopped working. */
  needsPerson: z.boolean().default(true),
});

export const ReviewDisconnectInput = z.object({ workspaceId: uuid, connectionId: uuid });
export const ReviewSyncNowInput = z.object({ workspaceId: uuid, connectionId: uuid });

export const ReviewReplyInput = z.object({
  workspaceId: uuid,
  reviewId: uuid,
  body: z.string().trim().min(1, 'Write a reply.').max(4000),
});
export const ReviewReplyOutput = z.object({ reviewId: uuid });

export const ReviewListInput = z.object({
  workspaceId: uuid,
  /** Only the ones nobody has answered, which is the list a business actually works through. */
  unansweredOnly: z.boolean().default(false),
  provider: reviewProvider.optional(),
  limit: z.int().min(1).max(100).default(50),
  /** Older than this, for the next page. */
  before: isoDateTime.optional(),
});

export const ReviewRow = z.object({
  id: uuid,
  provider: reviewProvider,
  authorName: z.string().nullable(),
  authorPhotoUrl: z.string().nullable(),
  /** Google's stars, or null where there are none to have. */
  rating: z.number().int().min(1).max(5).nullable(),
  /** Facebook's thumb, or null where the stars say it. */
  sentiment: z.enum(['positive', 'negative']).nullable(),
  body: z.string().nullable(),
  postedAt: isoDateTime,
  url: z.string().nullable(),
  personId: uuid.nullable(),
  replyBody: z.string().nullable(),
  replyPostedAt: isoDateTime.nullable(),
  /** False where the provider will not let an app answer; the screen offers a link out instead. */
  canReply: z.boolean(),
});

export const ReviewConnectionRow = z.object({
  id: uuid,
  provider: reviewProvider,
  status: z.enum(['pending', 'connected', 'needs_attention', 'disconnected']),
  displayName: z.string().nullable(),
  publicUrl: z.string().nullable(),
  lastSyncedAt: isoDateTime.nullable(),
  lastError: z.string().nullable(),
});

export const ReviewListOutput = z.object({
  reviews: z.array(ReviewRow),
  connections: z.array(ReviewConnectionRow),
  /** What the whole of it looks like: the average where there are stars, and how many are unanswered. */
  summary: z.object({
    total: z.number().int(),
    averageRating: z.number().nullable(),
    recommended: z.number().int(),
    notRecommended: z.number().int(),
    unanswered: z.number().int(),
  }),
});
