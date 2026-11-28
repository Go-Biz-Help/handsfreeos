/**
 * How the Content Creator's pictures look (design tools, part 6; docs/socialcontent.md, "How your pictures look"),
 * against the local database with a stand-in AI and image model: the brand kit's logo in a corner of every page, on
 * the last page only, or never; the design AI held to the fonts and layouts picked, and to the brand kit's font until
 * they are; a picture's words fixed by hand and drawn again with no AI; and words designed over the person's own photo,
 * which is never sent to OpenAI, never failed for what's in it, and can go back to plain.
 */
import { randomUUID } from 'node:crypto';
import type { AiProvider, AiRequest, AiTurn } from '@hfos/ai';
import { socialcontentAddon } from '@hfos/core/addons/socialcontent/manifest';
import { socialcontentAddonServer } from '@hfos/core/addons/socialcontent/server';
import {
  LOGO_ON_PURPOSE,
  OWN_PHOTO_ON_PURPOSE,
  PICTURE_CHECK_SYSTEM,
} from '@hfos/core/addons/socialcontent/check-ai';
import {
  addonRef,
  executeCommand,
  fileStore,
  organizationCreate,
  storedFilePath,
  type CommandDef,
  type SystemActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addonJobs } from '../src/addons/index';
import { runAddonAction } from '../src/addons/actions';
import { ownPhotoWordsNow, redrawPicturesNow } from '../src/addons/socialcontent/content';
import { scheduleAddonJob } from '../src/addons/queue';
import { processJobs } from '../src/jobs';
import type { PictureMaker } from '../src/pictures';
import { testServices, type TestServices } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const DESIGNING = 'You design social media pictures';

const script = {
  design: {} as Record<string, unknown>,
  check: { passes: true, problems: [] as string[], photoProblems: [] as string[] },
  requests: [] as AiRequest[],
};
const turn = (value: unknown): AiTurn => ({
  text: JSON.stringify(value),
  toolCalls: [],
  stopReason: 'end_turn',
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
});
const ai: AiProvider = {
  id: 'picture-look-test',
  model: 'stand-in',
  async stream(request) {
    script.requests.push(request);
    if (request.system.startsWith(DESIGNING)) return turn(script.design);
    if (request.system === PICTURE_CHECK_SYSTEM) {
      const images = (request.messages[0]!.content as Any[]).filter((x) => x.type === 'image');
      return turn({
        pages: images.map((_, i) => ({ page: i + 1, photoLooked: [], ...script.check })),
      });
    }
    throw new Error(`unexpected ask: ${request.system.slice(0, 60)}`);
  },
};
const designAsks = () => script.requests.filter((r) => r.system.startsWith(DESIGNING));
const checkAsks = () => script.requests.filter((r) => r.system === PICTURE_CHECK_SYSTEM);

const prompts: string[] = [];
const pictures: PictureMaker = {
  model: 'stand-in-image',
  backupModel: null,
  async make(prompt) {
    prompts.push(prompt);
    const bytes = await sharp({
      create: { width: 1024, height: 1536, channels: 3, background: '#7a9e5a' },
    })
      .png()
      .toBuffer();
    return { bytes, model: 'stand-in-image', usage: null };
  },
};

const page = (over: Record<string, unknown> = {}) => ({
  layout: 'bold',
  kicker: 'Winter tip',
  heading: 'Your pipes can freeze tonight',
  body: 'Drip the taps when it drops below 20°F.',
  items: [],
  mark: '',
  footer: 'Look Pipes Co',
  ...over,
});
const design = (pages: Record<string, unknown>[], font = 'modern') => ({
  font,
  background: '#ffffff',
  text: '#111111',
  accent: '#2d69d8',
  pages,
});

let owner: TestUser;
let ws: string;
let orgId: string;
let s: TestServices;
let generation: number;
const actor = (): SystemActor => ({
  type: 'system',
  workspaceId: ws,
  organizationId: orgId,
  addon: addonRef(socialcontentAddon),
});
const op = (name: string) =>
  (socialcontentAddonServer.commands ?? []).find((o) => o.name === name) as CommandDef;

async function post(
  format: 'photo' | 'carousel',
  way: 'photo' | 'design' | 'own',
  network = 'facebook',
): Promise<string> {
  const { output } = await executeCommand(
    testDbs().worker.db,
    op('socialcontent.content.put'),
    {
      workspaceId: ws,
      network,
      ideaId: null,
      postAt: null,
      placedBy: 'ai',
      post: {
        title: `Look ${randomUUID().slice(0, 4)}`,
        format,
        hook: 'Your pipes can freeze tonight.',
        words: 'Here is how to keep them safe when it gets cold.',
        hashtags: [],
        slides:
          format === 'carousel'
            ? [
                { heading: 'Pipes freeze at 20°F', body: 'Outside walls first.' },
                { heading: 'Drip the taps', body: 'Moving water freezes slower.' },
              ]
            : [],
        script: null,
        picture: 'A frosty window over a kitchen sink at dawn.',
        pictureWay: way,
        angle: 'tip',
        topic: null,
      },
      askedBy: null,
    },
    actor(),
    meta(),
  );
  return (output as { postId: string }).postId;
}

/** Runs the picture jobs waiting, as the worker would. */
async function runJobs(): Promise<void> {
  const runner = `vitest-look-${randomUUID().slice(0, 8)}`;
  await rows(
    admin(),
    sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}, run_at = now()
        where status = 'pending' and workspace_id = ${ws} and kind = 'socialcontent.pictures'`,
  );
  await processJobs({
    ...s,
    pictures,
    jobs: { ...addonJobs },
    workerId: runner,
    batchSize: 10,
    reservedOnly: true,
  });
}

async function makePictures(postId: string): Promise<void> {
  await asWorker(s.db, { workspaceId: ws, organizationId: orgId }, (tx) =>
    scheduleAddonJob(
      tx,
      { id: 'socialcontent', generation },
      {
        kind: 'socialcontent.pictures',
        dedupeKey: `socialcontent.pictures:${postId}`,
        runAt: new Date(),
        payload: { postId, prompt: 'A frosty window over a kitchen sink at dawn.', ask: null },
        workspaceId: ws,
        organizationId: orgId,
      },
      { pullEarlier: true },
    ),
  );
  await runJobs();
}

async function kept(postId: string) {
  const [r] = await rows<{
    state: string;
    way: string;
    file_ids: string[];
    design: Any;
    failure: string | null;
    post_state: string;
  }>(
    admin(),
    sql`select c.picture_state as state, c.picture_way as way, c.file_ids, c.design,
          c.picture_failure as failure, c.state as post_state
        from addon_socialcontent.content c where c.record_id = ${postId}`,
  );
  return r!;
}

async function fileBytes(fileId: string): Promise<Buffer> {
  const [f] = await rows<{ bucket: string; object_path: string }>(
    admin(),
    sql`select bucket, object_path from app.files where id = ${fileId}`,
  );
  return s.store.download(f!.bucket, f!.object_path);
}

/** The colour of one pixel of a picture. */
async function pixel(bytes: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

const lookSet = (look: Record<string, unknown>) =>
  rows(
    admin(),
    sql`insert into addon_socialcontent.settings (workspace_id, picture_look) values (${ws}, ${JSON.stringify(look)}::jsonb)
        on conflict (workspace_id) do update set picture_look = excluded.picture_look`,
  );
const kitSet = (kit: Record<string, unknown>) =>
  rows(
    admin(),
    sql`update app.workspaces
        set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{look}',
          coalesce(settings -> 'look', '{}'::jsonb) || ${JSON.stringify(kit)}::jsonb)
        where id = ${ws}`,
  );

const redraw = (postId: string, pages: unknown[]) =>
  runAddonAction(s, testDbs().worker.db, {
    manifest: socialcontentAddon,
    action: redrawPicturesNow,
    workspaceId: ws,
    userId: owner.id,
    input: { postId, pages },
  }) as Promise<{ pictures: number; cut: boolean }>;
const ownPhoto = (postId: string, words: boolean) =>
  runAddonAction(s, testDbs().worker.db, {
    manifest: socialcontentAddon,
    action: ownPhotoWordsNow,
    workspaceId: ws,
    userId: owner.id,
    input: { postId, words },
  });

/** A red logo, kept in the brand bucket as the brand kit's. */
async function addLogo(): Promise<void> {
  const id = randomUUID();
  const path = `${ws}/logo/${id}.png`;
  const bytes = await sharp({
    create: { width: 400, height: 100, channels: 4, background: '#e11d48' },
  })
    .png()
    .toBuffer();
  await s.store.upload('brand', path, bytes, 'image/png', { upsert: true });
  await kitSet({
    logo: { path, width: 400, height: 100, from: 'upload', at: new Date().toISOString() },
  });
}

/** The person's own photo, added to the post as its one picture. */
async function addOwnPhoto(postId: string): Promise<string> {
  const id = randomUUID();
  const path = storedFilePath(ws, 'custom_record', postId, id, 'van.jpg');
  const bytes = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: '#3b82f6' },
  })
    .jpeg()
    .toBuffer();
  await s.store.upload('attachments', path, bytes, 'image/jpeg', { upsert: true });
  await executeCommand(
    testDbs().worker.db,
    fileStore,
    {
      workspaceId: ws,
      id,
      recordType: 'custom_record',
      recordId: postId,
      name: 'van.jpg',
      mimeType: 'image/jpeg',
      from: 'ai',
    },
    actor(),
    meta(),
  );
  await rows(
    admin(),
    sql`update addon_socialcontent.content set file_ids = array[${id}]::uuid[], picture_state = 'none'
        where record_id = ${postId}`,
  );
  return id;
}

beforeAll(async () => {
  s = testServices({ ai: { provider: ai } });
  owner = await createTestUser('content-look-owner');
  const created = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Look Pipes Co' },
    { type: 'human', userId: owner.id, email: owner.email, claims: owner.claims },
    meta(),
  );
  ws = created.output.workspaceId;
  orgId = created.output.organizationId;
  const [inst] = await rows<{ generation: number }>(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, 'socialcontent', 'enabled', ${socialcontentAddon.version})
        returning generation`,
  );
  generation = inst!.generation;
  for (const k of socialcontentAddon.recordKinds ?? [])
    await rows(
      admin(),
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, name_label, icon, position,
            addon_id, write_permission)
          values (${ws}, ${k.key}, ${k.singular}, ${k.plural}, ${k.nameLabel ?? 'Name'}, ${k.icon ?? 'box'}, 900,
            'socialcontent', ${k.writePermission})`,
    );
  await addLogo();
}, 60_000);
afterAll(closeTestDbs);
beforeEach(async () => {
  script.check = { passes: true, problems: [], photoProblems: [] };
  await lookSet({});
});

describe('the logo on its pictures', () => {
  it('puts the brand kit’s logo in the bottom right corner of a picture, and tells the check', async () => {
    script.design = design([page()]);
    const id = await post('photo', 'design');
    await makePictures(id);
    const c = await kept(id);
    expect(c.state).toBe('made');
    expect(c.design.logoOn).toEqual([true]);
    const drawn = await fileBytes(c.file_ids[0]!);
    // The logo's middle (1080 wide, 4:5): red, where the page is white.
    expect(await pixel(drawn, 1080 - 96 - 105, 1350 - 96 - 2)).toEqual([225, 29, 72]);
    expect(await pixel(drawn, 1080 - 96 - 105, 200)).not.toEqual([225, 29, 72]);
    const asked = JSON.stringify(checkAsks().at(-1)!.messages);
    expect(asked).toContain(LOGO_ON_PURPOSE.slice(0, 40));
  });

  it('puts it on the last page only, or never', async () => {
    script.design = design([page(), page({ heading: 'Drip the taps' })]);
    await lookSet({ logo: 'last' });
    const carousel = await post('carousel', 'design');
    await makePictures(carousel);
    expect((await kept(carousel)).design.logoOn).toEqual([false, true]);

    await lookSet({ logo: 'never' });
    const none = await post('carousel', 'design');
    await makePictures(none);
    expect((await kept(none)).design.logoOn).toBeUndefined();
  });
});

describe('the fonts and layouts it may use', () => {
  it('tells the design AI only the ones picked, and swaps any other for one that is', async () => {
    await lookSet({ fonts: ['classic'], layouts: ['clean', 'quote', 'framed'] });
    script.design = design([page({ layout: 'bold' })], 'loud');
    const id = await post('photo', 'design');
    await makePictures(id);
    const ask = designAsks().at(-1)!;
    expect(ask.system).toContain('Use the "classic" font');
    expect(ask.system).not.toContain('"loud"');
    expect(ask.system).not.toContain('"bold"');
    const d = (await kept(id)).design;
    expect(d.font).toBe('classic');
    expect(d.pages[0].layout).toBe('clean');
  });

  it('follows the brand kit’s font until fonts are picked', async () => {
    await kitSet({ font: { name: 'Lora', at: new Date().toISOString() } });
    try {
      script.design = design([page()], 'friendly');
      const id = await post('photo', 'design');
      await makePictures(id);
      expect(designAsks().at(-1)!.system).toContain('Use the "classic" font');
      expect((await kept(id)).design.font).toBe('classic');
    } finally {
      await rows(
        admin(),
        sql`update app.workspaces set settings = settings #- '{look,font}' where id = ${ws}`,
      );
    }
  });
});

describe('fixing a picture’s words by hand', () => {
  it('draws the pictures again with the new words, asking no AI, and takes the OK back', async () => {
    script.design = design([page(), page({ heading: 'Drip the taps', layout: 'clean' })]);
    const id = await post('carousel', 'design');
    await makePictures(id);
    const before = await kept(id);
    await rows(
      admin(),
      sql`update addon_socialcontent.content set state = 'ready', approved_at = now() where record_id = ${id}`,
    );
    const asked = script.requests.length;
    const out = await redraw(id, [
      {
        kicker: 'Winter tip',
        heading: 'Your pipes can freeze tonight!',
        body: null,
        footer: 'Look Pipes Co',
      },
      { heading: 'Drip the taps a little', body: 'Moving water freezes slower.' },
    ]);
    expect(out).toMatchObject({ pictures: 2, cut: false });
    expect(script.requests.length).toBe(asked);
    const after = await kept(id);
    expect(after.file_ids).toHaveLength(2);
    expect(after.file_ids).not.toEqual(before.file_ids);
    expect(after.design.pages[0].heading).toBe('Your pipes can freeze tonight!');
    expect(after.design.pages[0].body).toBeNull();
    expect(after.design.pages[1]).toMatchObject({
      heading: 'Drip the taps a little',
      layout: 'clean',
      footer: null,
    });
    expect(after.design.edited).toBe(true);
    expect(after.design.font).toBe(before.design.font);
    expect(after.post_state).toBe('draft');
  });

  it('keeps a photo-style picture’s photo, so its words can be drawn again over it', async () => {
    // Too many words for OpenAI's whole graphic, so the words are drawn over its photo.
    script.design = design([
      page({
        layout: 'photo',
        heading: 'Frozen pipes can burst overnight and flood your whole kitchen in minutes',
      }),
    ]);
    const id = await post('photo', 'photo');
    await makePictures(id);
    const c = await kept(id);
    expect(c.design.photoFile).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.file_ids).not.toContain(c.design.photoFile);
    const madeBefore = prompts.length;
    await redraw(id, [{ heading: 'Frozen pipes cost $5,000' }]);
    expect(prompts.length).toBe(madeBefore);
    const after = await kept(id);
    expect(after.design.pages[0]).toMatchObject({
      layout: 'photo',
      heading: 'Frozen pipes cost $5,000',
    });
    // Drawn over the same green photo.
    expect(await pixel(await fileBytes(after.file_ids[0]!), 540, 200)).toEqual(
      await pixel(await fileBytes(c.file_ids[0]!), 540, 200),
    );
  });

  it('refuses words OpenAI made as part of its graphic, and the wrong number of pictures', async () => {
    script.design = design([page()]);
    const id = await post('photo', 'design');
    await makePictures(id);
    await expect(redraw(id, [{ heading: 'One' }, { heading: 'Two' }])).rejects.toThrow(/1 picture/);
    await rows(
      admin(),
      sql`update addon_socialcontent.content
          set design = design || '{"graphic": {"tried": true, "passed": true}}'::jsonb
          where record_id = ${id}`,
    );
    await expect(redraw(id, [{ heading: 'One' }])).rejects.toMatchObject({
      rule: 'socialcontent_words_not_drawn',
    });
  });
});

describe('words over the person’s own photo', () => {
  it('designs words over it without OpenAI, keeps it their own, and posts it plain again', async () => {
    script.design = design([page({ layout: 'photo' })]);
    script.check = { passes: false, problems: [], photoProblems: ['made-up writing on the van'] };
    const id = await post('photo', 'own');
    const photoId = await addOwnPhoto(id);
    const madeBefore = prompts.length;
    await ownPhoto(id, true);
    await runJobs();
    const c = await kept(id);
    expect(c.state).toBe('made');
    expect(c.way).toBe('own');
    expect(c.design.own).toBe(photoId);
    expect(c.file_ids).toHaveLength(1);
    expect(c.file_ids[0]).not.toBe(photoId);
    expect(prompts.length).toBe(madeBefore);
    // The van's real writing isn't the image AI's mistake: the check's photo problems are left out.
    expect(c.design.check).toMatchObject({ passes: true, problems: [] });
    expect(JSON.stringify(checkAsks().at(-1)!.messages)).toContain(
      OWN_PHOTO_ON_PURPOSE.slice(0, 40),
    );
    // Its words can be fixed by hand too, over the same photo.
    await redraw(id, [{ heading: 'Our van is ready for winter' }]);
    expect((await kept(id)).design.own).toBe(photoId);

    await ownPhoto(id, false);
    const plain = await kept(id);
    expect(plain.file_ids).toEqual([photoId]);
    expect(plain.design).toBeNull();
    expect(plain.way).toBe('own');
  });

  it('refuses a post with several photos, and one whose picture HandsFreeOS makes', async () => {
    const id = await post('photo', 'own');
    await addOwnPhoto(id);
    const second = await addOwnPhoto(id);
    await rows(
      admin(),
      sql`update addon_socialcontent.content set file_ids = file_ids || array[${second}]::uuid[]
          where record_id = ${id}`,
    );
    await expect(ownPhoto(id, true)).rejects.toMatchObject({ rule: 'socialcontent_own_photo_one' });
    const designed = await post('photo', 'design');
    await expect(ownPhoto(designed, true)).rejects.toMatchObject({
      rule: 'socialcontent_not_own_photo',
    });
  });
});
