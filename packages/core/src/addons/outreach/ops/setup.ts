/**
 * Social Outreach's setup (../setup.ts, docs/outreach.md decisions 36, 45 and 83): where each of the person's steps
 * stands, worked out from facts, and what the steps show (the playbooks in use, their groups, the computer that works,
 * and where to download the extension). Each person reads and writes only their own: neither takes a `userId`.
 */
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { choicesFor, NO_RULES } from '../automation';
import { outreachSettings } from '../chat-read';
import { bestGroupFit } from '../groups';
import { outreachAddon } from '../manifest';
import { networksShown } from '../network-words';
import { PLATFORM_KEYS } from '../networks';
import { runsOn } from '../playbooks';
import { allowedOn } from '../reports';
import {
  businessStates,
  isFirstTime,
  networkStepStates,
  SETUP_GROUPS_SHOWN,
  SETUP_REACHED,
  SetupInput,
  SetupOutput,
  SetupSaveInput,
  SetupSaveOutput,
  setupNext,
  setupStepStates,
  setupSteps,
  showsSetupBanner,
  type SetupFacts,
} from '../setup';
import { days, groups, myGroups, playbooks, setup } from '../tables';
import { automationOf } from './automation';
import { inWorkspace, type Ctx } from './common';
import { playbooksInUse } from './friends';
import { myComputers, workingOf } from './live';
import { readinessFor } from './readiness';

type Row = typeof setup.$inferSelect;

/** The person asking: only a person has their own setup. */
function meOf(ctx: Ctx): string {
  const me = userIdOf(ctx.actor);
  if (!me) throw HfosError.forbidden('Only a person has their own Social Outreach setup.');
  return me;
}

async function rowOf(ctx: Ctx, me: string): Promise<Row | undefined> {
  const [row] = await ctx.tx
    .select()
    .from(setup)
    .where(and(eq(setup.workspaceId, ctx.scope.workspaceId!), eq(setup.userId, me)));
  return row;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const filled = (v: string | null | undefined) => Boolean(v?.trim());

/** Everything the setup's steps show the person, and where each stands. */
async function shownSetup(ctx: Ctx, me: string, row: Row | undefined): Promise<SetupOutput> {
  const ws = ctx.scope.workspaceId!;
  const canManage = scopeCan(ctx.scope, 'outreach.manage' as Permission);
  const [inUse, [mine], [business], [installed], latest, fitting, auto, computers, started] =
    await Promise.all([
      ctx.tx
        .select({ id: playbooks.id, name: playbooks.name, template: playbooks.template })
        .from(playbooks)
        .where(and(eq(playbooks.workspaceId, ws), isNull(playbooks.archivedAt)))
        .orderBy(playbooks.createdAt),
      ctx.tx
        .select({ n: count() })
        .from(myGroups)
        .where(
          and(eq(myGroups.workspaceId, ws), eq(myGroups.userId, me), eq(myGroups.joined, true)),
        ),
      ctx.tx.select({ n: count() }).from(groups).where(eq(groups.workspaceId, ws)),
      rows<{ settings: unknown }>(
        ctx.tx,
        sql`select settings from app.addon_installations
            where workspace_id = ${ws} and addon_id = ${outreachAddon.id}`,
      ),
      // The groups they're in that the extension saw last.
      ctx.tx
        .select({
          groupId: groups.id,
          name: groups.name,
          detail: groups.detail,
          members: groups.members,
          privacy: groups.privacy,
        })
        .from(myGroups)
        .innerJoin(groups, eq(groups.id, myGroups.groupId))
        .where(
          and(eq(myGroups.workspaceId, ws), eq(myGroups.userId, me), eq(myGroups.joined, true)),
        )
        .orderBy(desc(myGroups.seenAt))
        .limit(SETUP_GROUPS_SHOWN),
      playbooksInUse(ctx),
      automationOf(ctx, me),
      myComputers(ctx, me),
      // A day kept on a network means one started there.
      ctx.tx
        .select({ platform: days.platform })
        .from(days)
        .where(and(eq(days.workspaceId, ws), eq(days.userId, me))),
    ]);
  // Their own save, ever: an owner or admin saving them for them doesn't count as choosing, nor undo it.
  const settingsSaved = Boolean(row?.settingsAt);
  const kept = row ?? null;
  const stored = installed?.settings;
  const business_ = outreachSettings(stored);
  // The install stores the starting rules: kept in the setup, or changed from those, says someone looked at them.
  const rulesSaved =
    business_.rulesKept || JSON.stringify(business_.rules) !== JSON.stringify(NO_RULES);
  const details = new Map(fitting.map((p) => [p.id, p.details]));
  const networks = networksShown(auto.settings, auto.rules.networksAllowed);
  const working = workingOf(computers);
  const readies = new Map(
    await Promise.all(
      [...new Set(['facebook' as const, ...networks])].map(
        async (p) => [p, await readinessFor(ctx, me, p)] as const,
      ),
    ),
  );
  const facts: SetupFacts = {
    canManage,
    extensionAt: iso(row?.extensionAt ?? null),
    settingsSaved,
    rulesSaved,
    video: fitting.some((p) => filled(p.details.videoLink)),
    noVideo: business_.noVideo,
    ready: readies.get('facebook')!.items,
    networks: networks.map((platform) => ({
      platform,
      // Facebook's is let on as it's put in; a build that doesn't say which reads as allowed (./reports.ts).
      allowed:
        platform === 'facebook' || (working !== null && allowedOn(working.allowed, platform)),
      ready: readies.get(platform)!.items,
      sending: choicesFor(auto.settings, platform).sending,
      started: started.some((d) => d.platform === platform),
    })),
  };
  const states = setupStepStates(facts);
  const shownNetworks = facts.networks.map((n) => ({
    platform: n.platform,
    steps: networkStepStates(facts, n),
  }));
  const next = setupNext({ states, networks: shownNetworks });
  return {
    steps: setupSteps(canManage),
    states,
    business: businessStates(facts),
    networks: shownNetworks,
    next,
    reached: row?.reached ?? null,
    startedAt: iso(row?.startedAt ?? null),
    finishedAt: iso(row?.finishedAt ?? null),
    extensionAt: iso(row?.extensionAt ?? null),
    computer: working?.name ?? null,
    settingsSaved,
    firstTime: isFirstTime(kept, settingsSaved),
    banner: showsSetupBanner(kept, settingsSaved, next !== null),
    canManage,
    sendingAllowedMore: auto.rules.sendingAllowed.some((m) => m !== 'off'),
    playbooks: inUse.map((p) => {
      const d = details.get(p.id);
      return {
        id: p.id,
        name: p.name,
        template: p.template,
        niche: Boolean(d && filled(d.niche) && filled(d.problem)),
        video: Boolean(d && filled(d.videoLink)),
        networks: d ? networksOf(d) : [],
      };
    }),
    noVideo: business_.noVideo,
    groups: {
      mine: Number(mine?.n ?? 0),
      business: Number(business?.n ?? 0),
      latest: latest.map((g) => ({
        groupId: g.groupId,
        name: g.name,
        verdict: bestGroupFit(fitting, { ...g, joined: true }).verdict,
      })),
    },
    extensionLink: business_.extensionLink,
  };
}

const networksOf = (d: Parameters<typeof runsOn>[0]) => PLATFORM_KEYS.filter((p) => runsOn(d, p));

export const setupGet = defineAddonQuery(outreachAddon, {
  name: 'outreach.setup',
  description:
    'The person’s own Social Outreach setup: where each of their steps stands (the main setup’s and each network’s), the next one left, whether the extension signed in, whether they saved their settings, the playbooks in use, their groups saved, and where to download the extension.',
  input: SetupInput,
  output: SetupOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx) {
    const me = meOf(ctx);
    return shownSetup(ctx, me, await rowOf(ctx, me));
  },
});

export const setupSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.setup.save',
  description:
    'The person started the Social Outreach setup or left it for later, a first day started from it, its reminder was hidden, or the extension said it’s signed in.',
  risk: 0,
  input: SetupSaveInput,
  output: SetupSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.setup.saved'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const me = meOf(ctx);
    const ws = ctx.scope.workspaceId!;
    const before = await rowOf(ctx, me);
    const at = changeMoment(ctx.meta);
    // The extension signing in says nothing about the setup: only the person moving on, or leaving it, starts it.
    const starts = Boolean(input.reached || input.finished || input.started);
    // Each save only moves its own parts forward, merged in the database, so two at once (the extension's report
    // and the person pressing Next) never put back what the other saved.
    const order = sql.raw(`array[${SETUP_REACHED.map((step) => `'${step}'`).join(', ')}]::text[]`);
    const [row] = await ctx.tx
      .insert(setup)
      .values({
        workspaceId: ws,
        userId: me,
        reached: input.reached ?? null,
        startedAt: starts ? at : null,
        finishedAt: input.finished ? at : null,
        bannerHiddenAt: input.hideBanner ? at : null,
        extensionAt: input.extension ? at : null,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [setup.workspaceId, setup.userId],
        set: {
          reached: sql`case
            when excluded.reached is null then ${setup.reached}
            when ${setup.reached} is null then excluded.reached
            when array_position(${order}, excluded.reached) > array_position(${order}, ${setup.reached})
              then excluded.reached
            else ${setup.reached} end`,
          startedAt: sql`coalesce(${setup.startedAt}, excluded.started_at)`,
          finishedAt: sql`coalesce(excluded.finished_at, ${setup.finishedAt})`,
          bannerHiddenAt: sql`coalesce(excluded.banner_hidden_at, ${setup.bannerHiddenAt})`,
          extensionAt: sql`coalesce(excluded.extension_at, ${setup.extensionAt})`,
          updatedAt: at,
        },
      })
      .returning();
    const firstSignIn = input.extension === true && !before?.extensionAt;
    // Only the extension's report that changes nothing anyone sees (a sign-in again, or its check every few hours)
    // stays off the live channel, so colleagues' open tabs don't refetch for someone else's extension.
    const quiet = input.extension === true && !firstSignIn && !starts && !input.hideBanner;
    // Broadcast otherwise, so the setup open in another tab ticks when the extension first signs in.
    await ctx.emit({
      type: 'outreach.setup.saved',
      entityType: 'outreach_setup',
      entityId: row!.id,
      payload: {
        userId: me,
        reached: row!.reached,
        finished: row!.finishedAt !== null,
        extension: input.extension === true,
        firstSignIn,
      },
      ...(quiet ? { broadcast: false } : {}),
    });
    return shownSetup(ctx, me, row);
  },
});

export const setupCommands = [setupSave] as const;
export const setupQueries = [setupGet] as const;
