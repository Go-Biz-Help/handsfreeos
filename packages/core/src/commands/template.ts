/**
 * The wording a business reuses: making it, changing it, filing it away, and counting what gets used.
 *
 * Archiving rather than deleting, because a template that has been used is part of why a message reads as
 * it does, and a business that tidies up on a Friday should not lose the reason for last Tuesday's text.
 */
import { and, eq, sql } from 'drizzle-orm';
import { messageTemplates } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  TemplateArchiveInput,
  TemplateArchiveOutput,
  TemplateCreateInput,
  TemplateCreateOutput,
  TemplateUpdateInput,
  TemplateUpdateOutput,
  TemplateUsedInput,
  TemplateUsedOutput,
} from '../schemas/template';

/** A name already in use, said as a conflict rather than as a database error. */
const nameTaken = (name: string) =>
  new HfosError('conflict', 409, `You already have a template called "${name}".`, {}, 'duplicate');

export const templateCreate = defineCommand({
  name: 'template.create',
  description:
    'Save wording to reuse: a name, whether it is a text or an email, and the words, with the same {{placeholders}} a workflow uses.',
  risk: 1,
  input: TemplateCreateInput,
  output: TemplateCreateOutput,
  permission: 'templates.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['template.created'],
  actors: ['human', 'system'],
  offline: 'anytime',
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [taken] = await ctx.tx
      .select({ id: messageTemplates.id })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.workspaceId, workspaceId),
          sql`lower(btrim(${messageTemplates.name})) = lower(btrim(${input.name}))`,
          sql`${messageTemplates.archivedAt} is null`,
        ),
      );
    if (taken) throw nameTaken(input.name);
    const [row] = await ctx.tx
      .insert(messageTemplates)
      .values({
        workspaceId,
        name: input.name,
        channel: input.channel,
        subject: input.channel === 'email' ? (input.subject ?? null) : null,
        body: input.body,
        folder: input.folder ?? null,
        createdBy: userIdOf(ctx.actor),
      })
      .returning({ id: messageTemplates.id });
    await ctx.emit({
      type: 'template.created',
      entityType: 'template',
      entityId: row!.id,
      payload: { name: input.name, channel: input.channel },
    });
    return { templateId: row!.id };
  },
});

export const templateUpdate = defineCommand({
  name: 'template.update',
  description: 'Change a saved piece of wording: its name, its words, or which folder it sits in.',
  risk: 1,
  input: TemplateUpdateInput,
  output: TemplateUpdateOutput,
  permission: 'templates.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['template.updated'],
  actors: ['human', 'system'],
  offline: 'anytime',
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.id, input.templateId),
          eq(messageTemplates.workspaceId, workspaceId),
        ),
      );
    if (!current) throw HfosError.notFound('That template is not here.');
    if (input.name && input.name.toLowerCase() !== current.name.toLowerCase()) {
      const [taken] = await ctx.tx
        .select({ id: messageTemplates.id })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.workspaceId, workspaceId),
            sql`lower(btrim(${messageTemplates.name})) = lower(btrim(${input.name}))`,
            sql`${messageTemplates.archivedAt} is null`,
          ),
        );
      if (taken) throw nameTaken(input.name);
    }
    const channel = input.channel ?? current.channel;
    const subject = input.subject === undefined ? current.subject : input.subject;
    await ctx.tx
      .update(messageTemplates)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.channel === undefined ? {} : { channel: input.channel }),
        // Turning an email into a text drops the subject rather than keeping something unsendable.
        subject: channel === 'email' ? subject : null,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.folder === undefined ? {} : { folder: input.folder }),
      })
      .where(eq(messageTemplates.id, input.templateId));
    await ctx.emit({
      type: 'template.updated',
      entityType: 'template',
      entityId: input.templateId,
      payload: { name: input.name ?? current.name },
    });
    return { templateId: input.templateId };
  },
});

export const templateArchive = defineCommand({
  name: 'template.archive',
  description: 'Put a piece of wording away, or bring it back. Nothing is deleted.',
  risk: 1,
  input: TemplateArchiveInput,
  output: TemplateArchiveOutput,
  permission: 'templates.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['template.archived'],
  actors: ['human', 'system'],
  offline: 'anytime',
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.id, input.templateId),
          eq(messageTemplates.workspaceId, workspaceId),
        ),
      );
    if (!current) throw HfosError.notFound('That template is not here.');
    if (input.restore) {
      const [taken] = await ctx.tx
        .select({ id: messageTemplates.id })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.workspaceId, workspaceId),
            sql`lower(btrim(${messageTemplates.name})) = lower(btrim(${current.name}))`,
            sql`${messageTemplates.archivedAt} is null`,
          ),
        );
      if (taken) throw nameTaken(current.name);
    }
    await ctx.tx
      .update(messageTemplates)
      .set({ archivedAt: input.restore ? null : new Date() })
      .where(eq(messageTemplates.id, input.templateId));
    await ctx.emit({
      type: 'template.archived',
      entityType: 'template',
      entityId: input.templateId,
      payload: { name: current.name, restored: input.restore },
    });
    return { templateId: input.templateId, archived: !input.restore };
  },
});

export const templateUsed = defineCommand({
  name: 'template.used',
  description:
    'Somebody reached for a template. Counted so the picker puts what this business actually says at the top.',
  risk: 0,
  input: TemplateUsedInput,
  output: TemplateUsedOutput,
  // Using wording is not managing it: anyone who can send a message can reach for one.
  permission: 'inbox.use',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: [],
  actors: ['human', 'system'],
  offline: 'anytime',
  async handler(ctx, input) {
    /**
     * Through the database's own function, not a plain update.
     *
     * The person reaching for wording is usually not the person who decides what the business says, and
     * row-level security has no way to say "this one may change only these two columns". The function is
     * that sentence: it checks the caller can use this business's inbox, and the only thing it can do is
     * add one to the count.
     */
    const result = await ctx.tx.execute(
      sql`select private.template_used(${ctx.scope.workspaceId!}::uuid, ${input.templateId}::uuid)
            as used_count`,
    );
    const [row] = Array.from(result as unknown as Iterable<{ used_count: number | null }>);
    if (row?.used_count === null || row?.used_count === undefined)
      throw HfosError.notFound('That template is not here.');
    return { templateId: input.templateId, usedCount: Number(row.used_count) };
  },
});

export const templateCommands = [
  templateCreate,
  templateUpdate,
  templateArchive,
  templateUsed,
] as const;
