import { tags } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { TagCreateInput, TagCreateOutput } from '../schemas/tag';

export const tagCreate = defineCommand({
  name: 'tag.create',
  description: 'Add a tag to the workspace.',
  risk: 1,
  input: TagCreateInput,
  output: TagCreateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['tag.created'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .insert(tags)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        name: input.name,
        color: input.color,
        createdBy: userIdOf(ctx.actor),
      })
      .returning({ id: tags.id, name: tags.name });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'tag.created',
      entityType: 'tag',
      entityId: row.id,
      payload: { name: row.name },
      after: { name: row.name, color: input.color },
      broadcast: false,
    });
    return { tagId: row.id };
  },
});
