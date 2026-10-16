/**
 * Asks as the lists show them (../asks.ts, decision 43): read with their computer, so one whose computer went away
 * shows as lost and one that waited a day as let go, whether or not anything has ended it yet. Waiting for you, the
 * beat and the asks' own operations read them through here.
 */
import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import {
  ASK_EXPIRED_LINE,
  ASK_LOST_HOURS,
  ASK_LOST_LINE,
  ASK_LOST_MINUTES,
  ASK_WAIT_HOURS,
  askShownState,
  NEEDS_YOU_STATES,
  TAKEN_ASK_STATES,
  type AskShown,
} from '../asks';
import { asks, computers } from '../tables';
import type { Platform } from '../networks';
import type { Ctx } from './common';

export type AskRow = typeof asks.$inferSelect;

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** An ask as the lists show it. */
export function askShown(
  row: AskRow,
  computer: { readonly name: string | null; readonly seenAt: Date | null },
  now: number,
): AskShown {
  const state = askShownState(
    { state: row.state, askedAt: row.askedAt, startedAt: row.startedAt, seenAt: computer.seenAt },
    now,
  );
  return {
    askId: row.id,
    platform: row.platform,
    kind: row.kind,
    target: row.target,
    about: row.about,
    via: row.via,
    state,
    line: state === 'expired' ? ASK_EXPIRED_LINE : state === 'lost' ? ASK_LOST_LINE : row.line,
    result: row.result ?? null,
    reply: state === 'stuck' ? row.reply : null,
    askedAt: row.askedAt.toISOString(),
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    computerName: computer.name,
  };
}

/** The person's asks that `where` picks, with their computers, newest first. */
export async function shownAsks(
  ctx: Ctx,
  me: string,
  where: SQL | undefined,
  now: number,
  most?: number,
): Promise<AskShown[]> {
  const q = ctx.tx
    .select({ ask: asks, name: computers.name, seenAt: computers.lastSeenAt })
    .from(asks)
    .leftJoin(computers, eq(computers.id, asks.computerId))
    .where(and(eq(asks.workspaceId, ctx.scope.workspaceId!), eq(asks.userId, me), where))
    .orderBy(desc(asks.askedAt), desc(asks.id));
  const found = most === undefined ? await q : await q.limit(most);
  return found.map((r) => askShown(r.ask, { name: r.name, seenAt: r.seenAt }, now));
}

/** Waiting asks a computer may still take: not let go after a day. */
export const takeable = (now: number) =>
  and(eq(asks.state, 'waiting'), gte(asks.askedAt, new Date(now - ASK_WAIT_HOURS * HOUR)));

/** How many of the person's asks wait for their computer. */
export async function asksWaiting(ctx: Ctx, me: string, now: number): Promise<number> {
  const [row] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(asks)
    .where(and(eq(asks.workspaceId, ctx.scope.workspaceId!), eq(asks.userId, me), takeable(now)));
  return row?.n ?? 0;
}

const seenSince = (now: number) => new Date(now - ASK_LOST_MINUTES * MIN);
const startedSince = (now: number) => new Date(now - ASK_LOST_HOURS * HOUR);

/** Open and not lost: the computer was seen lately and it started within hours. */
const stillThere = (now: number) =>
  and(gte(computers.lastSeenAt, seenSince(now)), gte(asks.startedAt, startedSince(now)));

/**
 * Each person's asks that wait on them at their computer (a step handed over, or their password), for Waiting for
 * you: how many, the newest, and, for `itemsFor` (the person asking), the asks themselves. An ask's task, line and
 * result name the people reached, so a colleague's are counted on the database (`private.outreach_asks_waiting`, with
 * the same states and times as `stillThere`), never read (decision 41).
 */
export async function asksNeedingYou(
  ctx: Ctx,
  userIds: readonly string[],
  now: number,
  itemsFor: string | null = null,
): Promise<{
  readonly counts: Map<string, { count: number; newestAt: string | null }>;
  readonly items: AskShown[];
}> {
  const counts = new Map<string, { count: number; newestAt: string | null }>();
  if (!userIds.length) return { counts, items: [] };
  const ws = ctx.scope.workspaceId!;
  const [counted, found] = await Promise.all([
    rows<{ user_id: string; n: number; newest: Date | string | null }>(
      ctx.tx,
      sql`select user_id, n, newest from private.outreach_asks_waiting(
            ${ws}::uuid, ${`{${userIds.join(',')}}`}::uuid[], ${`{${NEEDS_YOU_STATES.join(',')}}`}::text[],
            ${seenSince(now).toISOString()}::timestamptz, ${startedSince(now).toISOString()}::timestamptz)`,
    ),
    itemsFor === null
      ? []
      : ctx.tx
          .select({ ask: asks, name: computers.name, seenAt: computers.lastSeenAt })
          .from(asks)
          .innerJoin(computers, eq(computers.id, asks.computerId))
          .where(
            and(
              eq(asks.workspaceId, ws),
              eq(asks.userId, itemsFor),
              inArray(asks.state, [...NEEDS_YOU_STATES]),
              stillThere(now),
            ),
          )
          .orderBy(desc(asks.updatedAt)),
  ]);
  for (const c of counted)
    counts.set(c.user_id, {
      count: c.n,
      newestAt: c.newest === null ? null : new Date(c.newest).toISOString(),
    });
  const items = found.map((r) => askShown(r.ask, { name: r.name, seenAt: r.seenAt }, now));
  return { counts, items };
}

/**
 * Ends the person's asks nobody will finish: waiting a day with no computer to take them (let go), and taken by a
 * computer that went away or long ago, or that this computer took before the one it's on now (lost). The lists
 * showed them so already; this keeps them from counting as open. Tells nobody.
 */
export async function endStale(
  ctx: Ctx,
  me: string,
  at: Date,
  here: {
    readonly computerId: string;
    readonly underway: string | null;
    /** The network whose line is taking: only its own asks taken before are lost; another network's go on. */
    readonly platform?: Platform;
  } | null = null,
): Promise<void> {
  const ws = ctx.scope.workspaceId!;
  const now = at.getTime();
  await ctx.tx
    .update(asks)
    .set({ state: 'failed', line: ASK_EXPIRED_LINE, endedAt: at, updatedAt: new Date() })
    .where(
      and(
        eq(asks.workspaceId, ws),
        eq(asks.userId, me),
        eq(asks.state, 'waiting'),
        lt(asks.askedAt, new Date(now - ASK_WAIT_HOURS * HOUR)),
      ),
    );
  const gone = or(
    sql`${asks.computerId} is null`,
    lt(asks.startedAt, new Date(now - ASK_LOST_HOURS * HOUR)),
    sql`exists (select 1 from addon_outreach.computers c where c.id = ${asks.computerId}
          and c.last_seen_at < ${new Date(now - ASK_LOST_MINUTES * MIN).toISOString()}::timestamptz)`,
    here
      ? and(
          eq(asks.computerId, here.computerId),
          here.platform ? eq(asks.platform, here.platform) : undefined,
          here.underway ? sql`${asks.id} <> ${here.underway}` : undefined,
        )
      : undefined,
  );
  await ctx.tx
    .update(asks)
    .set({ state: 'failed', line: ASK_LOST_LINE, endedAt: at, reply: null, updatedAt: new Date() })
    .where(
      and(
        eq(asks.workspaceId, ws),
        eq(asks.userId, me),
        inArray(asks.state, [...TAKEN_ASK_STATES]),
        gone,
      ),
    );
}

/** The groups named, as the computer gets them: their links, people saved and whether their admins were all read. */
export async function groupsForAsk(
  ctx: Ctx,
  where: SQL,
): Promise<
  { id: string; name: string | null; url: string; people: number; admins_read: boolean }[]
> {
  return rows(
    ctx.tx,
    sql`select g.id, g.name, g.url, g.admins_read_at is not null as admins_read,
          (select count(*)::int from addon_outreach.group_people gp where gp.group_id = g.id) as people
        from addon_outreach.groups g
        where g.workspace_id = ${ctx.scope.workspaceId!} and ${where}`,
  );
}
