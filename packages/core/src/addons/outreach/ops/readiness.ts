/**
 * Get ready for your best results (../readiness.ts; docs/outreach.md, decision 63): where each item stands for the
 * person, worked out each time from what's kept, and their own two: the profile items they tick, and their numbers.
 * `readinessFor` is what Start my day, Today's list and the extension's own helpful posts ask before anything
 * outreach-like happens. Each person reads and writes only their own.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { knowledgeSources, mainOffers, mainOfferVersions } from '@hfos/db/schema';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import { MainOfferParts } from '../../../main-offer/parts';
import type { CommandContext } from '../../../kernel/types';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { dayList } from '../automation';
import { outreachAddon } from '../manifest';
import {
  messageNotesOf,
  MessageSamples,
  sampleAt,
  withMineKept,
  withNote,
  withoutNote,
  withSample,
  type MessageNotes,
  type SampleSlot,
} from '../conversation';
import { ProfileCheck } from '../profile-check';
import {
  carriedOver,
  ProfileMoreSaveInput,
  ProfilesInput,
  ProfilesOutput,
  ProfileUsernamesSaveInput,
  withMore,
  withUsernames,
} from '../profile-parts';
import {
  MessageEditInput,
  MessageForgetInput,
  MessageRewriteSaveInput,
  MessageSamplesSaveInput,
  MessagesOkInput,
  NumbersInput,
  numbersPace,
  ProfileCheckSaveInput,
  ProfileTickInput,
  ProfileTicks,
  readinessOf,
  ReadinessInput,
  ReadinessOutput,
  type Readiness,
} from '../readiness';
import type { OtherPlatform } from '../automation';
import { PLATFORM_KEYS, PLATFORMS, type Platform } from '../networks';
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
export function profileOf(row: Awaited<ReturnType<typeof setupRow>>, platform: Platform) {
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

export async function setupRow(ctx: Ctx, me: string) {
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
  // One goal for every network the person works: each one's safe pace counts (decision 88).
  const pace = numbersPace(auto.settings, auto.rules);
  const r: Readiness = readinessOf({
    offer,
    playbooks: playbooks.map((p) => ({
      name: p.name,
      niche: p.details.niche ?? null,
      problem: p.details.problem ?? null,
      proof: p.details.proof ?? [],
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
    messages: {
      at: messages?.at ?? null,
      version: messages?.version ?? null,
      samples,
      notes: messageNotesOf(row?.messageNotes),
    },
    numbers: {
      ...numbers,
      days: dayList(auto.settings.hours.days),
      canSend: pace.canSend,
      networks: [...pace.networks],
      more: [...pace.more],
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
  ai: {
    tool: 'outreach_get_ready',
    keywords: ['get ready', 'profile checklist', 'ready to reach people'],
  },
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
  ai: {
    tool: 'outreach_tick_profile_item',
    keywords: ['profile item done', 'checklist'],
  },
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
  ai: {
    tool: 'outreach_set_goal',
    autonomy: 'confirm',
    keywords: ['calls booked goal', 'days I work', 'monthly goal'],
  },
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
    const row = await setupRow(ctx, input.userId);
    // What the person said they want, and what was written before, stay from check to check (decision 84).
    const check = carriedOver(input.check, profileOf(row, input.platform).check);
    await saveProfileCheck(ctx, row, input.userId, input.platform, check);
    return readinessFor(ctx, input.userId, input.platform);
  },
});

/** Keeps a network's check on the person's setup row: Facebook's in its column, every other's in `network_profiles`. */
async function saveProfileCheck(
  ctx: CommandContext,
  row: Awaited<ReturnType<typeof setupRow>>,
  userId: string,
  platform: Platform,
  check: ProfileCheck,
): Promise<void> {
  const at = changeMoment(ctx.meta);
  const set =
    platform === 'facebook'
      ? { profileCheck: check }
      : { networkProfiles: withProfile(row, platform, { check }) };
  const [kept] = await ctx.tx
    .insert(setup)
    .values({ workspaceId: ctx.scope.workspaceId!, userId, ...set, updatedAt: at })
    .onConflictDoUpdate({
      target: [setup.workspaceId, setup.userId],
      set: { ...set, updatedAt: at },
    })
    .returning({ id: setup.id });
  await ctx.emit({
    type: 'outreach.readiness.saved',
    entityType: 'outreach_setup',
    entityId: kept!.id,
    payload: { userId, part: 'profile_check', platform },
  });
}

const noCheckYet = (platform: Platform) =>
  HfosError.rule(
    'outreach_profile_not_read',
    409,
    `Your ${PLATFORMS[platform]} profile hasn’t been read yet. Press Read my profile first, then ask for more.`,
  );

/**
 * Show me more (decision 84): a round the AI wrote of one part, kept on the person's check, newest first, with their
 * note kept for the next check. The worker's alone, after the AI answers.
 */
export const profileMoreSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.profile.more_save',
  description:
    'Keeps more options the AI wrote for one part of a person’s own profile (its bio, name, username, cover line or About), with what they said they want of it.',
  risk: 0,
  input: ProfileMoreSaveInput,
  output: ProfileCheck,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.readiness.saved'],
  async handler(ctx, input) {
    const row = await setupRow(ctx, input.userId);
    const was = profileOf(row, input.platform).check;
    if (!was) throw noCheckYet(input.platform);
    const check = withMore(was, input.part, input.options, input.note);
    await saveProfileCheck(ctx, row, input.userId, input.platform, check);
    return check;
  },
});

/**
 * What the person's computer found of some usernames (decision 84): each free, taken, or not known, kept on their
 * check. A username they typed themselves is kept with them.
 */
export const profileUsernamesSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.profile.usernames_save',
  description:
    'Keeps whether usernames are free on a network, as the person’s computer found when it opened each one’s address.',
  risk: 0,
  input: ProfileUsernamesSaveInput,
  output: ProfileCheck,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.readiness.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const row = await setupRow(ctx, me);
    const was = profileOf(row, input.platform).check;
    if (!was) throw noCheckYet(input.platform);
    const check = withUsernames(was, input.found);
    await saveProfileCheck(ctx, row, me, input.platform, check);
    return check;
  },
});

/**
 * Every network's latest check of the person's own profile, a booking link from a playbook running on each, and the
 * business's website (decision 84): what the parts, the links to add and side by side are worked out from.
 */
export const profilesGet = defineAddonQuery(outreachAddon, {
  name: 'outreach.profiles',
  description:
    'The person’s own profiles on every network as their latest checks read them, with the booking links and the business’s website, for side by side.',
  input: ProfilesInput,
  output: ProfilesOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_my_profiles',
    keywords: ['my profile', 'bio', 'booking link'],
  },
  scope: inWorkspace,
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const [row, playbooks, site] = await Promise.all([
      setupRow(ctx, me),
      Promise.all(PLATFORM_KEYS.map((p) => playbooksInUse(ctx, p))),
      ctx.tx
        .select({ url: knowledgeSources.url })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.workspaceId, ctx.scope.workspaceId!)),
    ]);
    const entries = <T>(f: (p: Platform, i: number) => T) =>
      Object.fromEntries(PLATFORM_KEYS.map((p, i) => [p, f(p, i)])) as Record<Platform, T>;
    return {
      checks: entries((p) => profileOf(row, p).check),
      booking: entries(
        (_, i) => playbooks[i]!.map((pb) => pb.details.link).find((l): l is string => !!l) ?? null,
      ),
      website: site[0]?.url ?? null,
    };
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
  ai: {
    tool: 'outreach_ok_message_samples',
    autonomy: 'confirm',
    keywords: ['ok sample messages', 'how my messages read'],
  },
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
    // The ones the person wrote themselves stay as they are (decision 87).
    const row = await setupRow(ctx, input.userId);
    const samples = withMineKept(
      input.samples,
      MessageSamples.safeParse(row?.messageSamples ?? null).data ?? null,
    );
    const [kept] = await ctx.tx
      .insert(setup)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        userId: input.userId,
        messageSamples: samples,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [setup.workspaceId, setup.userId],
        set: { messageSamples: samples, updatedAt: at },
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

/** The person's samples as kept, and the one at a slot: refused with none, or once that slot is gone. */
async function sampleOf(ctx: Ctx, me: string, slot: SampleSlot) {
  const row = await setupRow(ctx, me);
  const samples = MessageSamples.safeParse(row?.messageSamples ?? null).data ?? null;
  if (!samples)
    throw HfosError.rule(
      'outreach_messages_unseen',
      422,
      'There are no sample messages to change yet. Press Write samples under Your messages first.',
    );
  if (sampleAt(samples, slot) === null)
    throw HfosError.rule(
      'outreach_message_gone',
      409,
      'That message isn’t in your samples any more, as they were written again. Change it from the ones showing now.',
    );
  return { samples, notes: messageNotesOf(row?.messageNotes) };
}

/** Keeps the person's samples and their notes, and says so. */
async function saveMessages(
  ctx: CommandContext,
  me: string,
  change: { readonly samples?: MessageSamples; readonly notes?: MessageNotes },
  part: 'message_samples' | 'message_notes',
) {
  const at = changeMoment(ctx.meta);
  const [kept] = await ctx.tx
    .update(setup)
    .set({
      ...(change.samples ? { messageSamples: change.samples } : {}),
      ...(change.notes ? { messageNotes: change.notes } : {}),
      updatedAt: at,
    })
    .where(and(eq(setup.workspaceId, ctx.scope.workspaceId!), eq(setup.userId, me)))
    .returning({ id: setup.id });
  await ctx.emit({
    type: 'outreach.readiness.saved',
    entityType: 'outreach_setup',
    entityId: kept!.id,
    payload: { userId: me, part },
  });
  return readinessFor(ctx, me);
}

/**
 * Change (decision 87): one sample in the person's own words, kept as they wrote it when the rest are written again,
 * and followed by their real messages of that part. Refused with the playbook's words to avoid in it, as every message
 * of the playbook keeps them out.
 */
export const messageEdit = defineAddonCommand(outreachAddon, {
  name: 'outreach.messages.edit',
  description:
    'Puts one of the person’s sample messages in their own words: a first message, the video, the link, a follow-up or the check-in. Their real messages of that part follow it.',
  risk: 0,
  input: MessageEditInput,
  output: ReadinessOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_edit_sample_message',
    autonomy: 'confirm',
    keywords: ['my own words', 'edit sample message', 'how my messages read'],
  },
  scope: inWorkspace,
  emits: ['outreach.readiness.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const { samples } = await sampleOf(ctx, me, input);
    const playbook = (await playbooksInUse(ctx)).find((p) => p.id === samples.playbookId);
    const lower = input.text.toLowerCase();
    const avoided = (playbook?.details.avoid ?? []).find(
      (w) => w.trim() && lower.includes(w.trim().toLowerCase()),
    );
    if (avoided && playbook)
      throw HfosError.rule(
        'outreach_message_avoid',
        422,
        `Your playbook “${playbook.name}” keeps “${avoided.trim()}” out of every message. Take it out, or ${
          scopeCan(ctx.scope, 'outreach.manage' as Permission)
            ? 'change Words to avoid on the playbook'
            : 'ask an owner of this business to change the playbook’s Words to avoid'
        }.`,
      );
    return saveMessages(
      ctx,
      me,
      { samples: withSample(samples, input, input.text, true) },
      'message_samples',
    );
  },
});

/** Forget (decision 87): a note on a part of the person's messages that the AI no longer follows. */
export const messageForget = defineAddonCommand(outreachAddon, {
  name: 'outreach.messages.forget',
  description:
    'Lets go of something the person told the AI about a part of their messages, so their samples and real messages no longer follow it.',
  risk: 0,
  input: MessageForgetInput,
  output: ReadinessOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_forget_message_note',
    keywords: ['forget what I told the AI', 'message note'],
  },
  scope: inWorkspace,
  emits: ['outreach.readiness.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const row = await setupRow(ctx, me);
    if (!row) return readinessFor(ctx, me);
    return saveMessages(
      ctx,
      me,
      { notes: withoutNote(messageNotesOf(row.messageNotes), input.part, input.note) },
      'message_notes',
    );
  },
});

/**
 * Not quite right? (decision 87): one sample the AI wrote again on the person's say, and their note on its part, which
 * the next samples and their real messages of that part follow too. The worker's alone, after the AI answers.
 */
export const messageRewriteSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.messages.rewrite_save',
  description:
    'Keeps one sample message the AI wrote again for a person, with what they said they want of that part of their messages.',
  risk: 0,
  input: MessageRewriteSaveInput,
  output: ReadinessOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.readiness.saved'],
  async handler(ctx, input) {
    const { samples, notes } = await sampleOf(ctx, input.userId, input);
    return saveMessages(
      ctx,
      input.userId,
      {
        samples: withSample(samples, input, input.text, false),
        notes: withNote(notes, input.part, input.note),
      },
      'message_samples',
    );
  },
});

export const readinessCommands = [
  readinessProfile,
  readinessNumbers,
  profileCheckSave,
  profileMoreSave,
  profileUsernamesSave,
  readinessMessages,
  messageSamplesSave,
  messageEdit,
  messageForget,
  messageRewriteSave,
] as const;
export const readinessQueries = [readinessGet, profilesGet] as const;
