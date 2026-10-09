/**
 * Today (../today.ts): the person's list for the day on Facebook, worked out each time it's asked for from the
 * groups, friends, chats and steps HandsFreeOS keeps. Nothing is saved: a step the person takes is noted by the
 * extension, and that takes it off the list.
 */
import { sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { localDateOf, startOfLocalDay } from '../../../calendar/engine/zoned';
import { workspaceTimezone } from '../../../crm/records';
import { requireHuman } from '../../../kernel/actor';
import { defineAddonQuery } from '../../server';
import { bestFit } from '../fit';
import { bestGroupFit } from '../groups';
import { DONT_PITCH_TAG } from '../limits';
import { outreachAddon } from '../manifest';
import {
  DEFAULT_PACE,
  leftToday,
  TODAY_MOST,
  TODAY_WINDOW_DAYS,
  TodayInput,
  todayLimits,
  TodayOutput,
  type TodayItem,
} from '../today';
import { inWorkspace } from './common';
import { playbooksInUse } from './friends';

const DAY = 86_400_000;
/** The most people from groups weighed for requests at once. */
const CANDIDATES_MOST = 500;

/** A profile that's never pitched: on Don't pitch, or a customer tagged Friend or family. */
const pitchable = (p: string) => sql`not ${sql.raw(p)}.dont_pitch and not exists (
  select 1 from app.record_tags rt join app.tags tg on tg.id = rt.tag_id
  where rt.record_type = 'person' and rt.record_id = ${sql.raw(p)}.person_id
    and lower(tg.name::text) = lower(${DONT_PITCH_TAG}))`;

export const today = defineAddonQuery(outreachAddon, {
  name: 'outreach.today',
  description:
    'The person’s list for today on Facebook, for them to send themselves: friend requests to people found in the business’s groups who fit a playbook (never anyone who runs a group, is on Don’t pitch or is in Contacts), a first message to new friends who accepted, follow-ups to likely prospects gone quiet, and replies owed; with today’s steps against the daily limits.',
  input: TodayInput,
  output: TodayOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, _input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const timezone = await workspaceTimezone(ctx.tx, ws);
    const todayFrom = new Date(startOfLocalDay(localDateOf(now, timezone), timezone)).toISOString();
    const [done] = await rows<{ friend_request: number; first_message: number; follow_up: number }>(
      ctx.tx,
      sql`select count(*) filter (where kind = 'friend_request')::int as friend_request,
            count(*) filter (where step = 'first_message')::int as first_message,
            count(*) filter (where step = 'follow_up')::int as follow_up
          from addon_outreach.touches
          where workspace_id = ${ws} and user_id = ${me} and at >= ${todayFrom}::timestamptz`,
    );
    const limits = todayLimits(done ?? { friend_request: 0, first_message: 0, follow_up: 0 });
    const playbooks = await playbooksInUse(ctx);
    const pace = {
      messageAfterDays: Math.min(
        ...playbooks.map((p) => p.details.pace.messageAfterDays),
        playbooks.length ? Infinity : DEFAULT_PACE.messageAfterDays,
      ),
      followUpAfterDays: Math.min(
        ...playbooks.map((p) => p.details.pace.followUpAfterDays),
        playbooks.length ? Infinity : DEFAULT_PACE.followUpAfterDays,
      ),
    };
    const ago = (days: number) => new Date(now - days * DAY).toISOString();
    const items: TodayItem[] = [];
    const item = (more: Partial<TodayItem> & Pick<TodayItem, 'kind' | 'name'>): TodayItem => ({
      profileId: null,
      profileUrl: null,
      chatId: null,
      threadKey: null,
      why: [],
      summary: null,
      nextStep: null,
      playbookName: null,
      ...more,
    });

    // Friend requests: people found in the groups, the best fit first.
    const requestsLeft = leftToday(limits, 'friend_request');
    if (playbooks.length && requestsLeft) {
      const found = await rows<{
        id: string;
        name: string;
        url: string;
        intro: string[];
        mutual_friends: number | null;
        lines: string[];
        group_name: string | null;
        group_detail: string | null;
        group_members: number | null;
        group_privacy: 'public' | 'private' | null;
      }>(
        ctx.tx,
        sql`select distinct on (p.id) p.id, p.name, p.url, p.intro, p.mutual_friends, gp.lines,
              g.name as group_name, g.detail as group_detail, g.members as group_members,
              g.privacy as group_privacy
            from addon_outreach.group_people gp
            join addon_outreach.groups g on g.id = gp.group_id
            join addon_outreach.profiles p on p.id = gp.profile_id
            where gp.workspace_id = ${ws} and g.admins_read_at is not null and not gp.runs_group
              and p.person_id is null and ${pitchable('p')}
              and p.friendship not in ('self', 'friends', 'request_sent', 'request_received')
              and not exists (select 1 from addon_outreach.group_people x
                where x.profile_id = p.id and x.runs_group)
              and not exists (select 1 from addon_outreach.friends f
                where f.profile_id = p.id and f.user_id = ${me})
              and not exists (select 1 from addon_outreach.touches t
                where t.profile_id = p.id and t.kind = 'friend_request')
            order by p.id, gp.seen_at desc
            limit ${CANDIDATES_MOST}`,
      );
      const fitted = found.flatMap((p) => {
        const group = bestGroupFit(playbooks, {
          name: p.group_name,
          detail: p.group_detail,
          members: p.group_members,
          privacy: p.group_privacy,
          joined: null,
        });
        if (group.verdict === 'skip') return [];
        const fit = bestFit(playbooks, {
          lines: [...p.lines, ...p.intro],
          mutualFriends: p.mutual_friends,
          groupName: p.group_name,
        });
        return fit.level === 'skip' || fit.level === 'unknown' ? [] : [{ p, fit }];
      });
      fitted.sort((a, b) => b.fit.score - a.fit.score || a.p.name.localeCompare(b.p.name));
      for (const { p, fit } of fitted.slice(0, requestsLeft))
        items.push(
          item({
            kind: 'friend_request',
            name: p.name,
            profileId: p.id,
            profileUrl: p.url,
            why: [...fit.reasons],
            playbookName: fit.playbookName,
          }),
        );
    }

    // Say hi: new friends who accepted the person's request, without a message yet.
    const openersLeft = leftToday(limits, 'opener');
    if (openersLeft) {
      const accepted = await rows<{ id: string; name: string; url: string; since: Date | string }>(
        ctx.tx,
        sql`select p.id, p.name, p.url, f.since from addon_outreach.friends f
            join addon_outreach.profiles p on p.id = f.profile_id
            where f.workspace_id = ${ws} and f.user_id = ${me} and f.state = 'friends'
              and f.since between ${ago(TODAY_WINDOW_DAYS.opener)}::timestamptz
                and ${ago(pace.messageAfterDays)}::timestamptz
              and ${pitchable('p')}
              and exists (select 1 from addon_outreach.touches t where t.profile_id = p.id
                and t.user_id = ${me} and t.kind = 'friend_request')
              and not exists (select 1 from addon_outreach.touches t where t.profile_id = p.id
                and t.kind = 'message')
              and not exists (select 1 from addon_outreach.file_chats c where c.profile_id = p.id
                and c.user_id = ${me})
            order by f.since desc limit ${openersLeft}`,
      );
      for (const p of accepted)
        items.push(
          item({
            kind: 'opener',
            name: p.name,
            profileId: p.id,
            profileUrl: p.url,
            why: [`Accepted your request ${dayWords(p.since, now)}`],
          }),
        );
    }

    // Follow-ups and replies: likely prospects in the person's chats.
    const chats = await rows<{
      id: string;
      name: string;
      profile_id: string | null;
      url: string | null;
      thread_key: string | null;
      last_at: Date | string;
      last_from_me: boolean;
      summary: string | null;
      next_step: string | null;
    }>(
      ctx.tx,
      sql`select c.id, c.name, c.profile_id, p.url, c.thread_key, c.last_at, c.last_from_me, c.summary,
            c.next_step
          from addon_outreach.file_chats c left join addon_outreach.profiles p on p.id = c.profile_id
          where c.workspace_id = ${ws} and c.user_id = ${me} and c.read_state = 'read' and c.prospect
            and (p.id is null or ${pitchable('p')})
            and ((c.last_from_me and c.last_at between ${ago(TODAY_WINDOW_DAYS.follow_up)}::timestamptz
                  and ${ago(pace.followUpAfterDays)}::timestamptz)
              or (not c.last_from_me and c.last_at >= ${ago(TODAY_WINDOW_DAYS.reply)}::timestamptz))
            and not exists (select 1 from addon_outreach.touches t
              where t.profile_id = c.profile_id and t.user_id = ${me} and t.kind = 'message'
                and t.at > c.last_at)
          order by c.last_at desc limit ${TODAY_MOST * 2}`,
    );
    let followUps = leftToday(limits, 'follow_up');
    let replies = TODAY_MOST;
    for (const c of chats) {
      const kind = c.last_from_me ? 'follow_up' : 'reply';
      if (kind === 'follow_up' ? followUps-- <= 0 : replies-- <= 0) continue;
      items.push(
        item({
          kind,
          name: c.name,
          profileId: c.profile_id,
          profileUrl: c.url,
          chatId: c.id,
          threadKey: c.thread_key,
          why: [
            kind === 'reply'
              ? `They wrote ${dayWords(c.last_at, now)}`
              : `You wrote last, ${dayWords(c.last_at, now)}`,
          ],
          summary: c.summary,
          nextStep: c.next_step,
        }),
      );
    }

    const readAdmins = await rows<{ id: string; name: string | null; url: string }>(
      ctx.tx,
      sql`select g.id, g.name, g.url from addon_outreach.groups g
          where g.workspace_id = ${ws} and g.admins_read_at is null
            and exists (select 1 from addon_outreach.group_people gp
              where gp.group_id = g.id and not gp.runs_group)
          order by g.seen_at desc nulls last limit 10`,
    );
    return {
      limits,
      items,
      readAdmins: readAdmins.map((g) => ({ groupId: g.id, name: g.name, url: g.url })),
      hasPlaybook: playbooks.length > 0,
    };
  },
});

/** "today", "yesterday", "4 days ago". */
function dayWords(at: Date | string, now: number): string {
  const days = Math.floor((now - new Date(at).getTime()) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

export const todayQueries = [today] as const;
