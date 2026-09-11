import { and, eq } from 'drizzle-orm';
import { companies, leads, people } from '@hfos/db/schema';
import { setRecordTags, tagsOf } from '../crm/records';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { RecordSetTagsInput, RecordSetTagsOutput } from '../schemas/tag';

export const recordSetTags = defineCommand({
  name: 'record.set_tags',
  description: 'Replace the tags on a person, company or lead.',
  risk: 1,
  input: RecordSetTagsInput,
  output: RecordSetTagsOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['record.tags_changed'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const table =
      input.recordType === 'person' ? people : input.recordType === 'company' ? companies : leads;
    const [record] = await ctx.tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, input.recordId), eq(table.workspaceId, workspaceId)));
    if (!record) throw HfosError.notFound('Record not found.');
    const before = (await tagsOf(ctx.tx, workspaceId, input.recordType, input.recordId)).map(
      (t) => t.name,
    );
    const after = await setRecordTags(
      ctx.tx,
      workspaceId,
      input.recordType,
      input.recordId,
      input.tagIds,
      userIdOf(ctx.actor),
    );
    await ctx.emit({
      type: 'record.tags_changed',
      entityType: input.recordType,
      entityId: input.recordId,
      payload: { recordType: input.recordType, tagIds: input.tagIds },
      before: { tags: before },
      after: { tags: after.map((t) => t.name) },
      broadcast: false,
    });
    return { tags: after };
  },
});
