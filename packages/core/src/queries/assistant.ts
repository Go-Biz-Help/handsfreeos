import { and, asc, desc, eq, isNull, sql as dsql } from 'drizzle-orm';
import { assistantMessages, assistantThreads, assistantToolCalls } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import {
  AssistantCard,
  AssistantThreadGetInput,
  AssistantThreadGetOutput,
  AssistantThreadListInput,
  AssistantThreadListOutput,
  AssistantToolCallOut,
} from '../schemas/assistant';

const threadSummary = {
  id: assistantThreads.id,
  title: assistantThreads.title,
  lastMessageAt: assistantThreads.lastMessageAt,
};
const summaryOut = (t: { id: string; title: string; lastMessageAt: Date }) => ({
  id: t.id,
  title: t.title,
  lastMessageAt: t.lastMessageAt.toISOString(),
});

// Chats are private: RLS shows a person only their own threads, messages and tool calls, so anyone
// else's chat does not exist for them.

export const assistantThreadList = defineQuery({
  name: 'assistant_thread.list',
  description: 'Your chats with the Assistant in this workspace, most recent first.',
  input: AssistantThreadListInput,
  output: AssistantThreadListOutput,
  permission: 'assistant.use',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const list = await ctx.tx
      .select(threadSummary)
      .from(assistantThreads)
      .where(
        and(
          eq(assistantThreads.workspaceId, input.workspaceId),
          eq(assistantThreads.userId, requireHuman(ctx).userId),
          isNull(assistantThreads.archivedAt),
        ),
      )
      .orderBy(desc(assistantThreads.lastMessageAt), desc(assistantThreads.id))
      .limit(input.limit);
    return { items: list.map(summaryOut) };
  },
});

export const assistantThreadGet = defineQuery({
  name: 'assistant_thread.get',
  description:
    'One of your chats: its messages oldest first with their cards, and where each tool call stands.',
  input: AssistantThreadGetInput,
  output: AssistantThreadGetOutput,
  permission: 'assistant.use',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [thread] = await ctx.tx
      .select(threadSummary)
      .from(assistantThreads)
      .where(
        and(
          eq(assistantThreads.id, input.threadId),
          eq(assistantThreads.workspaceId, input.workspaceId),
        ),
      );
    if (!thread)
      throw HfosError.notFound(
        'That chat with the Assistant isn’t there anymore. It may have been deleted. Start a new one.',
      );
    const messages = await ctx.tx
      .select({
        id: assistantMessages.id,
        role: assistantMessages.role,
        text: assistantMessages.text,
        cards: assistantMessages.cards,
        createdAt: assistantMessages.createdAt,
      })
      .from(assistantMessages)
      .where(eq(assistantMessages.threadId, thread.id))
      .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id));
    const calls = await ctx.tx
      .select({
        id: assistantToolCalls.id,
        tool: assistantToolCalls.tool,
        status: assistantToolCalls.status,
        outcome: dsql<string | null>`${assistantToolCalls.result}->>'outcome'`,
        href: dsql<string | null>`${assistantToolCalls.result}->>'href'`,
        error: assistantToolCalls.error,
        undone: dsql<boolean>`coalesce((${assistantToolCalls.result}->>'undone')::boolean, false)`,
      })
      .from(assistantToolCalls)
      .where(eq(assistantToolCalls.threadId, thread.id))
      .orderBy(asc(assistantToolCalls.createdAt), asc(assistantToolCalls.id));
    return {
      thread: summaryOut(thread),
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        // A card that no longer fits the schema is dropped rather than failing the whole chat.
        cards: m.cards.flatMap((c) => {
          const parsed = AssistantCard.safeParse(c);
          return parsed.success ? [parsed.data] : [];
        }),
        createdAt: m.createdAt.toISOString(),
      })),
      toolCalls: calls.map((c) => ({
        ...c,
        href: AssistantToolCallOut.shape.href.safeParse(c.href).success ? c.href : null,
      })),
    };
  },
});
