/**
 * AI Social Media Content Creator's picture job (apps/worker/src/addons/socialcontent/content.ts, `runPictures`;
 * docs/socialcontent.md, "Variety", decisions 39 and 40), against the local database with a stand-in AI and image
 * model: OpenAI's whole graphic kept when the check passes it, the next photo post's words drawn over a photo, a
 * graphic that fails the check swapped for a photo with drawn words, and a drawn design that fails designed again.
 * Instagram's are 3:4, and its posts not up yet whose pictures were made before that get them made again (the
 * owner, 15 Nov). A mistake in a photo itself, like a blank screen in someone's hand, has the photo made again, up to
 * twice (the owner, 15 and 16 Nov).
 */
import { randomUUID } from 'node:crypto';
import type { AiProvider, AiRequest, AiTurn } from '@hfos/ai';
import { socialcontentAddon } from '@hfos/core/addons/socialcontent/manifest';
import { socialcontentAddonServer } from '@hfos/core/addons/socialcontent/server';
import { PICTURE_CHECK_SYSTEM } from '@hfos/core/addons/socialcontent/check-ai';
import { DESIGN_SYSTEM } from '@hfos/core/addons/socialcontent/posts-ai';
import {
  addonRef,
  executeCommand,
  organizationCreate,
  type CommandDef,
  type SystemActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addonJobs } from '../src/addons/index';
import { scheduleAddonJob } from '../src/addons/queue';
import { processJobs } from '../src/jobs';
import type { PictureMaker } from '../src/pictures';
import { testServices, type TestServices } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

/** What the stand-in AI says next to a design ask and a check, and every request it was sent. */
const script = {
  /** Each design ask takes the next one; the last repeats. */
  designs: [] as Record<string, unknown>[],
  /** Each check takes the next one; the last repeats. */
  checks: [] as { passes: boolean; problems: string[]; photoProblems?: string[] }[],
  requests: [] as AiRequest[],
};
const turn = (value: unknown): AiTurn => ({
  text: JSON.stringify(value),
  toolCalls: [],
  stopReason: 'end_turn',
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
});
const ai: AiProvider = {
  id: 'pictures-test',
  model: 'stand-in',
  async stream(request) {
    script.requests.push(request);
    if (request.system === DESIGN_SYSTEM) {
      const n = script.requests.filter((r) => r.system === DESIGN_SYSTEM).length;
      return turn(script.designs[Math.min(n, script.designs.length) - 1]);
    }
    if (request.system === PICTURE_CHECK_SYSTEM) {
      const n = script.requests.filter((r) => r.system === PICTURE_CHECK_SYSTEM).length;
      const c = script.checks[Math.min(n, script.checks.length) - 1]!;
      const images = (request.messages[0]!.content as Any[]).filter((x) => x.type === 'image');
      return turn({ pages: images.map((_, i) => ({ page: i + 1, ...c })) });
    }
    throw new Error(`unexpected ask: ${request.system.slice(0, 60)}`);
  },
};

/** The stand-in image model: a plain picture, and every prompt it was asked and whether square. */
const prompts: string[] = [];
const squares: boolean[] = [];
const pictures: PictureMaker = {
  model: 'stand-in-image',
  backupModel: null,
  async make(prompt, o) {
    prompts.push(prompt);
    squares.push(o?.square === true);
    const bytes = await sharp({
      create: {
        width: 1024,
        height: o?.square ? 1024 : 1536,
        channels: 3,
        background: '#7a9e5a',
      },
    })
      .png()
      .toBuffer();
    return { bytes, model: 'stand-in-image', usage: null };
  },
};

const page = (over: Record<string, unknown> = {}) => ({
  layout: 'photo',
  kicker: 'Winter tip',
  heading: 'Your pipes can freeze tonight',
  body: '',
  items: [],
  mark: '',
  footer: 'Pipe Pictures Co',
  ...over,
});
const design = (pages: Record<string, unknown>[]) => ({
  font: 'friendly',
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

/** A post as the AI wrote it, with no pictures yet. */
async function post(
  format: 'photo' | 'carousel',
  way: 'photo' | 'design',
  network = 'instagram',
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
        title: `Frozen pipes ${randomUUID().slice(0, 4)}`,
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

/** Runs the picture job for a post, as the worker would. */
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
  const runner = `vitest-pictures-${randomUUID().slice(0, 8)}`;
  await rows(
    admin(),
    sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
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

/** The sizes of the pictures the last check was shown, each made smaller but in its own shape. */
async function checkedSizes(): Promise<number[][]> {
  const check = script.requests.filter((r) => r.system === PICTURE_CHECK_SYSTEM).at(-1)!;
  const images = (check.messages[0]!.content as Any[]).filter((c) => c.type === 'image');
  return Promise.all(
    images.map(async (i) => {
      const m = await sharp(Buffer.from(i.data, 'base64')).metadata();
      return [m.width!, m.height!];
    }),
  );
}

async function made(postId: string) {
  const [r] = await rows<{
    state: string;
    way: string;
    files: number;
    design: Any;
    failure: string;
  }>(
    admin(),
    sql`select c.picture_state as state, c.picture_way as way, cardinality(c.file_ids) as files,
          c.design, c.picture_failure as failure
        from addon_socialcontent.content c where c.record_id = ${postId}`,
  );
  const files = await rows<{ mime_type: string }>(
    admin(),
    sql`select f.mime_type from app.files f
        where f.record_id = ${postId} and f.deleted_at is null order by f.created_at`,
  );
  return { ...r!, mimes: files.map((f) => f.mime_type) };
}

beforeAll(async () => {
  s = testServices({ ai: { provider: ai } });
  owner = await createTestUser('content-pictures-owner');
  const created = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Pipe Pictures Co' },
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
}, 60_000);
afterAll(closeTestDbs);

describe('making a post’s pictures, and checking them', () => {
  it('keeps OpenAI’s whole graphic when the check passes it', async () => {
    script.designs = [design([page()])];
    script.checks = [{ passes: true, problems: [] }];
    prompts.length = 0;
    const id = await post('photo', 'photo');
    await makePictures(id);
    const m = await made(id);
    expect(m).toMatchObject({ state: 'made', way: 'photo', files: 1 });
    expect(m.mimes).toEqual(['image/jpeg']);
    expect(m.design.graphic).toEqual({ tried: true, passed: true });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"Your pipes can freeze tonight"');
    // Instagram's picture is 3:4 (the owner, 15 Nov): asked for as a portrait, and checked whole.
    expect(prompts[0]).toContain('portrait (3:4)');
    expect(squares.at(-1)).toBe(false);
    expect(m.design.shape).toBe('3:4');
    // A picture with a photo is looked at whole, at full size (the owner, 17 Nov: a bent laptop passed at half).
    expect(await checkedSizes()).toEqual([[1080, 1440]]);
    // The check was shown the picture and told the words it should say.
    const check = script.requests.filter((r) => r.system === PICTURE_CHECK_SYSTEM).at(-1)!;
    const content = check.messages[0]!.content as Any[];
    expect(content.filter((c) => c.type === 'image')).toHaveLength(1);
    expect(content.at(-1).text).toContain('Your pipes can freeze tonight');
  });

  it('draws the words over a photo on the next photo post, so the two take turns', async () => {
    script.designs = [design([page({ layout: 'framed' })])];
    script.checks = [{ passes: true, problems: [] }];
    prompts.length = 0;
    const id = await post('photo', 'photo');
    await makePictures(id);
    const m = await made(id);
    expect(m).toMatchObject({ state: 'made', way: 'photo', files: 1 });
    expect(m.design.graphic).toEqual({ tried: false, passed: false });
    expect(m.design.check).toEqual({ passes: true, problems: [] });
    expect(m.design.pages[0].layout).toBe('framed');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/No words, letters, logos/);
  });

  it('never keeps a graphic that fails the check: the words are drawn over a new photo', async () => {
    script.designs = [design([page()])];
    script.checks = [
      { passes: false, problems: ['“Freze” is misspelt'] },
      { passes: true, problems: [] },
    ];
    script.requests.length = 0;
    prompts.length = 0;
    const id = await post('photo', 'photo');
    await makePictures(id);
    const m = await made(id);
    expect(m).toMatchObject({ state: 'made', way: 'photo', files: 1 });
    expect(m.design.graphic).toEqual({
      tried: true,
      passed: false,
      problems: ['“Freze” is misspelt'],
    });
    expect(m.design.check.passes).toBe(true);
    // Two pictures from OpenAI: the graphic, then a photo with no words.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/No words, letters, logos/);
  });

  it('designs a carousel again when its check fails, telling the AI what to fix', async () => {
    const pages = [
      page({ layout: 'number', mark: '20°F', heading: 'is when pipes can freeze', kicker: '' }),
      page({ layout: 'list', heading: 'Do these', items: ['Drip the taps', 'Open the cupboards'] }),
    ];
    script.designs = [design(pages), design(pages.map((p) => ({ ...p, layout: 'clean' })))];
    script.checks = [
      { passes: false, problems: ['Words cut off at the right'] },
      { passes: true, problems: [] },
    ];
    script.requests.length = 0;
    prompts.length = 0;
    const id = await post('carousel', 'design');
    await makePictures(id);
    const m = await made(id);
    expect(m).toMatchObject({ state: 'made', way: 'design', files: 2 });
    expect(m.mimes).toEqual(['image/png', 'image/png']);
    expect(m.design.pages.map((p: Any) => p.layout)).toEqual(['clean', 'clean']);
    expect(m.design.check).toEqual({ passes: true, problems: [] });
    // Every page of an Instagram carousel is drawn 3:4.
    expect(m.design.shape).toBe('3:4');
    expect(await checkedSizes()).toEqual([
      [506, 675],
      [506, 675],
    ]);
    const asks = script.requests.filter((r) => r.system === DESIGN_SYSTEM);
    expect(asks).toHaveLength(2);
    expect(JSON.stringify(asks[0]!.messages)).not.toContain('square picture');
    expect(JSON.stringify(asks[1]!.messages)).toContain('Page 1: Words cut off at the right');
    expect(prompts).toHaveLength(0);
  });
});

describe('Instagram’s own picture shape', () => {
  it('keeps every other network’s pictures 4:5', async () => {
    script.designs = [design([page({ layout: 'framed' })])];
    script.checks = [{ passes: true, problems: [] }];
    prompts.length = 0;
    squares.length = 0;
    const id = await post('photo', 'photo', 'facebook');
    await makePictures(id);
    const m = await made(id);
    expect(m).toMatchObject({ state: 'made', way: 'photo', files: 1 });
    expect(m.design.shape).toBe('4:5');
    expect(squares).toEqual([false]);
    expect(prompts[0]).toContain('portrait (4:5)');
    expect(await checkedSizes()).toEqual([[1080, 1350]]);
  });

  it('makes again the pictures of Instagram posts not up yet that were made before they were 3:4', async () => {
    const pending = () =>
      rows<{ post_id: string; way: string }>(
        admin(),
        sql`select payload->>'postId' as post_id, payload->>'way' as way from app.scheduled_jobs
            where workspace_id = ${ws} and kind = 'socialcontent.pictures' and status = 'pending'`,
      );
    // Pictures made before (no shape in their design), on posts in every state.
    const before = async (state: string, opts: { network?: string; hidden?: boolean } = {}) => {
      const id = await post('photo', 'design', opts.network ?? 'instagram');
      await rows(
        admin(),
        sql`update addon_socialcontent.content
            set state = ${state}, picture_state = 'made', design = '{"pages":[]}'::jsonb,
                approved_at = case when ${state} in ('ready', 'posting', 'posted') then now() end,
                hidden_at = ${opts.hidden ? new Date().toISOString() : null}::timestamptz
            where record_id = ${id}`,
      );
      return id;
    };
    const draft = await before('draft');
    const okd = await before('ready');
    const up = await before('posted');
    const hidden = await before('draft', { hidden: true });
    const facebook = await before('draft', { network: 'facebook' });
    // Any post's pictures being made sets them going.
    script.designs = [design([page({ layout: 'clean' })])];
    script.checks = [{ passes: true, problems: [] }];
    const id = await post('photo', 'design');
    await makePictures(id);
    expect((await made(id)).design.shape).toBe('3:4');
    const queued = await pending();
    expect(queued.map((q) => q.post_id).sort()).toEqual([draft, okd].sort());
    expect(queued.every((q) => q.way === 'design')).toBe(true);
    for (const left of [up, hidden, facebook])
      expect(queued.some((q) => q.post_id === left)).toBe(false);
    // Made again, 3:4, they aren't queued again. The OK'd one waits for an OK again, as with Make it again. They're
    // queued a little apart, so both are brought due first.
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where workspace_id = ${ws} and kind = 'socialcontent.pictures' and status = 'pending'`,
    );
    await makePictures(draft);
    expect((await made(draft)).design.shape).toBe('3:4');
    expect((await made(okd)).design.shape).toBe('3:4');
    expect(await pending()).toEqual([]);
    const [o] = await rows<{ state: string }>(
      admin(),
      sql`select state from addon_socialcontent.content where record_id = ${okd}`,
    );
    expect(o!.state).toBe('draft');
  });
});

describe('a mistake in a photo itself', () => {
  // A carousel never tries OpenAI's whole graphic, so the first picture OpenAI makes is always the photo.
  const designAsks = () => script.requests.filter((r) => r.system === DESIGN_SYSTEM);

  it('makes the photo again, told what to avoid, under the same design', async () => {
    script.designs = [design([page(), page({ layout: 'clean', heading: 'Drip the taps' })])];
    script.checks = [
      {
        passes: false,
        problems: [],
        photoProblems: ['The phone in her hand has a blank white screen'],
      },
      { passes: true, problems: [] },
    ];
    script.requests.length = 0;
    prompts.length = 0;
    const id = await post('carousel', 'photo', 'facebook');
    await makePictures(id);
    const m = await made(id);
    expect(m).toMatchObject({ state: 'made', way: 'photo', files: 2 });
    // Two photos: the first, and one made again that's told what was wrong.
    expect(prompts).toHaveLength(2);
    for (const asked of prompts)
      expect(asked).toMatch(
        /never a blank white, grey or black screen, even if the scene above says so/,
      );
    expect(prompts[0]).not.toContain('The last photo had these problems');
    expect(prompts[1]).toContain(
      'The last photo had these problems; make sure the new one has none of them: The phone in her hand has a blank white screen',
    );
    // Only the photo was wrong, so it wasn't designed again.
    expect(designAsks()).toHaveLength(1);
    expect(m.design.check).toEqual({ passes: true, problems: [] });
    expect(m.design.checked).toBe(4);
  });

  it('designs it again for the words and makes the photo again for the photo', async () => {
    script.designs = [design([page(), page({ layout: 'clean', heading: 'Drip the taps' })])];
    script.checks = [
      {
        passes: false,
        problems: ['The heading runs off the edge'],
        photoProblems: ['Six fingers on the hand'],
      },
      { passes: true, problems: [] },
    ];
    script.requests.length = 0;
    prompts.length = 0;
    const id = await post('carousel', 'photo', 'facebook');
    await makePictures(id);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Six fingers on the hand');
    expect(prompts[1]).not.toContain('heading');
    // The design asked again is told only what a design can fix.
    const asks = designAsks();
    expect(asks).toHaveLength(2);
    const again = JSON.stringify(asks[1]!.messages);
    expect(again).toContain('The heading runs off the edge');
    expect(again).not.toContain('Six fingers');
    expect((await made(id)).design.check.passes).toBe(true);
  });

  it('tries twice more when the photo still has a mistake, then keeps the one with the fewest problems', async () => {
    script.designs = [design([page(), page({ layout: 'clean', heading: 'Drip the taps' })])];
    script.checks = [
      {
        passes: false,
        problems: [],
        photoProblems: ['Faint words show through', 'A sixth finger'],
      },
      { passes: false, problems: [], photoProblems: ['Faint words show through'] },
      { passes: true, problems: [] },
    ];
    script.requests.length = 0;
    prompts.length = 0;
    const id = await post('carousel', 'photo', 'facebook');
    await makePictures(id);
    // The photo, then two made again, each told what the last one got wrong.
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('A sixth finger');
    expect(prompts[2]).toContain('Faint words show through');
    expect(prompts[2]).not.toContain('A sixth finger');
    const m = await made(id);
    expect(m.design.check.passes).toBe(true);
    expect(m.design.checked).toBe(4);

    // Never more than two more tries: the one with the fewest problems is kept, and what it still has is kept on it.
    script.checks = [
      {
        passes: false,
        problems: [],
        photoProblems: ['Faint words show through', 'A sixth finger'],
      },
      { passes: false, problems: [], photoProblems: ['Faint words show through'] },
      { passes: false, problems: [], photoProblems: ['Faint words show through', 'Melted cup'] },
    ];
    script.requests.length = 0;
    prompts.length = 0;
    const two = await post('carousel', 'photo', 'facebook');
    await makePictures(two);
    expect(prompts).toHaveLength(3);
    const kept = (await made(two)).design.check;
    expect(kept.passes).toBe(false);
    expect(kept.photo).toEqual([
      'Page 1: Faint words show through',
      'Page 2: Faint words show through',
    ]);
  });

  it('never makes a designed picture’s photo, which it hasn’t got', async () => {
    script.designs = [design([page({ layout: 'clean' })])];
    script.checks = [
      { passes: false, problems: [], photoProblems: ['A melted coffee cup'] },
      { passes: true, problems: [] },
    ];
    script.requests.length = 0;
    prompts.length = 0;
    const id = await post('photo', 'design', 'facebook');
    await makePictures(id);
    expect(prompts).toHaveLength(0);
    // Without a photo, the design is told every problem.
    const asks = designAsks();
    expect(asks).toHaveLength(2);
    expect(JSON.stringify(asks[1]!.messages)).toContain('A melted coffee cup');
  });

  it('makes again the photos of posts not up yet that were made before the check looked for this', async () => {
    const pending = () =>
      rows<{ post_id: string; way: string }>(
        admin(),
        sql`select payload->>'postId' as post_id, payload->>'way' as way from app.scheduled_jobs
            where workspace_id = ${ws} and kind = 'socialcontent.pictures' and status = 'pending'`,
      );
    const before = async (way: 'photo' | 'design', checked: number | null, passed = true) => {
      const id = await post('photo', way, 'facebook');
      const d = {
        pages: [],
        ...(checked
          ? { checked, check: { passes: passed, problems: passed ? [] : ['Faint text'] } }
          : {}),
      };
      await rows(
        admin(),
        sql`update addon_socialcontent.content
            set picture_state = 'made', design = ${JSON.stringify(d)}::jsonb
            where record_id = ${id}`,
      );
      return id;
    };
    const old = await before('photo', null);
    const designed = await before('design', null);
    // Made under the first photo check and still failing it: made again under the stricter one (16 Nov).
    const flagged = await before('photo', 2, false);
    const current = await before('photo', 4);
    script.designs = [design([page({ layout: 'clean' })])];
    script.checks = [{ passes: true, problems: [] }];
    const id = await post('photo', 'design', 'facebook');
    await makePictures(id);
    // The photo made before and the one that failed the first check are queued to be made again; a designed picture
    // has no photo, and the other was made under this check.
    expect((await pending()).map((q) => q.post_id).sort()).toEqual([old, flagged].sort());
    expect((await pending()).every((q) => q.way === 'photo')).toBe(true);
    for (const left of [designed, current, id])
      expect((await pending()).some((q) => q.post_id === left)).toBe(false);
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where workspace_id = ${ws} and kind = 'socialcontent.pictures' and status = 'pending'`,
    );
    await makePictures(old);
    expect((await made(old)).design.checked).toBe(4);
    expect((await made(flagged)).design.checked).toBe(4);
    expect(await pending()).toEqual([]);
  });
});

describe('a photo that passed an older check', () => {
  // The owner, 17 Nov: "look at the laptop on this image. the ai should have noticed how the shape of it is all
  // wonky". Photos kept under check 3 are checked again under this one, and made again only when they fail it.
  const designAsks = () => script.requests.filter((r) => r.system === DESIGN_SYSTEM);
  const checks = () => script.requests.filter((r) => r.system === PICTURE_CHECK_SYSTEM);
  const pending = () =>
    rows<{ post_id: string; recheck: string | null }>(
      admin(),
      sql`select payload->>'postId' as post_id, payload->>'recheck' as recheck from app.scheduled_jobs
          where workspace_id = ${ws} and kind = 'socialcontent.pictures' and status = 'pending'`,
    );

  /** A photo post whose picture was made and passed, marked as made under check 3. */
  async function keptUnder3(): Promise<{ id: string; files: string[] }> {
    script.designs = [
      design([
        page({ layout: 'framed', heading: 'Just send a message' }),
        page({ layout: 'clean', heading: 'Drip the taps' }),
      ]),
    ];
    script.checks = [{ passes: true, problems: [] }];
    // A carousel never tries OpenAI's whole graphic, so its photo is drawn under the first page's words.
    const id = await post('carousel', 'photo', 'facebook');
    await makePictures(id);
    const [r] = await rows<{ file_ids: string[] }>(
      admin(),
      sql`update addon_socialcontent.content set design = jsonb_set(design, '{checked}', '3')
          where record_id = ${id} returning file_ids`,
    );
    return { id, files: r!.file_ids };
  }

  /**
   * Any post's pictures being made queues the catch-up; its jobs are then brought due and run. What making the posts
   * queued before is cleared first, so only this catch-up's jobs wait.
   */
  async function catchUp(): Promise<void> {
    await rows(
      admin(),
      sql`update app.scheduled_jobs set status = 'cancelled'
          where workspace_id = ${ws} and kind = 'socialcontent.pictures' and status = 'pending'`,
    );
    script.designs = [design([page({ layout: 'clean' })])];
    script.checks = [{ passes: true, problems: [] }];
    await makePictures(await post('photo', 'design', 'facebook'));
  }
  async function runQueued(postId: string): Promise<void> {
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where workspace_id = ${ws} and kind = 'socialcontent.pictures' and status = 'pending'`,
    );
    await makePictures(postId);
  }

  it('keeps the pictures when they pass this check, marked as checked under it', async () => {
    const { id, files } = await keptUnder3();
    await catchUp();
    expect(await pending()).toEqual([{ post_id: id, recheck: 'true' }]);
    script.checks = [{ passes: true, problems: [] }];
    script.requests.length = 0;
    prompts.length = 0;
    await runQueued(id);
    const [r] = await rows<{ file_ids: string[] }>(
      admin(),
      sql`select file_ids from addon_socialcontent.content where record_id = ${id}`,
    );
    expect(r!.file_ids).toEqual(files);
    const m = await made(id);
    expect(m.design).toMatchObject({ checked: 4, check: { passes: true, problems: [] } });
    // Only checked: no new photo, no new design. The page with the photo was looked at whole, the other at half.
    expect(prompts).toHaveLength(0);
    expect(designAsks()).toHaveLength(0);
    expect(checks()).toHaveLength(1);
    expect(await checkedSizes()).toEqual([
      [1080, 1350],
      [540, 675],
    ]);
    expect(await pending()).toEqual([]);
  });

  it('makes a new photo under the same design when the photo fails, told what was wrong', async () => {
    const { id, files } = await keptUnder3();
    await catchUp();
    script.checks = [
      {
        passes: false,
        problems: [],
        photoProblems: ['The laptop’s lid is bent and its base runs into the dashboard'],
      },
      { passes: true, problems: [] },
    ];
    script.requests.length = 0;
    prompts.length = 0;
    await runQueued(id);
    const m = await made(id);
    expect(m).toMatchObject({ state: 'made', way: 'photo', files: 2 });
    expect(m.design).toMatchObject({ checked: 4, check: { passes: true, problems: [] } });
    expect(m.design.pages[0].heading).toBe('Just send a message');
    const [r] = await rows<{ file_ids: string[] }>(
      admin(),
      sql`select file_ids from addon_socialcontent.content where record_id = ${id}`,
    );
    expect(r!.file_ids).not.toEqual(files);
    // One new photo, told what was wrong; the same design over it.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      'make sure the new one has none of them: The laptop’s lid is bent and its base runs into the dashboard',
    );
    expect(designAsks()).toHaveLength(0);
    expect(checks()).toHaveLength(2);
  });

  it('designs it again when the words fail, and leaves a picture that failed its own check to be made again', async () => {
    const { id } = await keptUnder3();
    // One that failed check 3 is made again, never only checked.
    const failed = await keptUnder3();
    await rows(
      admin(),
      sql`update addon_socialcontent.content
          set design = design || '{"check": {"passes": false, "problems": ["Faint text"]}}'::jsonb
          where record_id = ${failed.id}`,
    );
    await catchUp();
    expect((await pending()).sort((a, b) => a.post_id.localeCompare(b.post_id))).toEqual(
      [
        { post_id: id, recheck: 'true' },
        { post_id: failed.id, recheck: null },
      ].sort((a, b) => a.post_id.localeCompare(b.post_id)),
    );
    script.designs = [
      design([
        page({ layout: 'framed', heading: 'Just text it' }),
        page({ layout: 'clean', heading: 'Drip the taps' }),
      ]),
    ];
    script.checks = [
      { passes: false, problems: ['The heading is cut off at the right'] },
      { passes: true, problems: [] },
    ];
    script.requests.length = 0;
    prompts.length = 0;
    await rows(
      admin(),
      sql`update app.scheduled_jobs set status = 'cancelled'
          where workspace_id = ${ws} and kind = 'socialcontent.pictures' and status = 'pending'
            and payload->>'postId' = ${failed.id}`,
    );
    await runQueued(id);
    const m = await made(id);
    expect(m.design).toMatchObject({ checked: 4, check: { passes: true, problems: [] } });
    expect(m.design.pages[0].heading).toBe('Just text it');
    const asks = designAsks();
    expect(asks).toHaveLength(1);
    expect(JSON.stringify(asks[0]!.messages)).toContain('The heading is cut off at the right');
    expect(prompts).toHaveLength(1);
  });
});
