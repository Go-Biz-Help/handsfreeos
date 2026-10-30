/**
 * Groups, theirs first, then new ones (../group-checks.ts, docs/outreach.md decision 48): which groups the person's
 * computer checks next, what their About pages, rules and posts said, the AI's read of them, how many people the
 * groups have left to reach, which groups to ask to join, and how each ask went. The groups and the AI's read of them
 * are the business's; the asks to join are each person's own.
 *
 * Each network's groups are their own (decision 92: Alignable's go through the same pipeline as Facebook's): the
 * groups checked and joined, the playbooks that run there, its warning, the day's joins, its Join switch and its
 * people left to reach. What differs is in its kit (`joinsPerDay`, `foundChecksPerDay`); an older build that names no
 * network gets Facebook's.
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { businessLimitsOn } from '../automation';
import type { CheckVerdict } from '../checks';
import { eachSearchOnce } from '../finds';
import { bestFit, type FitPlaybook } from '../fit';
import {
  GROUP_CHECK_AGAIN_DAYS,
  GROUP_CHECK_RETRY_DAYS,
  GroupCheckSaveInput,
  GroupCheckSaveOutput,
  GroupLookInput,
  GroupLookOutput,
  groupsByCheck,
  GroupsToCheckInput,
  GroupsToCheckOutput,
  JoinNoteInput,
  JoinNoteOutput,
  JoinsNextInput,
  JoinsNextOutput,
  prospectsLeft,
  type GroupCheckState,
  type ProspectsLeft,
} from '../group-checks';
import { bestGroupFit, checkedGroupFit, type GroupFit, type GroupFitPlaybook } from '../groups';
import { limitNow } from '../limits';
import { outreachAddon } from '../manifest';
import { networkLimitsNow, NETWORKS, type Platform } from '../networks';
import type { PlaybookDetails } from '../playbooks';
import { dayNumber, inTurn } from '../posts';
import { groups, joins, myGroups } from '../tables';
import { automationOf, rulesOf } from './automation';
import { moreToday } from './checks';
import {
  countryLetsSql,
  countryRuleOf,
  inPlay,
  inWorkspace,
  notOthers,
  pitchable,
  type Ctx,
} from './common';
import { playbooksInUse } from './friends';
import { claimGroup } from './owners';
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
 * People in the business's groups on a network who haven't been reached by the person, by group, never anyone who
 * runs a group:
 *
 * - **Facebook's** fit a playbook as Today's friend requests weigh them, in a group whose admins have been read.
 * - **On a network that checks people found** (`groupsByCheck`, Alignable's, decision 92) only people found in groups
 *   count: members of a good group not checked yet, and members whose found check was good. Its search results and
 *   town posters don't, so a full queue of them never stops a join.
 */
export async function peopleLeft(
  ctx: Ctx,
  me: string,
  playbooks: readonly Playbook[],
  platform: Platform = 'facebook',
): Promise<Map<string, number>> {
  const left = new Map<string, number>();
  if (!playbooks.length) return left;
  const byCheck = groupsByCheck(platform);
  // Anyone the business's country setting skips isn't left to reach (decision 61).
  const lets = countryLetsSql(await countryRuleOf(ctx), 'p');
  const found = await rows<
    CheckedGroupRow & {
      id: string;
      group_id: string;
      lines: string[];
      intro: string[];
      mutual_friends: number | null;
      verdict: CheckVerdict | null;
    }
  >(
    ctx.tx,
    sql`select distinct on (p.id) p.id, gp.group_id, gp.lines, p.intro, p.mutual_friends,
          g.name, g.detail, g.members, g.privacy, g.check_state, g.check_why, g.check_playbook_id,
          null::text as check_playbook,
          (select m.joined from addon_outreach.my_groups m where m.group_id = g.id and m.user_id = ${me}) as joined,
          ${
            byCheck
              ? sql`(select c.verdict from addon_outreach.checks c
                  where c.profile_id = p.id and c.user_id = ${me})`
              : sql`null::text`
          } as verdict
        from addon_outreach.group_people gp
        join addon_outreach.groups g on g.id = gp.group_id and g.platform = ${platform}
        join addon_outreach.profiles p on p.id = gp.profile_id
        where gp.workspace_id = ${ctx.scope.workspaceId!}
          and ${byCheck ? sql`true` : sql`g.admins_read_at is not null`}
          and not gp.runs_group and p.person_id is null and ${pitchable('p')} and ${inPlay(me, 'p')}
          and ${notOthers(me, 'g')} and ${lets}
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
    if (byCheck ? !leftByCheck(playbooks, p) : !leftByWords(playbooks, p)) continue;
    left.set(p.group_id, (left.get(p.group_id) ?? 0) + 1);
  }
  return left;
}

type LeftRow = CheckedGroupRow & {
  readonly lines: string[];
  readonly intro: string[];
  readonly mutual_friends: number | null;
  readonly verdict: CheckVerdict | null;
};

/** Facebook's: found in a group that fits, and fitting a playbook by the words they show. */
function leftByWords(playbooks: readonly Playbook[], p: LeftRow): boolean {
  if (groupFitOf(playbooks, p).verdict === 'skip') return false;
  const fit = bestFit(playbooks, {
    lines: [...p.lines, ...p.intro],
    mutualFriends: p.mutual_friends,
    groupName: p.name,
  });
  return fit.level !== 'skip' && fit.level !== 'unknown';
}

/**
 * By the AI's check of each (decision 92): a good one counts wherever they were found in a group; one not checked yet
 * (or that couldn't be) counts only in a group to work; a maybe or a no never does, as only a good check reaches them.
 */
function leftByCheck(playbooks: readonly Playbook[], p: LeftRow): boolean {
  if (p.verdict === 'good') return true;
  if (p.verdict === 'maybe' || p.verdict === 'not') return false;
  return groupFitOf(playbooks, p).verdict === 'work';
}

/** How many people a network's groups have left to reach, against a day's friend requests there. */
export async function prospectsOf(
  ctx: Ctx,
  left: ReadonlyMap<string, number>,
  platform: Platform = 'facebook',
): Promise<ProspectsLeft> {
  const rules = await rulesOf(ctx);
  const perDay = networkLimitsNow(
    platform,
    false,
    businessLimitsOn(rules, platform),
  ).friend_request;
  return prospectsLeft(
    [...left.values()].reduce((a, b) => a + b, 0),
    perDay,
  );
}

const ago = (now: number, days: number) => new Date(now - days * DAY).toISOString();

/**
 * The words to search a network for groups with: the playbooks' words for groups, with whether that word's playbook
 * works with clients online (decision 92), so the search goes anywhere rather than the person's town. Each once for
 * each way (`eachSearchOnce`): a word a local playbook and an online one share is searched both ways. Anywhere only
 * where groups go by the AI's check of the people in them (`groupsByCheck`, Alignable's); Facebook's never go
 * anywhere, so each word is searched there once, whatever its case.
 */
export function groupSearchWords(
  playbooks: readonly { readonly details: Pick<PlaybookDetails, 'groupWords' | 'worksOnline'> }[],
  platform: Platform,
): { words: string; anywhere: boolean }[] {
  return eachSearchOnce(
    playbooks.flatMap((p) =>
      p.details.groupWords.flatMap((w) => {
        const words = w.replace(/[“”"]/g, '').trim();
        return words
          ? [{ words, anywhere: groupsByCheck(platform) && p.details.worksOnline === true }]
          : [];
      }),
    ),
  );
}

export const groupsToCheck = defineAddonQuery(outreachAddon, {
  name: 'outreach.groups.to_check',
  description:
    'Which of the business’s groups on a network (Facebook’s, or Alignable’s) the person’s computer checks next for whether the playbooks’ people are there: their own groups first, then groups found that fit by name; none checked lately. Facebook’s when no network is named.',
  input: GroupsToCheckInput,
  output: GroupsToCheckOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_groups_to_check',
    keywords: ['groups checked next'],
  },
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
          where g.workspace_id = ${ctx.scope.workspaceId!} and g.platform = ${input.platform}
            and (g.check_state is null
              or (g.check_state in ('good', 'maybe', 'not')
                and g.checked_at < ${ago(now, GROUP_CHECK_AGAIN_DAYS)}::timestamptz)
              or (g.check_state = 'failed'
                and g.about_at < ${ago(now, GROUP_CHECK_RETRY_DAYS)}::timestamptz))
          order by g.seen_at desc nulls last limit 500`,
    );
    const playbooks = await playbooksInUse(ctx, input.platform);
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
    const [kept] = found.length
      ? [{ n: found.length }]
      : await rows<{ n: number }>(
          ctx.tx,
          sql`select count(*)::int as n from addon_outreach.groups
              where workspace_id = ${ctx.scope.workspaceId!} and platform = ${input.platform}`,
        );
    return {
      groups: ranked.slice(0, input.most).map(({ g }) => ({
        groupId: g.id,
        name: g.name,
        url: g.url,
        joined: g.joined,
      })),
      saved: kept?.n ?? 0,
    };
  },
});

export const groupLook = defineAddonCommand(outreachAddon, {
  name: 'outreach.group.look',
  description:
    'What a group’s About page, rules and latest posts said as the person’s computer read them, on Facebook or Alignable, for the AI to see whether the playbooks’ people are there. The About page and rules are kept on the group; the posts only until the AI has read them.',
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
      .select({ id: groups.id, platform: groups.platform })
      .from(groups)
      .where(and(eq(groups.workspaceId, ws), eq(groups.id, input.groupId)))
      .for('update');
    if (!group)
      throw HfosError.notFound('That group isn’t kept here anymore. Save your groups again.');
    await ctx.tx
      .update(groups)
      .set({
        ...(input.about.length ? { about: input.about } : {}),
        ...(input.rules.length ? { rules: input.rules } : {}),
        aboutAt: at,
        checkLines: input.posts,
        checkState: state,
        ...(nothing
          ? {
              // Its own network's name: "Alignable didn’t show what it’s about".
              checkWhy: [`${NETWORKS[group.platform].name} didn’t show what it’s about`],
              checkWho: null,
              checkedAt: at,
            }
          : {}),
      })
      .where(eq(groups.id, group.id));
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
        entityType: 'outreach_group',
        entityId: group.id,
        payload: { groupId: group.id },
      });
    return { groupId: group.id, checkState: state };
  },
});

export const groupCheck = defineAddonCommand(outreachAddon, {
  name: 'outreach.group.check',
  description:
    'Worker: what the AI made of a group on Facebook or Alignable: the business’s people are there, some are, or they aren’t, which playbook, why and who posts there; or that it couldn’t read it. The posts it read are let go.',
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
      entityType: 'outreach_group',
      entityId: group.id,
      payload: { groupId: group.id, checkState: state },
    });
    return { saved: true, checkState: state };
  },
});

export const joinsNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.joins.next',
  description:
    'Which groups on a network (Facebook’s, or Alignable’s) the person’s computer asks to join next (decisions 31 and 92): the ones the AI says the business’s people are in, or that fit well by name while it hasn’t read them, that the person isn’t in and hasn’t asked to join; no more than today has room for there. With how many people that network’s groups have left to reach, words to search for more groups with and whether they go anywhere, and the person’s Join switch there. Facebook’s when no network is named.',
  input: JoinsNextInput,
  output: JoinsNextOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_groups_to_join',
    keywords: ['groups to join', 'ask to join'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const platform = input.platform;
    const now = Date.now();
    const todayStart = await startOfToday(ctx, now);
    // Groups are joined on their own network: only its warning halves the joins there, and a network with no joins in
    // its kit has none.
    const warning = await warningOf(ctx, me, platform, todayStart, now);
    const most = NETWORKS[platform].joinsPerDay;
    const perDay = most ? limitNow(most, slowsNow(warning, now)) : 0;
    const [done] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from addon_outreach.joins j
          join addon_outreach.groups g on g.id = j.group_id and g.platform = ${platform}
          where j.workspace_id = ${ws} and j.user_id = ${me}
            and j.asked_at >= ${todayStart.toISOString()}::timestamptz`,
    );
    const today = done?.n ?? 0;
    const playbooks = await playbooksInUse(ctx, platform);
    const prospects = await prospectsOf(
      ctx,
      await peopleLeft(ctx, me, playbooks, platform),
      platform,
    );
    const words = groupSearchWords(playbooks, platform);
    const room = Math.max(0, Math.min(input.most, perDay - today));
    const found = room
      ? await rows<CheckedGroupRow & { id: string; url: string }>(
          ctx.tx,
          sql`select g.id, g.name, g.url, g.detail, g.members, g.privacy, g.check_state, g.check_why,
                g.check_playbook_id, null::text as check_playbook, false as joined
              from addon_outreach.groups g
              where g.workspace_id = ${ws} and g.platform = ${platform}
                and ${input.groupIds ? sql`g.id = any (${`{${input.groupIds.join(',')}}`}::uuid[])` : sql`true`}
                and not exists (select 1 from addon_outreach.my_groups m
                  where m.group_id = g.id and m.user_id = ${me} and m.joined)
                and not exists (select 1 from addon_outreach.joins j
                  where j.group_id = g.id and j.user_id = ${me} and (j.state <> 'failed'
                    or ${input.groupIds ? sql`false` : sql`j.asked_at >= ${ago(now, GROUP_CHECK_RETRY_DAYS)}::timestamptz`}))
                and g.check_state is distinct from 'not'
                ${input.groupIds ? sql`` : sql`and ${notOthers(me, 'g')}`}
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
    // A different word each day, in turn; a search again later in the day takes the next word (decision 126).
    const [word] = inTurn(words, 1, dayNumber(now) + input.round);
    return {
      groups: ranked.slice(0, room).map(({ g }) => ({ groupId: g.id, name: g.name, url: g.url })),
      today,
      perDay,
      prospects,
      words: word?.words ?? null,
      anywhere: word?.anywhere ?? false,
      // The person's Join switch on that network (Facebook's is the settings' own).
      onItsOwn: (await automationOf(ctx, me, now, platform)).choices.joinGroups,
      more: await moreToday(ctx, me, platform, now, warning),
    };
  },
});

export const joinNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.join.note',
  description:
    'How the person’s computer’s ask to join a group on Facebook or Alignable went: asked, waiting for the admins, joined, or couldn’t and why, with the AI’s answers to the group’s questions. Joined, it’s one of the person’s groups.',
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
    // Asking to join works the group (decision 107).
    if (input.state !== 'failed') await claimGroup(ctx, me, group.id, at);
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
      entityType: 'outreach_group',
      entityId: group.id,
      payload: { groupId: group.id, state: input.state },
    });
    return { groupId: group.id, state: input.state };
  },
});

export const groupCheckCommands = [groupLook, groupCheck, joinNote] as const;
export const groupCheckQueries = [groupsToCheck, joinsNext] as const;
