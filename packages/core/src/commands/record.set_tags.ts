import { and, eq, inArray } from 'drizzle-orm';
import { companies, leads, people, recordTagRemovals, recordTags, tags } from '@hfos/db/schema';
import { assertAiReach } from '../ai-team/reach';
import { setRecordTags, tagsOf } from '../crm/records';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changedSince, logLaterChange, whoChangedIt } from '../kernel/later-change';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import type { RecordType } from '../schemas/crm';
import {
  RecordSetTagsInput,
  RecordSetTagsOutput,
  RecordTagInput,
  RecordTagOutput,
} from '../schemas/tag';

type TagsMode = 'replace' | 'add' | 'remove';

/**
 * The tags someone put on or took off after this change was made (on a phone, perhaps long before it had signal): adding
 * one taken off since, or removing one put on since, leaves theirs, and the record's timeline says so. A tag that's
 * on says when it went on (`record_tags.created_at`); one that's off, when it came off (`record_tag_removals`, 0063).
 */
async function tagsChangedSince(
  ctx: CommandContext,
  input: {
    recordType: RecordType;
    recordId: string;
    tagIds: readonly string[];
    mode: 'add' | 'remove';
  },
): Promise<string[]> {
  if (!ctx.meta.occurredAt || input.tagIds.length === 0) return [];
  const workspaceId = ctx.scope.workspaceId!;
  const { recordType, recordId, mode } = input;
  const ofRecord = (t: typeof recordTags | typeof recordTagRemovals) =>
    and(
      eq(t.workspaceId, workspaceId),
      eq(t.recordType, recordType),
      eq(t.recordId, recordId),
      inArray(t.tagId, [...input.tagIds]),
    );
  const on = new Map(
    (
      await ctx.tx
        .select({ tagId: recordTags.tagId, at: recordTags.createdAt })
        .from(recordTags)
        .where(ofRecord(recordTags))
    ).map((r) => [r.tagId, r.at]),
  );
  const off = new Map(
    (
      await ctx.tx
        .select({ tagId: recordTagRemovals.tagId, at: recordTagRemovals.removedAt })
        .from(recordTagRemovals)
        .where(ofRecord(recordTagRemovals))
    ).map((r) => [r.tagId, r.at]),
  );
  const later = input.tagIds.filter((tagId) =>
    mode === 'add'
      ? !on.has(tagId) && changedSince(ctx.meta, off.get(tagId))
      : on.has(tagId) && changedSince(ctx.meta, on.get(tagId)),
  );
  if (!later.length) return [];
  const names = new Map(
    (
      await ctx.tx
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(inArray(tags.id, later))
    ).map((t) => [t.id, t.name]),
  );
  const record = { type: recordType, id: recordId };
  for (const tagId of later) {
    const at = mode === 'add' ? off.get(tagId) : on.get(tagId);
    const who = await whoChangedIt(ctx.tx, record, ['record.tags_changed'], at, {
      [mode === 'add' ? 'removed' : 'added']: [tagId],
    });
    const did = mode === 'add' ? 'removed it' : 'added it';
    await logLaterChange(
      ctx,
      {
        key: 'tagId',
        tried: `${mode} the tag “${names.get(tagId) ?? 'a tag'}”`,
        because: `${who ? `${who} ${did}` : `it was ${mode === 'add' ? 'removed' : 'added'}`} after that`,
        changedAt: at,
      },
      record,
      recordType === 'person'
        ? { personId: recordId }
        : recordType === 'company'
          ? { companyId: recordId }
          : { leadId: recordId },
    );
  }
  return later;
}

/**
 * Changes a record's tags and records it (`record.tags_changed`, whichever command asked): `replace` leaves exactly
 * these tags; `add` and `remove` touch only these, so two changes at once (a workflow, a teammate, a phone that was
 * offline) both land. Replace always records the choice; adding a tag it has, or removing one it lacks, is a no-op, and
 * so is adding or removing one someone changed later than this change was made (`notApplied`).
 */
async function changeTags(
  ctx: CommandContext,
  input: { recordType: RecordType; recordId: string; tagIds: readonly string[]; mode: TagsMode },
) {
  const workspaceId = ctx.scope.workspaceId!;
  const { recordType, recordId, mode } = input;
  const table = recordType === 'person' ? people : recordType === 'company' ? companies : leads;
  const [record] = await ctx.tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, recordId), eq(table.workspaceId, workspaceId)));
  if (!record) throw HfosError.notFound('Record not found.');
  const before = await tagsOf(ctx.tx, workspaceId, recordType, recordId);
  const later =
    mode === 'replace'
      ? []
      : await tagsChangedSince(ctx, { recordType, recordId, tagIds: input.tagIds, mode });
  const tagIds = [...new Set(input.tagIds)].filter((t) => !later.includes(t));
  const createdBy = userIdOf(ctx.actor);
  // Put on when the person did it (on a phone, perhaps before it had signal); a tag already there keeps its time.
  const createdAt = changeMoment(ctx.meta);
  if (mode === 'add' && tagIds.length > 0)
    await ctx.tx
      .insert(recordTags)
      .values(
        tagIds.map((tagId) => ({ workspaceId, tagId, recordType, recordId, createdBy, createdAt })),
      )
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
      ? await setRecordTags(ctx.tx, workspaceId, recordType, recordId, tagIds, createdBy, createdAt)
      : await tagsOf(ctx.tx, workspaceId, recordType, recordId);
  const had = new Set(before.map((t) => t.id));
  const has = new Set(after.map((t) => t.id));
  const added = after.filter((t) => !had.has(t.id)).map((t) => t.id);
  const removed = before.filter((t) => !has.has(t.id)).map((t) => t.id);
  const changed = added.length > 0 || removed.length > 0;
  const notApplied = later.length ? ['tagId'] : [];
  if (mode !== 'replace' && !changed) return { tags: after, changed, notApplied };
  await ctx.emit({
    type: 'record.tags_changed',
    entityType: recordType,
    entityId: recordId,
    payload: { recordType, tagIds: after.map((t) => t.id), mode, added, removed },
    before: { tags: before.map((t) => t.name) },
    after: { tags: after.map((t) => t.name) },
    broadcast: false,
  });
  return { tags: after, changed, notApplied };
}

export const recordSetTags = defineCommand({
  name: 'record.set_tags',
  description:
    'Set the tags on a person, company or lead, or add or remove some and leave the rest (mode). People’s screens use record.add_tag and record.remove_tag.',
  risk: 1,
  input: RecordSetTagsInput,
  output: RecordSetTagsOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['record.tags_changed'],
  actors: ['human', 'system', 'workflow', 'ai_employee'],
  async handler(ctx, input) {
    const { recordType, recordId, mode } = input;
    // The AI teammate only adds tags, to its own customer or their lead.
    if (ctx.actor.type === 'ai_employee') {
      if (mode !== 'add')
        throw HfosError.validation([{ path: 'mode', message: 'The AI teammate only adds tags.' }]);
      await assertAiReach(
        ctx,
        recordType === 'person'
          ? { personId: recordId }
          : recordType === 'lead'
            ? { leadId: recordId }
            : { companyId: recordId },
      );
    }
    const { tags: after } = await changeTags(ctx, input);
    return { tags: after };
  },
});

export const recordAddTag = defineCommand({
  name: 'record.add_tag',
  description:
    'Put one tag on a person, company or lead. Already there, nothing changes; the other tags are left alone.',
  risk: 1,
  input: RecordTagInput,
  output: RecordTagOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['record.tags_changed'],
  offline: 'anytime',
  async handler(ctx, input) {
    // A tag deleted while the phone was offline is gone, not a server fault.
    const [tag] = await ctx.tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.id, input.tagId), eq(tags.workspaceId, ctx.scope.workspaceId!)));
    if (!tag) throw HfosError.notFound('That tag isn’t there anymore.');
    return changeTags(ctx, { ...input, tagIds: [input.tagId], mode: 'add' });
  },
});

export const recordRemoveTag = defineCommand({
  name: 'record.remove_tag',
  description:
    'Take one tag off a person, company or lead. Already off, nothing changes; the other tags are left alone.',
  risk: 1,
  input: RecordTagInput,
  output: RecordTagOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['record.tags_changed'],
  offline: 'anytime',
  async handler(ctx, input) {
    return changeTags(ctx, { ...input, tagIds: [input.tagId], mode: 'remove' });
  },
});
