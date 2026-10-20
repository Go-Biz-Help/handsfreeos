/**
 * The extension on its own (../automation.ts, docs/outreach.md decisions 26 to 40): each person's own choices, set on
 * Social Outreach's Settings tab and read by the extension before it does anything for them, inside the business's
 * rules; their training wheels; and a profile it found no post to like on before a friend request (decision 33).
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { rows, type Tx } from '@hfos/db/client';
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
  businessLimitsOn,
  choicesFor,
  dayList,
  NETWORKS_DEFAULTS,
  NetworksSettings,
  notAllowedWords,
  NO_WHEELS,
  OTHER_PLATFORMS,
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
  type NetworkChoices,
  type OtherPlatform,
  type WheelsKept,
  type WheelsState,
} from '../automation';
import { outreachSettings } from '../chat-read';
import type { Voice } from '../voice';
import { outreachAddon } from '../manifest';
import { networkLimitsNow, type Platform } from '../networks';
import { automation, profiles, setup, type NetworkWheelKept } from '../tables';
import { inWorkspace, type Ctx } from './common';

type Row = typeof automation.$inferSelect;

/** Which networks the person works and each other network's choices, as kept: the defaults fill in what isn't. */
function networksOf(row: Row): NetworksSettings {
  const read = NetworksSettings.safeParse(row.networks ?? {});
  return read.success ? read.data : NETWORKS_DEFAULTS;
}

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
          dayReport: row.dayReport,
          voice: {
            shorthand: row.voiceShorthand,
            acronyms: row.voiceAcronyms,
            emoji: row.voiceEmoji,
            split: row.voiceSplit,
          },
          networks: networksOf(row),
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

/** A person's training wheels on a network, as kept: Facebook's in the wheels columns, any other's in `network_wheels`. */
const keptOf = (row: Row | undefined, platform: Platform = 'facebook'): WheelsKept => {
  if (!row) return NO_WHEELS;
  if (platform === 'facebook')
    return {
      from: row.wheelsFrom,
      ok: row.wheelsOk,
      edits: row.wheelsEdits,
      doneAt: row.wheelsDoneAt,
    };
  return row.networkWheels[platform] ?? NO_WHEELS;
};

const stateOf = (
  row: Row | undefined,
  rules: BusinessRules,
  now: number,
  platform: Platform = 'facebook',
): WheelsState =>
  wheelsState(
    keptOf(row, platform),
    now,
    wheelsMatter(choicesFor(settingsOf(row, rules), platform)),
  );

/** Each other network's training wheels, as the settings show them. */
const networkWheelsOf = (row: Row | undefined, rules: BusinessRules, now: number) =>
  Object.fromEntries(OTHER_PLATFORMS.map((p) => [p, stateOf(row, rules, now, p)])) as Record<
    OtherPlatform,
    WheelsState
  >;

/** A network's training wheels kept anew: `network_wheels` with that network's changed. */
const withWheels = (row: Row, platform: OtherPlatform, kept: NetworkWheelKept) => ({
  ...row.networkWheels,
  [platform]: kept,
});

const iso = (at: Date | string | null) => (at === null ? null : new Date(at).toISOString());

async function rowOf(ctx: Ctx, userId: string): Promise<Row | undefined> {
  const [row] = await ctx.tx
    .select()
    .from(automation)
    .where(and(eq(automation.workspaceId, ctx.scope.workspaceId!), eq(automation.userId, userId)));
  return row;
}

/**
 * A person's own choices in the business, the defaults until they save theirs; and on one network (Facebook when left
 * out), their choices there and their training wheels there.
 */
export async function automationOf(
  ctx: Ctx,
  userId: string,
  now = Date.now(),
  platform: Platform = 'facebook',
): Promise<{
  settings: AutomationSettings;
  choices: NetworkChoices;
  saved: boolean;
  wheels: WheelsState;
  rules: BusinessRules;
}> {
  const [row, rules] = await Promise.all([rowOf(ctx, userId), rulesOf(ctx)]);
  const settings = settingsOf(row, rules);
  return {
    settings,
    choices: choicesFor(settings, platform),
    saved: row !== undefined,
    wheels: stateOf(row, rules, now, platform),
    rules,
  };
}

/**
 * How the AI writes for someone (../voice.ts): their own choice, or the business's default until they save theirs. For
 * the worker, which writes their drafts.
 */
export async function voiceFor(tx: Tx, workspaceId: string, userId: string): Promise<Voice> {
  const [row] = await rows<{
    shorthand: boolean;
    acronyms: boolean;
    emoji: boolean;
    split: boolean;
  }>(
    tx,
    sql`select voice_shorthand as shorthand, voice_acronyms as acronyms, voice_emoji as emoji, voice_split as split
        from addon_outreach.automation where workspace_id = ${workspaceId} and user_id = ${userId}`,
  );
  if (row) return row;
  const [installed] = await rows<{ settings: unknown }>(
    tx,
    sql`select settings from app.addon_installations
        where workspace_id = ${workspaceId} and addon_id = ${outreachAddon.id}`,
  );
  return outreachSettings(installed?.settings).rules.defaults.voice;
}

/** Everyone's choices and training wheels in the business at once, for the team's live view (./live.ts). */
export async function everyoneAutomation(ctx: Ctx, now = Date.now()) {
  const [rules, kept] = await Promise.all([
    rulesOf(ctx),
    ctx.tx.select().from(automation).where(eq(automation.workspaceId, ctx.scope.workspaceId!)),
  ]);
  return {
    rules,
    of(
      userId: string,
      platform: Platform = 'facebook',
    ): { settings: AutomationSettings; wheels: WheelsState } {
      const row = kept.find((k) => k.userId === userId);
      return { settings: settingsOf(row, rules), wheels: stateOf(row, rules, now, platform) };
    },
  };
}

/**
 * Whether the person's daily limits on a network are half now: after a warning there (decision 25), or on training
 * wheels there.
 */
export async function slowerFor(
  ctx: Ctx,
  userId: string,
  warned: boolean,
  now = Date.now(),
  platform: Platform = 'facebook',
) {
  return warned || (await automationOf(ctx, userId, now, platform)).wheels.on;
}

/** The person's daily limits on a network now: the business's own there, halved after a warning or on training wheels. */
export async function limitsFor(
  ctx: Ctx,
  userId: string,
  warned: boolean,
  now = Date.now(),
  platform: Platform = 'facebook',
) {
  const { wheels, rules } = await automationOf(ctx, userId, now, platform);
  return networkLimitsNow(platform, warned || wheels.on, businessLimitsOn(rules, platform));
}

/**
 * One message OK'd on training wheels on a network: it counts toward the 25, and whether it was changed toward the
 * last 10. Each network's wheels are its own.
 */
export async function countWheels(
  ctx: Ctx,
  userId: string,
  edits: readonly boolean[],
  platform: Platform = 'facebook',
) {
  const [row, rules] = await Promise.all([rowOf(ctx, userId), rulesOf(ctx)]);
  const now = Date.now();
  const kept = keptOf(row, platform);
  if (
    !row ||
    !edits.length ||
    !wheelsMatter(choicesFor(settingsOf(row, rules), platform)) ||
    !wheelsOn(kept, now)
  )
    return stateOf(row, rules, now, platform);
  const at = changeMoment(ctx.meta);
  const counted = {
    ok: kept.ok + edits.length,
    edits: [...kept.edits, ...edits].slice(-WHEELS.last),
  };
  if (platform === 'facebook') {
    const [after] = await ctx.tx
      .update(automation)
      .set({ wheelsOk: counted.ok, wheelsEdits: counted.edits, updatedAt: at })
      .where(eq(automation.id, row.id))
      .returning();
    // Earned: they stay off from now on, whatever comes of the next ones.
    const state = stateOf(after, rules, now);
    if (!state.on)
      await ctx.tx.update(automation).set({ wheelsDoneAt: at }).where(eq(automation.id, row.id));
    return state;
  }
  const next = { from: iso(kept.from), ok: counted.ok, edits: counted.edits, doneAt: null };
  const earned = !wheelsOn(next, now);
  const [after] = await ctx.tx
    .update(automation)
    .set({
      networkWheels: withWheels(row, platform, {
        ...next,
        doneAt: earned ? at.toISOString() : null,
      }),
      updatedAt: at,
    })
    .where(eq(automation.id, row.id))
    .returning();
  return stateOf(after, rules, now, platform);
}

/**
 * A warning puts training wheels back on for 7 days on the network that showed it, for anyone who ever had them
 * there. The person's other networks keep theirs as they were.
 */
export async function wheelsBackOn(ctx: Ctx, userId: string, platform: Platform = 'facebook') {
  const at = changeMoment(ctx.meta);
  if (platform === 'facebook') {
    await ctx.tx
      .update(automation)
      .set({ wheelsFrom: at, wheelsDoneAt: null })
      .where(
        and(
          eq(automation.workspaceId, ctx.scope.workspaceId!),
          eq(automation.userId, userId),
          isNotNull(automation.wheelsFrom),
        ),
      );
    return;
  }
  const row = await rowOf(ctx, userId);
  const kept = row?.networkWheels[platform];
  if (!row || !kept?.from) return;
  await ctx.tx
    .update(automation)
    .set({
      networkWheels: withWheels(row, platform, { ...kept, from: at.toISOString(), doneAt: null }),
    })
    .where(eq(automation.id, row.id));
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
  const [installed] = await rows<{ at: Date | string }>(
    ctx.tx,
    sql`select installed_at as at from app.addon_installations
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = ${outreachAddon.id}`,
  );
  const now = Date.now();
  return {
    settings: settingsOf(row, rules),
    saved: row !== undefined,
    wheels: stateOf(row, rules, now),
    networkWheels: networkWheelsOf(row, rules, now),
    timezone: await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!),
    startedAt: installed ? new Date(installed.at).toISOString() : null,
    userId: whose,
    name: nameOf(whose),
    changedBy: row?.changedBy ? nameOf(row.changedBy) : null,
    rules: {
      sendingAllowed: rules.sendingAllowed,
      repliesAllowed: rules.repliesAllowed,
      postingAllowed: rules.postingAllowed,
      dailyLimits: rules.dailyLimits,
      networksAllowed: rules.networksAllowed,
      networkLimits: rules.networkLimits,
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
  // The worker reads them for someone too: the networks they work, for the morning push.
  actors: ['human', 'system'],
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
    const before = await rowOf(ctx, whose);
    // A screen from before the voice, the day's report or the networks sends none: the ones kept stay.
    const kept = settingsOf(before, rules);
    const s: AutomationSettings = {
      ...input.settings,
      voice: input.settings.voice ?? kept.voice,
      dayReport: input.settings.dayReport ?? kept.dayReport,
      networks: input.settings.networks ?? kept.networks,
    };
    const refused = notAllowedWords(s, rules);
    if (refused) throw HfosError.rule('not_allowed', 403, refused);
    // Choosing Sending (b), or Replies (b) or (c), starts the training wheels, once, on each network on its own.
    const wheels = wheelsMatter(s) && !before?.wheelsFrom ? { wheelsFrom: at } : {};
    const networkWheels = { ...(before?.networkWheels ?? {}) };
    for (const p of OTHER_PLATFORMS)
      if (wheelsMatter(s.networks[p]) && !networkWheels[p]?.from)
        networkWheels[p] = { from: at.toISOString(), ok: 0, edits: [], doneAt: null };
    const values = {
      ...wheels,
      networks: s.networks,
      networkWheels,
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
      dayReport: s.dayReport,
      voiceShorthand: s.voice.shorthand,
      voiceAcronyms: s.voice.acronyms,
      voiceEmoji: s.voice.emoji,
      voiceSplit: s.voice.split,
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
        networks: Object.fromEntries(
          (['facebook', ...OTHER_PLATFORMS] as const).map((p) => [p, choicesFor(s, p).on]),
        ),
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
    'An owner or admin ends someone’s training wheels early on one network: their messages there go without waiting for them, and their daily limits there are full again.',
  risk: 1,
  input: WheelsEndInput,
  output: WheelsEndOutput,
  permission: 'outreach.manage',
  scope: inWorkspace,
  emits: ['outreach.wheels.ended'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const at = changeMoment(ctx.meta);
    const ended = async (id: string) => {
      await ctx.emit({
        type: 'outreach.wheels.ended',
        entityType: 'outreach_automation',
        entityId: id,
        payload: { userId: input.userId, platform: input.platform },
      });
      return { userId: input.userId, ended: true };
    };
    if (input.platform === 'facebook') {
      const [row] = await ctx.tx
        .update(automation)
        .set({ wheelsDoneAt: at, updatedAt: at })
        .where(
          and(
            eq(automation.workspaceId, ctx.scope.workspaceId!),
            eq(automation.userId, input.userId),
            isNotNull(automation.wheelsFrom),
            sql`${automation.wheelsDoneAt} is null`,
          ),
        )
        .returning({ id: automation.id });
      return row ? ended(row.id) : { userId: input.userId, ended: false };
    }
    const row = await rowOf(ctx, input.userId);
    const kept = row?.networkWheels[input.platform];
    if (!row || !kept?.from || kept.doneAt) return { userId: input.userId, ended: false };
    await ctx.tx
      .update(automation)
      .set({
        networkWheels: withWheels(row, input.platform, { ...kept, doneAt: at.toISOString() }),
        updatedAt: at,
      })
      .where(eq(automation.id, row.id));
    return ended(row.id);
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
      .where(eq(automation.workspaceId, ctx.scope.workspaceId!));
    return {
      people: kept
        .flatMap(({ row, fullName, email }) =>
          (['facebook', ...OTHER_PLATFORMS] as const).map((platform) => ({
            userId: row.userId,
            name: fullName || email,
            platform,
            wheels: stateOf(row, rules, now, platform),
          })),
        )
        .filter((p) => p.wheels.on)
        .sort((a, b) => a.name.localeCompare(b.name) || a.platform.localeCompare(b.platform)),
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
