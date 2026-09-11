import { and, eq } from 'drizzle-orm';
import { tags } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { TagUpdateInput, TagUpdateOutput } from '../schemas/tag';

export const tagUpdate = defineCommand({
  name: 'tag.update',
  description: 'Rename or recolor a tag everywhere it is used.',
  risk: 1,
  input: TagUpdateInput,
  output: TagUpdateOutput,
  permission: 'tags.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['tag.updated'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(tags)
      .where(and(eq(tags.id, input.tagId), eq(tags.workspaceId, ctx.scope.workspaceId!)));
    if (!current) throw HfosError.notFound('Tag not found.');
    const patch: { name?: string; color?: string } = {};
    if (input.name !== undefined && input.name !== current.name) patch.name = input.name;
    if (input.color !== undefined && input.color !== current.color) patch.color = input.color;
    const updated = Object.keys(patch);
    if (updated.length === 0) return { tagId: current.id, updated: [] };
    await ctx.tx.update(tags).set(patch).where(eq(tags.id, current.id));
    await ctx.emit({
      type: 'tag.updated',
      entityType: 'tag',
      entityId: current.id,
      payload: { name: patch.name ?? current.name, fields: updated },
      before: { name: current.name, color: current.color },
      after: { name: patch.name ?? current.name, color: patch.color ?? current.color },
    });
    return { tagId: current.id, updated };
  },
});
