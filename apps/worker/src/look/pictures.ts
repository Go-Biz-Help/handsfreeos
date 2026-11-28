import {
  executeCommandIn,
  PICTURE_BUCKET,
  PICTURE_MAX_SIDE,
  PICTURE_MIN_SIDE,
  PICTURE_PROBLEMS,
  PICTURE_UPLOAD_BUCKET,
  PICTURE_UPLOAD_MAX_BYTES,
  PICTURE_UPLOAD_PATH,
  pictureNoteMade,
  scheduleJob,
  type PictureProblem,
} from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { designPictures } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { HandlerContext } from '../handlers/types';
import type { JobContext, JobHandler } from '../jobs';
import { errorMessage, MAX_ATTEMPTS } from '../outbox';
import { systemActor, tenantOf, type TenantScope } from '../services';

/**
 * Your pictures, the worker's part (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 1, core's look/pictures.ts).
 *
 * `picture.upload_ready` (someone handed over an upload) queues `picture.make`: the picture waiting in
 * `picture-uploads` is made into the copy everyone sees, in the public `pictures` bucket, and `picture.note_made`
 * keeps it, or says why it couldn't be used. The upload is removed either way.
 *
 * The copy is a WebP at most 2000 pixels on its longer side, turned the way the camera held it, with nothing of the
 * original's hidden details (where it was taken, the phone) carried over. Only PNG, JPG, WebP, GIF (its first frame)
 * and AVIF are opened, whatever the file says it is, and nothing so big that a small file unpacks into a huge
 * picture. A retry writes the same file again: it's named for the picture.
 */

export const MAKE_PICTURE_JOB = 'picture.make';

export const PICTURE_LIMITS = {
  /** Pictures with more pixels than this aren't opened (a 48-megapixel phone photo is under it). */
  maxInputPixels: 60_000_000,
  /** WebP quality: sharp to the eye, a fraction of a phone photo's size. */
  quality: 82,
} as const;

interface MakePictureJob {
  readonly pictureId: string;
  readonly objectPath: string;
  readonly requestedBy: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export class PictureError extends Error {
  constructor(readonly problem: PictureProblem) {
    super(PICTURE_PROBLEMS[problem]);
    this.name = 'PictureError';
  }
}

export interface MadePicture {
  readonly webp: Buffer;
  readonly width: number;
  readonly height: number;
}

const FORMATS = new Set(['png', 'jpeg', 'webp', 'gif', 'heif']);

/** The copy everyone sees, made from an upload: a PictureError when it can't be used. */
export async function makePicture(data: Buffer): Promise<MadePicture> {
  if (data.length > PICTURE_UPLOAD_MAX_BYTES) throw new PictureError('tooBig');
  try {
    const image = sharp(data, { limitInputPixels: PICTURE_LIMITS.maxInputPixels, failOn: 'error' });
    const meta = await image.metadata();
    // sharp calls AVIF "heif"; an Apple HEIC can't be opened by the libvips sharp ships, so it fails here or below.
    if (!meta.format || !FORMATS.has(meta.format)) throw new PictureError('unreadable');
    const { data: webp, info } = await image
      .rotate()
      .resize({
        width: PICTURE_MAX_SIDE,
        height: PICTURE_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: PICTURE_LIMITS.quality })
      .toBuffer({ resolveWithObject: true });
    if (Math.max(info.width, info.height) < PICTURE_MIN_SIDE) throw new PictureError('tooSmall');
    return { webp, width: info.width, height: info.height };
  } catch (e) {
    if (e instanceof PictureError) throw e;
    throw new PictureError('unreadable');
  }
}

const byPerson = (ctx: HandlerContext) =>
  ctx.event.actorType === 'human' ? (ctx.event.actorId ?? null) : null;

/** `picture.upload_ready`: make the picture, once for each upload. */
export async function onPictureUploadReady(ctx: HandlerContext): Promise<void> {
  const p = ctx.event.payload as { pictureId?: string; objectPath?: string };
  if (!p.pictureId || !p.objectPath) throw new Error('picture.upload_ready is missing its picture');
  await scheduleJob(ctx.tx, {
    kind: MAKE_PICTURE_JOB,
    dedupeKey: `${MAKE_PICTURE_JOB}:${p.pictureId}`,
    runAt: new Date(),
    payload: {
      pictureId: p.pictureId,
      objectPath: p.objectPath,
      requestedBy: byPerson(ctx),
      correlationId: ctx.event.correlationId,
      causationId: ctx.event.id,
    } satisfies MakePictureJob,
    workspaceId: ctx.event.workspaceId,
    organizationId: ctx.event.organizationId,
  });
}

export const makePictureJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const job = ctx.job.payload as unknown as MakePictureJob;
  try {
    await makeUploadedPicture(ctx, scope, job);
  } catch (e) {
    if (ctx.attempt < MAX_ATTEMPTS) throw e;
    // Out of tries: the person is told, and can upload it again.
    ctx.log.warn(
      { pictureId: job.pictureId, err: errorMessage(e) },
      'a picture someone uploaded couldn’t be made ready',
    );
    await note(ctx, scope, job, null, PICTURE_PROBLEMS.failed);
    await ctx.store.remove(PICTURE_UPLOAD_BUCKET, job.objectPath);
  }
};

async function makeUploadedPicture(
  ctx: JobContext,
  scope: TenantScope,
  job: MakePictureJob,
): Promise<void> {
  // Only ever a picture of this business, at a place picture.begin_upload names.
  if (
    !PICTURE_UPLOAD_PATH.test(job.objectPath) ||
    !job.objectPath.startsWith(`${scope.workspaceId}/${job.pictureId}.`)
  )
    throw new Error('picture.make was given a picture outside its business');
  const log = ctx.log.child({ pictureId: job.pictureId });
  const [row] = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select({ status: designPictures.status, removedAt: designPictures.removedAt })
      .from(designPictures)
      .where(eq(designPictures.id, job.pictureId)),
  );
  if (!row || row.removedAt || row.status !== 'making') {
    // Taken out of the library, or dealt with already: what's left of it goes.
    await ctx.store.remove(PICTURE_UPLOAD_BUCKET, job.objectPath);
    return;
  }
  const info = await ctx.store.info(PICTURE_UPLOAD_BUCKET, job.objectPath);
  if (!info) {
    await note(ctx, scope, job, null, PICTURE_PROBLEMS.missing);
    return;
  }
  let made: MadePicture;
  try {
    if (info.size > PICTURE_UPLOAD_MAX_BYTES) throw new PictureError('tooBig');
    made = await makePicture(await ctx.store.download(PICTURE_UPLOAD_BUCKET, job.objectPath));
  } catch (e) {
    if (!(e instanceof PictureError)) throw e;
    log.info({ problem: e.problem }, 'an uploaded picture couldn’t be used');
    await note(ctx, scope, job, null, e.message);
    await ctx.store.remove(PICTURE_UPLOAD_BUCKET, job.objectPath);
    return;
  }
  const path = `${scope.workspaceId}/${job.pictureId}.webp`;
  await ctx.store.upload(PICTURE_BUCKET, path, made.webp, 'image/webp', { upsert: true });
  const kept = await note(ctx, scope, job, { path, made }, null);
  if (!kept) await ctx.store.remove(PICTURE_BUCKET, path);
  await ctx.store.remove(PICTURE_UPLOAD_BUCKET, job.objectPath);
  log.info({ kept, width: made.width, height: made.height }, 'made an uploaded picture');
}

async function note(
  ctx: JobContext,
  scope: TenantScope,
  job: MakePictureJob,
  made: { readonly path: string; readonly made: MadePicture } | null,
  problem: string | null,
): Promise<boolean> {
  const { output } = await asWorker(ctx.db, scope, (tx) =>
    executeCommandIn(
      tx,
      pictureNoteMade,
      {
        workspaceId: scope.workspaceId,
        pictureId: job.pictureId,
        made: made
          ? {
              path: made.path,
              width: made.made.width,
              height: made.made.height,
              bytes: made.made.webp.length,
            }
          : null,
        problem,
      },
      systemActor(scope, job.requestedBy),
      { correlationId: job.correlationId, causationId: job.causationId, channel: 'worker' },
    ),
  );
  return output.kept;
}
