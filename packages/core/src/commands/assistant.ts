import { and, eq, sql as dsql } from 'drizzle-orm';
import { assistantThreads } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  AssistantThreadArchiveInput,
  AssistantThreadOutput,
  AssistantThreadRenameInput,
} from '../schemas/assistant';

// Chats are private to their person, so these emit no events: events feed the workspace-wide audit
// log and live updates. RLS and the column grants let a person change only the title and archived_at
// of their own threads; anyone else's thread matches no row and is not found.

const ownThread = (ctx: CommandContext, threadId: string) =>
  and(eq(assistantThreads.id, threadId), eq(assistantThreads.workspaceId, ctx.scope.workspaceId!));

const chatGone = () =>
  HfosError.notFound('That chat isn’t in your chat history anymore. Refresh and try again.');

export const assistantThreadRename = defineCommand({
  name: 'assistant_thread.rename',
  description: 'Rename one of your chats with the Assistant.',
  risk: 1,
  input: AssistantThreadRenameInput,
  output: AssistantThreadOutput,
  permission: 'assistant.use',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: [],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(assistantThreads)
      .set({ title: input.title })
      .where(ownThread(ctx, input.threadId))
      .returning({ id: assistantThreads.id });
    if (!row) throw chatGone();
    return { threadId: row.id };
  },
});

export const assistantThreadArchive = defineCommand({
  name: 'assistant_thread.archive',
  description: 'Archive one of your chats so it leaves your chat history.',
  risk: 1,
  input: AssistantThreadArchiveInput,
  output: AssistantThreadOutput,
  permission: 'assistant.use',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: [],
  async handler(ctx, input) {
    // Archiving twice keeps the first time.
    const [row] = await ctx.tx
      .update(assistantThreads)
      .set({ archivedAt: dsql`coalesce(${assistantThreads.archivedAt}, now())` })
      .where(ownThread(ctx, input.threadId))
      .returning({ id: assistantThreads.id });
    if (!row) throw chatGone();
    return { threadId: row.id };
  },
});
