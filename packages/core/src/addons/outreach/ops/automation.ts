/**
 * The extension on its own (../automation.ts, docs/outreach.md decisions 26 to 36): each person's own choices, which
 * the extension reads before it does anything for them, and a profile it found no post to like on before a friend
 * request (decision 33).
 */
import { and, eq } from 'drizzle-orm';
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
  WarmUpMissedInput,
  WarmUpMissedOutput,
  type AutomationSettings,
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
        hours: { start: row.hoursStart, end: row.hoursEnd, days: [...row.days] },
      }
    : AUTOMATION_DEFAULTS;

/** A person's own choices in the business: the defaults until they save theirs. */
export async function automationOf(
  ctx: Ctx,
  userId: string,
): Promise<{ settings: AutomationSettings; saved: boolean }> {
  const [row] = await ctx.tx
    .select()
    .from(automation)
    .where(and(eq(automation.workspaceId, ctx.scope.workspaceId!), eq(automation.userId, userId)));
  return { settings: settingsOf(row), saved: row !== undefined };
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
    'The person chooses what the browser extension does for them on Facebook on its own (friend requests, likes and comments, liking a post first, confirming requests that fit) and their working hours.',
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
    const { sending, warmUp, confirmRequests, hours } = input.settings;
    const values = {
      sending,
      warmUp,
      confirmRequests,
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
      payload: { sending, warmUp, confirmRequests },
    });
    const timezone = await workspaceTimezone(ctx.tx, ws);
    return { settings: settingsOf(row), timezone, saved: true };
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

export const automationCommands = [automationSave, warmUpMissed] as const;
export const automationQueries = [automationGet] as const;
