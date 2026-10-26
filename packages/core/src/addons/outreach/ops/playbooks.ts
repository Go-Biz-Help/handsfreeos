/**
 * Social Outreach's playbooks (docs/outreach.md): everyone using the add-on reads them, and owners and admins
 * (`outreach.manage`) write them. A playbook is archived rather than deleted, and can come back.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { isUniqueViolation } from '../../../kernel/pg-errors';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { outreachAddon } from '../manifest';
import {
  blankPlaybook,
  Playbook as PlaybookOut,
  followUpGapsFor,
  paceOf,
  PLAYBOOK_KEPT_KEYS,
  PlaybookArchiveInput,
  PlaybookListInput,
  PlaybookListOutput,
  PlaybookSaveInput,
  renumberQuestions,
  type PlaybookDetails,
  upgradePlaybookDetails,
} from '../playbooks';
import { playbooks } from '../tables';
import { inWorkspace, type Ctx } from './common';

const playbookOut = (p: typeof playbooks.$inferSelect): z.input<typeof PlaybookOut> => ({
  id: p.id,
  name: p.name,
  template: p.template,
  // One saved before its questions had answers reads in today's shape (data version 2).
  details: upgradePlaybookDetails(p.details) as z.input<typeof PlaybookDetails>,
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

/**
 * The parts data versions 3 and 4 added, as a save leaves them: one it leaves out keeps what's saved (or starts
 * empty), so a phone built before them never wipes them. The pace's follow-ups too.
 */
function keptParts(details: PlaybookDetails, stored: unknown): PlaybookDetails {
  const was = (upgradePlaybookDetails(stored) ?? {}) as Record<string, unknown>;
  const blank = blankPlaybook();
  const kept = Object.fromEntries(
    PLAYBOOK_KEPT_KEYS.filter((k) => details[k] === undefined).map((k) => [k, was[k] ?? blank[k]]),
  );
  const wasPace = paceOf(was['pace'] ?? blank.pace);
  const followUps = details.pace.followUps ?? wasPace.followUps;
  const pace = {
    messageAfterDays: details.pace.messageAfterDays,
    followUps,
    followUpGaps:
      details.pace.followUpGaps ??
      (wasPace.followUpGaps.length === followUps
        ? wasPace.followUpGaps
        : followUpGapsFor(followUps)),
  };
  return { ...details, ...kept, pace: { ...pace, followUpGaps: [...pace.followUpGaps] } };
}

/** Two playbooks in use never share a name. */
async function namedOnce<T>(playbookName: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (isUniqueViolation(e, 'playbooks_name_idx'))
      throw HfosError.rule(
        'outreach_playbook_name_taken',
        409,
        `There’s already a playbook called “${playbookName}”. Give this one another name.`,
      );
    throw e;
  }
}

export const playbookList = defineAddonQuery(outreachAddon, {
  name: 'outreach.playbook.list',
  description:
    'The business’s playbooks for social outreach, the ones in use first, then any archived.',
  input: PlaybookListInput,
  output: PlaybookListOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_playbooks',
    keywords: ['playbook', 'niche', 'who to reach', 'offer'],
  },
  scope: inWorkspace,
  async handler(ctx) {
    const rows = await ctx.tx
      .select()
      .from(playbooks)
      .where(eq(playbooks.workspaceId, ctx.scope.workspaceId!))
      .orderBy(asc(playbooks.createdAt));
    return {
      playbooks: [...rows.filter((p) => !p.archivedAt), ...rows.filter((p) => p.archivedAt)].map(
        playbookOut,
      ),
    };
  },
});

export const playbookSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.playbook.save',
  description:
    'Write a playbook for social outreach, or change one: its name, goal and offer, who it’s for, where to look, the steps it takes, how it sounds, the tags to use, and its short video (videoLink: a video or playlist link that someone who says yes gets before the booking link). A save sends the whole playbook: read it first with its list, and change only what the person asked.',
  risk: 1,
  input: PlaybookSaveInput,
  output: PlaybookOut,
  permission: 'outreach.manage',
  ai: {
    tool: 'outreach_save_playbook',
    autonomy: 'confirm',
    keywords: ['write a playbook', 'change a playbook', 'new playbook'],
  },
  scope: inWorkspace,
  emits: ['outreach.playbook.saved'],
  async handler(ctx, input) {
    const me = userIdOf(ctx.actor);
    const at = changeMoment(ctx.meta);
    // Its questions keep short names however often they come and go.
    const details = { ...input.details, questions: renumberQuestions(input.details.questions) };
    const saved = await namedOnce(input.name, async () => {
      if (input.playbookId) {
        const was = await loadPlaybook(ctx, input.playbookId);
        const [p] = await ctx.tx
          .update(playbooks)
          .set({
            name: input.name,
            details: keptParts(details, was.details),
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
          name: input.name,
          template: input.template ?? null,
          details: keptParts(details, null),
          createdBy: me,
          updatedBy: me,
        })
        .returning();
      return p!;
    });
    await ctx.emit({
      type: 'outreach.playbook.saved',
      entityType: 'outreach_playbook',
      entityId: saved.id,
      payload: { name: saved.name, created: !input.playbookId },
    });
    return playbookOut(saved);
  },
});

export const playbookArchive = defineAddonCommand(outreachAddon, {
  name: 'outreach.playbook.archive',
  description: 'Put a playbook away, or bring an archived one back.',
  risk: 1,
  input: PlaybookArchiveInput,
  output: PlaybookOut,
  permission: 'outreach.manage',
  ai: {
    tool: 'outreach_archive_playbook',
    autonomy: 'confirm',
    keywords: ['archive playbook', 'restore playbook'],
  },
  scope: inWorkspace,
  emits: ['outreach.playbook.archived'],
  async handler(ctx, input) {
    const was = await loadPlaybook(ctx, input.playbookId);
    if (Boolean(was.archivedAt) === input.archived) return playbookOut(was);
    const me = userIdOf(ctx.actor);
    const saved = await namedOnce(was.name, async () => {
      const [p] = await ctx.tx
        .update(playbooks)
        .set(
          input.archived
            ? { archivedAt: changeMoment(ctx.meta), archivedBy: me }
            : { archivedAt: null, archivedBy: null },
        )
        .where(
          and(eq(playbooks.id, was.id), input.archived ? isNull(playbooks.archivedAt) : undefined),
        )
        .returning();
      return p ?? was;
    });
    await ctx.emit({
      type: 'outreach.playbook.archived',
      entityType: 'outreach_playbook',
      entityId: saved.id,
      payload: { name: saved.name, archived: input.archived },
    });
    return playbookOut(saved);
  },
});

export const playbookCommands = [playbookSave, playbookArchive] as const;
export const playbookQueries = [playbookList] as const;
