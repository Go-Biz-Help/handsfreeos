/**
 * Sales Coach's playbooks (docs/salescoach.md): everyone it coaches reads them, owners and admins
 * (`salescoach.manage`) write them. A call uses the one for how it started, else the usual one; a playbook is archived
 * rather than deleted, and can come back.
 */
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { isUniqueViolation } from '../../../kernel/pg-errors';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  playbookArchiveCard,
  playbookArchiveOutcome,
  playbookSaveCard,
  playbookSaveOutcome,
  playbooksAnswer,
} from '../ai-answers';
import { salescoachAddon } from '../manifest';
import {
  changedPlaybook,
  Playbook as PlaybookOut,
  PlaybookArchiveInput,
  PlaybookDetails,
  PlaybookListInput,
  PlaybookListOutput,
  PlaybookSaveInput,
} from '../playbooks';
import { playbooks } from '../tables';

export const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type Ctx = CommandContext | QueryContext;

export const playbookOut = (p: typeof playbooks.$inferSelect): PlaybookOut => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  isDefault: p.isDefault,
  details: PlaybookDetails.parse(p.details),
  archivedAt: p.archivedAt?.toISOString() ?? null,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

async function loadPlaybook(ctx: Ctx, playbookId: string) {
  const [p] = await ctx.tx
    .select()
    .from(playbooks)
    .where(and(eq(playbooks.id, playbookId), eq(playbooks.workspaceId, ctx.scope.workspaceId!)));
  if (!p)
    throw HfosError.notFound(
      'That playbook isn’t there anymore. Refresh the page to see the ones there are.',
    );
  return p;
}

/** Two playbooks in use never share a name. */
async function namedOnce<T>(playbookName: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (isUniqueViolation(e, 'playbooks_name_idx'))
      throw HfosError.rule(
        'salescoach_playbook_name_taken',
        409,
        `There’s already a playbook called “${playbookName}”. Give this one another name.`,
      );
    throw e;
  }
}

/** Makes `id` the usual playbook: whichever was before stops being it. */
async function makeDefault(ctx: CommandContext, id: string): Promise<void> {
  await ctx.tx
    .update(playbooks)
    .set({ isDefault: false })
    .where(
      and(
        eq(playbooks.workspaceId, ctx.scope.workspaceId!),
        eq(playbooks.isDefault, true),
        ne(playbooks.id, id),
      ),
    );
  await ctx.tx.update(playbooks).set({ isDefault: true }).where(eq(playbooks.id, id));
}

async function hasDefault(ctx: CommandContext): Promise<boolean> {
  const [d] = await ctx.tx
    .select({ id: playbooks.id })
    .from(playbooks)
    .where(and(eq(playbooks.workspaceId, ctx.scope.workspaceId!), eq(playbooks.isDefault, true)));
  return !!d;
}

export const playbookList = defineAddonQuery(salescoachAddon, {
  name: 'salescoach.playbook.list',
  description:
    'The business’s sales playbooks (script steps, objections with their answers, talking points): the usual one first, then the rest in use, then any archived; or one by its id.',
  input: PlaybookListInput,
  output: PlaybookListOutput,
  permission: 'salescoach.use',
  scope: inWorkspace,
  ai: {
    tool: 'salescoach_list_playbooks',
    description:
      'The business’s sales playbooks, each with the kind of call it’s for and whether it’s the usual one: the steps of a sales call, the objections customers raise with the business’s answers, and talking points. A call uses the playbook for how it started (a booked call, a new lead, an older lead or a cold call), else the usual one. When there are too many to read whole, each comes in brief; pass playbookId to read one whole, its steps, objections and talking points each a list of its own.',
    answer: playbooksAnswer,
  },
  async handler(ctx, input) {
    const all = await ctx.tx
      .select()
      .from(playbooks)
      .where(
        and(
          eq(playbooks.workspaceId, ctx.scope.workspaceId!),
          input.playbookId ? eq(playbooks.id, input.playbookId) : undefined,
        ),
      )
      .orderBy(asc(playbooks.createdAt));
    const inUse = all.filter((p) => !p.archivedAt);
    return {
      playbooks: [
        ...inUse.filter((p) => p.isDefault),
        ...inUse.filter((p) => !p.isDefault),
        ...all.filter((p) => p.archivedAt),
      ].map(playbookOut),
    };
  },
});

export const playbookSave = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.playbook.save',
  description:
    'Write a sales playbook, or change one: its name, the kind of call it’s for, its script steps, the objections with their answers and its talking points. A call uses the playbook for how it started (a booked call, a new lead, an older lead or a cold call), else the usual one; the first one saved is the usual one until another is marked. On a change, whatever is left out stays as it is: pass only the name, the kind, or the lists of details that change (a list given replaces that list whole), or only isDefault to make it the usual one.',
  risk: 1,
  input: PlaybookSaveInput,
  output: PlaybookOut,
  permission: 'salescoach.manage',
  ai: {
    tool: 'salescoach_playbook_save',
    autonomy: 'confirm',
    card: playbookSaveCard,
    outcome: playbookSaveOutcome,
  },
  scope: inWorkspace,
  emits: ['salescoach.playbook.saved'],
  async handler(ctx, input) {
    const me = userIdOf(ctx.actor);
    const at = changeMoment(ctx.meta);
    const was = input.playbookId ? await loadPlaybook(ctx, input.playbookId) : null;
    const name = input.name ?? was?.name ?? '';
    const saved = await namedOnce(name, async () => {
      if (was) {
        if (was.archivedAt)
          throw HfosError.rule(
            'salescoach_playbook_archived',
            409,
            `“${was.name}” is archived. Bring it back first, then change it.`,
          );
        // What isn't given stays as it is: its name, its kind, and each list of its details.
        const [p] = await ctx.tx
          .update(playbooks)
          .set({
            name,
            kind: input.kind ?? was.kind,
            details: changedPlaybook(PlaybookDetails.parse(was.details), input.details),
            updatedBy: me,
            updatedAt: at,
          })
          .where(eq(playbooks.id, was.id))
          .returning();
        return p!;
      }
      const [p] = await ctx.tx
        .insert(playbooks)
        .values({
          workspaceId: ctx.scope.workspaceId!,
          name,
          kind: input.kind ?? 'any',
          details: changedPlaybook(null, input.details),
          createdBy: me,
          updatedBy: me,
        })
        .returning();
      return p!;
    });
    // The first playbook is the usual one; after that, only when asked.
    if (input.isDefault || (!saved.isDefault && !(await hasDefault(ctx))))
      await makeDefault(ctx, saved.id);
    const now = await loadPlaybook(ctx, saved.id);
    await ctx.emit({
      type: 'salescoach.playbook.saved',
      entityType: 'salescoach_playbook',
      entityId: now.id,
      payload: { name: now.name, created: !input.playbookId, isDefault: now.isDefault },
    });
    return playbookOut(now);
  },
});

export const playbookArchive = defineAddonCommand(salescoachAddon, {
  name: 'salescoach.playbook.archive',
  description:
    'Put a sales playbook away, or bring an archived one back. Putting the usual one away makes the next one in use the usual one.',
  risk: 1,
  input: PlaybookArchiveInput,
  output: PlaybookOut,
  permission: 'salescoach.manage',
  ai: {
    tool: 'salescoach_playbook_archive',
    autonomy: 'confirm',
    card: playbookArchiveCard,
    outcome: playbookArchiveOutcome,
  },
  scope: inWorkspace,
  emits: ['salescoach.playbook.archived'],
  async handler(ctx, input) {
    const was = await loadPlaybook(ctx, input.playbookId);
    if (Boolean(was.archivedAt) === input.archived) return playbookOut(was);
    const me = userIdOf(ctx.actor);
    await namedOnce(was.name, () =>
      ctx.tx
        .update(playbooks)
        .set(
          input.archived
            ? { archivedAt: changeMoment(ctx.meta), archivedBy: me, isDefault: false }
            : { archivedAt: null, archivedBy: null },
        )
        .where(eq(playbooks.id, was.id)),
    );
    if (!(await hasDefault(ctx))) {
      const [next] = await ctx.tx
        .select({ id: playbooks.id })
        .from(playbooks)
        .where(and(eq(playbooks.workspaceId, ctx.scope.workspaceId!), isNull(playbooks.archivedAt)))
        .orderBy(asc(playbooks.createdAt))
        .limit(1);
      if (next) await makeDefault(ctx, next.id);
    }
    const now = await loadPlaybook(ctx, was.id);
    await ctx.emit({
      type: 'salescoach.playbook.archived',
      entityType: 'salescoach_playbook',
      entityId: now.id,
      payload: { name: now.name, archived: input.archived },
    });
    return playbookOut(now);
  },
});

export const playbookCommands = [playbookSave, playbookArchive] as const;
export const playbookQueries = [playbookList] as const;
