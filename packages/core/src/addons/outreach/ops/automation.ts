/**
 * The extension on its own (../automation.ts, docs/outreach.md decisions 26 to 36): each person's own choices, which
 * the extension reads before it does anything for them, their training wheels, and a profile it found no post to like
 * on before a friend request (decision 33).
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { users } from '@hfos/db/schema';
import { workspaceTimezone } from '../../../crm/records';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  AUTOMATION_DEFAULTS,
  AutomationInput,
  AutomationOutput,
  AutomationSaveInput,
  AutomationSaveOutput,
  dayList,
  NO_WHEELS,
  WHEELS,
  WarmUpMissedInput,
  WarmUpMissedOutput,
  WheelsEndInput,
  WheelsEndOutput,
  WheelsListInput,
  WheelsListOutput,
  wheelsMatter,
  wheelsOn,
  wheelsState,
  type AutomationSettings,
  type WheelsKept,
  type WheelsState,
} from '../automation';
import { outreachAddon } from '../manifest';
import { automation, profiles } from '../tables';
import { inWorkspace, type Ctx } from './common';

type Row = typeof automation.$inferSelect;

const settingsOf = (row: Row | undefined): AutomationSettings =>
  row
    ? {
        sending: row.sending,
        warmUp: row.warmUp,
        confirmRequests: row.confirmRequests,
        collect: row.collect,
        hours: { start: row.hoursStart, end: row.hoursEnd, days: [...row.days] },
      }
    : AUTOMATION_DEFAULTS;

const keptOf = (row: Row | undefined): WheelsKept =>
  row
    ? { from: row.wheelsFrom, ok: row.wheelsOk, edits: row.wheelsEdits, doneAt: row.wheelsDoneAt }
    : NO_WHEELS;

const stateOf = (row: Row | undefined, now: number): WheelsState => {
  const settings = settingsOf(row);
  return wheelsState(keptOf(row), now, wheelsMatter(settings));
};

async function rowOf(ctx: Ctx, userId: string): Promise<Row | undefined> {
  const [row] = await ctx.tx
    .select()
    .from(automation)
    .where(and(eq(automation.workspaceId, ctx.scope.workspaceId!), eq(automation.userId, userId)));
  return row;
}

/** A person's own choices in the business, the defaults until they save theirs, and their training wheels. */
export async function automationOf(
  ctx: Ctx,
  userId: string,
  now = Date.now(),
): Promise<{ settings: AutomationSettings; saved: boolean; wheels: WheelsState }> {
  const row = await rowOf(ctx, userId);
  return { settings: settingsOf(row), saved: row !== undefined, wheels: stateOf(row, now) };
}

/**
 * Whether the person's daily limits are half now: after a warning from Facebook (decision 25), or on training wheels.
 */
export async function slowerFor(ctx: Ctx, userId: string, warned: boolean, now = Date.now()) {
  return warned || (await automationOf(ctx, userId, now)).wheels.on;
}

/** One message OK'd on training wheels: it counts toward the 25, and whether it was changed toward the last 10. */
export async function countWheels(ctx: Ctx, userId: string, edits: readonly boolean[]) {
  const row = await rowOf(ctx, userId);
  const now = Date.now();
  if (!row || !edits.length || !wheelsMatter(settingsOf(row)) || !wheelsOn(keptOf(row), now))
    return stateOf(row, now);
  const [after] = await ctx.tx
    .update(automation)
    .set({
      wheelsOk: row.wheelsOk + edits.length,
      wheelsEdits: [...row.wheelsEdits, ...edits].slice(-WHEELS.last),
      updatedAt: changeMoment(ctx.meta),
    })
    .where(eq(automation.id, row.id))
    .returning();
  // Earned: they stay off from now on, whatever comes of the next ones.
  const state = stateOf(after, now);
  if (!state.on)
    await ctx.tx
      .update(automation)
      .set({ wheelsDoneAt: changeMoment(ctx.meta) })
      .where(eq(automation.id, row.id));
  return state;
}

/** A warning from Facebook puts training wheels back on for 7 days, for anyone who ever had them. */
export async function wheelsBackOn(ctx: Ctx, userId: string) {
  await ctx.tx
    .update(automation)
    .set({ wheelsFrom: changeMoment(ctx.meta), wheelsDoneAt: null })
    .where(
      and(
        eq(automation.workspaceId, ctx.scope.workspaceId!),
        eq(automation.userId, userId),
        isNotNull(automation.wheelsFrom),
      ),
    );
}

export const automationGet = defineAddonQuery(outreachAddon, {
  name: 'outreach.automation',
  description:
    'What the person lets the browser extension do for them on Facebook on its own, and their working hours, in the business’s time zone.',
  input: AutomationInput,
  output: AutomationOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person has their own choices for the extension.');
    const timezone = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
    return { ...(await automationOf(ctx, me)), timezone };
  },
});

export const automationSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.automation.save',
  description:
    'The person chooses what the browser extension does for them on Facebook on its own (friend requests, likes and comments, liking a post first, confirming requests that fit, the once-a-day jobs) and their working hours.',
  risk: 0,
  input: AutomationSaveInput,
  output: AutomationSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.automation.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const { sending, warmUp, confirmRequests, collect, hours } = input.settings;
    const before = await rowOf(ctx, me);
    // Choosing (b) starts the training wheels, once.
    const wheels = wheelsMatter(input.settings) && !before?.wheelsFrom ? { wheelsFrom: at } : {};
    const values = {
      ...wheels,
      sending,
      warmUp,
      confirmRequests,
      collect,
      hoursStart: hours.start,
      hoursEnd: hours.end,
      days: dayList(hours.days),
      updatedAt: at,
    };
    const [row] = await ctx.tx
      .insert(automation)
      .values({ workspaceId: ws, userId: me, ...values })
      .onConflictDoUpdate({ target: [automation.workspaceId, automation.userId], set: values })
      .returning();
    await ctx.emit({
      type: 'outreach.automation.saved',
      entityType: 'outreach_automation',
      entityId: row!.id,
      payload: { sending, warmUp, confirmRequests, collect },
    });
    const timezone = await workspaceTimezone(ctx.tx, ws);
    return { settings: settingsOf(row), timezone, saved: true, wheels: stateOf(row, Date.now()) };
  },
});

export const warmUpMissed = defineAddonCommand(outreachAddon, {
  name: 'outreach.warm_up.missed',
  description:
    'The extension found no post to like on someone’s profile before their friend request: the request goes without it.',
  risk: 0,
  input: WarmUpMissedInput,
  output: WarmUpMissedOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.warm_up.missed'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const [row] = await ctx.tx
      .update(profiles)
      .set({ warmUpMissedAt: changeMoment(ctx.meta) })
      .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, input.profileId)))
      .returning({ id: profiles.id });
    if (!row)
      throw HfosError.notFound(
        'That person isn’t kept in Social Outreach any more. Refresh your list for today.',
      );
    await ctx.emit({
      type: 'outreach.warm_up.missed',
      entityType: 'outreach_profile',
      entityId: row.id,
      payload: {},
    });
    return { profileId: row.id };
  },
});

export const wheelsEnd = defineAddonCommand(outreachAddon, {
  name: 'outreach.wheels.end',
  description:
    'An owner or admin ends someone’s training wheels early: their messages go without waiting for them, and their daily limits are full again.',
  risk: 1,
  input: WheelsEndInput,
  output: WheelsEndOutput,
  permission: 'outreach.manage',
  scope: inWorkspace,
  emits: ['outreach.wheels.ended'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const [row] = await ctx.tx
      .update(automation)
      .set({ wheelsDoneAt: changeMoment(ctx.meta), updatedAt: changeMoment(ctx.meta) })
      .where(
        and(
          eq(automation.workspaceId, ctx.scope.workspaceId!),
          eq(automation.userId, input.userId),
          isNotNull(automation.wheelsFrom),
          sql`${automation.wheelsDoneAt} is null`,
        ),
      )
      .returning({ id: automation.id });
    if (!row) return { userId: input.userId, ended: false };
    await ctx.emit({
      type: 'outreach.wheels.ended',
      entityType: 'outreach_automation',
      entityId: row.id,
      payload: { userId: input.userId },
    });
    return { userId: input.userId, ended: true };
  },
});

export const wheelsList = defineAddonQuery(outreachAddon, {
  name: 'outreach.wheels',
  description:
    'Everyone in the business on training wheels now, with how far each has come: messages OK’d, days left and how many they changed.',
  input: WheelsListInput,
  output: WheelsListOutput,
  permission: 'outreach.manage',
  scope: inWorkspace,
  async handler(ctx) {
    const now = Date.now();
    const kept = await ctx.tx
      .select({ row: automation, fullName: users.fullName, email: users.email })
      .from(automation)
      .innerJoin(users, eq(users.id, automation.userId))
      .where(
        and(eq(automation.workspaceId, ctx.scope.workspaceId!), isNotNull(automation.wheelsFrom)),
      );
    return {
      people: kept
        .map(({ row, fullName, email }) => ({
          userId: row.userId,
          name: fullName || email,
          wheels: stateOf(row, now),
        }))
        .filter((p) => p.wheels.on)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

export const automationCommands = [automationSave, warmUpMissed, wheelsEnd] as const;
export const automationQueries = [automationGet, wheelsList] as const;
