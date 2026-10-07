/**
 * The business's logo and colour on the local database (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md
 * §4, "Your logo and colour"):
 * - **Uploading** reserves a place for that person's picture, hands it to the worker once it's there, and the
 *   worker keeps the logo it made and the colour it stands for, or says why the picture couldn't be used.
 * - **The website** is looked at for a logo once it's saved, and on "Look on … again"; a logo found there never
 *   replaces one kept, and nothing found replaces a colour a person picked.
 * - **The colour** is a person's pick, and the website chat follows it unless it was given its own.
 * - It's for those who may change the business; the settings key is the look commands' own.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta, SystemActor } from '../src/kernel/types';
import { LOOK_DEFAULT_COLOR, lookOf, type BusinessLook } from '../src/look/index';
import {
  chatWidgetCreate,
  chatWidgetUpdate,
  lookBeginUpload,
  lookFind,
  lookNoteUpload,
  lookNoteWebsite,
  lookSet,
  lookUseUpload,
  onboardingSetupGet,
  onboardingSetupSave,
  organizationCreate,
  workspaceUpdate,
} from '../src/server';
import { executeQuery } from '../src/kernel/execute';

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

const lookIn = async (workspaceId: string): Promise<BusinessLook> => {
  const [w] = await rows<{ settings: Record<string, unknown> }>(
    admin(),
    sql`select settings from app.workspaces where id = ${workspaceId}`,
  );
  return lookOf(w!.settings);
};
const eventCount = async (workspaceId: string, type: string) => {
  const [r] = await rows<{ n: number }>(
    admin(),
    sql`select count(*)::int as n from app.events where workspace_id = ${workspaceId} and event_type = ${type}`,
  );
  return r!.n;
};
/** Stands in for the browser's upload: the object as Storage records it. */
const putObject = (path: string, size = 2048, mimetype = 'image/png') =>
  rows(
    admin(),
    sql`insert into storage.objects (bucket_id, name, metadata)
        values ('brand-uploads', ${path}, ${JSON.stringify({ size, mimetype })}::jsonb)`,
  );

let dale: TestUser;
let marco: TestUser;
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
const madeLogo = () => ({ path: `${ws}/logo/${randomUUID()}.png`, width: 600, height: 180 });

beforeAll(async () => {
  [dale, marco] = await Promise.all([
    createTestUser('look-owner', { fullName: 'Dale Owner' }),
    createTestUser('look-member', { fullName: 'Marco Member' }),
  ]);
  ws = (
    await run(organizationCreate, { businessName: 'Look Plumbing', industry: 'plumbing' }, dale)
  ).workspaceId;
  const [w] = await rows<{ organizationId: string }>(
    admin(),
    sql`select organization_id as "organizationId" from app.workspaces where id = ${ws}`,
  );
  org = w!.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${marco.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

describe('uploading a logo', () => {
  it('takes only a picture, and not too big a one', async () => {
    await expectHfos(
      () =>
        run(
          lookBeginUpload,
          { workspaceId: ws, name: 'logo.pdf', mimeType: 'application/pdf', sizeBytes: 100 },
          dale,
        ),
      'rule_violation',
      'look_upload_type',
    );
    const big = await expectHfos(
      () =>
        run(
          lookBeginUpload,
          { workspaceId: ws, name: 'logo.png', mimeType: 'image/png', sizeBytes: 6 * 1024 * 1024 },
          dale,
        ),
      'rule_violation',
      'look_upload_size',
    );
    expect(big.message).toBe('logo.png is over 5 MB. Upload a smaller picture of your logo.');
  });

  it('is for those who may change the business', async () => {
    await expectHfos(
      () =>
        run(
          lookBeginUpload,
          { workspaceId: ws, name: 'logo.png', mimeType: 'image/png', sizeBytes: 100 },
          marco,
        ),
      'forbidden',
    );
  });

  it('reserves a place, hands the picture over once it’s there, and keeps the logo the worker made', async () => {
    const begun = await run(
      lookBeginUpload,
      { workspaceId: ws, name: 'Logo Final.png', mimeType: 'image/png', sizeBytes: 2048 },
      dale,
    );
    expect(begun.bucket).toBe('brand-uploads');
    expect(begun.objectPath.startsWith(`${ws}/`)).toBe(true);
    expect((await lookIn(ws)).upload).toMatchObject({
      path: begun.objectPath,
      name: 'Logo Final.png',
      by: dale.id,
      sent: false,
    });

    // Nothing there yet, and not someone else's place.
    await expectHfos(
      () => run(lookUseUpload, { workspaceId: ws, objectPath: begun.objectPath }, dale),
      'rule_violation',
      'look_not_uploaded',
    );
    await expectHfos(
      () => run(lookUseUpload, { workspaceId: ws, objectPath: `${ws}/${randomUUID()}.png` }, dale),
      'rule_violation',
      'look_upload_unknown',
    );

    await putObject(begun.objectPath);
    const used = await run(lookUseUpload, { workspaceId: ws, objectPath: begun.objectPath }, dale);
    expect(used.look.upload?.sent).toBe(true);
    expect(await eventCount(ws, 'look.upload_ready')).toBe(1);
    // Twice is once.
    await run(lookUseUpload, { workspaceId: ws, objectPath: begun.objectPath }, dale);
    expect(await eventCount(ws, 'look.upload_ready')).toBe(1);

    // The worker made it: the logo is kept, and the colour it stands for.
    const logo = madeLogo();
    expect(
      await asWorker(lookNoteUpload, {
        workspaceId: ws,
        objectPath: begun.objectPath,
        logo,
        color: '#b42318',
        problem: null,
      }),
    ).toEqual({ kept: true });
    const look = await lookIn(ws);
    expect(look.logo).toMatchObject({ ...logo, from: 'upload' });
    expect(look.color).toMatchObject({ hex: '#b42318', from: 'logo' });
    expect(look.upload).toBeNull();
    expect(await eventCount(ws, 'look.changed')).toBe(1);

    // Late news about the same picture changes nothing.
    expect(
      await asWorker(lookNoteUpload, {
        workspaceId: ws,
        objectPath: begun.objectPath,
        logo: madeLogo(),
        color: '#2d69d8',
        problem: null,
      }),
    ).toEqual({ kept: false });
    expect((await lookIn(ws)).logo?.path).toBe(logo.path);
  });

  it('says why a picture couldn’t be used, and keeps the logo there was', async () => {
    const before = await lookIn(ws);
    const begun = await run(
      lookBeginUpload,
      { workspaceId: ws, name: 'tiny.gif', mimeType: 'image/gif', sizeBytes: 90 },
      dale,
    );
    await putObject(begun.objectPath, 90, 'image/gif');
    await run(lookUseUpload, { workspaceId: ws, objectPath: begun.objectPath }, dale);
    await asWorker(lookNoteUpload, {
      workspaceId: ws,
      objectPath: begun.objectPath,
      logo: null,
      color: null,
      problem: 'That logo is too small to look sharp. Upload one at least 64 pixels across.',
    });
    const look = await lookIn(ws);
    expect(look.problem?.message).toContain('too small');
    expect(look.upload).toBeNull();
    expect(look.logo).toEqual(before.logo);
    // The screens waiting on it hear that it's over.
    expect(await eventCount(ws, 'look.upload_refused')).toBe(1);
  });
});

describe('the colour', () => {
  it('is a person’s pick, which nothing found later replaces', async () => {
    const r = await run(lookSet, { workspaceId: ws, color: '#0E7490' }, dale);
    expect(r).toMatchObject({ changed: true, look: { color: { hex: '#0e7490', from: 'person' } } });
    expect((await run(lookSet, { workspaceId: ws, color: '#0e7490' }, dale)).changed).toBe(false);

    const begun = await run(
      lookBeginUpload,
      { workspaceId: ws, name: 'new.png', mimeType: 'image/png', sizeBytes: 2048 },
      dale,
    );
    await putObject(begun.objectPath);
    await run(lookUseUpload, { workspaceId: ws, objectPath: begun.objectPath }, dale);
    await asWorker(lookNoteUpload, {
      workspaceId: ws,
      objectPath: begun.objectPath,
      logo: madeLogo(),
      color: '#008743',
      problem: null,
    });
    expect((await lookIn(ws)).color).toMatchObject({ hex: '#0e7490', from: 'person' });
  });

  it('is for those who may change the business, and its key is the look commands’ own', async () => {
    await expectHfos(() => run(lookSet, { workspaceId: ws, color: '#191d25' }, marco), 'forbidden');
    await expectHfos(
      () =>
        run(
          workspaceUpdate,
          { workspaceId: ws, settings: { look: { color: { hex: '#000000' } } } },
          dale,
        ),
      'validation',
    );
  });

  it('takes the logo off, so the initials stand in', async () => {
    const r = await run(lookSet, { workspaceId: ws, removeLogo: true }, dale);
    expect(r.changed).toBe(true);
    expect((await lookIn(ws)).logo).toBeNull();
  });
});

describe('the website chat', () => {
  it('starts in the business’s colour, and follows it unless it was given its own', async () => {
    const r = await run(
      organizationCreate,
      { businessName: 'Chat Colours', industry: 'plumbing' },
      dale,
    );
    const biz = r.workspaceId;
    const blue = await run(
      chatWidgetCreate,
      { workspaceId: biz, allowedOrigins: ['https://blue.example'] },
      dale,
    );
    const own = await run(
      chatWidgetCreate,
      { workspaceId: biz, allowedOrigins: ['https://own.example'], accentColor: '#7c3aed' },
      dale,
    );
    const accent = async (widgetId: string) => {
      const [w] = await rows<{ accent: string }>(
        admin(),
        sql`select accent_color as accent from app.chat_widgets where id = ${widgetId}`,
      );
      return w!.accent;
    };
    expect(await accent(blue.widgetId)).toBe(LOOK_DEFAULT_COLOR);

    await run(lookSet, { workspaceId: biz, color: '#b42318' }, dale);
    expect(await accent(blue.widgetId)).toBe('#b42318');
    expect(await accent(own.widgetId)).toBe('#7c3aed');
    await run(lookSet, { workspaceId: biz, color: '#008743' }, dale);
    expect(await accent(blue.widgetId)).toBe('#008743');

    // Someone picks the chat its own colour: it keeps it.
    await run(
      chatWidgetUpdate,
      { workspaceId: biz, widgetId: blue.widgetId, accentColor: '#191d25' },
      dale,
    );
    await run(lookSet, { workspaceId: biz, color: '#0e7490' }, dale);
    expect(await accent(blue.widgetId)).toBe('#191d25');

    const later = await run(
      chatWidgetCreate,
      { workspaceId: biz, allowedOrigins: ['https://later.example'] },
      dale,
    );
    expect(await accent(later.widgetId)).toBe('#0e7490');
  });
});

describe('the website', () => {
  // As saving the website keeps it.
  const SITE = 'https://sitelook.example/';
  let biz: string;
  let bizOrg: string;
  const sys = (): SystemActor => ({ type: 'system', workspaceId: biz, organizationId: bizOrg });
  const note = (input: Record<string, unknown>) =>
    executeCommand(worker(), lookNoteWebsite, { workspaceId: biz, ...input }, sys(), {
      ...meta(),
      channel: 'worker',
    }).then((r) => r.output);

  beforeAll(async () => {
    biz = (await run(organizationCreate, { businessName: 'Site Look', industry: 'hvac' }, dale))
      .workspaceId;
    const [w] = await rows<{ organizationId: string }>(
      admin(),
      sql`select organization_id as "organizationId" from app.workspaces where id = ${biz}`,
    );
    bizOrg = w!.organizationId;
  });

  it('is looked at for a logo once it’s saved, and not again while that look is fresh', async () => {
    await expectHfos(
      () => run(lookFind, { workspaceId: biz }, dale),
      'rule_violation',
      'look_no_website',
    );
    const { answers } = await executeQuery(
      api(),
      onboardingSetupGet,
      { workspaceId: biz },
      human(dale),
      meta(),
    );
    const save = () =>
      run(
        onboardingSetupSave,
        {
          workspaceId: biz,
          screen: 'business',
          answers,
          business: { website: 'sitelook.example' },
        },
        dale,
      );
    await save();
    expect(await eventCount(biz, 'look.find_requested')).toBe(1);
    const [event] = await rows<{ payload: { url: string } }>(
      admin(),
      sql`select payload from app.events where workspace_id = ${biz} and event_type = 'look.find_requested'`,
    );
    expect(event!.payload.url).toBe(SITE);
    await save();
    expect(await eventCount(biz, 'look.find_requested')).toBe(1);

    // "Look on sitelook.example again" asks whenever someone presses it.
    const found = await run(lookFind, { workspaceId: biz }, dale);
    expect(found.url).toBe(SITE);
    expect(await eventCount(biz, 'look.find_requested')).toBe(2);
  });

  it('keeps the logo found there, and the colour it stands for', async () => {
    const logo = { path: `${biz}/logo/${randomUUID()}.png`, width: 512, height: 512 };
    // About a website it no longer has: nothing kept.
    expect(
      await note({ url: 'https://old.example', logo, color: { hex: '#b42318', from: 'logo' } }),
    ).toEqual({ kept: false });
    expect((await lookIn(biz)).logo).toBeNull();

    expect(
      await note({
        url: SITE,
        logo,
        color: { hex: '#b42318', from: 'logo' },
      }),
    ).toEqual({ kept: true });
    const look = await lookIn(biz);
    expect(look.logo).toMatchObject({ ...logo, from: 'website' });
    expect(look.color).toMatchObject({ hex: '#b42318', from: 'logo' });
    expect(look.searched).toMatchObject({ url: SITE, found: true });
  });

  it('never replaces a logo kept, nor a colour someone picked', async () => {
    const kept = (await lookIn(biz)).logo!;
    expect(
      await note({
        url: SITE,
        logo: { path: `${biz}/logo/${randomUUID()}.png`, width: 64, height: 64 },
        color: { hex: '#008743', from: 'logo' },
      }),
    ).toEqual({ kept: false });
    const look = await lookIn(biz);
    expect(look.logo).toEqual(kept);
    expect(look.color?.hex).toBe('#b42318');

    await run(lookSet, { workspaceId: biz, removeLogo: true, color: '#7c3aed' }, dale);
    await note({
      url: SITE,
      logo: null,
      color: { hex: '#2d69d8', from: 'website' },
    });
    const after = await lookIn(biz);
    expect(after.color).toMatchObject({ hex: '#7c3aed', from: 'person' });
    expect(after.searched).toMatchObject({ found: false });
    // Nothing new, but the screens waiting on the look hear that it's over.
    expect(await eventCount(biz, 'look.searched')).toBe(2);
  });

  it('is looked at again when Settings gives the business a new website, while it has no logo', async () => {
    const other = (
      await run(organizationCreate, { businessName: 'Settings Look', industry: 'hvac' }, dale)
    ).workspaceId;
    const update = (website: string) =>
      run(workspaceUpdate, { workspaceId: other, settings: { website } }, dale);
    await update('https://settingslook.example/');
    expect(await eventCount(other, 'look.find_requested')).toBe(1);
    expect((await lookIn(other)).asked).toMatchObject({ url: 'https://settingslook.example/' });
    // The same address again asks nothing more.
    await run(workspaceUpdate, { workspaceId: other, name: 'Settings Look Co' }, dale);
    expect(await eventCount(other, 'look.find_requested')).toBe(1);
  });

  it('is the worker’s to note, never a person’s', async () => {
    await expectHfos(
      () => run(lookNoteWebsite, { workspaceId: biz, url: SITE, logo: null, color: null }, dale),
      'forbidden',
    );
  });
});
