/**
 * Get ready for your best results (../readiness.ts; docs/outreach.md, decision 63): where each item stands for the
 * person, worked out each time from what's kept, and their own two: the profile items they tick, and their numbers.
 * `readinessFor` is what Start my day, Today's list and the extension's own helpful posts ask before anything
 * outreach-like happens. Each person reads and writes only their own.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { mainOffers, mainOfferVersions } from '@hfos/db/schema';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import { MainOfferParts } from '../../../main-offer/parts';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { dayList } from '../automation';
import { DAILY_LIMITS } from '../limits';
import { outreachAddon } from '../manifest';
import { MessageSamples } from '../conversation';
import { ProfileCheck } from '../profile-check';
import {
  MessageSamplesSaveInput,
  MessagesOkInput,
  NumbersInput,
  ProfileCheckSaveInput,
  ProfileTickInput,
  ProfileTicks,
  readinessOf,
  ReadinessInput,
  ReadinessOutput,
  type Readiness,
} from '../readiness';
import type { OtherPlatform } from '../automation';
import type { Platform } from '../networks';
import { automation, setup, type NetworkProfileKept, type NetworkProfilesKept } from '../tables';
import { automationOf } from './automation';
import { inWorkspace, type Ctx } from './common';
import { playbooksInUse } from './friends';

/** The main offer's live version and the one before it, as the readiness reads them. */
async function liveOffer(ctx: Ctx) {
  const ws = ctx.scope.workspaceId!;
  const [kept] = await ctx.tx
    .select({ live: mainOffers.liveVersion })
    .from(mainOffers)
    .where(eq(mainOffers.workspaceId, ws));
  const live = kept?.live ?? null;
  if (live === null) return null;
  const versions = await ctx.tx
    .select({
      version: mainOfferVersions.version,
      parts: mainOfferVersions.parts,
      line: mainOfferVersions.line,
    })
    .from(mainOfferVersions)
    .where(
      and(
        eq(mainOfferVersions.workspaceId, ws),
        inArray(mainOfferVersions.version, live > 1 ? [live, live - 1] : [live]),
      ),
    )
    .orderBy(desc(mainOfferVersions.version));
  const now = versions.find((v) => v.version === live);
  if (!now) return null;
  const before = versions.find((v) => v.version === live - 1);
  const read = (parts: unknown) => MainOfferParts.safeParse(parts).data ?? MainOfferParts.parse({});
  return {
    version: live,
    line: now.line,
    parts: read(now.parts),
    before: before ? read(before.parts) : null,
  };
}

/** A network's profile as kept: Facebook's in its own columns, every other network's in `network_profiles`. */
function profileOf(row: Awaited<ReturnType<typeof setupRow>>, platform: Platform) {
  const kept = platform === 'facebook' ? null : row?.networkProfiles?.[platform];
  const ticks = platform === 'facebook' ? row?.profile : kept?.ticks;
  const check = platform === 'facebook' ? row?.profileCheck : kept?.check;
  return {
    ticks: ProfileTicks.safeParse(ticks ?? {}).data ?? {},
    check: ProfileCheck.safeParse(check ?? null).data ?? null,
  };
}

/** Every other network's profiles with one network's changed: what `network_profiles` keeps next. */
function withProfile(
  row: Awaited<ReturnType<typeof setupRow>>,
  platform: OtherPlatform,
  change: Partial<NetworkProfileKept>,
): NetworkProfilesKept {
  const all = row?.networkProfiles ?? {};
  return { ...all, [platform]: { ...all[platform], ...change } };
}

async function setupRow(ctx: Ctx, me: string) {
  const [row] = await ctx.tx
    .select()
    .from(setup)
    .where(and(eq(setup.workspaceId, ctx.scope.workspaceId!), eq(setup.userId, me)));
  return row;
}

/** Everything Get ready shows the person, and whether they're ready (the worker asking on their behalf counts as them). */
export async function readinessFor(
  ctx: Ctx,
  me: string,
  platform: Platform = 'facebook',
): Promise<ReadinessOutput> {
  const [offer, playbooks, row, auto] = await Promise.all([
    liveOffer(ctx),
    playbooksInUse(ctx, platform),
    setupRow(ctx, me),
    automationOf(ctx, me),
  ]);
  // The network's own profile: a LinkedIn day waits on LinkedIn's, never on Facebook's.
  const { ticks: profile, check: profileCheck } = profileOf(row, platform);
  const samples = MessageSamples.safeParse(row?.messageSamples ?? null).data ?? null;
  const messages = row?.messagesAt
    ? { at: row.messagesAt.toISOString(), version: row.messagesVersion ?? null }
    : null;
  const numbers = {
    goal: row?.callsGoal ?? null,
    at: row?.numbersAt?.toISOString() ?? null,
  };
  const r: Readiness = readinessOf({
    offer,
    playbooks: playbooks.map((p) => ({
      name: p.name,
      niche: p.details.niche ?? null,
      problem: p.details.problem ?? null,
      proof: p.details.proof ?? [],
      videoLink: p.details.videoLink ?? null,
    })),
    profile,
    profileCheck,
    platform,
    messages,
    numbers,
    canOffer: scopeCan(ctx.scope, 'main_offer.manage' as Permission),
    canPlaybooks: scopeCan(ctx.scope, 'outreach.manage' as Permission),
  });
  return {
    ...r,
    platform,
    items: [...r.items],
    changed: [...r.changed],
    offer: offer ? { version: offer.version, line: offer.line } : null,
    profile,
    profileCheck,
    messages: { at: messages?.at ?? null, version: messages?.version ?? null, samples },
    numbers: {
      ...numbers,
      days: dayList(auto.settings.hours.days),
      canSend: Math.min(
        DAILY_LIMITS.first_message,
        auto.rules.dailyLimits.first_message ?? DAILY_LIMITS.first_message,
      ),
    },
  };
}

/** The person asking: only a person gets ready. */
function meOf(ctx: Ctx): string {
  const me = userIdOf(ctx.actor);
  if (!me) throw HfosError.forbidden('Only a person gets ready for Social Outreach.');
  return me;
}

export const readinessGet = defineAddonQuery(outreachAddon, {
  name: 'outreach.readiness',
  description:
    'Get ready for your best results: where each of the person’s items stands before the extension reaches anyone for them (the business’s main offer, a playbook with a niche, their profile, their numbers), what’s left of each, and their goal and working days.',
  input: ReadinessInput,
  output: ReadinessOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    return readinessFor(ctx, meOf(ctx), input.platform);
  },
});

export const readinessProfile = defineAddonCommand(outreachAddon, {
  name: 'outreach.readiness.profile',
  description:
    'The person ticks an item on their Facebook profile list as done (or takes it back), against the main offer live now.',
  risk: 0,
  input: ProfileTickInput,
  output: ReadinessOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.readiness.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [row, offer] = await Promise.all([setupRow(ctx, me), liveOffer(ctx)]);
    const ticks: ProfileTicks = { ...profileOf(row, input.platform).ticks };
    if (input.done) ticks[input.item] = { at: at.toISOString(), version: offer?.version ?? null };
    else delete ticks[input.item];
    // Facebook's in its column, every other network's in its own place in `network_profiles`.
    const set =
      input.platform === 'facebook'
        ? { profile: ticks }
        : { networkProfiles: withProfile(row, input.platform, { ticks }) };
    const [kept] = await ctx.tx
      .insert(setup)
      .values({ workspaceId: ws, userId: me, ...set, updatedAt: at })
      .onConflictDoUpdate({
        target: [setup.workspaceId, setup.userId],
        set: { ...set, updatedAt: at },
      })
      .returning({ id: setup.id });
    await ctx.emit({
      type: 'outreach.readiness.saved',
      entityType: 'outreach_setup',
      entityId: kept!.id,
      payload: { userId: me, part: 'profile', platform: input.platform },
    });
    return readinessFor(ctx, me, input.platform);
  },
});

export const readinessNumbers = defineAddonCommand(outreachAddon, {
  name: 'outreach.readiness.numbers',
  description:
    'The person sets their goal for calls booked a month and the days they work (kept in their working hours), having seen what it takes each day.',
  risk: 0,
  input: NumbersInput,
  output: ReadinessOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.readiness.saved', 'outreach.automation.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [kept] = await ctx.tx
      .insert(setup)
      .values({ workspaceId: ws, userId: me, callsGoal: input.goal, numbersAt: at, updatedAt: at })
      .onConflictDoUpdate({
        target: [setup.workspaceId, setup.userId],
        set: { callsGoal: input.goal, numbersAt: at, updatedAt: at },
      })
      .returning({ id: setup.id });
    // The days are their working hours': changed here, they're the person's own choice, kept with the rest of their
    // settings (the business's defaults until now, when they had none of their own).
    const { settings: s } = await automationOf(ctx, me);
    const days = dayList(input.days);
    if (days.join() !== dayList(s.hours.days).join()) {
      const [row] = await ctx.tx
        .insert(automation)
        .values({
          workspaceId: ws,
          userId: me,
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
          days,
          noting: s.noting,
          readChats: s.readChats,
          markPosts: s.markPosts,
          pushes: s.pushes,
          dayReport: s.dayReport,
          voiceShorthand: s.voice.shorthand,
          voiceAcronyms: s.voice.acronyms,
          voiceEmoji: s.voice.emoji,
          voiceSplit: s.voice.split,
          changedBy: null,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [automation.workspaceId, automation.userId],
          set: { days, changedBy: null, updatedAt: at },
        })
        .returning();
      await ctx.emit({
        type: 'outreach.automation.saved',
        entityType: 'outreach_automation',
        entityId: row!.id,
        payload: {
          userId: me,
          sending: s.sending,
          replies: s.replies,
          warmUp: s.warmUp,
          confirmRequests: s.confirmRequests,
          collect: s.collect,
          byOther: false,
        },
      });
    }
    await ctx.emit({
      type: 'outreach.readiness.saved',
      entityType: 'outreach_setup',
      entityId: kept!.id,
      payload: { userId: me, part: 'numbers' },
    });
    return readinessFor(ctx, me);
  },
});

/**
 * The AI's check of the person's own profile, which the extension read (../profile-check.ts, decision 64): the worker's
 * alone, after the AI answers. Only the answer is kept; what the page said never reaches here.
 */
export const profileCheckSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.profile.check_save',
  description:
    'Keeps the AI’s check of a person’s own Facebook profile, read by their extension: each item right or not and what to change, bios to pick from, a cover line and what to feature.',
  risk: 0,
  input: ProfileCheckSaveInput,
  output: ReadinessOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.readiness.saved'],
  async handler(ctx, input) {
    const at = changeMoment(ctx.meta);
    const set =
      input.platform === 'facebook'
        ? { profileCheck: input.check }
        : {
            networkProfiles: withProfile(await setupRow(ctx, input.userId), input.platform, {
              check: input.check,
            }),
          };
    const [kept] = await ctx.tx
      .insert(setup)
      .values({ workspaceId: ctx.scope.workspaceId!, userId: input.userId, ...set, updatedAt: at })
      .onConflictDoUpdate({
        target: [setup.workspaceId, setup.userId],
        set: { ...set, updatedAt: at },
      })
      .returning({ id: setup.id });
    await ctx.emit({
      type: 'outreach.readiness.saved',
      entityType: 'outreach_setup',
      entityId: kept!.id,
      payload: { userId: input.userId, part: 'profile_check', platform: input.platform },
    });
    return readinessFor(ctx, input.userId, input.platform);
  },
});

/**
 * Your messages (decisions 65 to 67): the person OKs how the sample messages for their playbook read, against the main
 * offer live now. Refused before they've seen any, or with no offer live.
 */
export const readinessMessages = defineAddonCommand(outreachAddon, {
  name: 'outreach.readiness.messages',
  description:
    'The person OKs how their messages read, having seen the samples the AI wrote for their playbook (the first message, the video, the link, the follow-ups and a check-in), against the main offer live now.',
  risk: 0,
  input: MessagesOkInput,
  output: ReadinessOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.readiness.saved'],
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [row, offer] = await Promise.all([setupRow(ctx, me), liveOffer(ctx)]);
    if (!offer)
      throw HfosError.rule(
        'outreach_messages_no_offer',
        422,
        'Your business’s main offer isn’t live yet, so there are no messages to see. Ask an owner of this business to finish it under Settings → Main offer.',
      );
    const samples = MessageSamples.safeParse(row?.messageSamples ?? null).data ?? null;
    if (!samples || samples.version !== offer.version)
      throw HfosError.rule(
        'outreach_messages_unseen',
        422,
        'See your sample messages first: press Write samples under Your messages, read them, then OK them.',
      );
    const [kept] = await ctx.tx
      .update(setup)
      .set({ messagesAt: at, messagesVersion: offer.version, updatedAt: at })
      .where(and(eq(setup.workspaceId, ws), eq(setup.userId, me)))
      .returning({ id: setup.id });
    await ctx.emit({
      type: 'outreach.readiness.saved',
      entityType: 'outreach_setup',
      entityId: kept!.id,
      payload: { userId: me, part: 'messages' },
    });
    return readinessFor(ctx, me);
  },
});

/** The samples the AI wrote for a person's Your messages: the worker's alone, after the AI answers. */
export const messageSamplesSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.messages.samples_save',
  description:
    'Keeps the sample messages the AI wrote for a person’s playbook, for Get ready’s Your messages: first messages, the video, the link, the follow-ups and a check-in, to someone made up.',
  risk: 0,
  input: MessageSamplesSaveInput,
  output: ReadinessOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.readiness.saved'],
  async handler(ctx, input) {
    const at = changeMoment(ctx.meta);
    const [kept] = await ctx.tx
      .insert(setup)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        userId: input.userId,
        messageSamples: input.samples,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [setup.workspaceId, setup.userId],
        set: { messageSamples: input.samples, updatedAt: at },
      })
      .returning({ id: setup.id });
    await ctx.emit({
      type: 'outreach.readiness.saved',
      entityType: 'outreach_setup',
      entityId: kept!.id,
      payload: { userId: input.userId, part: 'message_samples' },
    });
    return readinessFor(ctx, input.userId);
  },
});

export const readinessCommands = [
  readinessProfile,
  readinessNumbers,
  profileCheckSave,
  readinessMessages,
  messageSamplesSave,
] as const;
export const readinessQueries = [readinessGet] as const;
