import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  organizationCreate,
  PICTURE_BUCKET,
  PICTURE_PROBLEMS,
  PICTURE_UPLOAD_BUCKET,
  pictureBeginUpload,
  pictureList,
  pictureRemove,
  pictureUseUpload,
  executeQuery,
  type HumanActor,
  type PictureRow,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { processJobs } from '../src/jobs';
import { MAKE_PICTURE_JOB, makePicture, PictureError } from '../src/look/pictures';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

/**
 * Your pictures, the worker's part (look/pictures.ts): an uploaded picture made into the web copy everyone sees (a
 * WebP at most 2000 pixels on its longer side, turned the way the camera held it, with none of the original's hidden
 * details), or refused with words saying why. The upload goes either way.
 */

const WORKER_ID = `vitest-pictures-${process.pid}`;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

/** A plain photo-sized picture, `width` × `height`, as a JPG. */
const photo = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#2d69d8' } })
    .jpeg()
    .toBuffer();

let owner: TestUser;
let s: TestServices;

beforeAll(async () => {
  owner = await createTestUser('pictures-jobs-owner');
  s = testServices();
});
afterAll(closeTestDbs);

describe('making a picture', () => {
  it('turns it the way the camera held it, sizes it down, and leaves out its hidden details', async () => {
    // Taken sideways: 3000 × 1000 as stored, 1000 × 3000 as seen, with where it was taken written inside.
    const sideways = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: '#b42318' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExifMerge({ IFD0: { Make: 'Phone' } })
      .toBuffer();
    expect(await sharp(sideways).metadata()).toMatchObject({
      orientation: 6,
      exif: expect.anything(),
    });
    const made = await makePicture(sideways);
    expect({ width: made.width, height: made.height }).toEqual({ width: 667, height: 2000 });
    const meta = await sharp(made.webp).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('keeps a small picture its own size, and takes a GIF’s first frame', async () => {
    const made = await makePicture(await photo(640, 480));
    expect({ width: made.width, height: made.height }).toEqual({ width: 640, height: 480 });
    const gif = await sharp({
      create: { width: 200, height: 100, channels: 3, background: '#008743' },
    })
      .gif()
      .toBuffer();
    expect((await makePicture(gif)).width).toBe(200);
  });

  it('says why one can’t be used', async () => {
    const problem = async (data: Buffer) => {
      try {
        await makePicture(data);
      } catch (e) {
        expect(e).toBeInstanceOf(PictureError);
        return (e as PictureError).problem;
      }
      return null;
    };
    expect(await problem(await photo(20, 20))).toBe('tooSmall');
    expect(await problem(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      'unreadable',
    );
    expect(await problem(Buffer.from('not a picture at all'))).toBe('unreadable');
    expect(await problem(Buffer.alloc(21 * 1024 * 1024))).toBe('tooBig');
  });
});

async function business(name: string): Promise<string> {
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: name, industry: 'roofing' },
    actor(owner),
    meta(),
  );
  return output.workspaceId;
}

async function reserve(ws: string): Promise<void> {
  for (const table of ['outbox', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${ws}`,
    );
}

/** Runs this business's outbox and jobs until the picture's job is done. */
async function work(ws: string): Promise<void> {
  const deps = { ...s, workerId: WORKER_ID, batchSize: 50, reservedOnly: true };
  const deadline = Date.now() + 60_000;
  for (;;) {
    await reserve(ws);
    const passes = [await processOnce({ ...deps, handlers }), await processJobs({ ...deps, jobs })];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select kind as what, last_error from app.scheduled_jobs where workspace_id = ${ws} and last_error is not null
            union all select event_type, last_error from app.outbox where workspace_id = ${ws} and last_error is not null`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    const done = await rows(
      admin(),
      sql`select 1 from app.scheduled_jobs where workspace_id = ${ws} and kind = ${MAKE_PICTURE_JOB} and status = 'done'`,
    );
    if (done.length) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

/** Uploads a picture as the browser would, after picture.begin_upload, and hands it over. */
async function upload(ws: string, data: Buffer, mimeType: string, name = 'crew.jpg') {
  const { output } = await executeCommand(
    api(),
    pictureBeginUpload,
    { workspaceId: ws, name, mimeType, sizeBytes: data.length },
    actor(owner),
    meta(),
  );
  await s.store.upload(PICTURE_UPLOAD_BUCKET, output.objectPath, data, mimeType);
  await executeCommand(
    api(),
    pictureUseUpload,
    { workspaceId: ws, pictureId: output.pictureId },
    actor(owner),
    meta(),
  );
  return output;
}

const pictureIn = async (ws: string, id: string): Promise<PictureRow | undefined> =>
  (await executeQuery(api(), pictureList, { workspaceId: ws }, actor(owner), meta())).pictures.find(
    (p) => p.id === id,
  );

describe('an uploaded picture', () => {
  it('is made into the copy everyone sees, and the upload goes', async () => {
    const ws = await business('Picture Jobs Roofing');
    const { pictureId, objectPath } = await upload(ws, await photo(2400, 1600), 'image/jpeg');
    await work(ws);
    const picture = await pictureIn(ws, pictureId);
    expect(picture).toMatchObject({
      status: 'ready',
      path: `${ws}/${pictureId}.webp`,
      width: 2000,
      height: 1333,
      problem: null,
    });
    expect(await s.store.info(PICTURE_BUCKET, picture!.path!)).toMatchObject({
      contentType: 'image/webp',
    });
    expect(await s.store.info(PICTURE_UPLOAD_BUCKET, objectPath)).toBeNull();
  });

  it('says why a picture couldn’t be used, and the upload goes', async () => {
    const ws = await business('Bad Picture Roofing');
    const { pictureId, objectPath } = await upload(
      ws,
      await photo(16, 16),
      'image/jpeg',
      'dot.jpg',
    );
    await work(ws);
    expect(await pictureIn(ws, pictureId)).toMatchObject({
      status: 'failed',
      path: null,
      problem: PICTURE_PROBLEMS.tooSmall,
    });
    expect(await s.store.info(PICTURE_UPLOAD_BUCKET, objectPath)).toBeNull();
  });

  it('isn’t made once it’s taken out of the library', async () => {
    const ws = await business('Removed Picture Roofing');
    const { pictureId, objectPath } = await upload(ws, await photo(800, 600), 'image/jpeg');
    await executeCommand(
      api(),
      pictureRemove,
      { workspaceId: ws, pictureId },
      actor(owner),
      meta(),
    );
    await work(ws);
    expect(await s.store.info(PICTURE_BUCKET, `${ws}/${pictureId}.webp`)).toBeNull();
    expect(await s.store.info(PICTURE_UPLOAD_BUCKET, objectPath)).toBeNull();
  });
});
