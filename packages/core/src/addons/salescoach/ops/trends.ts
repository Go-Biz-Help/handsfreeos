/**
 * Trends (round four, ../trends.ts): a rep's coached calls over time, and the owner's view of every rep.
 *
 * Row security does the deciding: a rep reads only their own coached calls, so their trends are their own; whoever
 * reviews (`salescoach.review`) reads everyone's, and gets every rep and the team.
 */
import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { users, workspaces } from '@hfos/db/schema';
import { defineAddonQuery } from '../../server';
import { salescoachAddon } from '../manifest';
import { PlaybookDetails } from '../playbooks';
import { coachedCalls, playbooks } from '../tables';
import {
  Trend,
  TREND_WEEKS,
  trendBounds,
  trendOf,
  trendWeeks,
  type TrendPlaybook,
  type TrendRecord,
} from '../trends';
import { inWorkspace } from './playbooks';

const uuid = z.uuid();

const RepTrend = Trend.extend({ rep: z.object({ id: uuid, name: z.string() }) });

export const trends = defineAddonQuery(salescoachAddon, {
  name: 'salescoach.trends',
  description:
    'How coached calls are going over the last weeks against the weeks before: the score, talk time, objections answered, script steps done, wins and the steps skipped most, week by week. Your own, or every rep’s and the team’s for people who review calls.',
  input: z.object({
    workspaceId: uuid,
    weeks: z.number().int().min(TREND_WEEKS.min).max(TREND_WEEKS.max).default(TREND_WEEKS.default),
    /** Only this rep's. */
    userId: uuid.optional(),
  }),
  output: z.object({
    /** Each week's Monday, oldest first; the last is this week, so far. */
    weeks: z.array(z.string()),
    timeZone: z.string(),
    /** Most coached first. */
    reps: z.array(RepTrend),
    team: Trend,
  }),
  permission: 'salescoach.use',
  scope: inWorkspace,
  ai: {
    tool: 'salescoach_trends',
    description:
      'How each sales rep’s coached calls are trending: average score, talk time, objections answered, script steps done, wins and the steps they skip most, against the weeks before.',
  },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [w] = await ctx.tx
      .select({ timeZone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    const timeZone = w?.timeZone ?? 'America/Chicago';
    const now = Date.now();
    const weeks = trendWeeks(now, input.weeks, timeZone);
    const { from, previousFrom } = trendBounds(now, input.weeks, timeZone);

    const found = await ctx.tx
      .select({
        userId: coachedCalls.userId,
        startedAt: coachedCalls.startedAt,
        callId: coachedCalls.callId,
        liveMeetingId: coachedCalls.liveMeetingId,
        playbookId: coachedCalls.playbookId,
        result: coachedCalls.result,
        wonAt: coachedCalls.wonAt,
      })
      .from(coachedCalls)
      .where(
        and(
          eq(coachedCalls.workspaceId, ws),
          eq(coachedCalls.state, 'done'),
          isNotNull(coachedCalls.result),
          gte(coachedCalls.startedAt, new Date(previousFrom)),
          input.userId ? eq(coachedCalls.userId, input.userId) : undefined,
        ),
      );
    const records: TrendRecord[] = found.flatMap((r) =>
      r.result
        ? [
            {
              userId: r.userId,
              at: r.startedAt.getTime(),
              spoken: r.callId !== null || r.liveMeetingId !== null,
              score: r.result.score,
              stepsCovered: r.result.stepsCovered,
              playbookId: r.playbookId,
              won: r.wonAt !== null,
            },
          ]
        : [],
    );

    const playbookIds = [...new Set(records.flatMap((r) => (r.playbookId ? [r.playbookId] : [])))];
    const books = new Map<string, TrendPlaybook>();
    if (playbookIds.length)
      for (const p of await ctx.tx
        .select({ id: playbooks.id, name: playbooks.name, details: playbooks.details })
        .from(playbooks)
        .where(and(eq(playbooks.workspaceId, ws), inArray(playbooks.id, playbookIds)))) {
        const d = PlaybookDetails.safeParse(p.details);
        if (d.success)
          books.set(p.id, {
            name: p.name,
            steps: d.data.steps.map((s) => ({ id: s.id, title: s.title })),
          });
      }

    const userIds = [...new Set(records.flatMap((r) => (r.userId ? [r.userId] : [])))];
    const names = userIds.length
      ? await ctx.tx
          .select({ id: users.id, name: users.fullName })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const shape = { weeks, from, previousFrom, timeZone, playbooks: books };
    const reps = userIds
      .map((id) => ({
        rep: {
          id,
          name: names.find((u) => u.id === id)?.name?.trim() || 'Someone on the team',
        },
        ...trendOf(
          records.filter((r) => r.userId === id),
          shape,
        ),
      }))
      // Someone who coached only before this period still shows, so the owner sees them drop off.
      .sort(
        (a, b) =>
          b.totals.coached - a.totals.coached ||
          b.previous.coached - a.previous.coached ||
          a.rep.name.localeCompare(b.rep.name),
      );
    return { weeks, timeZone, reps, team: trendOf(records, shape) };
  },
});

export const trendQueries = [trends] as const;
