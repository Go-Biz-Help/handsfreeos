/**
 * Social Outreach's playbooks (docs/outreach.md): everyone using the add-on reads them, and owners and admins
 * (`outreach.manage`) write them. A playbook is archived rather than deleted, and can come back. The AI writes each
 * network's own words on a customers' playbook once (`outreach.playbook.words`, decision 92), never over the
 * person's.
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
  FIND_WORDS_PARTS,
  forPartners,
  Playbook as PlaybookOut,
  PlaybookDetails as PlaybookDetailsSchema,
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
  WORDS_PLATFORM_KEYS,
  type WordsPlatform,
} from '../playbooks';
import { hashtagOf } from '../posts';
import { playbooks } from '../tables';
import { cleanFindWords, PlaybookWordsInput, PlaybookWordsOutput, wordsDue } from '../topics';
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

/** The networks whose words the AI has written, as saved (data version 8): the server's alone to change. */
export function wordsWrittenOf(stored: unknown): WordsPlatform[] {
  const was = (upgradePlaybookDetails(stored) ?? {}) as Record<string, unknown>;
  const written = Array.isArray(was['wordsWritten']) ? (was['wordsWritten'] as unknown[]) : [];
  return WORDS_PLATFORM_KEYS.filter((p) => written.includes(p));
}

/**
 * The parts data versions 3 to 8 added, as a save leaves them: one it leaves out keeps what's saved (or starts
 * empty), so a phone built before them never wipes them. The pace's follow-ups too. Which networks' words the AI has
 * written is never the save's to say: it keeps what's saved (`outreach.playbook.words` changes it).
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
  return {
    ...details,
    ...kept,
    wordsWritten: wordsWrittenOf(stored),
    pace: { ...pace, followUpGaps: [...pace.followUpGaps] },
  };
}

/**
 * A playbook's hashtags as people tag them (data version 8), each once: "#Austin Plumbing!" is austinplumbing. One
 * that makes no hashtag is refused, saying which.
 */
function cleanHashtags(details: PlaybookDetails): PlaybookDetails {
  if (!details.hashtags) return details;
  const tags: string[] = [];
  for (const line of details.hashtags) {
    const tag = hashtagOf(line);
    if (!tag)
      throw HfosError.rule(
        'outreach_playbook_hashtag',
        422,
        `“${line}” isn’t a hashtag anyone tags. Write a hashtag as people tag it, like austinroofing, under Hashtags on Instagram.`,
      );
    if (!tags.includes(tag)) tags.push(tag);
  }
  return { ...details, hashtags: tags };
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
    // Its questions keep short names however often they come and go, and its hashtags are as people tag them.
    const details = cleanHashtags({
      ...input.details,
      questions: renumberQuestions(input.details.questions),
    });
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

export const playbookWords = defineAddonCommand(outreachAddon, {
  name: 'outreach.playbook.words',
  description:
    'Worker: the AI’s words for each network a customers’ playbook runs on: hashtags to look at on Instagram, phrases to search LinkedIn’s posts with, and kinds of business to search for on Alignable, with whether the business works with these clients online. A list is filled only while it’s empty and the AI hasn’t written it before, so the person’s own words, and a list they emptied, stay as they are; works online only while nobody has said.',
  risk: 0,
  input: PlaybookWordsInput,
  output: PlaybookWordsOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  // Never `outreach.playbook.saved`: that is what asks for the words, so the AI's writing can't ask again.
  emits: ['outreach.playbook.words_written'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [was] = await ctx.tx
      .select()
      .from(playbooks)
      .where(and(eq(playbooks.id, input.playbookId), eq(playbooks.workspaceId, ws)))
      .for('update');
    if (!was)
      throw HfosError.notFound(
        'That playbook isn’t there anymore. Refresh the page to see the ones there are.',
      );
    const read = PlaybookDetailsSchema.safeParse(upgradePlaybookDetails(was.details));
    // One that doesn't read as a playbook now is left for the person to save again.
    if (!read.success) return { written: [], worksOnline: null };
    const d = read.data;
    if (forPartners(d))
      throw HfosError.rule(
        'outreach_playbook_partner_words',
        409,
        `“${was.name}” is a partner playbook, so it has no hashtags, post searches or kinds of business of its own: its partner searches go with its words for groups.`,
      );
    const unchanged = { written: [], worksOnline: d.worksOnline ?? null };
    if (was.archivedAt) return unchanged;
    // Only a list still empty that the AI hasn't written, on a network the playbook runs on.
    const written: WordsPlatform[] = [];
    const lists: Partial<Record<(typeof FIND_WORDS_PARTS)[WordsPlatform], string[]>> = {};
    for (const platform of wordsDue(d).networks) {
      const part = FIND_WORDS_PARTS[platform];
      const lines = cleanFindWords(platform, input[part] ?? []);
      if (!lines.length) continue;
      lists[part] = lines;
      written.push(platform);
    }
    const online =
      (d.worksOnline ?? null) === null && input.worksOnline !== undefined
        ? input.worksOnline
        : null;
    if (!written.length && online === null) return unchanged;
    const details: PlaybookDetails = {
      ...d,
      ...lists,
      worksOnline: online ?? d.worksOnline ?? null,
      wordsWritten: WORDS_PLATFORM_KEYS.filter(
        (p) => (d.wordsWritten ?? []).includes(p) || written.includes(p),
      ),
    };
    await ctx.tx
      .update(playbooks)
      .set({ details, updatedAt: changeMoment(ctx.meta) })
      .where(eq(playbooks.id, was.id));
    await ctx.emit({
      type: 'outreach.playbook.words_written',
      entityType: 'outreach_playbook',
      entityId: was.id,
      payload: { name: was.name, written, worksOnline: online },
    });
    return { written, worksOnline: details.worksOnline ?? null };
  },
});

export const playbookCommands = [playbookSave, playbookArchive, playbookWords] as const;
export const playbookQueries = [playbookList] as const;
