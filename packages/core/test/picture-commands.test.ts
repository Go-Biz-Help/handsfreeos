/**
 * Your pictures on the local database (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 1):
 * - **Uploading** reserves a place for that person's picture, hands it to the worker once it's there, and the worker
 *   keeps the web copy it made, or says why the picture couldn't be used.
 * - Only pictures the worker can open are taken: an Apple HEIC photo is refused with how to save it as a JPG.
 * - **Anyone in the business sees the library**; adding, renaming and removing are for whoever may change the
 *   business, its forms, calendars or channels.
 * - **Removing** takes it out of the library, and the worker then keeps nothing more of it.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta, SystemActor } from '../src/kernel/types';
import { PICTURE_PROBLEMS, pictureUrlFor } from '../src/look/pictures';
import {
  organizationCreate,
  permissionSetMember,
  pictureBeginUpload,
  pictureList,
  pictureNoteMade,
  pictureRemove,
  pictureUpdate,
  pictureUseUpload,
} from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const worker = () => testDbs().worker.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const list = (u: TestUser, workspaceId = ws) =>
  executeQuery(api(), pictureList, { workspaceId }, human(u), meta()).then((r) => r.pictures);

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect({ code: err.code, rule: err.rule }).toMatchObject({ code, ...(rule ? { rule } : {}) });
    return err;
  }
  throw new Error(`expected ${code}${rule ? ` (${rule})` : ''}, but the call succeeded`);
}

const eventCount = async (type: string, entityId: string) => {
  const [r] = await rows<{ n: number }>(
    admin(),
    sql`select count(*)::int as n from app.events where event_type = ${type} and entity_id = ${entityId}`,
  );
  return r!.n;
};
/** Stands in for the browser's upload: the object as Storage records it. */
const putObject = (path: string, size = 200_000, mimetype = 'image/jpeg') =>
  rows(
    admin(),
    sql`insert into storage.objects (bucket_id, name, metadata)
        values ('picture-uploads', ${path}, ${JSON.stringify({ size, mimetype })}::jsonb)`,
  );

let dale: TestUser;
let marco: TestUser;
let fran: TestUser;
let ws: string;
let org: string;

const system = (): SystemActor => ({ type: 'system', workspaceId: ws, organizationId: org });
const asWorker = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
) =>
  executeCommand(worker(), cmd, input, system(), { ...meta(), channel: 'worker' }).then(
    (r) => r.output,
  );
const made = (pictureId: string) => ({
  path: `${ws}/${pictureId}.webp`,
  width: 1600,
  height: 1067,
  bytes: 180_000,
});

/** A picture uploaded by `u` and handed over: being made. */
async function uploaded(u: TestUser, name = 'crew.jpg') {
  const begun = await run(
    pictureBeginUpload,
    { workspaceId: ws, name, mimeType: 'image/jpeg', sizeBytes: 200_000 },
    u,
  );
  await putObject(begun.objectPath);
  const { picture } = await run(
    pictureUseUpload,
    { workspaceId: ws, pictureId: begun.pictureId },
    u,
  );
  return { ...begun, picture };
}

beforeAll(async () => {
  [dale, marco, fran] = await Promise.all([
    createTestUser('pictures-owner', { fullName: 'Dale Owner' }),
    createTestUser('pictures-member', { fullName: 'Marco Member' }),
    createTestUser('pictures-forms', { fullName: 'Fran Forms' }),
  ]);
  ws = (
    await run(organizationCreate, { businessName: 'Picture Roofing', industry: 'roofing' }, dale)
  ).workspaceId;
  const [w] = await rows<{ organizationId: string }>(
    admin(),
    sql`select organization_id as "organizationId" from app.workspaces where id = ${ws}`,
  );
  org = w!.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${ws}, ${marco.id}, 'member'), (${ws}, ${fran.id}, 'member')`,
  );
  // Fran may change the forms, and nothing else of the business's look.
  await run(
    permissionSetMember,
    { workspaceId: ws, userId: fran.id, permission: 'forms.manage', allowed: true },
    dale,
  );
});
afterAll(closeTestDbs);

describe('uploading a picture', () => {
  it('takes only pictures the worker can open, and not too big a one', async () => {
    const heic = await expectHfos(
      () =>
        run(
          pictureBeginUpload,
          { workspaceId: ws, name: 'IMG_0042.HEIC', mimeType: 'image/heic', sizeBytes: 3_000_000 },
          dale,
        ),
      'rule_violation',
      'picture_upload_heic',
    );
    expect(heic.message).toBe(PICTURE_PROBLEMS.heic);
    // A phone that hands it over without its type is caught by its ending.
    await expectHfos(
      () =>
        run(
          pictureBeginUpload,
          { workspaceId: ws, name: 'IMG_0043.heic', mimeType: '', sizeBytes: 3_000_000 },
          dale,
        ),
      'rule_violation',
      'picture_upload_heic',
    );
    const pdf = await expectHfos(
      () =>
        run(
          pictureBeginUpload,
          { workspaceId: ws, name: 'menu.pdf', mimeType: 'application/pdf', sizeBytes: 100 },
          dale,
        ),
      'rule_violation',
      'picture_upload_type',
    );
    expect(pdf.message).toContain('menu.pdf');
    await expectHfos(
      () =>
        run(
          pictureBeginUpload,
          { workspaceId: ws, name: 'huge.png', mimeType: 'image/png', sizeBytes: 21 * 1024 * 1024 },
          dale,
        ),
      'rule_violation',
      'picture_upload_size',
    );
  });

  it('is for whoever may change the business or its forms, calendars or channels', async () => {
    await expectHfos(
      () =>
        run(
          pictureBeginUpload,
          { workspaceId: ws, name: 'crew.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 },
          marco,
        ),
      'forbidden',
      'pictures_not_yours',
    );
    const { picture } = await uploaded(fran, 'truck.jpg');
    expect(picture).toMatchObject({ name: 'truck.jpg', status: 'making' });
  });

  it('waits for the upload, and only for the person who reserved it', async () => {
    const begun = await run(
      pictureBeginUpload,
      { workspaceId: ws, name: 'roof.png', mimeType: 'image/png', sizeBytes: 50_000 },
      dale,
    );
    expect(begun).toMatchObject({ bucket: 'picture-uploads' });
    expect(begun.objectPath).toBe(`${ws}/${begun.pictureId}.png`);
    await expectHfos(
      () => run(pictureUseUpload, { workspaceId: ws, pictureId: begun.pictureId }, dale),
      'rule_violation',
      'picture_not_uploaded',
    );
    await putObject(begun.objectPath, 50_000, 'image/png');
    await expectHfos(
      () => run(pictureUseUpload, { workspaceId: ws, pictureId: begun.pictureId }, fran),
      'rule_violation',
      'picture_upload_unknown',
    );
    const { picture } = await run(
      pictureUseUpload,
      { workspaceId: ws, pictureId: begun.pictureId },
      dale,
    );
    expect(picture.status).toBe('making');
    // Handing it over twice asks the worker once.
    await run(pictureUseUpload, { workspaceId: ws, pictureId: begun.pictureId }, dale);
    expect(await eventCount('picture.upload_ready', begun.pictureId)).toBe(1);
  });

  it('keeps the web copy the worker made, which anyone in the business sees', async () => {
    const { pictureId } = await uploaded(dale);
    expect(
      await asWorker(pictureNoteMade, {
        workspaceId: ws,
        pictureId,
        made: made(pictureId),
        problem: null,
      }),
    ).toEqual({ kept: true });
    const seen = (await list(marco)).find((p) => p.id === pictureId);
    expect(seen).toMatchObject({
      name: 'crew.jpg',
      status: 'ready',
      path: `${ws}/${pictureId}.webp`,
      width: 1600,
      height: 1067,
      problem: null,
    });
    expect(await eventCount('picture.ready', pictureId)).toBe(1);
    // Noted again (a retry), nothing changes.
    expect(
      await asWorker(pictureNoteMade, {
        workspaceId: ws,
        pictureId,
        made: made(pictureId),
        problem: null,
      }),
    ).toEqual({ kept: false });
  });

  it('says why a picture couldn’t be used', async () => {
    const { pictureId } = await uploaded(dale, 'tiny.jpg');
    await asWorker(pictureNoteMade, {
      workspaceId: ws,
      pictureId,
      made: null,
      problem: PICTURE_PROBLEMS.tooSmall,
    });
    expect((await list(dale)).find((p) => p.id === pictureId)).toMatchObject({
      status: 'failed',
      path: null,
      problem: PICTURE_PROBLEMS.tooSmall,
    });
    expect(await eventCount('picture.refused', pictureId)).toBe(1);
  });

  it('is the worker’s to note, never a person’s', async () => {
    const { pictureId } = await uploaded(dale, 'mine.jpg');
    await expectHfos(
      () =>
        run(
          pictureNoteMade,
          { workspaceId: ws, pictureId, made: made(pictureId), problem: null },
          dale,
        ),
      'forbidden',
    );
  });
});

describe('a picture in the library', () => {
  it('can be renamed and say what it shows, by whoever may add pictures', async () => {
    const { pictureId } = await uploaded(dale, 'IMG_2231.jpg');
    await asWorker(pictureNoteMade, {
      workspaceId: ws,
      pictureId,
      made: made(pictureId),
      problem: null,
    });
    const { picture } = await run(
      pictureUpdate,
      { workspaceId: ws, pictureId, name: 'Crew on a roof', words: 'Our crew on a roof in Austin' },
      fran,
    );
    expect(picture).toMatchObject({
      name: 'Crew on a roof',
      words: 'Our crew on a roof in Austin',
    });
    expect(await eventCount('picture.updated', pictureId)).toBe(1);
    // The same again changes nothing.
    await run(pictureUpdate, { workspaceId: ws, pictureId, name: 'Crew on a roof' }, dale);
    expect(await eventCount('picture.updated', pictureId)).toBe(1);
    await expectHfos(
      () => run(pictureUpdate, { workspaceId: ws, pictureId, name: 'Mine now' }, marco),
      'forbidden',
      'pictures_not_yours',
    );
  });

  it('comes out of the library when removed, and the worker keeps nothing more of it', async () => {
    const { pictureId } = await uploaded(dale, 'old-truck.jpg');
    await expectHfos(
      () => run(pictureRemove, { workspaceId: ws, pictureId }, marco),
      'forbidden',
      'pictures_not_yours',
    );
    expect(await run(pictureRemove, { workspaceId: ws, pictureId }, dale)).toEqual({
      removed: true,
    });
    expect((await list(dale)).some((p) => p.id === pictureId)).toBe(false);
    expect(
      await asWorker(pictureNoteMade, {
        workspaceId: ws,
        pictureId,
        made: made(pictureId),
        problem: null,
      }),
    ).toEqual({ kept: false });
    await expectHfos(
      () => run(pictureUpdate, { workspaceId: ws, pictureId, name: 'Back again' }, dale),
      'not_found',
    );
    await expectHfos(() => run(pictureRemove, { workspaceId: ws, pictureId }, dale), 'not_found');
  });

  it('belongs to its own business only', async () => {
    const other = (
      await run(organizationCreate, { businessName: 'Other Roofing', industry: 'roofing' }, marco)
    ).workspaceId;
    expect(await list(marco, other)).toEqual([]);
    const { pictureId } = await uploaded(dale, 'ours.jpg');
    await expectHfos(
      () => run(pictureRemove, { workspaceId: other, pictureId }, marco),
      'not_found',
    );
  });
});

describe('where a picture is seen', () => {
  it('is Storage’s public address for it, however many slashes end the address it was given', () => {
    const path = `${randomUUID()}/${randomUUID()}.webp`;
    const want = `https://x.supabase.co/storage/v1/object/public/pictures/${path}`;
    expect(pictureUrlFor('https://x.supabase.co', path)).toBe(want);
    expect(pictureUrlFor('https://x.supabase.co///', path)).toBe(want);
  });
});
