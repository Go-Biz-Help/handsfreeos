/**
 * The extension on its own (../automation.ts, docs/outreach.md decisions 26 to 40): each person's own choices, set on
 * Social Outreach's Settings tab and read by the extension before it does anything for them, inside the business's
 * rules; their training wheels; and a profile it found no post to like on before a friend request (decision 33).
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { users } from '@hfos/db/schema';
import { workspaceTimezone } from '../../../crm/records';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { scopeCan } from '../../../kernel/execute';
import type { Permission } from '../../../permissions';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  AutomationInput,
  AutomationPeopleInput,
  AutomationPeopleOutput,
  AutomationOutput,
  AutomationSaveInput,
  AutomationSaveOutput,
  dayList,
  notAllowedWords,
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
  withinRules,
  type AutomationSettings,
  type BusinessRules,
  type WheelsKept,
  type WheelsState,
} from '../automation';
import { outreachSettings } from '../chat-read';
import { dailyLimitsNow } from '../limits';
import { outreachAddon } from '../manifest';
import { automation, profiles, setup } from '../tables';
import { inWorkspace, type Ctx } from './common';

type Row = typeof automation.$inferSelect;

/** A person's choices as kept, or the business's defaults until they save their own; inside its rules either way. */
const settingsOf = (row: Row | undefined, rules: BusinessRules): AutomationSettings =>
  withinRules(
    row
      ? {
          sending: row.sending,
          replies: row.replies,
          warmUp: row.warmUp,
          confirmRequests: row.confirmRequests,
          collect: row.collect,
          joinGroups: row.joinGroups,
          watchPosts: row.watchPosts,
          posting: row.posting,
          hours: { start: row.hoursStart, end: row.hoursEnd, days: [...row.days] },
          noting: row.noting,
          readChats: row.readChats,
          markPosts: row.markPosts,
          pushes: row.pushes,
        }
      : rules.defaults,
    rules,
  );

/** The business's rules for everyone's choices (decision 38), kept with its Social Outreach settings. */
export async function rulesOf(ctx: Ctx): Promise<BusinessRules> {
  const [installed] = await rows<{ settings: unknown }>(
    ctx.tx,
    sql`select settings from app.addon_installations
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = ${outreachAddon.id}`,
  );
  return outreachSettings(installed?.settings).rules;
}

const keptOf = (row: Row | undefined): WheelsKept =>
  row
    ? { from: row.wheelsFrom, ok: row.wheelsOk, edits: row.wheelsEdits, doneAt: row.wheelsDoneAt }
    : NO_WHEELS;

const stateOf = (row: Row | undefined, rules: BusinessRules, now: number): WheelsState =>
  wheelsState(keptOf(row), now, wheelsMatter(settingsOf(row, rules)));

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
): Promise<{
  settings: AutomationSettings;
  saved: boolean;
  wheels: WheelsState;
  rules: BusinessRules;
}> {
  const [row, rules] = await Promise.all([rowOf(ctx, userId), rulesOf(ctx)]);
  return {
    settings: settingsOf(row, rules),
    saved: row !== undefined,
    wheels: stateOf(row, rules, now),
    rules,
  };
}

/** Everyone's choices and training wheels in the business at once, for the team's live view (./live.ts). */
export async function everyoneAutomation(ctx: Ctx, now = Date.now()) {
  const [rules, kept] = await Promise.all([
    rulesOf(ctx),
    ctx.tx.select().from(automation).where(eq(automation.workspaceId, ctx.scope.workspaceId!)),
  ]);
  return {
    rules,
    of(userId: string): { settings: AutomationSettings; wheels: WheelsState } {
      const row = kept.find((k) => k.userId === userId);
      return { settings: settingsOf(row, rules), wheels: stateOf(row, rules, now) };
    },
  };
}

/**
 * Whether the person's daily limits are half now: after a warning from Facebook (decision 25), or on training wheels.
 */
export async function slowerFor(ctx: Ctx, userId: string, warned: boolean, now = Date.now()) {
  return warned || (await automationOf(ctx, userId, now)).wheels.on;
}

/** The person's daily limits now: the business's own, halved after a warning or on training wheels. */
export async function limitsFor(ctx: Ctx, userId: string, warned: boolean, now = Date.now()) {
  const { wheels, rules } = await automationOf(ctx, userId, now);
  return dailyLimitsNow(warned || wheels.on, rules.dailyLimits);
}

/** One message OK'd on training wheels: it counts toward the 25, and whether it was changed toward the last 10. */
export async function countWheels(ctx: Ctx, userId: string, edits: readonly boolean[]) {
  const [row, rules] = await Promise.all([rowOf(ctx, userId), rulesOf(ctx)]);
  const now = Date.now();
  if (!row || !edits.length || !wheelsMatter(settingsOf(row, rules)) || !wheelsOn(keptOf(row), now))
    return stateOf(row, rules, now);
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
  const state = stateOf(after, rules, now);
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

/** Whose choices a request is for: the person's own, or for an owner or admin, anyone's here. */
async function whoseFor(ctx: Ctx, userId: string | undefined) {
  const me = userIdOf(ctx.actor);
  if (!me) throw HfosError.forbidden('Only a person has their own choices for the extension.');
  if (!userId || userId === me) return { me, whose: me };
  if (!scopeCan(ctx.scope, 'outreach.manage' as Permission))
    throw HfosError.forbidden(
      'Only an owner or admin of this business can see or change someone else’s Social Outreach settings.',
    );
  const [them] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select true as ok from app.workspace_memberships m
        where m.workspace_id = ${ctx.scope.workspaceId} and m.user_id = ${userId}
          and 'outreach.use' = any (private.user_permissions(m.user_id, m.workspace_id))`,
  );
  if (!them)
    throw HfosError.notFound(
      'That person can’t use Social Outreach in this business. Refresh the list of people.',
    );
  return { me, whose: userId };
}

/** Everything the Settings tab and the extension show about someone's choices. */
async function shown(ctx: Ctx, whose: string, row: Row | undefined, rules: BusinessRules) {
  const ids = [whose, ...(row?.changedBy ? [row.changedBy] : [])];
  const named = await ctx.tx
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(sql`${users.id} = any (${`{${ids.join(',')}}`}::uuid[])`);
  const nameOf = (id: string) => {
    const u = named.find((n) => n.id === id);
    return u ? u.fullName || u.email : 'Someone';
  };
  return {
    settings: settingsOf(row, rules),
    saved: row !== undefined,
    wheels: stateOf(row, rules, Date.now()),
    timezone: await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!),
    userId: whose,
    name: nameOf(whose),
    changedBy: row?.changedBy ? nameOf(row.changedBy) : null,
    rules: {
      sendingAllowed: rules.sendingAllowed,
      repliesAllowed: rules.repliesAllowed,
      postingAllowed: rules.postingAllowed,
      dailyLimits: rules.dailyLimits,
    },
  };
}

export const automationGet = defineAddonQuery(outreachAddon, {
  name: 'outreach.automation',
  description:
    'What the person lets the browser extension do for them on Facebook on its own, its switches and their working hours, in the business’s time zone, inside the business’s rules; an owner or admin can ask for anyone’s.',
  input: AutomationInput,
  output: AutomationOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const { whose } = await whoseFor(ctx, input.userId);
    const [row, rules] = await Promise.all([rowOf(ctx, whose), rulesOf(ctx)]);
    return shown(ctx, whose, row, rules);
  },
});

export const automationSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.automation.save',
  description:
    'The person chooses what the browser extension does for them on Facebook on its own (friend requests, likes and comments, messages, replies, liking a post first, confirming requests that fit, the once-a-day jobs), its switches, how their phone hears what waits, and their working hours; an owner or admin can choose for anyone. Only what the business allows.',
  risk: 0,
  input: AutomationSaveInput,
  output: AutomationSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.automation.saved'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const { me, whose } = await whoseFor(ctx, input.userId);
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const rules = await rulesOf(ctx);
    const refused = notAllowedWords(input.settings, rules);
    if (refused) throw HfosError.rule('not_allowed', 403, refused);
    const s = input.settings;
    const before = await rowOf(ctx, whose);
    // Choosing Sending (b), or Replies (b) or (c), starts the training wheels, once.
    const wheels = wheelsMatter(s) && !before?.wheelsFrom ? { wheelsFrom: at } : {};
    const values = {
      ...wheels,
      sending: s.sending,
      replies: s.replies,
      warmUp: s.warmUp,
      confirmRequests: s.confirmRequests,
      collect: s.collect,
      joinGroups: s.joinGroups,
      watchPosts: s.watchPosts,
      posting: s.posting,
      hoursStart: s.hours.start,
      hoursEnd: s.hours.end,
      days: dayList(s.hours.days),
      noting: s.noting,
      readChats: s.readChats,
      markPosts: s.markPosts,
      pushes: s.pushes,
      // Someone else's choices say who changed them; the person's own clear it.
      changedBy: whose === me ? null : me,
      updatedAt: at,
    };
    const [row] = await ctx.tx
      .insert(automation)
      .values({ workspaceId: ws, userId: whose, ...values })
      .onConflictDoUpdate({ target: [automation.workspaceId, automation.userId], set: values })
      .returning();
    // Their own save counts as having chosen, for good (../setup.ts): an owner's or admin's later save doesn't undo it.
    if (whose === me)
      await ctx.tx
        .insert(setup)
        .values({ workspaceId: ws, userId: me, settingsAt: at, updatedAt: at })
        .onConflictDoUpdate({
          target: [setup.workspaceId, setup.userId],
          set: { settingsAt: at, updatedAt: at },
        });
    await ctx.emit({
      type: 'outreach.automation.saved',
      entityType: 'outreach_automation',
      entityId: row!.id,
      payload: {
        userId: whose,
        sending: s.sending,
        replies: s.replies,
        warmUp: s.warmUp,
        confirmRequests: s.confirmRequests,
        collect: s.collect,
        byOther: whose !== me,
      },
    });
    return shown(ctx, whose, row, rules);
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
    const rules = await rulesOf(ctx);
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
          wheels: stateOf(row, rules, now),
        }))
        .filter((p) => p.wheels.on)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

export const automationPeople = defineAddonQuery(outreachAddon, {
  name: 'outreach.automation.people',
  description:
    'Everyone who can use Social Outreach in the business, with what each lets the extension do on its own, for an owner or admin to look over or change.',
  input: AutomationPeopleInput,
  output: AutomationPeopleOutput,
  permission: 'outreach.manage',
  scope: inWorkspace,
  async handler(ctx) {
    const now = Date.now();
    const rules = await rulesOf(ctx);
    const found = await rows<{ user_id: string; full_name: string | null; email: string }>(
      ctx.tx,
      // Each person's own access row is theirs alone to read: their permissions come from their membership.
      sql`select m.user_id, u.full_name, u.email from app.workspace_memberships m
          join app.users u on u.id = m.user_id
          where m.workspace_id = ${ctx.scope.workspaceId}
            and 'outreach.use' = any (private.user_permissions(m.user_id, m.workspace_id))`,
    );
    const kept = await ctx.tx
      .select()
      .from(automation)
      .where(eq(automation.workspaceId, ctx.scope.workspaceId!));
    return {
      people: found
        .map((p) => {
          const row = kept.find((k) => k.userId === p.user_id);
          const settings = settingsOf(row, rules);
          return {
            userId: p.user_id,
            name: p.full_name || p.email,
            saved: row !== undefined,
            sending: settings.sending,
            replies: settings.replies,
            wheels: stateOf(row, rules, now).on,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

export const automationCommands = [automationSave, warmUpMissed, wheelsEnd] as const;
export const automationQueries = [automationGet, wheelsList, automationPeople] as const;
