/**
 * Lead intake settings (M14, channels.manage: owners and admins).
 *
 * Every way a lead arrives is a row in app.intake_sources. A channel — text, call, email — has one row per
 * business, and one that nobody has touched has no row at all and runs on the defaults, so this writes the
 * row the first time anything about it changes. A form on the business's own website, or a service sending
 * leads over, is a row of its own with a key, and there may be as many as they like.
 *
 * A form's key is public: it sits in the page's HTML, and what keeps it safe is the list of sites it may be
 * posted from. A connected app's key is secret: it is shown once, here, and kept only as its hash, so a lost
 * one is replaced rather than looked up.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, sql as dsql } from 'drizzle-orm';
import { intakeSources, pipelineStages, pipelines } from '@hfos/db/schema';
import { normalizeChatOrigins } from '../chat/origins';
import { INTAKE_NAMES, intakeSourceOf, type IntakeSource } from '../crm/intake';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  IntakeSourceArchiveOutput,
  IntakeSourceCreateInput,
  IntakeSourceCreateOutput,
  IntakeSourceKeyOutput,
  IntakeSourceRefInput,
  IntakeSourceUpdateInput,
  IntakeSourceUpdateOutput,
} from '../schemas/intake';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Every column but the secret hash, which nobody but the worker may read (the grants in 0082). */
export const READABLE = {
  id: intakeSources.id,
  workspaceId: intakeSources.workspaceId,
  kind: intakeSources.kind,
  name: intakeSources.name,
  active: intakeSources.active,
  createLead: intakeSources.createLead,
  pipelineId: intakeSources.pipelineId,
  stageId: intakeSources.stageId,
  dailyCap: intakeSources.dailyCap,
  dayCount: intakeSources.dayCount,
  dayOn: intakeSources.dayOn,
  lastIntakeAt: intakeSources.lastIntakeAt,
  publicKey: intakeSources.publicKey,
  secretHint: intakeSources.secretHint,
  allowedOrigins: intakeSources.allowedOrigins,
  redirectUrl: intakeSources.redirectUrl,
  lastUsedAt: intakeSources.lastUsedAt,
  archivedAt: intakeSources.archivedAt,
} as const;

/** A connected app's key: `hfos_` and 32 characters. Shown once; only its hash is kept. */
function newSecret(): { secret: string; hash: Buffer; hint: string } {
  const secret = `hfos_${randomBytes(24).toString('base64url')}`;
  return {
    secret,
    hash: createHash('sha256').update(secret).digest(),
    hint: secret.slice(-4),
  };
}

/** The typed sites as exact origins with their www twins, or a validation error on each refused one. */
function originsOrThrow(typed: readonly string[]): string[] {
  const { origins, issues } = normalizeChatOrigins(typed);
  if (issues.length)
    throw HfosError.validation(
      issues.map((i) => ({
        path: i.index === null ? 'allowedOrigins' : `allowedOrigins.${i.index}`,
        message: i.message,
      })),
    );
  return origins;
}

/** Where a form's sender is taken afterwards: a page of their own, over https. */
function redirectOrThrow(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  if (!/^https:\/\/[^\s]+$/i.test(trimmed))
    throw HfosError.validation([
      { path: 'redirectUrl', message: 'Give a web address starting https://.' },
    ]);
  return trimmed;
}

/** The pipeline and stage a source points at: the business's own, the stage in that pipeline. */
async function targetOrThrow(
  ctx: CommandContext,
  pipelineId: string | null,
  stageId: string | null | undefined,
): Promise<{ pipelineId: string | null; stageId: string | null }> {
  if (!pipelineId) return { pipelineId: null, stageId: null };
  const ws = ctx.scope.workspaceId!;
  const [pipeline] = await ctx.tx
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(
      and(
        eq(pipelines.id, pipelineId),
        eq(pipelines.workspaceId, ws),
        isNull(pipelines.archivedAt),
      ),
    );
  if (!pipeline)
    throw HfosError.validation([{ path: 'pipelineId', message: 'Pick one of your pipelines.' }]);
  if (stageId) {
    const [stage] = await ctx.tx
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)));
    if (!stage)
      throw HfosError.validation([{ path: 'stageId', message: 'Pick a stage in that pipeline.' }]);
    return { pipelineId, stageId };
  }
  // A pipeline on its own lands its leads where a lead starts: its first open stage.
  const [first] = await ctx.tx
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelineStages.kind, 'open')))
    .orderBy(asc(pipelineStages.position))
    .limit(1);
  if (!first)
    throw HfosError.validation([
      {
        path: 'pipelineId',
        message:
          'That pipeline has no open stage to put a lead in. Add one in Settings → Pipelines, or pick another pipeline.',
      },
    ]);
  return { pipelineId, stageId: first.id };
}

/** The row a form or a connected app is, or a refusal: a key names one source and no other business's. */
async function keyedOrThrow(ctx: CommandContext, sourceId: string) {
  const [row] = await ctx.tx
    .select(READABLE)
    .from(intakeSources)
    .where(
      and(eq(intakeSources.id, sourceId), eq(intakeSources.workspaceId, ctx.scope.workspaceId!)),
    );
  if (!row)
    throw HfosError.notFound(
      'That form or key isn’t there anymore. It may have been deleted. Refresh and try again.',
    );
  if (row.kind !== 'website_form' && row.kind !== 'api')
    throw HfosError.validation([
      { path: 'sourceId', message: 'That is a channel; name it with kind instead.' },
    ]);
  return row;
}

export const intakeSourceCreate = defineCommand({
  name: 'intake_source.create',
  description:
    'Add a way for leads to arrive from outside: a form on the business’s own website (returns a public key for the page, and the sites it may be posted from), or a connected app like Zapier (returns a secret key, shown this once).',
  risk: 2,
  input: IntakeSourceCreateInput,
  output: IntakeSourceCreateOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['intake_source.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const form = input.kind === 'website_form';
    if (!form && (input.allowedOrigins.length || input.redirectUrl))
      throw HfosError.validation([
        { path: 'allowedOrigins', message: 'Sites and a thank-you page belong to a website form.' },
      ]);
    const allowedOrigins = form ? originsOrThrow(input.allowedOrigins) : [];
    const redirectUrl = form ? redirectOrThrow(input.redirectUrl) : null;
    const target = await targetOrThrow(ctx, input.pipelineId ?? null, input.stageId);
    const key = form ? null : newSecret();
    const [row] = await ctx.tx
      .insert(intakeSources)
      .values({
        workspaceId: ws,
        kind: input.kind,
        name: input.name,
        createLead: input.createLead,
        pipelineId: target.pipelineId,
        stageId: target.stageId,
        dailyCap: input.dailyCap,
        allowedOrigins,
        redirectUrl,
        ...(form
          ? { publicKey: dsql<string>`private.new_intake_key()` }
          : { secretHash: key!.hash, secretHint: key!.hint }),
        createdBy: userIdOf(ctx.actor),
      })
      .returning({ id: intakeSources.id, publicKey: intakeSources.publicKey });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'intake_source.created',
      entityType: 'intake_source',
      entityId: row.id,
      payload: { kind: input.kind, sourceId: row.id },
      after: {
        name: input.name,
        kind: INTAKE_NAMES[input.kind],
        ...(form ? { sites: allowedOrigins.join(', ') } : {}),
      },
    });
    return {
      sourceId: row.id,
      publicKey: row.publicKey,
      secret: key?.secret ?? null,
      allowedOrigins,
    };
  },
});

export const intakeSourceUpdate = defineCommand({
  name: 'intake_source.update',
  description:
    'Change how leads arrive: whether a channel, a website form or a connected app opens a customer and a lead, what that lead is filed under, which pipeline and stage it lands in, how many a day, and — for a form — the sites it may be posted from and where its sender goes afterwards. Only the fields sent change.',
  risk: 2,
  input: IntakeSourceUpdateInput,
  output: IntakeSourceUpdateOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['intake_source.updated'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    if (!!input.kind === !!input.sourceId)
      throw HfosError.validation([
        {
          path: 'kind',
          message: input.kind
            ? 'Name either a channel or a form or key, not both.'
            : 'Name the channel, or the form or key, to change.',
        },
      ]);
    const keyed = input.sourceId ? await keyedOrThrow(ctx, input.sourceId) : null;
    const current: IntakeSource & { allowedOrigins: string[]; redirectUrl: string | null } = keyed
      ? {
          id: keyed.id,
          kind: keyed.kind,
          name: keyed.name,
          active: keyed.active,
          createLead: keyed.createLead,
          pipelineId: keyed.pipelineId,
          stageId: keyed.stageId,
          dailyCap: keyed.dailyCap,
          allowedOrigins: keyed.allowedOrigins,
          redirectUrl: keyed.redirectUrl,
        }
      : {
          ...(await intakeSourceOf(ctx.tx, ws, input.kind!)),
          allowedOrigins: [],
          redirectUrl: null,
        };
    const form = current.kind === 'website_form';
    if (!form && (input.allowedOrigins || input.redirectUrl !== undefined))
      throw HfosError.validation([
        { path: 'allowedOrigins', message: 'Sites and a thank-you page belong to a website form.' },
      ]);
    const target =
      input.pipelineId !== undefined || input.stageId !== undefined
        ? await targetOrThrow(
            ctx,
            input.pipelineId === undefined ? current.pipelineId : input.pipelineId,
            input.stageId,
          )
        : null;
    const origins = input.allowedOrigins ? originsOrThrow(input.allowedOrigins) : null;
    const next = {
      name: input.name ?? current.name,
      active: input.active ?? current.active,
      createLead: input.createLead ?? current.createLead,
      pipelineId: target ? target.pipelineId : current.pipelineId,
      stageId: target ? target.stageId : current.stageId,
      dailyCap: input.dailyCap ?? current.dailyCap,
      ...(form
        ? {
            allowedOrigins: origins ?? current.allowedOrigins,
            redirectUrl:
              input.redirectUrl === undefined
                ? current.redirectUrl
                : redirectOrThrow(input.redirectUrl),
          }
        : {}),
    };
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const updated = (Object.keys(next) as (keyof typeof next)[]).filter(
      (k) => !same(next[k], current[k as keyof typeof current]),
    );
    const listed = form ? next.allowedOrigins! : [];
    if (updated.length === 0)
      return { kind: current.kind, sourceId: current.id, updated: [], allowedOrigins: listed };

    if (current.id)
      await ctx.tx.update(intakeSources).set(next).where(eq(intakeSources.id, current.id));
    else
      await ctx.tx.insert(intakeSources).values({
        workspaceId: ws,
        kind: input.kind!,
        ...next,
        createdBy: userIdOf(ctx.actor),
      });

    await ctx.emit({
      type: 'intake_source.updated',
      entityType: 'intake_source',
      entityId: current.id ?? ws,
      payload: { kind: current.kind, sourceId: current.id, updated },
      before: Object.fromEntries(updated.map((k) => [k, current[k as keyof typeof current]])),
      after: {
        channel: keyed ? keyed.name : INTAKE_NAMES[current.kind],
        ...Object.fromEntries(updated.map((k) => [k, next[k]])),
      },
    });
    return { kind: current.kind, sourceId: current.id, updated, allowedOrigins: listed };
  },
});

export const intakeSourceRotateKey = defineCommand({
  name: 'intake_source.rotate_key',
  description:
    'Give a website form a new public key, or a connected app a new secret key. Every copy of the old one stops working at once — the form on the site needs the new key pasted in, and the app needs its key changed.',
  risk: 3,
  input: IntakeSourceRefInput,
  output: IntakeSourceKeyOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['intake_source.key_rotated'],
  async handler(ctx, input) {
    const row = await keyedOrThrow(ctx, input.sourceId);
    if (row.kind === 'website_form') {
      const [next] = await ctx.tx
        .update(intakeSources)
        .set({ publicKey: dsql`private.new_intake_key()` })
        .where(eq(intakeSources.id, row.id))
        .returning({ publicKey: intakeSources.publicKey });
      await ctx.emit({
        type: 'intake_source.key_rotated',
        entityType: 'intake_source',
        entityId: row.id,
        payload: { sourceId: row.id, kind: row.kind },
        after: { name: row.name, key: 'new' },
      });
      return { sourceId: row.id, publicKey: next!.publicKey, secret: null };
    }
    const key = newSecret();
    await ctx.tx
      .update(intakeSources)
      .set({ secretHash: key.hash, secretHint: key.hint })
      .where(eq(intakeSources.id, row.id));
    await ctx.emit({
      type: 'intake_source.key_rotated',
      entityType: 'intake_source',
      entityId: row.id,
      payload: { sourceId: row.id, kind: row.kind },
      after: { name: row.name, key: 'new' },
    });
    return { sourceId: row.id, publicKey: null, secret: key.secret };
  },
});

export const intakeSourceArchive = defineCommand({
  name: 'intake_source.archive',
  description:
    'Retire a website form or a connected app. Its key stops working and nothing more arrives through it; the customers and leads it opened stay where they are.',
  risk: 2,
  input: IntakeSourceRefInput,
  output: IntakeSourceArchiveOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['intake_source.archived'],
  async handler(ctx, input) {
    const row = await keyedOrThrow(ctx, input.sourceId);
    if (row.archivedAt) return { sourceId: row.id, archived: true };
    await ctx.tx
      .update(intakeSources)
      .set({ archivedAt: new Date(), archivedBy: userIdOf(ctx.actor) })
      .where(eq(intakeSources.id, row.id));
    await ctx.emit({
      type: 'intake_source.archived',
      entityType: 'intake_source',
      entityId: row.id,
      payload: { sourceId: row.id, kind: row.kind },
      after: { name: row.name },
    });
    return { sourceId: row.id, archived: true };
  },
});
