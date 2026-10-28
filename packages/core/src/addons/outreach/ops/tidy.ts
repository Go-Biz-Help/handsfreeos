/**
 * Tidying the person's own friends, and the networks' warnings (../tidy.ts): the sent requests and friends the
 * extension may cancel or unfriend once the person ticks them, each one it did, and each warning a network showed
 * them. Each person's are their own, and a warning is its network's alone: the others go on. With them, who the
 * extension tidies on its own today (decision 98), as the person picks for the network. On a follow network
 * (Instagram's), who the extension looks at to see whether they followed back (`outreach.follow_backs.next`), so
 * nobody who did is suggested for unfollowing.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { localDateOf, startOfLocalDay } from '../../../calendar/engine/zoned';
import { workspaceTimezone } from '../../../crm/records';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { tidyModeOn } from '../automation';
import { outreachSettings } from '../chat-read';
import { bestFit } from '../fit';
import { limitNow, OWN_TIDY_LIMITS, WARNING_SLOWER_DAYS, type TidyKind } from '../limits';
import {
  FOLLOW_BACK_AFTER_DAYS,
  FOLLOW_BACK_AGAIN_HOURS,
  FollowBacksNextInput,
  FollowBacksNextOutput,
} from '../friends';
import { outreachAddon } from '../manifest';
import { NETWORKS, type Platform } from '../networks';
import { friendEnds, warnings } from '../tables';
import {
  FriendEndInput,
  FriendEndOutput,
  TIDY_MOST,
  TidyInput,
  tidyLimits,
  TidyOutput,
  UNFRIEND_QUIET_DAYS,
  WarningNoteInput,
  WarningNoteOutput,
  warningEnds,
  type TidyCandidate,
  type WarningState,
} from '../tidy';
import { automationOf, wheelsBackOn } from './automation';
import { inWorkspace, keepFriendStates, keptProfile, once, pitchable, type Ctx } from './common';
import { warnDay } from './day';
import { playbooksInUse } from './friends';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Midnight today in the business's time zone. */
export async function startOfToday(ctx: Ctx, now = Date.now()): Promise<Date> {
  const timezone = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
  return new Date(startOfLocalDay(localDateOf(now, timezone), timezone));
}

/**
 * The latest warning a network showed the person that still slows them down there, or null. Another network's
 * warning never counts: each slows and stops only its own.
 */
export async function warningOf(
  ctx: Ctx,
  me: string,
  platform: Platform,
  todayFrom: Date,
  now = Date.now(),
): Promise<WarningState | null> {
  const [latest] = await ctx.tx
    .select({ at: warnings.at, words: warnings.words })
    .from(warnings)
    .where(
      and(
        eq(warnings.workspaceId, ctx.scope.workspaceId!),
        eq(warnings.userId, me),
        eq(warnings.platform, platform),
        gte(warnings.at, new Date(now - WARNING_SLOWER_DAYS * DAY)),
      ),
    )
    .orderBy(desc(warnings.at))
    .limit(1);
  if (!latest) return null;
  return stateOf(latest.at, latest.words, todayFrom);
}

function stateOf(at: Date, words: readonly string[], todayFrom: Date): WarningState {
  const ends = warningEnds(at);
  return {
    at: at.toISOString(),
    words: words[0] ?? '',
    slowerUntil: ends.slowerUntil.toISOString(),
    requestsFrom: ends.requestsFrom.toISOString(),
    today: at >= todayFrom,
  };
}

/** Whether a warning slows things down at this moment. */
export const slowsNow = (warning: WarningState | null, now = Date.now()): boolean =>
  warning !== null && new Date(warning.slowerUntil).getTime() > now;

/** How many of each the extension did for the person today on one network: each network's limits are its own. */
async function endsToday(
  ctx: Ctx,
  me: string,
  todayFrom: Date,
  platform: Platform,
): Promise<Record<TidyKind, number>> {
  const [done] = await rows<{ cancel_request: number; unfriend: number }>(
    ctx.tx,
    sql`select count(*) filter (where e.kind = 'cancel_request')::int as cancel_request,
          count(*) filter (where e.kind = 'unfriend')::int as unfriend
        from addon_outreach.friend_ends e
        join addon_outreach.profiles p on p.id = e.profile_id
        where e.workspace_id = ${ctx.scope.workspaceId!} and e.user_id = ${me} and p.platform = ${platform}
          and e.at >= ${todayFrom.toISOString()}::timestamptz`,
  );
  return done ?? { cancel_request: 0, unfriend: 0 };
}

type Found = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly platform_id: string | null;
  readonly username: string | null;
  readonly since: Date | string;
  readonly last_contact: Date | string | null;
  readonly intro: string[];
  readonly mutual_friends: number | null;
  readonly group_name: string | null;
  readonly total: number;
  /** A friend: any chat with them either way, kept or noted (decision 98). */
  readonly chatted?: boolean;
  /** A friend: the AI's check found they aren't a fit. */
  readonly not_fit?: boolean;
};

const iso = (at: Date | string) => new Date(at).toISOString();

export const friendsTidy = defineAddonQuery(outreachAddon, {
  name: 'outreach.friends.tidy',
  description:
    'The person’s own sent friend requests (LinkedIn’s invitations) on one network nobody answered in the business’s wait, and friends with no contact either way in six months who aren’t in Contacts, a prospect, kept or on Don’t pitch, for them to tick for the extension to cancel or unfriend; with that network’s counts today against its limits, and any warning it showed them lately.',
  input: TidyInput,
  output: TidyOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_tidy_up',
    keywords: ['cancel friend requests', 'unfriend', 'tidy up'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const todayFrom = await startOfToday(ctx, now);
    const [installed] = await rows<{ settings: unknown }>(
      ctx.tx,
      sql`select settings from app.addon_installations
          where workspace_id = ${ws} and addon_id = ${outreachAddon.id}`,
    );
    const weeks = outreachSettings(installed?.settings).cancelRequestsAfterWeeks;
    const warning = await warningOf(ctx, me, input.platform, todayFrom, now);
    const auto = await automationOf(ctx, me, now, input.platform);
    const slower = slowsNow(warning, now) || auto.slower;
    const kit = NETWORKS[input.platform];
    const done = await endsToday(ctx, me, todayFrom, input.platform);
    // On a follow network (Instagram's) tidying unfollows (the Instagram and Alignable plan's question 5): never anyone
    // who wrote back, a customer, someone kept, or anyone the person followed before HandsFreeOS saw it.
    const unfollowing =
      kit.requestsMessageAfterDays !== null
        ? sql`and p.person_id is null and not f.keep
            and exists (select 1 from addon_outreach.touches t
              where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'friend_request')
            and not exists (select 1 from addon_outreach.replies r
              where r.profile_id = p.id and r.user_id = ${me})
            and not exists (select 1 from addon_outreach.file_chats c
              where c.profile_id = p.id and c.user_id = ${me} and not c.last_from_me)`
        : sql``;

    const cancel = await rows<Found>(
      ctx.tx,
      sql`select p.id, p.name, p.url, p.platform_id, p.username, f.since, null as last_contact, p.intro,
            p.mutual_friends, g.name as group_name, count(*) over ()::int as total
          from addon_outreach.friends f
          join addon_outreach.profiles p on p.id = f.profile_id
          left join addon_outreach.groups g on g.id = p.group_id
          where f.workspace_id = ${ws} and f.user_id = ${me} and p.platform = ${input.platform}
            and f.state = 'request_sent'
            and f.since <= ${new Date(now - weeks * 7 * DAY).toISOString()}::timestamptz
            ${unfollowing}
          order by f.since, p.id limit ${TIDY_MOST}`,
    );

    const [file] = await rows<{ any: boolean }>(
      ctx.tx,
      sql`select exists (select 1 from addon_outreach.imports
            where workspace_id = ${ws} and user_id = ${me} and platform = ${input.platform}
              and finished_at is not null) as any`,
    );
    const needsFile = !file?.any;
    const quietSince = new Date(now - UNFRIEND_QUIET_DAYS * DAY).toISOString();
    const unfriend = needsFile
      ? []
      : await rows<Found>(
          ctx.tx,
          sql`select l.* from (
                select p.id, p.name, p.url, p.platform_id, p.username, p.intro, p.mutual_friends,
                  null::text as group_name,
                  coalesce((select min(fp.at) from addon_outreach.file_people fp
                    where fp.profile_id = p.id and fp.user_id = ${me} and fp.list = 'friends'), f.since) as since,
                  greatest(
                    (select max(c.last_at) from addon_outreach.file_chats c
                      where c.profile_id = p.id and c.user_id = ${me}),
                    (select max(t.at) from addon_outreach.touches t
                      where t.profile_id = p.id and t.user_id = ${me})) as last_contact,
                  (exists (select 1 from addon_outreach.file_chats c
                      where c.profile_id = p.id and c.user_id = ${me})
                    or exists (select 1 from addon_outreach.replies r
                      where r.profile_id = p.id and r.user_id = ${me})
                    or exists (select 1 from addon_outreach.touches t
                      where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'message')) as chatted,
                  exists (select 1 from addon_outreach.checks k
                    where k.profile_id = p.id and k.user_id = ${me} and k.verdict = 'not') as not_fit
                from addon_outreach.friends f
                join addon_outreach.profiles p on p.id = f.profile_id
                where f.workspace_id = ${ws} and f.user_id = ${me} and p.platform = ${input.platform}
                  and f.state = 'friends' and not f.keep and p.person_id is null and ${pitchable('p')}
                  and not exists (select 1 from addon_outreach.file_chats c
                    where c.profile_id = p.id and c.user_id = ${me} and c.prospect)
              ) l
              where l.since <= ${quietSince}::timestamptz
                and (l.last_contact is null or l.last_contact <= ${quietSince}::timestamptz)`,
        );
    // Of those, the longest quiet first: no contact ever before the oldest contact.
    unfriend.sort(
      (a, b) =>
        (a.last_contact ? new Date(a.last_contact).getTime() : 0) -
          (b.last_contact ? new Date(b.last_contact).getTime() : 0) ||
        new Date(a.since).getTime() - new Date(b.since).getTime() ||
        a.name.localeCompare(b.name),
    );

    const playbooks = cancel.length ? await playbooksInUse(ctx) : [];
    const candidate = (f: Found, fitted: boolean): TidyCandidate => ({
      profileId: f.id,
      name: f.name,
      url: f.url,
      platformId: f.platform_id,
      username: f.username,
      since: iso(f.since),
      lastContact: f.last_contact === null ? null : iso(f.last_contact),
      fit:
        fitted && playbooks.length
          ? bestFit(playbooks, {
              lines: f.intro,
              mutualFriends: f.mutual_friends,
              groupName: f.group_name,
            }).level
          : null,
    });
    const [counted] = await rows<{ friends: number }>(
      ctx.tx,
      sql`select count(*)::int as friends from addon_outreach.friends f
          join addon_outreach.profiles p on p.id = f.profile_id
          where f.workspace_id = ${ws} and f.user_id = ${me} and f.state = 'friends'
            and p.platform = ${input.platform}`,
    );
    const limits = tidyLimits(done, {
      cancel_request: limitNow(kit.tidyLimits.cancel_request, slower),
      unfriend: limitNow(kit.tidyLimits.unfriend, slower),
    });
    // On its own (decision 98): within the day's limit, what's left of it after any done by hand, and its own limit,
    // halved as the rest are. Nothing while a warning today stops the extension there.
    const ownRoom = (kind: TidyKind) =>
      warning?.today
        ? 0
        : Math.max(
            0,
            Math.min(limits[kind].most, limitNow(OWN_TIDY_LIMITS[kind], slower)) -
              limits[kind].done,
          );
    const mode = tidyModeOn(input.platform, auto.choices.tidy);
    const own = {
      mode,
      cancel:
        mode === 'off'
          ? []
          : cancel.slice(0, ownRoom('cancel_request')).map((f) => candidate(f, true)),
      // Only friends the AI found aren't a fit and the person never chatted with, the longest quiet first.
      unfriend:
        mode === 'unfriend'
          ? unfriend
              .filter((f) => f.not_fit && !f.chatted)
              .slice(0, ownRoom('unfriend'))
              .map((f) => candidate(f, false))
          : [],
    };
    return {
      cancel: cancel.map((f) => candidate(f, true)),
      unfriend: unfriend.slice(0, TIDY_MOST).map((f) => candidate(f, false)),
      totals: { cancel_request: cancel[0]?.total ?? 0, unfriend: unfriend.length },
      cancelAfterWeeks: weeks,
      needsFile,
      limits,
      friends: counted?.friends ?? 0,
      cap: kit.friendsCap,
      warning,
      own,
    };
  },
});

export const friendEnd = defineAddonCommand(outreachAddon, {
  name: 'outreach.friend.end',
  description:
    'Note a sent friend request the extension cancelled, or a friend it unfriended, on a social network for the person, once they ticked them: they’re no longer friends or asked, and it counts against today’s limit. One done already when the extension got there is noted but not counted.',
  risk: 1,
  input: FriendEndInput,
  output: FriendEndOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // Done on Facebook already: noted whenever it arrives.
  offline: 'anytime',
  emits: ['outreach.friend.ended'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      const profile = await keptProfile(ctx, input, me, at, { friendship: 'not_friends' }, (had) =>
        at >= had.lastSeenAt
          ? { friendship: 'not_friends' as const, lastSeenBy: me, lastSeenAt: at }
          : {},
      );
      await keepFriendStates(ctx, me, [{ profileId: profile.id, state: 'not_friends' }], at);
      if (!input.already)
        await ctx.tx.insert(friendEnds).values({
          workspaceId: ctx.scope.workspaceId!,
          userId: me,
          profileId: profile.id,
          kind: input.kind,
          at,
        });
      const done = await endsToday(ctx, me, await startOfToday(ctx), input.platform);
      await ctx.emit({
        type: 'outreach.friend.ended',
        entityType: 'outreach_profile',
        entityId: profile.id,
        payload: { platform: input.platform, kind: input.kind, already: input.already },
      });
      return { profileId: profile.id, counted: !input.already, doneToday: done[input.kind] };
    });
  },
});

export const warningNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.warning.note',
  description:
    'Note a warning a network showed the person, in its own words, as the extension read it: on that network alone, it halves their daily limits for a week, keeps friend requests off their list for two days, stops the extension for them for the day on every computer, and tells their phone. Their other networks go on.',
  risk: 1,
  input: WarningNoteInput,
  output: WarningNoteOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['outreach.warning.seen'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const todayFrom = await startOfToday(ctx);
    const words = [...new Set(input.words)];
    const asArray = `{${words.map((w) => `"${w.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;
    // The same words seen again the same day on the same network are the same warning.
    const [same] = await ctx.tx
      .select({ at: warnings.at, words: warnings.words })
      .from(warnings)
      .where(
        and(
          eq(warnings.workspaceId, ws),
          eq(warnings.userId, me),
          eq(warnings.platform, input.platform),
          gte(warnings.at, todayFrom),
          sql`${warnings.words} = ${asArray}::text[]`,
        ),
      )
      .limit(1);
    if (same) return { repeated: true, warning: stateOf(same.at, same.words, todayFrom) };
    await ctx.tx.insert(warnings).values({
      workspaceId: ws,
      userId: me,
      platform: input.platform,
      words,
      url: input.url,
      at,
    });
    // Training wheels go back on for 7 days on this network, for anyone who ever had them there. Their other
    // networks' stay as they were.
    await wheelsBackOn(ctx, me, input.platform);
    // The network's day stops in HandsFreeOS too, whatever was pressed (decision 41): every computer of theirs
    // follows it. The person's other networks go on.
    await warnDay(ctx, me, input.platform, at, words[0]!, await workspaceTimezone(ctx.tx, ws));
    await ctx.emit({
      type: 'outreach.warning.seen',
      entityType: 'workspace',
      entityId: ws,
      // Whose it is, for the push to their phone (the worker's alerts.ts).
      payload: { platform: input.platform, userId: me },
    });
    return { repeated: false, warning: stateOf(at, words, todayFrom) };
  },
});

export const followBacksNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.follow_backs.next',
  description:
    'Who the person’s computer looks at next on a follow network (Instagram’s) to see whether they follow the person back: those the person followed at least a day ago who haven’t followed back yet, not looked at in the last day, the longest since a look first, no more than the network’s looks a day (halved for a week after a warning there).',
  input: FollowBacksNextInput,
  output: FollowBacksNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const now = Date.now();
    const kit = NETWORKS[input.platform];
    if (kit.followBackLooksPerDay === null) return { people: [], perDay: 0 };
    const warning = await warningOf(ctx, me, input.platform, await startOfToday(ctx, now), now);
    const perDay = limitNow(kit.followBackLooksPerDay, slowsNow(warning, now));
    const ago = (ms: number) => new Date(now - ms).toISOString();
    // Followed by the person (a step noted, never someone followed before HandsFreeOS saw it), still waiting. A look
    // that saw them still waiting moves `seen_at` and keeps `since`, so they wait their turn again.
    const found = await rows<{
      id: string;
      name: string;
      url: string;
      platform_id: string | null;
      username: string | null;
      since: Date | string;
    }>(
      ctx.tx,
      sql`select p.id, p.name, p.url, p.platform_id, p.username, f.since
          from addon_outreach.friends f
          join addon_outreach.profiles p on p.id = f.profile_id
          where f.workspace_id = ${ctx.scope.workspaceId!} and f.user_id = ${me}
            and p.platform = ${input.platform} and f.state = 'request_sent'
            and f.since <= ${ago(FOLLOW_BACK_AFTER_DAYS * DAY)}::timestamptz
            and f.seen_at <= ${ago(FOLLOW_BACK_AGAIN_HOURS * HOUR)}::timestamptz
            and exists (select 1 from addon_outreach.touches t
              where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'friend_request')
          order by f.seen_at, f.since, p.id
          limit ${Math.min(input.most, perDay)}`,
    );
    return {
      people: found.map((p) => ({
        profileId: p.id,
        name: p.name,
        url: p.url,
        platformId: p.platform_id,
        username: p.username,
        followedAt: new Date(p.since).toISOString(),
      })),
      perDay,
    };
  },
});

export const tidyCommands = [friendEnd, warningNote] as const;
export const tidyQueries = [friendsTidy, followBacksNext] as const;
