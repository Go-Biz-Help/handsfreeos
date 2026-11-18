/**
 * What each person does and where, and the person's own town, radius and local focus (../local.ts, docs/outreach.md
 * decision 177), server side: towns are the US Census Bureau's (./towns.ts), so how far apart two are needs no lookup.
 * Server-only.
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import { businessAddressOf } from '../../../onboarding-setup/address';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  areaOfTown,
  LOCAL_WORDS,
  LocationGetInput,
  LocationSetInput,
  LocationShown,
  NEAR_SHOWN,
  RADIUS_START,
  TheirWorkNoteInput,
  TheirWorkNoteOutput,
  TheirWorkSetInput,
  TheirWorkSetOutput,
  townName,
  townOfArea,
  type AreaHow,
  type Reach,
  type TheirWork,
  type TheirWorkShown,
} from '../local';
import { outreachAddon } from '../manifest';
import { automation, profiles } from '../tables';
import { inWorkspace } from './common';
import { knownTown, milesBetweenTowns, townsNear } from './towns';

type Ctx = CommandContext | QueryContext;

/** The person's own town, radius and local focus: the defaults until they set them. */
export interface Local {
  readonly area: string | null;
  readonly town: string | null;
  readonly radiusMiles: number;
  readonly localFocus: boolean;
}

export async function localOf(ctx: Ctx, userId: string): Promise<Local> {
  const [row] = await rows<{
    home_area: string | null;
    home_town: string | null;
    radius_miles: number;
    local_focus: boolean;
  }>(
    ctx.tx,
    sql`select home_area, home_town, radius_miles, local_focus from addon_outreach.automation
        where workspace_id = ${ctx.scope.workspaceId!} and user_id = ${userId}`,
  );
  return {
    area: row?.home_area ?? null,
    town: row?.home_town ?? null,
    radiusMiles: row?.radius_miles ?? RADIUS_START,
    localFocus: row?.local_focus ?? false,
  };
}

/**
 * The towns local to the person while they focus on local groups (3): theirs first, then those inside their radius,
 * the closest first. Null while the focus is off or they have no town.
 */
export async function localTowns(ctx: Ctx, userId: string): Promise<string[] | null> {
  const local = await localOf(ctx, userId);
  return local.localFocus && local.town
    ? [local.town, ...townsNear(local.town, local.radiusMiles)]
    : null;
}

/** What they do and where as a profile keeps it, with how far it is from the person, for their card and a draft. */
export function theirWorkShown(
  row: {
    readonly work: string | null;
    readonly area: string | null;
    readonly town: string | null;
    readonly reach: string | null;
    readonly area_how: string | null;
  },
  local: Pick<Local, 'town' | 'radiusMiles'>,
): TheirWorkShown {
  const miles = milesBetweenTowns(local.town, row.town);
  return {
    work: row.work,
    area: row.area,
    reach: (row.reach as Reach | null) ?? null,
    how: (row.area_how as AreaHow | null) ?? null,
    miles: miles === null ? null : Math.round(miles),
    near: miles !== null && miles <= local.radiusMiles,
  };
}

const PROFILE_WORK = sql`work, area, town, reach, area_how`;

async function shownFor(ctx: Ctx, userId: string, profileId: string): Promise<TheirWorkShown> {
  const [row] = await rows<Parameters<typeof theirWorkShown>[0]>(
    ctx.tx,
    sql`select ${PROFILE_WORK} from addon_outreach.profiles
        where workspace_id = ${ctx.scope.workspaceId!} and id = ${profileId}`,
  );
  if (!row) throw HfosError.rule('outreach_profile_gone', 404, LOCAL_WORDS.profileGone);
  return theirWorkShown(row, await localOf(ctx, userId));
}

/** What a person typed of where they work, as a known town: refused, with how to write it, when it isn't one. */
function townTyped(area: string): string {
  const town = knownTown(townOfArea(area));
  if (!town) throw HfosError.rule('outreach_unknown_town', 400, LOCAL_WORDS.unknownTown(area));
  return town;
}

export const theirWorkSet = defineAddonCommand(outreachAddon, {
  name: 'outreach.their_work.set',
  description:
    'Change what someone in Social Outreach does and where (their card’s What they do and where): their line of work, the US town they work in with its state (“Austin, TX”), and whether they serve customers locally, nationwide or online. What a person sets, the AI never writes over. Empty clears a part; a part left out stays.',
  risk: 1,
  input: TheirWorkSetInput,
  output: TheirWorkSetOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_set_their_work',
    autonomy: 'confirm',
    keywords: ['what they do', 'where they work', 'their town', 'local business'],
  },
  scope: inWorkspace,
  emits: ['outreach.their_work.set'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const area = input.area === undefined ? undefined : input.area?.trim() || null;
    const town = area ? townTyped(area) : area === null ? null : undefined;
    const [row] = await ctx.tx
      .update(profiles)
      .set({
        ...(input.work !== undefined ? { work: input.work?.trim() || null } : {}),
        ...(area !== undefined ? { area: town ? areaOfTown(town) : null, town } : {}),
        ...(input.reach !== undefined ? { reach: input.reach } : {}),
        areaHow: 'typed',
        areaAt: at,
        areaBy: me,
        updatedAt: at,
      })
      .where(
        and(eq(profiles.workspaceId, ctx.scope.workspaceId!), eq(profiles.id, input.profileId)),
      )
      .returning({ id: profiles.id });
    if (!row) throw HfosError.rule('outreach_profile_gone', 404, LOCAL_WORDS.profileGone);
    await ctx.emit({
      type: 'outreach.their_work.set',
      entityType: 'outreach_profile',
      entityId: input.profileId,
      payload: { profileId: input.profileId },
    });
    return { profileId: input.profileId, shown: await shownFor(ctx, me, input.profileId) };
  },
});

/**
 * What the AI read of what they do and where (1a), kept on their profile: it fills what isn't known and keeps what's
 * newer, never writing over what a person typed, and never clears anything. Whether anything was kept.
 */
export async function noteTheirWork(
  ctx: CommandContext,
  profileId: string,
  how: 'page' | 'chat',
  them: TheirWork,
): Promise<boolean> {
  if (!them.work && !them.area && !them.reach) return false;
  // A town the AI named that isn't a known one is kept as it reads, with no town to measure from.
  const town = knownTown(townOfArea(them.area));
  const area = town ? areaOfTown(town) : them.area;
  const at = changeMoment(ctx.meta).toISOString();
  const set = await rows<{ id: string }>(
    ctx.tx,
    sql`update addon_outreach.profiles set
          work = coalesce(${them.work}, work),
          area = coalesce(${area}, area),
          town = case when ${area}::text is null then town else ${town} end,
          reach = coalesce(${them.reach}, reach),
          area_how = case when area_how = 'chat' and ${how} = 'page' then 'chat' else ${how} end,
          area_at = ${at}::timestamptz,
          updated_at = ${at}::timestamptz
        where workspace_id = ${ctx.scope.workspaceId!} and id = ${profileId}
          and area_how is distinct from 'typed'
        returning id`,
  );
  return set.length > 0;
}

/**
 * Worker: what the AI read of what they do and where, from their page or the chat (1a).
 */
export const theirWorkNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.their_work.note',
  description:
    'Worker: what the AI read of what someone does and where, from their page or the chat: their line of work, their town, and whether they serve customers locally, nationwide or online. Never writes over what a person set, and never clears anything.',
  risk: 0,
  input: TheirWorkNoteInput,
  output: TheirWorkNoteOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    return { saved: await noteTheirWork(ctx, input.profileId, input.how, input.them) };
  },
});

export const locationGet = defineAddonQuery(outreachAddon, {
  name: 'outreach.location.get',
  description:
    'The person’s own town in Social Outreach (Settings → You → Where you are), how far from it is local to them, whether Focus on local groups is on, and the towns inside that radius; with the business’s town to start from when they haven’t set theirs.',
  input: LocationGetInput,
  output: LocationShown,
  permission: 'outreach.use',
  ai: { tool: 'outreach_location', keywords: ['my town', 'local radius', 'local groups'] },
  scope: inWorkspace,
  async handler(ctx) {
    return locationShown(ctx, requireHuman(ctx).userId);
  },
});

async function locationShown(ctx: Ctx, userId: string): Promise<LocationShown> {
  const local = await localOf(ctx, userId);
  const near = local.town ? townsNear(local.town, local.radiusMiles) : [];
  const [ws] = await rows<{ settings: Record<string, unknown> | null }>(
    ctx.tx,
    sql`select settings from app.workspaces where id = ${ctx.scope.workspaceId!}`,
  );
  const address = businessAddressOf(ws?.settings ?? null);
  const suggested = address ? knownTown(townOfArea(`${address.city}, ${address.state}`)) : null;
  return {
    area: local.area,
    suggested: suggested ? areaOfTown(suggested) : null,
    radiusMiles: local.radiusMiles,
    localFocus: local.localFocus,
    near: near.slice(0, NEAR_SHOWN).map(townName),
    nearCount: near.length,
  };
}

export const locationSet = defineAddonCommand(outreachAddon, {
  name: 'outreach.location.set',
  description:
    'Change the person’s own town in Social Outreach (Settings → You → Where you are: a US town and its state, like “Dallas, TX”), how many miles from it is local to them (5 to 100), or Focus on local groups, which adds their town and the towns near it to group searches, ranks local groups higher and puts people who work near them first on Today. A part left out stays.',
  risk: 1,
  input: LocationSetInput,
  output: LocationShown,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_set_location',
    autonomy: 'confirm',
    keywords: ['my town', 'local radius', 'focus on local groups'],
  },
  scope: inWorkspace,
  emits: ['outreach.location.set'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const area = input.area === undefined ? undefined : input.area?.trim() || null;
    const town = area ? townTyped(area) : area === null ? null : undefined;
    const was = await localOf(ctx, me);
    // Clearing the town turns the focus off: there's nothing to be local to.
    const focus = town === null ? false : (input.localFocus ?? was.localFocus);
    if (focus && !(town === undefined ? was.town : town))
      throw HfosError.rule('outreach_local_needs_town', 400, LOCAL_WORDS.focusNeedsTown);
    const values = {
      ...(town !== undefined ? { homeArea: town ? areaOfTown(town) : null, homeTown: town } : {}),
      ...(input.radiusMiles !== undefined ? { radiusMiles: input.radiusMiles } : {}),
      ...(town === null || input.localFocus !== undefined ? { localFocus: focus } : {}),
      changedBy: me,
      updatedAt: at,
    };
    const [row] = await ctx.tx
      .insert(automation)
      .values({ workspaceId: ws, userId: me, ...values })
      .onConflictDoUpdate({ target: [automation.workspaceId, automation.userId], set: values })
      .returning({ id: automation.id });
    const shown = await locationShown(ctx, me);
    await ctx.emit({
      type: 'outreach.location.set',
      entityType: 'outreach_automation',
      entityId: row!.id,
      payload: {
        userId: me,
        area: shown.area,
        radiusMiles: shown.radiusMiles,
        localFocus: shown.localFocus,
      },
    });
    return shown;
  },
});

export const localCommands = [theirWorkSet, theirWorkNote, locationSet] as const;
export const localQueries = [locationGet] as const;
