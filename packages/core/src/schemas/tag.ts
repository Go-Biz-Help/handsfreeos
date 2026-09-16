import { z } from 'zod';
import { uuid } from './common';
import { recordType, tagIds, TagRef } from './crm';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a color.');
const tagName = z.string().trim().min(1, 'Enter a name.').max(40);

export const TagCreateInput = z.object({
  workspaceId: uuid,
  name: tagName,
  color: color.default('#2d69d8'),
});
export const TagCreateOutput = z.object({ tagId: uuid });
export const TagUpdateInput = z.object({
  workspaceId: uuid,
  tagId: uuid,
  name: tagName.optional(),
  color: color.optional(),
});
export const TagUpdateOutput = z.object({ tagId: uuid, updated: z.array(z.string()) });
export const TagDeleteInput = z.object({ workspaceId: uuid, tagId: uuid });
export const TagDeleteOutput = z.object({ tagId: uuid, removedFrom: z.number().int() });
/**
 * How record.set_tags changes the tags: `replace` (the default) leaves exactly `tagIds` on the record; `add`
 * and `remove` change only those tags, so a workflow tagging someone never undoes a teammate's change made at
 * the same moment.
 */
const tagsMode = z.enum(['replace', 'add', 'remove']);
export const RecordSetTagsInput = z.object({
  workspaceId: uuid,
  recordType,
  recordId: uuid,
  tagIds,
  mode: tagsMode.default('replace'),
});
export const RecordSetTagsOutput = z.object({ tags: z.array(TagRef) });
/**
 * One tag on or off a record (M10): what the web and the phone send, so two people tagging the same customer
 * both land. Adding a tag the record has, or removing one it lacks, changes nothing.
 */
export const RecordTagInput = z.object({
  workspaceId: uuid,
  recordType,
  recordId: uuid,
  tagId: uuid,
});
export const RecordTagOutput = z.object({
  tags: z.array(TagRef),
  /** False when the record already had (or already lacked) the tag. */
  changed: z.boolean(),
});
export const TagListInput = z.object({ workspaceId: uuid });
export const TagListOutput = z.object({
  tags: z.array(TagRef.extend({ usage: z.number().int() })),
});
