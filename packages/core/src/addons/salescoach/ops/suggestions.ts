/**
 * Replies Sales Coach suggests in a written conversation (round two, docs/salescoach.md). The worker keeps the
 * newest set for a conversation (`salescoach.suggestions.put`); the web reads it above the message box
 * (`salescoach.suggestions`) until anyone replies after the customer's message. Row security shows them only to
 * someone who sees the conversation, and only the worker writes them.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { rows, sql as dbSql } from '@hfos/db/client';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { salescoachAddon } from '../manifest';
import { SUGGEST_LABEL_CHARS, SUGGEST_MOST, Suggestion } from '../suggest';
import { suggestions } from '../tables';
import { inWorkspace } from './playbooks';

const uuid = z.uuid();

export const suggestionsPut = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.suggestions.put',
  description:
    'Worker: replies a person could send to the customer’s newest message in a conversation, replacing the ones before.',
  risk: 0,
  input: z.object({
    workspaceId: uuid,
    conversationId: uuid,
    messageId: uuid,
    replies: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(SUGGEST_LABEL_CHARS),
          text: z.string().trim().min(1).max(1200),
        }),
      )
      .min(1)
      .max(SUGGEST_MOST),
    objectionId: z
      .string()
      .regex(/^o[0-9]{1,3}$/)
      .nullable(),
  }),
  output: z.object({ kept: z.boolean() }),
  permission: 'salescoach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['salescoach.suggestions.ready'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    // Only for the customer's newest message, which must be this conversation's.
    const [newest] = await rows<{ id: string }>(
      ctx.tx,
      dbSql`select id from app.messages
            where conversation_id = ${input.conversationId} and workspace_id = ${ws} and direction = 'inbound'
            order by occurred_at desc, id desc limit 1`,
    );
    if (newest?.id !== input.messageId) return { kept: false };
    await ctx.tx
      .insert(suggestions)
      .values({
        workspaceId: ws,
        conversationId: input.conversationId,
        messageId: input.messageId,
        replies: input.replies,
        objectionId: input.objectionId,
      })
      .onConflictDoUpdate({
        target: suggestions.conversationId,
        set: {
          messageId: input.messageId,
          replies: input.replies,
          objectionId: input.objectionId,
          updatedAt: sql`now()`,
        },
      });
    // A conversation's event says no more than its kind on the live updates (20261012020500): the screens with the
    // conversation open read the suggestions again.
    await ctx.emit({
      type: 'salescoach.suggestions.ready',
      entityType: 'conversation',
      entityId: input.conversationId,
      payload: { messageId: input.messageId, replies: input.replies.length },
    });
    return { kept: true };
  },
});

export const suggestionsGet = defineAddonQuery(salescoachAddon, {
  name: 'salescoach.suggestions',
  description:
    'Replies the coach suggests for the customer’s newest message in a conversation, until someone replies after it.',
  input: z.object({ workspaceId: uuid, conversationId: uuid }),
  output: z.object({
    suggestions: z
      .object({
        messageId: uuid,
        replies: z.array(Suggestion),
        objectionId: z.string().nullable(),
      })
      .nullable(),
  }),
  permission: 'salescoach.use',
  ai: { tool: 'salescoach_suggestions' },
  scope: inWorkspace,
  async handler(ctx, input) {
    const [s] = await ctx.tx
      .select()
      .from(suggestions)
      .where(
        and(
          eq(suggestions.conversationId, input.conversationId),
          eq(suggestions.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (!s) return { suggestions: null };
    // Stale once anyone answered after the customer's message, or the customer wrote again.
    const [after] = await rows<{ n: number }>(
      ctx.tx,
      dbSql`select count(*)::int as n from app.messages m, app.messages them
            where them.id = ${s.messageId} and m.conversation_id = them.conversation_id and m.id <> them.id
              and (m.occurred_at, m.id) > (them.occurred_at, them.id)`,
    );
    if ((after?.n ?? 0) > 0) return { suggestions: null };
    return {
      suggestions: { messageId: s.messageId, replies: s.replies, objectionId: s.objectionId },
    };
  },
});

export const suggestionCommands = [suggestionsPut] as const;
export const suggestionQueries = [suggestionsGet] as const;
