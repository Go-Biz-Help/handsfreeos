/**
 * A business's logo and colour (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, "Your logo and
 * colour"), kept in `workspaces.settings.look` (look/look.ts).
 *
 * - A person uploads a logo in two steps, as with files: `look.begin_upload` reserves a place in the private
 *   `brand-uploads` bucket (the database admits only that place, for that person), and `look.use_upload` hands the
 *   picture to the worker (`look.upload_ready`), which makes the PNG everyone sees and says how it went
 *   (`look.note_upload`).
 * - The website is looked at for a logo when it's saved (`saveBusiness`) and on "Look on … again" (`look.find`):
 *   `look.find_requested`, answered by `look.note_website`. A logo found there never replaces one already kept.
 * - The colour comes from the logo, or the website's own colour, until a person picks one (`look.set`); nothing
 *   found later replaces their pick. The website chat follows the colour unless someone gave it one of its own.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { chatWidgets, workspaces } from '@hfos/db/schema';
import { chatWidgetName } from '../chat/origins';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin, scopeCan } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import { LOOK_DEFAULT_COLOR } from '../look/colour';
import {
  LOOK_SETTINGS_KEY,
  LOOK_UPLOAD_BUCKET,
  LOOK_UPLOAD_MAX_BYTES,
  LOOK_UPLOAD_TYPES,
  lookOf,
  type BusinessLook,
  type LookColor,
} from '../look/look';
import { LOOK_WORDS } from '../look/words';
import {
  LookBeginUploadInput,
  LookBeginUploadOutput,
  LookFindInput,
  LookFindOutput,
  LookNoteUploadInput,
  LookNoteUploadOutput,
  LookNoteWebsiteInput,
  LookNoteWebsiteOutput,
  LookSetInput,
  LookSetOutput,
  LookUseUploadInput,
  LookUseUploadOutput,
} from '../schemas/look';
import { chatWidgetUpdate } from './chat-widget';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const businessGone =
  'That business isn’t there, or you’re no longer in it. Pick a business from your list.';

const websiteOf = (settings: Record<string, unknown>): string | null =>
  typeof settings['website'] === 'string' && settings['website'] ? settings['website'] : null;

/**
 * The business's look and website, with its row held until this command saves. A person's command reads it as
 * them; the worker's, through `private.lock_look()`, since the system only reads businesses.
 */
async function lockLook(
  ctx: CommandContext,
): Promise<{ look: BusinessLook; website: string | null }> {
  if (ctx.actor.type === 'system') {
    const [held] = await rows<{ settings: Record<string, unknown> | null }>(
      ctx.tx,
      sql`select private.lock_look() as settings`,
    );
    if (!held?.settings) throw HfosError.notFound(businessGone);
    return { look: lookOf(held.settings), website: websiteOf(held.settings) };
  }
  const [w] = await ctx.tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.scope.workspaceId!))
    .for('update');
  if (!w) throw HfosError.notFound(businessGone);
  const settings = (w.settings ?? {}) as Record<string, unknown>;
  return { look: lookOf(settings), website: websiteOf(settings) };
}

/** Keeps the look, and nothing else in the settings. */
async function keepLook(ctx: CommandContext, next: BusinessLook): Promise<void> {
  const look = JSON.stringify(next);
  if (ctx.actor.type === 'system') {
    await ctx.tx.execute(sql`select private.keep_look(${look}::jsonb)`);
    return;
  }
  const [row] = await rows<{ id: string }>(
    ctx.tx,
    sql`update app.workspaces
        set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{${LOOK_SETTINGS_KEY}}`}::text[], ${look}::jsonb, true)
        where id = ${ctx.scope.workspaceId!} returning id`,
  );
  // Row-level security lets only someone with workspace.update change a business's settings.
  if (!row) throw HfosError.forbidden(LOOK_WORDS.cantChange);
}

/**
 * The website chat follows the business's colour: each widget still in HandsFreeOS's blue, or the colour the
 * business had before, takes the new one. A widget someone gave its own colour keeps it. A person changes the chat
 * as themselves, so it follows only when they may change it; the worker does what their command would.
 */
async function chatFollows(
  ctx: CommandContext,
  before: string | null,
  after: string | null,
): Promise<void> {
  if (!after || after === before) return;
  if (ctx.actor.type === 'human' && !scopeCan(ctx.scope, 'channels.manage')) return;
  const following = [...new Set([LOOK_DEFAULT_COLOR, ...(before ? [before] : [])])];
  const widgets = await ctx.tx
    .select({
      id: chatWidgets.id,
      accentColor: chatWidgets.accentColor,
      allowedOrigins: chatWidgets.allowedOrigins,
    })
    .from(chatWidgets)
    .where(
      and(
        eq(chatWidgets.workspaceId, ctx.scope.workspaceId!),
        inArray(chatWidgets.accentColor, following),
      ),
    );
  for (const w of widgets) {
    if (ctx.actor.type === 'human') {
      await executeCommandWithin(ctx, chatWidgetUpdate, {
        workspaceId: ctx.scope.workspaceId!,
        widgetId: w.id,
        accentColor: after,
      });
      continue;
    }
    await ctx.tx.update(chatWidgets).set({ accentColor: after }).where(eq(chatWidgets.id, w.id));
    await ctx.emit({
      type: 'chat_widget.updated',
      entityType: 'chat_widget',
      entityId: w.id,
      payload: { widgetId: w.id, fields: ['accentColor'] },
      before: { accentColor: w.accentColor },
      after: { name: chatWidgetName(w.allowedOrigins), accentColor: after },
    });
  }
}

/** What changed, for the audit and the event. */
async function emitChanged(
  ctx: CommandContext,
  before: BusinessLook,
  after: BusinessLook,
  how: 'person' | 'website' | 'upload',
): Promise<void> {
  const shown = (l: BusinessLook) => ({
    logo: l.logo ? l.logo.from : null,
    color: l.color?.hex ?? null,
  });
  await ctx.emit({
    type: 'look.changed',
    entityType: 'workspace',
    entityId: ctx.scope.workspaceId!,
    payload: { how, ...shown(after), logoPath: after.logo?.path ?? null },
    before: shown(before),
    after: shown(after),
  });
}

/** The colour a logo or website found stands for, unless a person picked one. */
const foundColor = (
  look: BusinessLook,
  found: { hex: string; from: 'logo' | 'website' } | null,
  at: string,
): LookColor | null =>
  look.color?.from === 'person' || !found ? look.color : { hex: found.hex, from: found.from, at };

export const lookBeginUpload = defineCommand({
  name: 'look.begin_upload',
  description:
    'Reserve a place to upload a picture of the business’s logo (PNG, JPG, WebP, GIF or SVG, up to 5 MB). Upload it there, then hand it over with look.use_upload.',
  risk: 1,
  input: LookBeginUploadInput,
  output: LookBeginUploadOutput,
  permission: 'workspace.update',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const ending = LOOK_UPLOAD_TYPES[input.mimeType as keyof typeof LOOK_UPLOAD_TYPES];
    if (!ending)
      throw HfosError.rule(
        'look_upload_type',
        422,
        `${input.name} isn’t a picture we can use for a logo. Upload a PNG, JPG, WebP, GIF or SVG.`,
      );
    if (input.sizeBytes > LOOK_UPLOAD_MAX_BYTES)
      throw HfosError.rule(
        'look_upload_size',
        422,
        `${input.name} is over ${LOOK_UPLOAD_MAX_BYTES / (1024 * 1024)} MB. Upload a smaller picture of your logo.`,
      );
    const { look } = await lockLook(ctx);
    const objectPath = `${ctx.scope.workspaceId}/${randomUUID()}.${ending}`;
    await keepLook(ctx, {
      ...look,
      upload: {
        path: objectPath,
        name: input.name,
        by: requireHuman(ctx).userId,
        at: new Date().toISOString(),
        sent: false,
      },
    });
    return { bucket: LOOK_UPLOAD_BUCKET, objectPath };
  },
});

export const lookUseUpload = defineCommand({
  name: 'look.use_upload',
  description:
    'Hand the uploaded picture of the logo to HandsFreeOS, which makes it ready for the booking page, chat, invoices and emails, and picks its colour unless one was picked.',
  risk: 1,
  input: LookUseUploadInput,
  output: LookUseUploadOutput,
  permission: 'workspace.update',
  scope: inWorkspace,
  emits: ['look.upload_ready'],
  async handler(ctx, input) {
    const { look } = await lockLook(ctx);
    const upload = look.upload;
    if (!upload || upload.path !== input.objectPath || upload.by !== requireHuman(ctx).userId)
      throw HfosError.rule(
        'look_upload_unknown',
        409,
        'That upload isn’t the one this business is waiting for. Upload your logo again.',
      );
    if (upload.sent) return { look };
    const [info] = await rows<{ size_bytes: number | null }>(
      ctx.tx,
      sql`select size_bytes from private.storage_object_info(${LOOK_UPLOAD_BUCKET}, ${upload.path})`,
    );
    if (!info)
      throw HfosError.rule(
        'look_not_uploaded',
        409,
        `${upload.name} didn’t finish uploading. Check your connection and upload it again.`,
      );
    const next: BusinessLook = {
      ...look,
      upload: { ...upload, sent: true, at: new Date().toISOString() },
      problem: null,
    };
    await keepLook(ctx, next);
    await ctx.emit({
      type: 'look.upload_ready',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId!,
      payload: { objectPath: upload.path },
      after: { name: upload.name },
    });
    return { look: next };
  },
});

export const lookSet = defineCommand({
  name: 'look.set',
  description:
    'Change the business’s colour, or take its logo off so its initials stand in. The website chat follows the colour unless it has one of its own.',
  risk: 1,
  input: LookSetInput,
  output: LookSetOutput,
  permission: 'workspace.update',
  scope: inWorkspace,
  emits: ['look.changed'],
  async handler(ctx, input) {
    const { look } = await lockLook(ctx);
    const at = new Date().toISOString();
    const next: BusinessLook = {
      ...look,
      ...(input.color !== undefined && input.color !== look.color?.hex
        ? { color: { hex: input.color, from: 'person' as const, at } }
        : input.color !== undefined && look.color
          ? { color: { ...look.color, from: 'person' as const } }
          : {}),
      ...(input.removeLogo ? { logo: null } : {}),
    };
    const changed =
      next.color?.hex !== look.color?.hex ||
      (next.logo?.path ?? null) !== (look.logo?.path ?? null);
    if (JSON.stringify(next) === JSON.stringify(look)) return { look, changed: false };
    await keepLook(ctx, next);
    if (changed) await emitChanged(ctx, look, next, 'person');
    await chatFollows(ctx, look.color?.hex ?? null, next.color?.hex ?? null);
    return { look: next, changed };
  },
});

export const lookFind = defineCommand({
  name: 'look.find',
  description:
    'Look on the business’s website for its logo, and the colour it stands for. A logo found there never replaces one already kept.',
  risk: 1,
  input: LookFindInput,
  output: LookFindOutput,
  permission: 'workspace.update',
  scope: inWorkspace,
  emits: ['look.find_requested'],
  async handler(ctx) {
    const { look, website } = await lockLook(ctx);
    if (!website)
      throw HfosError.rule(
        'look_no_website',
        409,
        'Add your website first, in Settings → Workspace, so we know where to look for your logo.',
      );
    const next = await askForLogo(ctx, look, website);
    return { look: next, url: website };
  },
});

/**
 * Asks the worker to look on the website for a logo (`look.find_requested`), and notes when, for the screens.
 * Used by `look.find` and by saving the website (`saveBusiness`), with the business's row held.
 */
export async function askForLogo(
  ctx: CommandContext,
  look: BusinessLook,
  website: string,
): Promise<BusinessLook> {
  const next: BusinessLook = { ...look, asked: { url: website, at: new Date().toISOString() } };
  await keepLook(ctx, next);
  await ctx.emit({
    type: 'look.find_requested',
    entityType: 'workspace',
    entityId: ctx.scope.workspaceId!,
    payload: { url: website },
    after: { url: website },
  });
  return next;
}

/** The look as `saveBusiness` sees it: read with the business's row held, for `askForLogo`. */
export const lockedLook = lockLook;

export const lookNoteWebsite = defineCommand({
  name: 'look.note_website',
  description:
    'System: keep the logo found on the business’s website, made into a PNG, and the colour it stands for. A logo already kept stays, and so does a colour a person picked.',
  risk: 0,
  input: LookNoteWebsiteInput,
  output: LookNoteWebsiteOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: ['look.changed', 'look.searched', 'chat_widget.updated'],
  async handler(ctx, input) {
    const { look, website } = await lockLook(ctx);
    // The website changed (or went) while it was being looked at.
    if (website !== input.url) return { kept: false };
    const at = new Date().toISOString();
    const logo = look.logo ?? (input.logo ? { ...input.logo, from: 'website' as const, at } : null);
    const next: BusinessLook = {
      ...look,
      logo,
      // The colour follows the logo kept: the found colour only when the found logo is the one kept, or there's none.
      color:
        look.logo && input.logo && input.color?.from === 'logo'
          ? look.color
          : foundColor(look, input.color, at),
      searched: { url: input.url, at, found: input.logo !== null },
    };
    await keepLook(ctx, next);
    if (
      (next.logo?.path ?? null) !== (look.logo?.path ?? null) ||
      next.color?.hex !== look.color?.hex
    )
      await emitChanged(ctx, look, next, 'website');
    // Nothing new, but the screens waiting on the look stop waiting.
    else
      await ctx.emit({
        type: 'look.searched',
        entityType: 'workspace',
        entityId: ctx.scope.workspaceId!,
        payload: { url: input.url, found: input.logo !== null },
        after: { url: input.url },
      });
    await chatFollows(ctx, look.color?.hex ?? null, next.color?.hex ?? null);
    return { kept: input.logo !== null && next.logo?.path === input.logo.path };
  },
});

export const lookNoteUpload = defineCommand({
  name: 'look.note_upload',
  description:
    'System: keep the logo made from a picture someone uploaded, and the colour it stands for unless a person picked one; or say why the picture couldn’t be used.',
  risk: 0,
  input: LookNoteUploadInput,
  output: LookNoteUploadOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: ['look.changed', 'look.upload_refused', 'chat_widget.updated'],
  async handler(ctx, input) {
    const { look } = await lockLook(ctx);
    // Another upload since, or taken back.
    if (look.upload?.path !== input.objectPath) return { kept: false };
    const at = new Date().toISOString();
    if (!input.logo) {
      const message = input.problem ?? 'That picture couldn’t be used.';
      await keepLook(ctx, { ...look, upload: null, problem: { message, at } });
      await ctx.emit({
        type: 'look.upload_refused',
        entityType: 'workspace',
        entityId: ctx.scope.workspaceId!,
        payload: { problem: message },
        after: { name: look.upload.name },
      });
      return { kept: false };
    }
    const next: BusinessLook = {
      ...look,
      logo: { ...input.logo, from: 'upload', at },
      color: foundColor(look, input.color ? { hex: input.color, from: 'logo' } : null, at),
      upload: null,
      problem: null,
    };
    await keepLook(ctx, next);
    await emitChanged(ctx, look, next, 'upload');
    await chatFollows(ctx, look.color?.hex ?? null, next.color?.hex ?? null);
    return { kept: true };
  },
});
