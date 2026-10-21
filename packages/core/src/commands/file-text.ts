import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { files, fileTexts } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { FileSaveTextInput, FileSaveTextOutput } from '../schemas/file';

/**
 * Words inside files (Search 5): the worker reads a file's words, with no AI and no cost, and keeps them here for
 * search (apps/worker/src/files/file-text.ts). Modelled on `knowledge_document.save_text`. One row a file, written
 * again when a better reader reads it. No event or audit row ever holds the words, so they never outlive the file:
 * they go when it's deleted for good (`private.forget_file_text`), and with it when the Deleted bin is emptied.
 */
export const fileSaveText = defineCommand({
  name: 'file.save_text',
  description:
    'Worker: keep the words read inside a file, for search. Never port papers or knowledge files; the words are never in the event.',
  risk: 1,
  input: FileSaveTextInput,
  output: FileSaveTextOutput,
  permission: null,
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  actors: ['system'],
  emits: ['file.text_saved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    // Read as the worker in this business: a file in the bin doesn't read, nor does another business's. Held until
    // this commits (`for share`), so a file deleted for good meanwhile either waits and then forgets these words
    // (`private.forget_file_text`), or went first and isn't found here: never words kept for a file that's gone.
    const [f] = await ctx.tx
      .select({ id: files.id, name: files.name })
      .from(files)
      .where(
        and(
          eq(files.id, input.fileId),
          eq(files.workspaceId, ws),
          eq(files.status, 'ready'),
          isNull(files.deletedAt),
          notInArray(files.recordType, ['knowledge', 'port']),
        ),
      )
      .for('share');
    if (!f) throw HfosError.notFound('File not found.');
    const chars = [...input.text].length;
    // Where each page starts, inside the words and in order.
    const pages = [...new Set(input.pages.filter((p) => p <= chars))].sort((a, b) => a - b);
    const values = { state: input.state, text: input.text, pages, chars, reader: input.reader };
    await ctx.tx
      .insert(fileTexts)
      .values({ fileId: f.id, workspaceId: ws, ...values })
      .onConflictDoUpdate({
        target: fileTexts.fileId,
        set: { ...values, extractedAt: sql`now()` },
      });
    await ctx.emit({
      type: 'file.text_saved',
      entityType: 'file',
      entityId: f.id,
      payload: { fileId: f.id, state: input.state, chars, reader: input.reader },
      // Its name for the Activity log, never its words.
      after: { name: f.name, state: input.state, chars, reader: input.reader },
    });
    return { fileId: f.id, state: input.state, chars };
  },
});
