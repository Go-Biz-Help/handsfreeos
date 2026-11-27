/**
 * Your pictures (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 1, look/pictures.ts): a business's library of
 * pictures for its forms, booking pages, emails, chat and invoices.
 *
 * - A person uploads in two steps, as with the logo: `picture.begin_upload` reserves a place in the private
 *   `picture-uploads` bucket (a row, `uploading`; the database admits only that place, for that person), and
 *   `picture.use_upload` hands it to the worker (`picture.upload_ready`), which makes the copy everyone sees and keeps
 *   it with `picture.note_made`.
 * - Anyone in the business sees the library. Adding, renaming and removing are for whoever may change how its pages
 *   look: the business, its forms, its calendars or its channels (`canAddPictures`), as the database's
 *   `private.can_add_pictures` says.
 * - `picture.remove` takes it out of the library; its file stays, so a page already showing it doesn't break.
 */
import { randomUUID } from 'node:crypto';
import { and, count, eq, isNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { designPictures } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import type { CommandContext, ResolvedScope } from '../kernel/types';
import {
  isAppleHeic,
  PICTURE_LIBRARY_MAX,
  PICTURE_PROBLEMS,
  PICTURE_UPLOAD_BUCKET,
  PICTURE_UPLOAD_MAX_BYTES,
  PICTURE_UPLOAD_TYPES,
  PICTURE_WORDS,
  type PictureStatus,
} from '../look/pictures';
import {
  PictureBeginUploadInput,
  PictureBeginUploadOutput,
  PictureNoteMadeInput,
  PictureNoteMadeOutput,
  PictureRemoveInput,
  PictureRemoveOutput,
  PictureUpdateInput,
  PictureUpdateOutput,
  PictureUseUploadInput,
  PictureUseUploadOutput,
  type PictureRow,
} from '../schemas/picture';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Whoever may change how the business's pages look: the business, its forms, its calendars or its channels. */
export const canAddPictures = (scope: ResolvedScope): boolean =>
  scopeCan(scope, 'workspace.update') ||
  scopeCan(scope, 'forms.manage') ||
  scopeCan(scope, 'calendars.manage') ||
  scopeCan(scope, 'channels.manage');

function mayAdd(ctx: CommandContext): void {
  if (ctx.actor.type === 'human' && !canAddPictures(ctx.scope))
    throw HfosError.forbidden(PICTURE_WORDS.cantChange, 'pictures_not_yours');
}

type Row = typeof designPictures.$inferSelect;

export const pictureRowOf = (r: Row): PictureRow => ({
  id: r.id,
  name: r.name,
  words: r.words,
  status: r.status as PictureStatus,
  path: r.path,
  width: r.width,
  height: r.height,
  problem: r.problem,
  createdAt: r.createdAt.toISOString(),
});

const gone = (name?: string) =>
  HfosError.notFound(
    `${name ? `${name} isn’t` : 'That picture isn’t'} in your pictures any more. Pick another one, or upload it again.`,
  );

/** The picture, held until this command saves; one taken out of the library counts as gone. */
async function held(ctx: CommandContext, pictureId: string): Promise<Row> {
  const [row] = await ctx.tx
    .select()
    .from(designPictures)
    .where(
      and(
        eq(designPictures.id, pictureId),
        eq(designPictures.workspaceId, ctx.scope.workspaceId!),
        isNull(designPictures.removedAt),
      ),
    )
    .for('update');
  if (!row) throw gone();
  return row;
}

export const pictureBeginUpload = defineCommand({
  name: 'picture.begin_upload',
  description:
    'Reserve a place to upload a picture to the business’s pictures (PNG, JPG, WebP or GIF, up to 20 MB). Upload it there, then hand it over with picture.use_upload.',
  risk: 1,
  input: PictureBeginUploadInput,
  output: PictureBeginUploadOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    mayAdd(ctx);
    if (isAppleHeic(input.mimeType, input.name))
      throw HfosError.rule('picture_upload_heic', 422, PICTURE_PROBLEMS.heic);
    const ending = PICTURE_UPLOAD_TYPES[input.mimeType as keyof typeof PICTURE_UPLOAD_TYPES];
    if (!ending)
      throw HfosError.rule(
        'picture_upload_type',
        422,
        `${input.name} isn’t a picture we can use. Upload a PNG, JPG, WebP or GIF.`,
      );
    if (input.sizeBytes > PICTURE_UPLOAD_MAX_BYTES)
      throw HfosError.rule(
        'picture_upload_size',
        422,
        `${input.name} is over ${PICTURE_UPLOAD_MAX_BYTES / (1024 * 1024)} MB. Upload a smaller copy of it.`,
      );
    const [kept] = await ctx.tx
      .select({ n: count() })
      .from(designPictures)
      .where(
        and(
          eq(designPictures.workspaceId, ctx.scope.workspaceId!),
          isNull(designPictures.removedAt),
        ),
      );
    if ((kept?.n ?? 0) >= PICTURE_LIBRARY_MAX)
      throw HfosError.rule(
        'picture_library_full',
        409,
        `Your pictures has ${PICTURE_LIBRARY_MAX}, the most it keeps. Remove some you don’t use, then upload ${input.name} again.`,
      );
    const id = randomUUID();
    const objectPath = `${ctx.scope.workspaceId}/${id}.${ending}`;
    await ctx.tx.insert(designPictures).values({
      id,
      workspaceId: ctx.scope.workspaceId!,
      name: input.name,
      status: 'uploading',
      uploadPath: objectPath,
      createdBy: requireHuman(ctx).userId,
    });
    return { pictureId: id, bucket: PICTURE_UPLOAD_BUCKET, objectPath };
  },
});

export const pictureUseUpload = defineCommand({
  name: 'picture.use_upload',
  description:
    'Hand an uploaded picture to HandsFreeOS, which makes a web copy of it for the business’s pages and emails.',
  risk: 1,
  input: PictureUseUploadInput,
  output: PictureUseUploadOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['picture.upload_ready'],
  async handler(ctx, input) {
    mayAdd(ctx);
    const row = await held(ctx, input.pictureId);
    if (row.createdBy !== requireHuman(ctx).userId || !row.uploadPath)
      throw HfosError.rule(
        'picture_upload_unknown',
        409,
        'That upload isn’t one we’re waiting for. Upload the picture again.',
      );
    if (row.status !== 'uploading') return { picture: pictureRowOf(row) };
    const [info] = await rows<{ size_bytes: number | null }>(
      ctx.tx,
      sql`select size_bytes from private.storage_object_info(${PICTURE_UPLOAD_BUCKET}, ${row.uploadPath})`,
    );
    if (!info)
      throw HfosError.rule(
        'picture_not_uploaded',
        409,
        `${row.name} didn’t finish uploading. Check your connection and upload it again.`,
      );
    const [next] = await ctx.tx
      .update(designPictures)
      .set({ status: 'making' })
      .where(eq(designPictures.id, row.id))
      .returning();
    await ctx.emit({
      type: 'picture.upload_ready',
      entityType: 'design_picture',
      entityId: row.id,
      payload: { pictureId: row.id, objectPath: row.uploadPath },
      after: { name: row.name },
    });
    return { picture: pictureRowOf(next!) };
  },
});

export const pictureUpdate = defineCommand({
  name: 'picture.update',
  description:
    'Rename one of the business’s pictures, or change what it shows in words (read out to people who can’t see it).',
  risk: 1,
  input: PictureUpdateInput,
  output: PictureUpdateOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['picture.updated'],
  async handler(ctx, input) {
    mayAdd(ctx);
    const row = await held(ctx, input.pictureId);
    const patch = {
      ...(input.name !== undefined && input.name !== row.name ? { name: input.name } : {}),
      ...(input.words !== undefined && input.words !== row.words ? { words: input.words } : {}),
    };
    if (!Object.keys(patch).length) return { picture: pictureRowOf(row) };
    const [next] = await ctx.tx
      .update(designPictures)
      .set(patch)
      .where(eq(designPictures.id, row.id))
      .returning();
    await ctx.emit({
      type: 'picture.updated',
      entityType: 'design_picture',
      entityId: row.id,
      payload: { pictureId: row.id, fields: Object.keys(patch) },
      before: { name: row.name, words: row.words },
      after: { name: next!.name, words: next!.words },
    });
    return { picture: pictureRowOf(next!) };
  },
});

export const pictureRemove = defineCommand({
  name: 'picture.remove',
  description:
    'Take a picture out of the business’s pictures. Forms, pages and emails already showing it keep showing it.',
  risk: 1,
  input: PictureRemoveInput,
  output: PictureRemoveOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['picture.removed'],
  async handler(ctx, input) {
    mayAdd(ctx);
    const row = await held(ctx, input.pictureId);
    await ctx.tx
      .update(designPictures)
      .set({ removedAt: new Date(), removedBy: requireHuman(ctx).userId })
      .where(eq(designPictures.id, row.id));
    await ctx.emit({
      type: 'picture.removed',
      entityType: 'design_picture',
      entityId: row.id,
      payload: { pictureId: row.id },
      before: { name: row.name },
    });
    return { removed: true };
  },
});

export const pictureNoteMade = defineCommand({
  name: 'picture.note_made',
  description:
    'System: keep the web copy made of a picture someone uploaded, or say why the picture couldn’t be used.',
  risk: 0,
  input: PictureNoteMadeInput,
  output: PictureNoteMadeOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: ['picture.ready', 'picture.refused'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .select()
      .from(designPictures)
      .where(
        and(
          eq(designPictures.id, input.pictureId),
          eq(designPictures.workspaceId, ctx.scope.workspaceId!),
        ),
      )
      .for('update');
    // Taken out of the library meanwhile, or dealt with already.
    if (!row || row.removedAt || row.status !== 'making') return { kept: false };
    if (!input.made) {
      const problem = input.problem ?? PICTURE_PROBLEMS.failed;
      await ctx.tx
        .update(designPictures)
        .set({ status: 'failed', problem, uploadPath: null })
        .where(eq(designPictures.id, row.id));
      await ctx.emit({
        type: 'picture.refused',
        entityType: 'design_picture',
        entityId: row.id,
        payload: { pictureId: row.id, problem },
        after: { name: row.name },
      });
      return { kept: false };
    }
    await ctx.tx
      .update(designPictures)
      .set({
        status: 'ready',
        path: input.made.path,
        width: input.made.width,
        height: input.made.height,
        bytes: input.made.bytes,
        problem: null,
        uploadPath: null,
      })
      .where(eq(designPictures.id, row.id));
    await ctx.emit({
      type: 'picture.ready',
      entityType: 'design_picture',
      entityId: row.id,
      payload: { pictureId: row.id, path: input.made.path },
      after: { name: row.name },
    });
    return { kept: true };
  },
});
