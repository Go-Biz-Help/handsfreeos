/**
 * Your pictures (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 1): the business's library, newest first, with
 * the ones still being made and the ones that couldn't be. Anyone in the business may look; RLS says so too.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { designPictures } from '@hfos/db/schema';
import { pictureRowOf } from '../commands/picture';
import { defineQuery } from '../kernel/define';
import { PICTURE_LIBRARY_MAX } from '../look/pictures';
import { PictureListInput, PictureListOutput } from '../schemas/picture';

export const pictureList = defineQuery({
  name: 'picture.list',
  description:
    'The business’s pictures, newest first: each one’s name, what it shows in words, whether it’s ready, and its size. Put one on a form, booking page or email by its id.',
  input: PictureListInput,
  output: PictureListOutput,
  permission: 'workspace.read',
  scope: (i: { workspaceId: string }) => ({
    kind: 'workspace' as const,
    workspaceId: i.workspaceId,
  }),
  async handler(ctx) {
    const list = await ctx.tx
      .select()
      .from(designPictures)
      .where(
        and(
          eq(designPictures.workspaceId, ctx.scope.workspaceId!),
          isNull(designPictures.removedAt),
        ),
      )
      .orderBy(desc(designPictures.createdAt), desc(designPictures.id))
      .limit(PICTURE_LIBRARY_MAX + 20);
    return { pictures: list.map(pictureRowOf) };
  },
});
