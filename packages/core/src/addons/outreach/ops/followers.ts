/**
 * The person's own followers on Facebook (../followers.ts, docs/outreach.md decision 113), server side: whether this
 * week's read is due, and the followers it read kept as theirs, each as a profile with no customer. Those who aren't
 * their friends are checked by the AI like friends (`outreach.checks.next`, ./checks.ts), and Today offers the good
 * fits a friend request (./today.ts). Each person's own. Server-only.
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  FOLLOWERS_EVERY_DAYS,
  FollowersNextInput,
  FollowersNextOutput,
  FollowersSaveInput,
  FollowersSaveOutput,
} from '../followers';
import { outreachAddon } from '../manifest';
import { followerReads } from '../tables';
import { inWorkspace, keptProfile, once } from './common';
import { tally } from './tallies';
import { startOfToday } from './tidy';

const DAY = 86_400_000;

export const followersNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.followers.next',
  description:
    'Whether the person’s computer reads who follows them on Facebook today: once a week, the first time and then a week after the last read.',
  input: FollowersNextInput,
  output: FollowersNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [row] = await ctx.tx
      .select({ readAt: followerReads.readAt })
      .from(followerReads)
      .where(
        and(
          eq(followerReads.workspaceId, ctx.scope.workspaceId!),
          eq(followerReads.userId, me),
          eq(followerReads.platform, input.platform),
        ),
      );
    if (!row) return { due: true };
    // By the business's days: read on a Monday, due again the next Monday whatever the hour.
    const dueFrom = (await startOfToday(ctx)).getTime() - (FOLLOWERS_EVERY_DAYS - 1) * DAY;
    return { due: new Date(row.readAt).getTime() < dueFrom };
  },
});

export const followersSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.followers.save',
  description:
    'Who follows the person on Facebook, as their computer just read their followers list, in parts: each kept as theirs, as a profile with no customer. Those who aren’t their friends are checked by the AI like friends, and the good fits go on Today for a friend request. The last part notes the week’s read done. Adds nobody to Contacts.',
  risk: 1,
  input: FollowersSaveInput,
  output: FollowersSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      const ids = new Set<string>();
      for (const person of input.people) {
        const profile = await keptProfile(
          ctx,
          { platform: input.platform, profile: person.profile, name: person.name },
          me,
          at,
        );
        ids.add(profile.id);
      }
      const list = [...ids];
      const kept = list.length
        ? await rows<{ id: string; fresh: boolean }>(
            ctx.tx,
            sql`insert into addon_outreach.followers (workspace_id, user_id, profile_id, seen_at)
                select ${ws}, ${me}, sent.u::uuid, ${at.toISOString()}::timestamptz
                from jsonb_array_elements_text(${JSON.stringify(list)}::jsonb) as sent (u)
                on conflict (workspace_id, user_id, profile_id) do update set
                  seen_at = greatest(addon_outreach.followers.seen_at, excluded.seen_at),
                  updated_at = excluded.seen_at
                returning profile_id as id, (xmax = 0) as fresh`,
          )
        : [];
      // New as a follower, and not their friend: the AI checks them like one.
      const fresh = kept.filter((k) => k.fresh).map((k) => k.id);
      const [added] = fresh.length
        ? await rows<{ n: number }>(
            ctx.tx,
            sql`select count(*)::int as n
                from jsonb_array_elements_text(${JSON.stringify(fresh)}::jsonb) as sent (u)
                where not exists (select 1 from addon_outreach.friends f
                  where f.workspace_id = ${ws} and f.user_id = ${me} and f.profile_id = sent.u::uuid
                    and f.state = 'friends')`,
          )
        : [{ n: 0 }];
      let readAt: string | null = null;
      if (input.done) {
        readAt = at.toISOString();
        await ctx.tx
          .insert(followerReads)
          .values({ workspaceId: ws, userId: me, platform: input.platform, readAt: at })
          .onConflictDoUpdate({
            target: [followerReads.workspaceId, followerReads.userId, followerReads.platform],
            set: { readAt: at, updatedAt: at },
          });
      }
      // Each follower read off the list counts (decision 140).
      await tally(ctx, me, input.platform, 'listed', list.length, at);
      return { saved: list.length, added: added?.n ?? 0, readAt };
    });
  },
});

export const followersCommands = [followersSave] as const;
export const followersQueries = [followersNext] as const;
