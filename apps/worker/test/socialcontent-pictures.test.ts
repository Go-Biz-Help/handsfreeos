/**
 * AI Social Media Content Creator's picture job (apps/worker/src/addons/socialcontent/content.ts, `runPictures`;
 * docs/socialcontent.md, "Variety", decisions 39 and 40), against the local database with a stand-in AI and image
 * model: OpenAI's whole graphic kept when the check passes it, the next photo post's words drawn over a photo, a
 * graphic that fails the check swapped for a photo with drawn words, and a drawn design that fails designed again.
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
  checks: [] as { passes: boolean; problems: string[] }[],
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

/** The stand-in image model: a plain picture, and every prompt it was asked. */
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
async function post(format: 'photo' | 'carousel', way: 'photo' | 'design'): Promise<string> {
  const { output } = await executeCommand(
    testDbs().worker.db,
    op('socialcontent.content.put'),
    {
      workspaceId: ws,
      network: 'instagram',
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
    const asks = script.requests.filter((r) => r.system === DESIGN_SYSTEM);
    expect(asks).toHaveLength(2);
    expect(JSON.stringify(asks[1]!.messages)).toContain('Page 1: Words cut off at the right');
    expect(prompts).toHaveLength(0);
  });
});
