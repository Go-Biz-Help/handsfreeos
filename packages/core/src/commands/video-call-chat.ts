/**
 * A HandsFreeOS video call's chat, kept (docs/video-calls.md, "The chat, kept"; the owner's pick of 3 November 2026,
 * "Kept on every call").
 *
 * - **Every message is kept, whatever the call's AI notes** (`video_call.chat`, the worker's). The screen that sent
 *   it reports it with the ticket it joined on, which the worker reads, so a message is only ever its sender's own.
 *   Someone taken out or turned away keeps nothing more, and one person keeps `VIDEO_CALL_CHAT_MAX_PER_PERSON` at
 *   most in a call.
 * - **The team reads it with the call** (`video_call.chat` the query): on the appointment, or on the call's own line
 *   on the timeline, its links pressable.
 * - **The AI's notes take it in** when a stretch of the call is over, while the notes are on (`video_call.keep_words`
 *   in ./video-call.ts): each message once, by the stretch it was sent in. What was typed before the notes went off,
 *   or while they were off, never reaches the AI (`video_call.set_ai` marks it `VIDEO_CALL_CHAT_NOT_FOR_AI`).
 */
import { and, asc, count, eq } from 'drizzle-orm';
import { videoCallMessages, videoCallPeople, videoCalls } from '@hfos/db/schema';
import { z } from 'zod';
import { HfosError } from '../errors';
import { defineCommand, defineQuery } from '../kernel/define';
import {
  sideOfKind,
  VIDEO_CALL_CHAT_MAX_PER_PERSON,
  type VideoCallKind,
} from '../meetings/video-calls';
import { isoDateTime, uuid } from '../schemas/common';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** A message's words, at most. The chat sends 1,000; the worker cuts anything longer to this before asking. */
export const VIDEO_CALL_MESSAGE_MAX_CHARS = 4_000;
/** Messages a read gives back, at most, oldest first: a webinar's chat can run long. */
const SHOWN = 1_000;

/** Who may still add to the chat: someone in the call, let in and joining, or just gone (a report on its way). */
const MAY_CHAT = new Set(['admitted', 'in', 'left']);

/**
 * Someone in a call sent a chat message, as the screen that sent it says, with the ticket it joined on (the worker
 * read who and which call off it). Kept with the call, whatever its AI notes. The same message again keeps one copy.
 */
export const videoCallChat = defineCommand({
  name: 'video_call.chat',
  description:
    'Worker: someone in a HandsFreeOS video call sent a chat message. Kept with the call, whatever its AI notes.',
  risk: 0,
  input: z.object({
    workspaceId: uuid,
    callId: uuid,
    /** Their identity in the room, from the ticket: a row of the call's people. */
    personId: uuid,
    /** LiveKit's id for the message, from their screen. */
    key: z.string().trim().min(1).max(100),
    text: z.string().trim().min(1).max(VIDEO_CALL_MESSAGE_MAX_CHARS),
  }),
  output: z.object({ kept: z.boolean() }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [call] = await ctx.tx
      .select({ id: videoCalls.id })
      .from(videoCalls)
      .where(and(eq(videoCalls.id, input.callId), eq(videoCalls.workspaceId, ws)));
    if (!call)
      throw HfosError.notFound(
        'That video call isn’t there anymore. Its chat went with its appointment.',
      );
    const [p] = await ctx.tx
      .select()
      .from(videoCallPeople)
      .where(and(eq(videoCallPeople.id, input.personId), eq(videoCallPeople.videoCallId, call.id)));
    if (!p || !MAY_CHAT.has(p.state)) return { kept: false };
    const [had] = await ctx.tx
      .select({ n: count() })
      .from(videoCallMessages)
      .where(
        and(eq(videoCallMessages.videoCallId, call.id), eq(videoCallMessages.personRowId, p.id)),
      );
    if ((had?.n ?? 0) >= VIDEO_CALL_CHAT_MAX_PER_PERSON) return { kept: false };
    const kept = await ctx.tx
      .insert(videoCallMessages)
      .values({
        workspaceId: ws,
        videoCallId: call.id,
        personRowId: p.id,
        side: sideOfKind(p.kind as VideoCallKind),
        name: p.name,
        body: input.text,
        sentAt: new Date(),
        messageKey: input.key,
      })
      .onConflictDoNothing({
        target: [
          videoCallMessages.videoCallId,
          videoCallMessages.personRowId,
          videoCallMessages.messageKey,
        ],
      })
      .returning({ id: videoCallMessages.id });
    return { kept: kept.length > 0 };
  },
});

const MessageOut = z.object({
  id: uuid,
  name: z.string(),
  /** The team's side or the customer's. */
  side: z.enum(['team', 'customer']),
  body: z.string(),
  sentAt: isoDateTime,
});
export type VideoCallMessageOut = z.infer<typeof MessageOut>;

/** A call's chat, oldest first, for the appointment and the call's line on the timeline. */
export const videoCallChatGet = defineQuery({
  name: 'video_call.chat',
  description:
    'What people typed in a HandsFreeOS video call’s chat, oldest first: who sent each message, and when.',
  input: z
    .object({ workspaceId: uuid, callId: uuid.optional(), appointmentId: uuid.optional() })
    .refine((i) => !!i.callId !== !!i.appointmentId, {
      error: 'Name the call or its appointment, not both.',
    }),
  output: z.object({
    callId: uuid.nullable(),
    messages: z.array(MessageOut),
    /** Messages past the ones given back. */
    more: z.int(),
  }),
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [call] = await ctx.tx
      .select({ id: videoCalls.id })
      .from(videoCalls)
      .where(
        and(
          eq(videoCalls.workspaceId, ws),
          input.callId
            ? eq(videoCalls.id, input.callId)
            : eq(videoCalls.appointmentId, input.appointmentId!),
        ),
      );
    if (!call) {
      if (input.callId)
        throw HfosError.notFound(
          'That video call isn’t there anymore, or isn’t one you can see. Open it again from the appointment or the customer’s page.',
        );
      return { callId: null, messages: [], more: 0 };
    }
    const list = await ctx.tx
      .select()
      .from(videoCallMessages)
      .where(eq(videoCallMessages.videoCallId, call.id))
      .orderBy(asc(videoCallMessages.sentAt), asc(videoCallMessages.createdAt))
      .limit(SHOWN + 1);
    const [all] =
      list.length > SHOWN
        ? await ctx.tx
            .select({ n: count() })
            .from(videoCallMessages)
            .where(eq(videoCallMessages.videoCallId, call.id))
        : [{ n: list.length }];
    return {
      callId: call.id,
      messages: list.slice(0, SHOWN).map((m) => ({
        id: m.id,
        name: m.name,
        side: m.side === 'team' ? ('team' as const) : ('customer' as const),
        body: m.body,
        sentAt: m.sentAt.toISOString(),
      })),
      more: Math.max(0, (all?.n ?? 0) - SHOWN),
    };
  },
});

export const videoCallChatCommands = [videoCallChat] as const;
export const videoCallChatQueries = [videoCallChatGet] as const;
