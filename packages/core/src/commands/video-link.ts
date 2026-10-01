import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { sql } from '@hfos/db/client';
import { conversations, messages, people, videoLinks } from '@hfos/db/schema';
import { logChannelActivity } from '../crm/activities';
import { formatPhone } from '../crm/phone';
import { fullName } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { loadConversation, scheduleJob, workspaceMessaging } from '../messaging/store';
import {
  VIDEO_LINK_DAYS,
  VIDEO_LINK_MAX_BYTES,
  VIDEO_LINK_MAX_STARTS,
  VIDEO_LINK_MAX_UPLOADS,
  VIDEO_LINK_TYPES,
  VIDEO_LINK_WORDS,
  videoLinkDay,
  videoLinkPath,
  videoSize,
} from '../messaging/video-link';
import {
  VideoLinkCreateInput,
  VideoLinkCreateOutput,
  VideoLinkReceiveUploadInput,
  VideoLinkReceiveUploadOutput,
  VideoLinkStartUploadInput,
  VideoLinkStartUploadOutput,
} from '../schemas/video-link';
import { customerOptedOut } from './message';

/**
 * Asking a customer for a video (20261018000300): a person makes a link and texts it from the reply box, the
 * customer's page starts an upload and the video goes up, and it lands in the conversation as their reply.
 *
 * The link is a key: the token goes to the person once, to send, and only its hash is kept. The page's two writes
 * run as the system actor in the link's business, which the worker learns from private.video_link_lookup().
 */

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export const videoLinkTokenHash = (token: string): Buffer =>
  createHash('sha256').update(token).digest();

/** Where a video goes up: the folder of the message it will arrive as, which storage already reads by its rules. */
export const videoUploadPath = (workspaceId: string, uploadId: string, contentType: string) =>
  `${workspaceId}/messages/${uploadId}/video.${VIDEO_LINK_TYPES[contentType] ?? 'mp4'}`;

/** The business's name and time zone, for the customer's page and its refusals. */
async function businessOf(ctx: CommandContext): Promise<{ name: string; timezone: string }> {
  const { name, timezone } = await workspaceMessaging(ctx.tx, ctx.scope.workspaceId!);
  return { name, timezone };
}

/** The link, locked for the change about to be made to it. */
async function lockedLink(ctx: CommandContext, videoLinkId: string) {
  const [link] = await ctx.tx
    .select()
    .from(videoLinks)
    .where(and(eq(videoLinks.id, videoLinkId), eq(videoLinks.workspaceId, ctx.scope.workspaceId!)))
    .for('update');
  if (!link) throw HfosError.rule('link_not_found', 404, VIDEO_LINK_WORDS.notFound);
  return link;
}

export const videoLinkCreate = defineCommand({
  name: 'video_link.create',
  description:
    'Makes a link to text a customer so they can send a video at full quality, which lands in this conversation. The link is shown once, to send; it lasts a week and takes three videos.',
  risk: 1,
  input: VideoLinkCreateInput,
  output: VideoLinkCreateOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['video_link.created'],
  shownOnce: ['token', 'path'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const conv = await loadConversation(ctx, input.conversationId);
    if (conv.channel !== 'sms')
      throw HfosError.rule(
        'channel_mismatch',
        400,
        VIDEO_LINK_WORDS.notByText(conv.channel === 'chat' ? 'a website chat' : 'an email thread'),
      );
    if (await customerOptedOut(ctx, conv)) {
      const [p] = conv.personId
        ? await ctx.tx
            .select({ firstName: people.firstName, lastName: people.lastName })
            .from(people)
            .where(eq(people.id, conv.personId))
        : [];
      const who = (p && fullName(p.firstName, p.lastName)) || formatPhone(conv.counterpart);
      throw HfosError.rule('opted_out', 409, VIDEO_LINK_WORDS.optedOut(who));
    }
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + VIDEO_LINK_DAYS * 24 * 60 * 60 * 1000);
    const [link] = await ctx.tx
      .insert(videoLinks)
      .values({
        workspaceId,
        conversationId: conv.id,
        tokenHash: videoLinkTokenHash(token),
        createdBy: ctx.actor.type === 'human' ? ctx.actor.userId : null,
        expiresAt,
        maxUploads: VIDEO_LINK_MAX_UPLOADS,
      })
      .returning({ id: videoLinks.id });
    await ctx.emit({
      type: 'video_link.created',
      entityType: 'conversation',
      entityId: conv.id,
      payload: { videoLinkId: link!.id, expiresAt: expiresAt.toISOString() },
      after: { videoLink: 'made', expires: expiresAt.toISOString() },
    });
    return {
      videoLinkId: link!.id,
      token,
      path: videoLinkPath(token),
      expiresAt: expiresAt.toISOString(),
      maxUploads: VIDEO_LINK_MAX_UPLOADS,
    };
  },
});

export const videoLinkStartUpload = defineCommand({
  name: 'video_link.start_upload',
  description:
    'Worker: the customer’s video page is about to send a video. Checks the link still takes one and that it is a video of a size it takes, and names where it goes up.',
  risk: 1,
  input: VideoLinkStartUploadInput,
  output: VideoLinkStartUploadOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const link = await lockedLink(ctx, input.videoLinkId);
    const { name: business, timezone } = await businessOf(ctx);
    if (link.expiresAt.getTime() <= Date.now())
      throw HfosError.rule(
        'link_expired',
        410,
        VIDEO_LINK_WORDS.expired(business, videoLinkDay(link.expiresAt, timezone)),
      );
    if (link.uploadsReceived >= link.maxUploads)
      throw HfosError.rule('link_full', 409, VIDEO_LINK_WORDS.full(business, link.maxUploads));
    if (link.uploadsStarted >= VIDEO_LINK_MAX_STARTS)
      throw HfosError.rule('too_many_starts', 429, VIDEO_LINK_WORDS.tooManyTries(business));
    if (!VIDEO_LINK_TYPES[input.contentType])
      throw HfosError.rule('not_a_video', 415, VIDEO_LINK_WORDS.notAVideo(input.name));
    if (input.sizeBytes > VIDEO_LINK_MAX_BYTES)
      throw HfosError.rule(
        'video_too_large',
        413,
        VIDEO_LINK_WORDS.tooLarge(videoSize(input.sizeBytes)),
      );
    await ctx.tx
      .update(videoLinks)
      .set({ uploadsStarted: link.uploadsStarted + 1 })
      .where(eq(videoLinks.id, link.id));
    const uploadId = randomUUID();
    return {
      uploadId,
      bucket: 'telephony',
      objectPath: videoUploadPath(ctx.scope.workspaceId!, uploadId, input.contentType),
    };
  },
});

export const videoLinkReceiveUpload = defineCommand({
  name: 'video_link.receive_upload',
  description:
    'Worker: a video the customer sent through a video link arrived. Files it in the conversation as their reply, as a text with the video on it, and starts the reply reminder.',
  risk: 1,
  input: VideoLinkReceiveUploadInput,
  output: VideoLinkReceiveUploadOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.received'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const dedupeKey = `video-link:${input.uploadId}`;
    const link = await lockedLink(ctx, input.videoLinkId);
    const [dup] = await ctx.tx
      .select({ id: messages.id, conversationId: messages.conversationId })
      .from(messages)
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.dedupeKey, dedupeKey)));
    if (dup) return { messageId: dup.id, conversationId: dup.conversationId, duplicate: true };
    // Only the folder this upload was given: the page can't name another message's video as its own.
    if (!input.objectPath.startsWith(`${workspaceId}/messages/${input.uploadId}/`))
      throw HfosError.rule('wrong_place', 400, VIDEO_LINK_WORDS.notArrived);
    const { name: business } = await businessOf(ctx);
    if (link.uploadsReceived >= link.maxUploads)
      throw HfosError.rule('link_full', 409, VIDEO_LINK_WORDS.full(business, link.maxUploads));
    if (!VIDEO_LINK_TYPES[input.contentType])
      throw HfosError.rule('not_a_video', 415, VIDEO_LINK_WORDS.notAVideo(input.name));
    if (input.sizeBytes > VIDEO_LINK_MAX_BYTES)
      throw HfosError.rule(
        'video_too_large',
        413,
        VIDEO_LINK_WORDS.tooLarge(videoSize(input.sizeBytes)),
      );

    const conv = await loadConversation(ctx, link.conversationId);
    const at = new Date();
    const preview = VIDEO_LINK_WORDS.preview;
    const messageId = input.uploadId;
    const eventId = await ctx.emit({
      type: 'message.received',
      entityType: 'message',
      entityId: messageId,
      payload: {
        conversationId: conv.id,
        personId: conv.personId,
        channel: 'sms',
        mediaCount: 1,
        keyword: null,
        reopened: conv.status !== 'open',
        via: 'video_link',
      },
      after: { from: formatPhone(conv.counterpart), preview, via: 'Video link' },
    });
    const activityId = await logChannelActivity(ctx, {
      kind: 'sms',
      subtype: 'inbound',
      personId: conv.personId,
      body: preview,
      occurredAt: at,
      eventId,
      meta: {
        direction: 'inbound',
        messageId,
        conversationId: conv.id,
        mediaCount: 1,
        via: 'video_link',
      },
    });
    await ctx.tx.insert(messages).values({
      id: messageId,
      workspaceId,
      conversationId: conv.id,
      channel: 'sms',
      direction: 'inbound',
      status: 'received',
      fromAddress: conv.counterpart,
      toAddresses: [],
      bodyText: null,
      media: [
        {
          bucket: 'telephony',
          objectPath: input.objectPath,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          name: input.name,
          via: 'video_link',
        },
      ],
      provider: 'video_link',
      providerMessageId: input.uploadId,
      dedupeKey,
      segments: 0,
      occurredAt: at,
      activityId,
    });
    // A reply like any other: unread, open again, and waiting for the team to answer.
    await ctx.tx
      .update(conversations)
      .set({
        lastMessageAt: at,
        lastInboundAt: at,
        lastPreview: preview,
        lastDirection: 'inbound',
        unreadCount: sql`${conversations.unreadCount} + 1`,
        status: 'open',
        snoozedUntil: null,
        closedAt: null,
        closedBy: null,
        awaitingReplySince: sql`coalesce(${conversations.awaitingReplySince}, ${at.toISOString()}::timestamptz)`,
      })
      .where(eq(conversations.id, conv.id));
    await ctx.tx
      .update(videoLinks)
      .set({ uploadsReceived: link.uploadsReceived + 1, lastUploadAt: at })
      .where(eq(videoLinks.id, link.id));
    const m = await workspaceMessaging(ctx.tx, workspaceId);
    const reminderMs = m.settings.unansweredReminderMinutes * 60_000;
    if (reminderMs > 0)
      await scheduleJob(ctx.tx, {
        kind: 'conversation.unanswered_check',
        dedupeKey: `unanswered:${conv.id}`,
        runAt: new Date(at.getTime() + reminderMs),
        payload: { conversationId: conv.id },
        workspaceId,
        organizationId: m.organizationId,
      });
    return { messageId, conversationId: conv.id, duplicate: false };
  },
});
