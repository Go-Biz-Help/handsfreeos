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
export const RecordSetTagsInput = z.object({
  workspaceId: uuid,
  recordType,
  recordId: uuid,
  tagIds,
});
export const RecordSetTagsOutput = z.object({ tags: z.array(TagRef) });
export const TagListInput = z.object({ workspaceId: uuid });
export const TagListOutput = z.object({
  tags: z.array(TagRef.extend({ usage: z.number().int() })),
});
