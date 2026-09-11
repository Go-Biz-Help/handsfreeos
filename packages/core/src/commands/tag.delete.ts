import { and, count, eq } from 'drizzle-orm';
import { recordTags, tags } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { TagDeleteInput, TagDeleteOutput } from '../schemas/tag';

export const tagDelete = defineCommand({
  name: 'tag.delete',
  description: 'Delete a tag and remove it from every record.',
  risk: 2,
  input: TagDeleteInput,
  output: TagDeleteOutput,
  permission: 'tags.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['tag.deleted'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(tags)
      .where(and(eq(tags.id, input.tagId), eq(tags.workspaceId, ctx.scope.workspaceId!)));
    if (!current) throw HfosError.notFound('Tag not found.');
    const [usage] = await ctx.tx
      .select({ n: count() })
      .from(recordTags)
      .where(eq(recordTags.tagId, current.id));
    await ctx.tx.delete(tags).where(eq(tags.id, current.id));
    await ctx.emit({
      type: 'tag.deleted',
      entityType: 'tag',
      entityId: current.id,
      payload: { name: current.name, removedFrom: Number(usage?.n ?? 0) },
      before: { name: current.name, color: current.color },
      after: null,
    });
    return { tagId: current.id, removedFrom: Number(usage?.n ?? 0) };
  },
});
