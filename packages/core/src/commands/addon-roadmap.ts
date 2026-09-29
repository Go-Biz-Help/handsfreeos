/**
 * Voting on what's next (0109, docs/addon-architecture.md): a business voting for a planned add-on and taking the vote
 * back, a person setting Home's note aside, and the team choosing the pick for a week that closed with nothing voted
 * for or a tie.
 *
 * The owner's decisions (2026-09-28): one vote per business, on as many planned add-ons as it likes, cast by its
 * owners and admins (`addons.manage`); a vote counts until the add-on is picked, and after that it stays where it
 * is, because it's how the business hears the news. Only planned add-ons still in the race take votes; the catalogue
 * is code, so that is checked here, and the database checks the rest (who, and that it isn't picked).
 *
 * Nothing here sends an email. The team's choice is written down and the worker tells the businesses that voted,
 * as it does for a week's winner (apps/worker/src/addons/roadmap.ts).
 *
 * Made by a factory over a catalogue, like the lifecycle commands, so the tests can use a made-up one.
 */
import { rows, sql } from '@hfos/db/client';
import { findAddon, type Catalog } from '../addons/graph';
import { loadOverrides } from '../addons/load';
import { addonsInRace } from '../addons/roadmap';
import { loadPicks } from '../addons/roadmap-load';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  AddonNewsSeenInput,
  AddonNewsSeenOutput,
  AddonPickChooseInput,
  AddonPickChooseOutput,
  AddonVoteInput,
  AddonVoteOutput,
} from '../schemas/addon';

async function votesOf(ctx: CommandContext, addonId: string): Promise<number> {
  const [row] = await rows<{ votes: number }>(
    ctx.tx,
    sql`select votes from platform.addon_vote_counts where addon_id = ${addonId}`,
  );
  return Number(row?.votes ?? 0);
}

/** The voting commands, over a catalogue. */
export function addonRoadmapCommands(catalog: Catalog) {
  const scope = (i: { workspaceId: string }) => ({
    kind: 'workspace' as const,
    workspaceId: i.workspaceId,
  });

  /** The add-on, if it's still up for a vote; otherwise why not, in words. */
  async function inRace(ctx: CommandContext, addonId: string) {
    const m = findAddon(catalog, addonId);
    if (!m) throw HfosError.notFound('There is no such add-on.');
    const [overrides, picks] = await Promise.all([loadOverrides(ctx.tx), loadPicks(ctx.tx)]);
    const picked = new Set(picks.map((p) => p.addonId));
    if (picked.has(m.id))
      throw HfosError.rule(
        'addon_vote_closed',
        409,
        `${m.name} is already coming soon, so voting on it has closed.`,
      );
    if (!addonsInRace(catalog, overrides, picked).includes(m.id))
      throw HfosError.rule('addon_not_votable', 409, `${m.name} isn’t up for a vote.`);
    return m;
  }

  const vote = defineCommand({
    name: 'addon.vote',
    description:
      'Vote for a planned add-on for this business: one vote per business on each add-on it wants. Every Sunday at midnight Eastern, the one with the most votes becomes Coming soon.',
    risk: 1,
    input: AddonVoteInput,
    output: AddonVoteOutput,
    permission: 'addons.manage',
    scope,
    emits: ['addon.voted'],
    async handler(ctx, input) {
      const m = await inRace(ctx, input.addonId);
      const cast = await rows<{ addon_id: string }>(
        ctx.tx,
        sql`insert into platform.addon_votes (addon_id, workspace_id, voted_by)
            values (${m.id}, ${ctx.scope.workspaceId}::uuid, ${requireHuman(ctx).userId}::uuid)
            on conflict (addon_id, workspace_id) do nothing
            returning addon_id`,
      );
      // A second press, or a teammate's, is the same vote: nothing to record.
      if (cast.length)
        await ctx.emit({ type: 'addon.voted', entityType: 'addon', payload: { addonId: m.id } });
      return { addonId: m.id, voted: true, votes: await votesOf(ctx, m.id) };
    },
  });

  const unvote = defineCommand({
    name: 'addon.unvote',
    description: 'Take back this business’s vote for a planned add-on.',
    risk: 1,
    input: AddonVoteInput,
    output: AddonVoteOutput,
    permission: 'addons.manage',
    scope,
    emits: ['addon.unvoted'],
    async handler(ctx, input) {
      const m = await inRace(ctx, input.addonId);
      const taken = await rows<{ addon_id: string }>(
        ctx.tx,
        sql`delete from platform.addon_votes
            where addon_id = ${m.id} and workspace_id = ${ctx.scope.workspaceId}::uuid
            returning addon_id`,
      );
      if (taken.length)
        await ctx.emit({ type: 'addon.unvoted', entityType: 'addon', payload: { addonId: m.id } });
      return { addonId: m.id, voted: false, votes: await votesOf(ctx, m.id) };
    },
  });

  const markNewsSeen = defineCommand({
    name: 'addon.mark_news_seen',
    description:
      'Set aside Home’s note that an add-on this business voted for is coming soon, or ready to add.',
    risk: 0,
    input: AddonNewsSeenInput,
    output: AddonNewsSeenOutput,
    permission: 'workspace.read',
    scope,
    emits: [],
    async handler(ctx, input) {
      const [pick] = await rows<{ addon_id: string }>(
        ctx.tx,
        sql`select addon_id from platform.addon_picks where addon_id = ${input.addonId}`,
      );
      if (!pick) throw HfosError.notFound('There is no such add-on news.');
      // Row security keeps it to the person's own.
      await rows(
        ctx.tx,
        sql`insert into platform.addon_news_seen (user_id, addon_id, kind)
            values (${requireHuman(ctx).userId}::uuid, ${input.addonId}, ${input.kind})
            on conflict do nothing`,
      );
      return { addonId: input.addonId, kind: input.kind, seen: true as const };
    },
  });

  const choosePick = defineCommand({
    name: 'addon_pick.choose',
    description:
      'Choose what comes next for a week that closed with nothing voted for or a tie: it becomes Coming soon, and the businesses that voted for it are told.',
    risk: 2,
    input: AddonPickChooseInput,
    output: AddonPickChooseOutput,
    permission: 'platform.addons.manage',
    scope: () => ({ kind: 'platform' as const }),
    emits: ['platform.addon_picked'],
    async handler(ctx, input) {
      const m = await inRace(ctx, input.addonId);
      // Who may, the week, the tie and whether it's taken are the database's to check.
      await rows(ctx.tx, sql`select private.choose_addon_pick(${input.weekId}::uuid, ${m.id})`);
      await ctx.emit({
        type: 'platform.addon_picked',
        entityType: 'addon',
        payload: { addonId: m.id, weekId: input.weekId, how: 'team' },
      });
      return { weekId: input.weekId, addonId: m.id };
    },
  });

  return { vote, unvote, markNewsSeen, choosePick };
}
