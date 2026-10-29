/**
 * Whose each group and each person is (../owners.ts, docs/outreach.md decision 107): the first teammate to work a
 * group, or reach a person, is theirs (`claimGroup`, `claimProfile`); who that is, as their pages show it (`ownersOf`);
 * send.queue's refusal of outreach to someone else's person (`someoneElses`); and an owner's or admin's move
 * (`outreach.owner.move`). Server-only.
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import type { Permission } from '../../../permissions';
import { defineAddonCommand } from '../../server';
import { SEND_KINDS } from '../automation';
import { outreachAddon } from '../manifest';
import { heldForOthers, OwnerMoveInput, OwnerMoveOutput, type TeamOwner } from '../owners';
import { groups, profiles } from '../tables';
import { inWorkspace, notOthers, skipOutreachTo, type Ctx } from './common';

/**
 * A person reached by `me`: theirs, unless another teammate who uses Social Outreach reached them first. The first
 * wins, whenever it's noted.
 */
export async function claimProfile(
  ctx: CommandContext,
  me: string,
  profileId: string,
  at: Date,
): Promise<void> {
  await ctx.tx.execute(
    sql`update addon_outreach.profiles p set owner_user_id = ${me}, owned_at = ${at.toISOString()}::timestamptz
        where p.workspace_id = ${ctx.scope.workspaceId!} and p.id = ${profileId}
          and p.owner_user_id is distinct from ${me} and ${notOthers(me, 'p')}`,
  );
}

/** A group worked by `me`: a step from it, an ask to join it or a helpful post there. As `claimProfile`. */
export async function claimGroup(
  ctx: CommandContext,
  me: string,
  groupId: string | null,
  at: Date,
): Promise<void> {
  if (!groupId) return;
  await ctx.tx.execute(
    sql`update addon_outreach.groups g set owner_user_id = ${me}, owned_at = ${at.toISOString()}::timestamptz
        where g.workspace_id = ${ctx.scope.workspaceId!} and g.id = ${groupId}
          and g.owner_user_id is distinct from ${me} and ${notOthers(me, 'g')}`,
  );
}

/** The teammates who use Social Outreach here, all of them or those among `userIds`, by name. */
async function team(ctx: Ctx, me: string, userIds?: readonly string[]): Promise<TeamOwner[]> {
  // Each person's own access row is theirs alone to read: their permissions come from their membership.
  const found = await rows<{ user_id: string; name: string }>(
    ctx.tx,
    sql`select m.user_id, coalesce(nullif(btrim(u.full_name), ''), u.email::text) as name
        from app.workspace_memberships m join app.users u on u.id = m.user_id
        where m.workspace_id = ${ctx.scope.workspaceId!}
          ${userIds ? sql`and m.user_id = any (${`{${userIds.join(',')}}`}::uuid[])` : sql``}
          and 'outreach.use' = any (private.user_permissions(m.user_id, m.workspace_id))
        order by name, m.user_id`,
  );
  return found.map((f) => ({ userId: f.user_id, name: f.name, you: f.user_id === me }));
}

/**
 * The teammates among `userIds` as their pages name them, each who still uses Social Outreach here: one who doesn't
 * holds nothing, so is left out.
 */
export async function ownersOf(
  ctx: Ctx,
  me: string,
  userIds: readonly (string | null)[],
): Promise<Map<string, TeamOwner>> {
  const ids = [...new Set(userIds.filter((u): u is string => u !== null))];
  if (!ids.length) return new Map();
  return new Map((await team(ctx, me, ids)).map((t) => [t.userId, t]));
}

/** For an owner or admin (`outreach.manage`): everyone a group or person can be given to. None for anyone else. */
export async function moveTargets(ctx: Ctx, me: string): Promise<TeamOwner[]> {
  return scopeCan(ctx.scope, 'outreach.manage' as Permission) ? team(ctx, me) : [];
}

/** Another teammate's who reached this person first, when it's someone else's: send.queue refuses them outreach. */
export async function someoneElses(
  ctx: Ctx,
  me: string,
  profileId: string,
): Promise<TeamOwner | null> {
  const [p] = await ctx.tx
    .select({ owner: profiles.ownerUserId })
    .from(profiles)
    .where(and(eq(profiles.workspaceId, ctx.scope.workspaceId!), eq(profiles.id, profileId)));
  if (!p?.owner || p.owner === me) return null;
  return (await ownersOf(ctx, me, [p.owner])).get(p.owner) ?? null;
}

export const ownerMove = defineAddonCommand(outreachAddon, {
  name: 'outreach.owner.move',
  description:
    'For owners and admins: give a group, or a person reached on a social network, to another teammate who uses Social Outreach (decision 107). Their Today then has the group’s people, or the person; the teammate before no longer does, and a person’s messages from them still waiting for an OK, or OK’d and not sent, are skipped, but a reply.',
  risk: 1,
  input: OwnerMoveInput,
  output: OwnerMoveOutput,
  permission: 'outreach.manage',
  ai: {
    tool: 'outreach_move_owner',
    keywords: ['move a group to a teammate', 'give this person to', 'who works this group'],
  },
  scope: inWorkspace,
  emits: ['outreach.owner.moved', 'outreach.send.skipped'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const owner = (await ownersOf(ctx, me, [input.userId])).get(input.userId);
    if (!owner)
      throw HfosError.rule(
        'outreach_owner_not_on_team',
        422,
        'They don’t use Social Outreach here, so nothing can be moved to them. Give them Use Social Outreach in Settings → Team first.',
      );
    const table = input.kind === 'group' ? groups : profiles;
    const [had] = await ctx.tx
      .select({ owner: table.ownerUserId })
      .from(table)
      .where(and(eq(table.workspaceId, ws), eq(table.id, input.id)));
    if (!had)
      throw HfosError.notFound(
        input.kind === 'group'
          ? 'That group isn’t kept in Social Outreach any more. Go back to Groups and pick it again.'
          : 'That person isn’t kept in Social Outreach any more. Refresh the page.',
      );
    if (had.owner === owner.userId) return { kind: input.kind, id: input.id, owner, skipped: 0 };
    await ctx.tx
      .update(table)
      .set({ ownerUserId: owner.userId, ownedAt: at })
      .where(and(eq(table.workspaceId, ws), eq(table.id, input.id)));
    // The teammate before stops: their outreach to the person waiting to go is skipped, never a reply.
    const skipped =
      input.kind === 'person' && had.owner
        ? await skipOutreachTo(ctx, [input.id], SEND_KINDS.filter(heldForOthers), had.owner)
        : 0;
    await ctx.emit({
      type: 'outreach.owner.moved',
      entityType: input.kind === 'group' ? 'outreach_group' : 'outreach_profile',
      entityId: input.id,
      payload: { kind: input.kind, from: had.owner, to: owner.userId },
    });
    return { kind: input.kind, id: input.id, owner, skipped };
  },
});

export const ownerCommands = [ownerMove] as const;
