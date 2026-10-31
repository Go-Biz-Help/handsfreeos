/**
 * What the extension does, counted, and the ticker's watch (../tallies.ts, decision 140). Server-only.
 *
 * - `tally`: each save the extension sends that says it did something adds to the person's count for the business's
 *   day, the network and the kind, in the save's own transaction, so a save that's refused counts nothing.
 * - `outreach.counts`: the counts for today, this week or this month, the person's own or, for owners and admins,
 *   the team's all together and person by person.
 * - `outreach.ticker`: what the ticker shows: the computer that works, its line, and today's newest steps.
 * - `outreach.live.watch`: a ticker is on screen. For the next minute and a half each of the person's computers has
 *   its line passed on every few seconds (`watched` on the beat's answer), and the first watch tells the extension at
 *   once over the live channel, so it speeds up without waiting for its minute's beat.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { workspaceTimezone } from '../../../crm/records';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { businessDay } from '../automation';
import { outreachAddon } from '../manifest';
import type { Platform } from '../networks';
import {
  countPeriodStart,
  CountsInput,
  CountsOutput,
  LiveWatchInput,
  LiveWatchOutput,
  TICKER_STEPS,
  TickerInput,
  TickerOutput,
  WATCH_SECONDS,
  type TallyCount,
  type TallyKind,
} from '../tallies';
import { computers, liveSteps, tallies } from '../tables';
import { inWorkspace, seesEveryone, type Ctx } from './common';
import { businessToday } from './day';
import { myComputers, shown, workingOf } from './live';
import { startOfToday } from './tidy';

/** The business's time zone, looked up once a transaction: a save may count more than one thing. */
const zones = new WeakMap<object, Promise<string>>();
function zoneOf(ctx: Ctx): Promise<string> {
  let zone = zones.get(ctx.tx);
  if (!zone) {
    zone = workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
    zones.set(ctx.tx, zone);
  }
  return zone;
}

/**
 * Adds `n` to the person's count of a kind on a network, for the business's day the thing was done on (`at`, the
 * save's own moment unless said). Nothing for 0. Called by each save that says the extension did something.
 */
export async function tally(
  ctx: Ctx,
  userId: string,
  platform: Platform,
  kind: TallyKind,
  n = 1,
  at: Date = changeMoment(ctx.meta),
): Promise<void> {
  if (!Number.isFinite(n) || n <= 0) return;
  const day = businessDay(at.getTime(), await zoneOf(ctx));
  await ctx.tx
    .insert(tallies)
    .values({
      workspaceId: ctx.scope.workspaceId!,
      userId,
      day,
      platform,
      kind,
      n: Math.round(n),
    })
    .onConflictDoUpdate({
      target: [tallies.workspaceId, tallies.userId, tallies.day, tallies.platform, tallies.kind],
      set: { n: sql`${tallies.n} + excluded.n`, updatedAt: sql`now()` },
    });
}

/** Several counts of one save, each only when above 0. */
export async function tallyAll(
  ctx: Ctx,
  userId: string,
  platform: Platform,
  counts: Partial<Record<TallyKind, number>>,
  at?: Date,
): Promise<void> {
  for (const [kind, n] of Object.entries(counts) as [TallyKind, number][])
    await tally(ctx, userId, platform, kind, n, at);
}

export const counts = defineAddonQuery(outreachAddon, {
  name: 'outreach.counts',
  description:
    'How many of each thing the person’s browser extension did on its own today, this week (from Monday) or this month (from the 1st), on each social network: friend requests, likes, comments and messages sent, profiles, posts and chats looked at, new people found, groups looked at and joined, old requests cancelled, messages drafted and more. Counting started the day it went live. Owners and admins can see the whole team’s, all together and person by person.',
  input: CountsInput,
  output: CountsOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_counts',
    keywords: [
      'how many profiles',
      'what has the extension done',
      'activity counter',
      'this week',
      'this month',
      'posts read',
    ],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person has outreach of their own.');
    const ws = ctx.scope.workspaceId!;
    if (input.everyone && !(await seesEveryone(ctx, me)))
      throw HfosError.forbidden(
        'Only owners and admins (Run Social Outreach) see the whole team’s counts. Yours are under You.',
        'outreach_counts_everyone',
      );
    const timezone = await zoneOf(ctx);
    const today = businessDay(Date.now(), timezone);
    const from = countPeriodStart(input.period, today);
    const whose = input.everyone ? sql`true` : sql`t.user_id = ${me}`;
    const found = await rows<{ user_id: string; platform: Platform; kind: TallyKind; n: number }>(
      ctx.tx,
      sql`select t.user_id, t.platform, t.kind, sum(t.n)::int as n
          from addon_outreach.tallies t
          where t.workspace_id = ${ws} and t.day >= ${from}::date and t.day <= ${today}::date
            and ${whose}
          group by t.user_id, t.platform, t.kind`,
    );
    const [first] = await rows<{ since: string | null }>(
      ctx.tx,
      sql`select min(t.day)::text as since from addon_outreach.tallies t
          where t.workspace_id = ${ws} and ${whose}`,
    );
    const added = (list: readonly (typeof found)[number][]): TallyCount[] => {
      const by = new Map<string, TallyCount>();
      for (const r of list) {
        const key = `${r.platform}:${r.kind}`;
        const had = by.get(key);
        by.set(key, { platform: r.platform, kind: r.kind, n: (had?.n ?? 0) + r.n });
      }
      return [...by.values()].filter((c) => c.n > 0);
    };
    let people: CountsOutput['people'] = null;
    if (input.everyone) {
      // Everyone who uses Social Outreach, as the team's live view lists them: their counts hold no names.
      const team = await rows<{ user_id: string; full_name: string | null; email: string }>(
        ctx.tx,
        sql`select m.user_id, u.full_name, u.email from app.workspace_memberships m
            join app.users u on u.id = m.user_id
            where m.workspace_id = ${ws}
              and 'outreach.use' = any (private.user_permissions(m.user_id, m.workspace_id))`,
      );
      const total = (cs: readonly TallyCount[]) => cs.reduce((sum, c) => sum + c.n, 0);
      people = team
        .map((p) => ({
          userId: p.user_id,
          name: p.full_name || p.email,
          counts: added(found.filter((r) => r.user_id === p.user_id)),
        }))
        .sort((a, b) => total(b.counts) - total(a.counts) || a.name.localeCompare(b.name));
    }
    return {
      timezone,
      period: input.period,
      from,
      to: today,
      everyone: input.everyone,
      counts: added(found),
      people,
      since: first?.since ?? null,
    };
  },
});

export const liveWatch = defineAddonCommand(outreachAddon, {
  name: 'outreach.live.watch',
  description:
    'A ticker of the person’s is on screen: for the next minute and a half their computer tells what it’s doing every few seconds, instead of every 20.',
  risk: 0,
  input: LiveWatchInput,
  output: LiveWatchOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // Said every minute while a ticker shows: a repeat does no harm, so it leaves no receipt.
  receipt: false,
  emits: ['outreach.live.watched'],
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = new Date();
    const until = new Date(now.getTime() + WATCH_SECONDS * 1000);
    const mine = and(eq(computers.workspaceId, ws), eq(computers.userId, me));
    const watched = await ctx.tx
      .select({ id: computers.id })
      .from(computers)
      .where(and(mine, gte(computers.watchedUntil, now)))
      .limit(1);
    const kept = await ctx.tx
      .update(computers)
      .set({ watchedUntil: until })
      .where(mine)
      .returning({ id: computers.id, activeAt: computers.activeAt });
    // Nobody was watching: the extension hears it now, so its next line goes in seconds, not at its minute's beat.
    // While someone already is, a watch says nothing to anyone.
    if (kept.length && !watched.length) {
      const working = [...kept].sort(
        (a, b) => (b.activeAt?.getTime() ?? 0) - (a.activeAt?.getTime() ?? 0),
      )[0]!;
      await ctx.emit({
        type: 'outreach.live.watched',
        entityType: 'outreach_computer',
        entityId: working.id,
        payload: { userId: me },
      });
    }
    return { until: until.toISOString() };
  },
});

export const ticker = defineAddonQuery(outreachAddon, {
  name: 'outreach.ticker',
  description:
    'What the ticker along the bottom of Social Outreach shows: what the person’s computer that works says it’s doing now, and today’s newest steps.',
  input: TickerInput,
  output: TickerOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const now = Date.now();
    const [{ timezone }, todayStart, all] = await Promise.all([
      businessToday(ctx, now),
      startOfToday(ctx, now),
      myComputers(ctx, me),
    ]);
    const working = workingOf(all);
    const steps = await ctx.tx
      .select({ at: liveSteps.at, kind: liveSteps.kind, line: liveSteps.line })
      .from(liveSteps)
      .where(
        and(
          eq(liveSteps.workspaceId, ctx.scope.workspaceId!),
          eq(liveSteps.userId, me),
          gte(liveSteps.at, todayStart),
        ),
      )
      .orderBy(desc(liveSteps.at), desc(liveSteps.createdAt))
      .limit(TICKER_STEPS);
    return {
      timezone,
      now: new Date(now).toISOString(),
      computer: working ? shown(working, working) : null,
      status: working
        ? {
            state: working.state,
            line: working.line,
            lineAt: working.lineAt?.toISOString() ?? null,
            nextAt: working.nextAt?.toISOString() ?? null,
            doing: working.doing ?? null,
          }
        : null,
      steps: steps.map((s) => ({ at: s.at.toISOString(), kind: s.kind, line: s.line })),
    };
  },
});

export const tallyCommands = [liveWatch] as const;
export const tallyQueries = [counts, ticker] as const;
