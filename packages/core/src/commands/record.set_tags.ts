import { and, eq, inArray } from 'drizzle-orm';
import { companies, leads, people, recordTags } from '@hfos/db/schema';
import { setRecordTags, tagsOf } from '../crm/records';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { RecordSetTagsInput, RecordSetTagsOutput } from '../schemas/tag';

export const recordSetTags = defineCommand({
  name: 'record.set_tags',
  description:
    'Set the tags on a person, company or lead, or add or remove some and leave the rest (mode).',
  risk: 1,
  input: RecordSetTagsInput,
  output: RecordSetTagsOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['record.tags_changed'],
  actors: ['human', 'system', 'workflow'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const { recordType, recordId, mode } = input;
    const table = recordType === 'person' ? people : recordType === 'company' ? companies : leads;
    const [record] = await ctx.tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, recordId), eq(table.workspaceId, workspaceId)));
    if (!record) throw HfosError.notFound('Record not found.');
    const before = await tagsOf(ctx.tx, workspaceId, recordType, recordId);
    const tagIds = [...new Set(input.tagIds)];
    const createdBy = userIdOf(ctx.actor);
    // Add and remove touch only these tags, so two changes at once (a workflow, a teammate) both land.
    if (mode === 'add' && tagIds.length > 0)
      await ctx.tx
        .insert(recordTags)
        .values(tagIds.map((tagId) => ({ workspaceId, tagId, recordType, recordId, createdBy })))
        .onConflictDoNothing();
    if (mode === 'remove' && tagIds.length > 0)
      await ctx.tx
        .delete(recordTags)
        .where(
          and(
            eq(recordTags.workspaceId, workspaceId),
            eq(recordTags.recordType, recordType),
            eq(recordTags.recordId, recordId),
            inArray(recordTags.tagId, tagIds),
          ),
        );
    const after =
      mode === 'replace'
        ? await setRecordTags(ctx.tx, workspaceId, recordType, recordId, tagIds, createdBy)
        : await tagsOf(ctx.tx, workspaceId, recordType, recordId);
    const had = new Set(before.map((t) => t.id));
    const has = new Set(after.map((t) => t.id));
    const added = after.filter((t) => !had.has(t.id)).map((t) => t.id);
    const removed = before.filter((t) => !has.has(t.id)).map((t) => t.id);
    // Replace always records the choice; adding a tag it has, or removing one it lacks, is a no-op.
    if (mode !== 'replace' && added.length === 0 && removed.length === 0) return { tags: after };
    await ctx.emit({
      type: 'record.tags_changed',
      entityType: recordType,
      entityId: recordId,
      payload: { recordType, tagIds: after.map((t) => t.id), mode, added, removed },
      before: { tags: before.map((t) => t.name) },
      after: { tags: after.map((t) => t.name) },
      broadcast: false,
    });
    return { tags: after };
  },
});
