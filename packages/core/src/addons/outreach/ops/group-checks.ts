/**
 * Groups, theirs first, then new ones (../group-checks.ts, docs/outreach.md decision 48): which groups the person's
 * computer checks next, what their About pages, rules and posts said, the AI's read of them, how many people the
 * groups have left to reach, which groups to ask to join, and how each ask went. The groups and the AI's read of them
 * are the business's; the asks to join are each person's own.
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { bestFit, type FitPlaybook } from '../fit';
import {
  GROUP_CHECK_AGAIN_DAYS,
  GROUP_CHECK_RETRY_DAYS,
  GroupCheckSaveInput,
  GroupCheckSaveOutput,
  GroupLookInput,
  GroupLookOutput,
  GroupsToCheckInput,
  GroupsToCheckOutput,
  JOINS_PER_DAY,
  JoinNoteInput,
  JoinNoteOutput,
  JoinsNextInput,
  JoinsNextOutput,
  prospectsLeft,
  type GroupCheckState,
  type ProspectsLeft,
} from '../group-checks';
import { bestGroupFit, checkedGroupFit, type GroupFit, type GroupFitPlaybook } from '../groups';
import { dailyLimitsNow, limitNow } from '../limits';
import { outreachAddon } from '../manifest';
import type { PlaybookDetails } from '../playbooks';
import { groups, joins, myGroups } from '../tables';
import { automationOf, rulesOf } from './automation';
import { inPlay, inWorkspace, pitchable, type Ctx } from './common';
import { playbooksInUse } from './friends';
import { slowsNow, startOfToday, warningOf } from './tidy';

const DAY = 86_400_000;
/** The most people weighed for what's left to reach at once. */
const LEFT_MOST = 5000;

type Playbook = FitPlaybook & GroupFitPlaybook & { readonly details: PlaybookDetails };

/** A group's facts as its fit reads them, with the AI's check on top. */
export type CheckedGroupRow = {
  readonly name: string | null;
  readonly detail: string | null;
  readonly members: number | null;
  readonly privacy: 'public' | 'private' | null;
  readonly joined: boolean | null;
  readonly check_state: GroupCheckState | null;
  readonly check_why: string[] | null;
  readonly check_playbook_id: string | null;
  readonly check_playbook: string | null;
};

/** How a group fits the playbooks in use, the AI's read of it on top (decision 48). */
export function groupFitOf(playbooks: readonly Playbook[], g: CheckedGroupRow): GroupFit {
  return checkedGroupFit(
    bestGroupFit(playbooks, {
      name: g.name,
      detail: g.detail,
      members: g.members,
      privacy: g.privacy,
      joined: g.joined,
    }),
    g.check_state
      ? {
          state: g.check_state,
          why: g.check_why ?? [],
          playbookId: g.check_playbook_id,
          playbookName: g.check_playbook,
        }
      : null,
  );
}

/**
 * People in the business's groups who fit a playbook and haven't been reached by the person, by group: Today's
 * friend requests' own, so a group whose admins aren't read yet, and anyone who runs a group, never counts.
 */
export async function peopleLeft(
  ctx: Ctx,
  me: string,
  playbooks: readonly Playbook[],
): Promise<Map<string, number>> {
  const left = new Map<string, number>();
  if (!playbooks.length) return left;
  const found = await rows<
    CheckedGroupRow & {
      id: string;
      group_id: string;
      lines: string[];
      intro: string[];
      mutual_friends: number | null;
    }
  >(
    ctx.tx,
    sql`select distinct on (p.id) p.id, gp.group_id, gp.lines, p.intro, p.mutual_friends,
          g.name, g.detail, g.members, g.privacy, g.check_state, g.check_why, g.check_playbook_id,
          null::text as check_playbook,
          (select m.joined from addon_outreach.my_groups m where m.group_id = g.id and m.user_id = ${me}) as joined
        from addon_outreach.group_people gp
        join addon_outreach.groups g on g.id = gp.group_id
        join addon_outreach.profiles p on p.id = gp.profile_id
        where gp.workspace_id = ${ctx.scope.workspaceId!} and g.admins_read_at is not null
          and not gp.runs_group and p.person_id is null and ${pitchable('p')} and ${inPlay(me, 'p')}
          and p.friendship not in ('self', 'friends', 'request_sent', 'request_received')
          and not exists (select 1 from addon_outreach.group_people x
            where x.profile_id = p.id and x.runs_group)
          and not exists (select 1 from addon_outreach.friends f
            where f.profile_id = p.id and f.user_id = ${me})
          and not exists (select 1 from addon_outreach.touches t
            where t.profile_id = p.id and t.kind = 'friend_request')
        order by p.id, gp.seen_at desc
        limit ${LEFT_MOST}`,
  );
  for (const p of found) {
    if (groupFitOf(playbooks, p).verdict === 'skip') continue;
    const fit = bestFit(playbooks, {
      lines: [...p.lines, ...p.intro],
      mutualFriends: p.mutual_friends,
      groupName: p.name,
    });
    if (fit.level === 'skip' || fit.level === 'unknown') continue;
    left.set(p.group_id, (left.get(p.group_id) ?? 0) + 1);
  }
  return left;
}

/** How many people the groups have left to reach, against a day's friend requests. */
export async function prospectsOf(
  ctx: Ctx,
  left: ReadonlyMap<string, number>,
): Promise<ProspectsLeft> {
  const perDay = dailyLimitsNow(false, (await rulesOf(ctx)).dailyLimits).friend_request;
  return prospectsLeft(
    [...left.values()].reduce((a, b) => a + b, 0),
    perDay,
  );
}

const ago = (now: number, days: number) => new Date(now - days * DAY).toISOString();

export const groupsToCheck = defineAddonQuery(outreachAddon, {
  name: 'outreach.groups.to_check',
  description:
    'Which of the business’s Facebook groups the person’s computer checks next for whether the playbooks’ people are there: their own groups first, then groups found that fit by name; none checked lately.',
  input: GroupsToCheckInput,
  output: GroupsToCheckOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const now = Date.now();
    const found = await rows<CheckedGroupRow & { id: string; url: string }>(
      ctx.tx,
      sql`select g.id, g.name, g.url, g.detail, g.members, g.privacy, g.check_state, g.check_why,
            g.check_playbook_id, null::text as check_playbook, m.joined
          from addon_outreach.groups g
          left join addon_outreach.my_groups m on m.group_id = g.id and m.user_id = ${me}
          where g.workspace_id = ${ctx.scope.workspaceId!}
            and (g.check_state is null
              or (g.check_state in ('good', 'maybe', 'not')
                and g.checked_at < ${ago(now, GROUP_CHECK_AGAIN_DAYS)}::timestamptz)
              or (g.check_state = 'failed'
                and g.about_at < ${ago(now, GROUP_CHECK_RETRY_DAYS)}::timestamptz))
          order by g.seen_at desc nulls last limit 500`,
    );
    const playbooks = await playbooksInUse(ctx);
    const ranked = found
      .map((g) => ({ g, fit: bestGroupFit(playbooks, { ...g, joined: g.joined }) }))
      // The person's own groups first; then groups found that fit by name, never one its name skips.
      .filter(({ g, fit }) => g.joined === true || fit.verdict !== 'skip')
      .sort(
        (a, b) =>
          Number(b.g.joined === true) - Number(a.g.joined === true) ||
          b.fit.score - a.fit.score ||
          (b.g.members ?? 0) - (a.g.members ?? 0),
      );
    return {
      groups: ranked.slice(0, input.most).map(({ g }) => ({
        groupId: g.id,
        name: g.name,
        url: g.url,
        joined: g.joined,
      })),
    };
  },
});

export const groupLook = defineAddonCommand(outreachAddon, {
  name: 'outreach.group.look',
  description:
    'What a Facebook group’s About page, rules and latest posts said as the person’s computer read them, for the AI to see whether the playbooks’ people are there. The About page and rules are kept on the group; the posts only until the AI has read them.',
  risk: 1,
  input: GroupLookInput,
  output: GroupLookOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.group.looked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const nothing = !input.about.length && !input.rules.length && !input.posts.length;
    const state: GroupCheckState = nothing ? 'failed' : 'waiting';
    const [group] = await ctx.tx
      .update(groups)
      .set({
        ...(input.about.length ? { about: input.about } : {}),
        ...(input.rules.length ? { rules: input.rules } : {}),
        aboutAt: at,
        checkLines: input.posts,
        checkState: state,
        ...(nothing
          ? { checkWhy: ['Facebook didn’t show what it’s about'], checkWho: null, checkedAt: at }
          : {}),
      })
      .where(and(eq(groups.workspaceId, ws), eq(groups.id, input.groupId)))
      .returning({ id: groups.id });
    if (!group)
      throw HfosError.notFound('That group isn’t kept here anymore. Save your groups again.');
    if (input.joined !== null)
      await ctx.tx
        .insert(myGroups)
        .values({
          workspaceId: ws,
          userId: me,
          groupId: group.id,
          joined: input.joined,
          seenAt: at,
        })
        .onConflictDoUpdate({
          target: [myGroups.workspaceId, myGroups.userId, myGroups.groupId],
          set: { joined: input.joined, seenAt: at },
        });
    if (state === 'waiting')
      await ctx.emit({
        type: 'outreach.group.looked',
        entityType: 'workspace',
        entityId: ws,
        payload: { groupId: group.id },
      });
    return { groupId: group.id, checkState: state };
  },
});

export const groupCheck = defineAddonCommand(outreachAddon, {
  name: 'outreach.group.check',
  description:
    'Worker: what the AI made of a Facebook group: the business’s people are there, some are, or they aren’t, which playbook, why and who posts there; or that it couldn’t read it. The posts it read are let go.',
  risk: 0,
  input: GroupCheckSaveInput,
  output: GroupCheckSaveOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.group.checked'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [group] = await ctx.tx
      .select()
      .from(groups)
      .where(and(eq(groups.workspaceId, ws), eq(groups.id, input.groupId)))
      .for('update');
    if (!group) throw HfosError.notFound('That group isn’t kept anymore.');
    if (
      group.checkState !== 'waiting' ||
      group.aboutAt?.getTime() !== new Date(input.aboutAt).getTime()
    )
      return { saved: false, checkState: group.checkState ?? 'waiting' };
    const a = input.answer;
    const state: GroupCheckState = a ? a.fit : 'failed';
    await ctx.tx
      .update(groups)
      .set({
        checkLines: [],
        checkState: state,
        checkWhy: a?.why ?? ['The AI couldn’t read it'],
        checkWho: a?.who ?? null,
        checkPlaybookId: a?.playbookId ?? null,
        checkedAt: at,
      })
      .where(eq(groups.id, group.id));
    await ctx.emit({
      type: 'outreach.group.checked',
      entityType: 'workspace',
      entityId: ws,
      payload: { groupId: group.id, checkState: state },
    });
    return { saved: true, checkState: state };
  },
});

export const joinsNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.joins.next',
  description:
    'Which Facebook groups the person’s computer asks to join next (decision 31): the ones the AI says the business’s people are in, or that fit well by name while it hasn’t read them, that the person isn’t in and hasn’t asked to join; no more than today has room for. With how many people the groups have left to reach, and words to search for more groups with.',
  input: JoinsNextInput,
  output: JoinsNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const todayStart = await startOfToday(ctx, now);
    const warning = await warningOf(ctx, me, todayStart, now);
    const perDay = limitNow(JOINS_PER_DAY, slowsNow(warning, now));
    const [done] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from addon_outreach.joins
          where workspace_id = ${ws} and user_id = ${me}
            and asked_at >= ${todayStart.toISOString()}::timestamptz`,
    );
    const today = done?.n ?? 0;
    const playbooks = await playbooksInUse(ctx);
    const prospects = await prospectsOf(ctx, await peopleLeft(ctx, me, playbooks));
    const words = [
      ...new Set(
        playbooks.flatMap((p) =>
          p.details.groupWords.map((w) => w.replace(/[“”"]/g, '').trim()).filter(Boolean),
        ),
      ),
    ];
    const room = Math.max(0, Math.min(input.most, perDay - today));
    const found = room
      ? await rows<CheckedGroupRow & { id: string; url: string }>(
          ctx.tx,
          sql`select g.id, g.name, g.url, g.detail, g.members, g.privacy, g.check_state, g.check_why,
                g.check_playbook_id, null::text as check_playbook, false as joined
              from addon_outreach.groups g
              where g.workspace_id = ${ws}
                and ${input.groupIds ? sql`g.id = any (${`{${input.groupIds.join(',')}}`}::uuid[])` : sql`true`}
                and not exists (select 1 from addon_outreach.my_groups m
                  where m.group_id = g.id and m.user_id = ${me} and m.joined)
                and not exists (select 1 from addon_outreach.joins j
                  where j.group_id = g.id and j.user_id = ${me} and (j.state <> 'failed'
                    or ${input.groupIds ? sql`false` : sql`j.asked_at >= ${ago(now, GROUP_CHECK_RETRY_DAYS)}::timestamptz`}))
                and g.check_state is distinct from 'not'
              limit 500`,
        )
      : [];
    const ranked = found
      .map((g) => ({ g, fit: groupFitOf(playbooks, g) }))
      // Asked for by name, any not skipped; else only those to work.
      .filter(({ fit }) => (input.groupIds ? fit.verdict !== 'skip' : fit.verdict === 'work'))
      .sort(
        (a, b) =>
          Number(b.g.check_state === 'good') - Number(a.g.check_state === 'good') ||
          b.fit.score - a.fit.score ||
          (b.g.members ?? 0) - (a.g.members ?? 0),
      );
    return {
      groups: ranked.slice(0, room).map(({ g }) => ({ groupId: g.id, name: g.name, url: g.url })),
      today,
      perDay,
      prospects,
      words: words.length ? words[Math.floor(now / DAY) % words.length]! : null,
      onItsOwn: (await automationOf(ctx, me, now)).settings.joinGroups,
    };
  },
});

export const joinNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.join.note',
  description:
    'How the person’s computer’s ask to join a Facebook group went: asked, waiting for the admins, joined, or couldn’t and why, with the AI’s answers to the group’s questions. Joined, it’s one of the person’s groups.',
  risk: 1,
  input: JoinNoteInput,
  output: JoinNoteOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.join.noted'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [group] = await ctx.tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.workspaceId, ws), eq(groups.id, input.groupId)));
    if (!group)
      throw HfosError.notFound('That group isn’t kept here anymore. Save your groups again.');
    await ctx.tx
      .insert(joins)
      .values({
        workspaceId: ws,
        userId: me,
        groupId: group.id,
        state: input.state,
        answers: input.answers,
        why: input.state === 'failed' ? input.why : null,
        askedAt: at,
      })
      .onConflictDoUpdate({
        target: [joins.workspaceId, joins.userId, joins.groupId],
        set: {
          state: input.state,
          ...(input.answers.length ? { answers: input.answers } : {}),
          why: input.state === 'failed' ? input.why : null,
          // Asked again after one that couldn't: it counts from now.
          askedAt: sql`case when ${joins.state} = 'failed' then excluded.asked_at else ${joins.askedAt} end`,
        },
      });
    if (input.state === 'joined')
      await ctx.tx
        .insert(myGroups)
        .values({ workspaceId: ws, userId: me, groupId: group.id, joined: true, seenAt: at })
        .onConflictDoUpdate({
          target: [myGroups.workspaceId, myGroups.userId, myGroups.groupId],
          set: { joined: true, seenAt: at },
        });
    await ctx.emit({
      type: 'outreach.join.noted',
      entityType: 'workspace',
      entityId: ws,
      payload: { groupId: group.id, state: input.state },
    });
    return { groupId: group.id, state: input.state };
  },
});

export const groupCheckCommands = [groupLook, groupCheck, joinNote] as const;
export const groupCheckQueries = [groupsToCheck, joinsNext] as const;
