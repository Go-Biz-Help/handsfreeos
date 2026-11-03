/**
 * The day's goal on a network (../goal.ts, decision 126): what the reason it's short is worked out from, for Today's
 * note and the worker's pushes. Counts only, each network's own, the person's own.
 */
import { sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { FEW_ACCEPTS, goalWhy, type GoalFacts, type GoalShort } from '../goal';
import { networksOn } from '../network-words';
import { isLooking, type Platform } from '../networks';
import { automationOf, limitsFor } from './automation';
import { goalStock, knownToMe } from './checks';
import type { Ctx } from './common';
import { readinessFor } from './readiness';
import { slowsNow, warningOf } from './tidy';

const DAY = 86_400_000;

/**
 * The person's checks on a network today and in the last 7 days, and of them who fit or might; the people they know
 * there not checked yet; and their requests there in the last `FEW_ACCEPTS.days` days, and of them accepted.
 */
export async function goalFacts(
  ctx: Ctx,
  me: string,
  platform: Platform,
  todayStart: Date,
  now: number,
): Promise<GoalFacts> {
  const ws = ctx.scope.workspaceId!;
  const today = todayStart.toISOString();
  const week = new Date(now - 7 * DAY).toISOString();
  const lately = new Date(now - FEW_ACCEPTS.days * DAY).toISOString();
  const [counted] = await rows<GoalFacts>(
    ctx.tx,
    sql`select
          (select count(*)::int from addon_outreach.checks ch
            join addon_outreach.profiles p on p.id = ch.profile_id
            where ch.workspace_id = ${ws} and ch.user_id = ${me} and p.platform = ${platform}
              and ch.verdict in ('good', 'maybe', 'not') and ch.checked_at >= ${today}::timestamptz) as checked,
          (select count(*)::int from addon_outreach.checks ch
            join addon_outreach.profiles p on p.id = ch.profile_id
            where ch.workspace_id = ${ws} and ch.user_id = ${me} and p.platform = ${platform}
              and ch.verdict in ('good', 'maybe') and ch.checked_at >= ${today}::timestamptz) as fit,
          (select count(*)::int from addon_outreach.checks ch
            join addon_outreach.profiles p on p.id = ch.profile_id
            where ch.workspace_id = ${ws} and ch.user_id = ${me} and p.platform = ${platform}
              and ch.verdict in ('good', 'maybe', 'not') and ch.checked_at >= ${week}::timestamptz) as "weekChecked",
          (select count(*)::int from addon_outreach.checks ch
            join addon_outreach.profiles p on p.id = ch.profile_id
            where ch.workspace_id = ${ws} and ch.user_id = ${me} and p.platform = ${platform}
              and ch.verdict in ('good', 'maybe') and ch.checked_at >= ${week}::timestamptz) as "weekFit",
          (select count(*)::int from addon_outreach.profiles p
            left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
            where p.workspace_id = ${ws} and p.platform = ${platform} and ${knownToMe(me)}
              and (ch.id is null or ch.verdict = 'waiting' or ch.again)) as unchecked,
          (select count(distinct t.profile_id)::int from addon_outreach.touches t
            join addon_outreach.profiles p on p.id = t.profile_id
            where t.workspace_id = ${ws} and t.user_id = ${me} and p.platform = ${platform}
              and t.kind = 'friend_request' and t.at >= ${lately}::timestamptz) as sent,
          (select count(distinct t.profile_id)::int from addon_outreach.touches t
            join addon_outreach.profiles p on p.id = t.profile_id
            join addon_outreach.friends f on f.profile_id = p.id and f.user_id = ${me} and f.state = 'friends'
            where t.workspace_id = ${ws} and t.user_id = ${me} and p.platform = ${platform}
              and t.kind = 'friend_request' and t.at >= ${lately}::timestamptz) as accepted`,
  );
  return {
    checked: counted?.checked ?? 0,
    fit: counted?.fit ?? 0,
    weekChecked: counted?.weekChecked ?? 0,
    weekFit: counted?.weekFit ?? 0,
    unchecked: counted?.unchecked ?? 0,
    sent: counted?.sent ?? 0,
    accepted: counted?.accepted ?? 0,
  };
}

/**
 * The networks the person works that fell short of a day's first messages (decision 126, answer 7a), for the day's
 * report: each with how many short and why, as it stands now. The day is `from` to `to`, on the business's clock.
 */
export async function goalShorts(
  ctx: Ctx,
  me: string,
  from: Date,
  to: Date,
  now: number,
): Promise<GoalShort[]> {
  const ws = ctx.scope.workspaceId!;
  const auto = await automationOf(ctx, me, now);
  const shorts: GoalShort[] = [];
  for (const platform of networksOn(auto.settings, auto.rules.networksAllowed)) {
    if (isLooking(platform)) continue;
    const warning = await warningOf(ctx, me, platform, from, now);
    const limits = await limitsFor(ctx, me, slowsNow(warning, now), now, platform);
    const [done] = await rows<{ firsts: number; requests: number }>(
      ctx.tx,
      sql`select count(*) filter (where t.step = 'first_message')::int as firsts,
            count(*) filter (where t.kind = 'friend_request')::int as requests
          from addon_outreach.touches t
          join addon_outreach.profiles p on p.id = t.profile_id
          where t.workspace_id = ${ws} and t.user_id = ${me} and p.platform = ${platform}
            and t.at >= ${from.toISOString()}::timestamptz and t.at < ${to.toISOString()}::timestamptz`,
    );
    const short = Math.max(0, limits.first_message - (done?.firsts ?? 0));
    if (!short) continue;
    const [facts, stock, readiness] = await Promise.all([
      goalFacts(ctx, me, platform, from, now),
      goalStock(ctx, me, platform, now),
      readinessFor(ctx, me, platform),
    ]);
    const held = stock.held || (warning !== null && new Date(warning.requestsFrom).getTime() > now);
    const why = goalWhy({
      short,
      ready: readiness.ready,
      facts,
      // The day is over: what's left to check, and requests not sent, say why.
      checksRoom: 0,
      requestsHeld: held,
      requests: {
        listed: 0,
        left: held ? 0 : Math.max(0, limits.friend_request - (done?.requests ?? 0)),
      },
    });
    if (why) shorts.push({ platform, short, most: limits.first_message, why, facts });
  }
  return shorts;
}
