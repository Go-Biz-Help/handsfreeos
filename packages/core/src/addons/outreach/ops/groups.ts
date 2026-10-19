/**
 * Groups (docs/outreach.md, the plan's Phase 1 step 4): the groups the extension saw, with what the page said about
 * them, and the people found on their People tab. How each group fits the playbooks is worked out as it's listed
 * (../groups.ts), so a changed playbook changes it at once; the ones whose people wrote back and booked demos come
 * first (../results.ts). Admins and moderators are kept as such and never suggested; a group's members are suggested
 * only once its full list of them has been read. Nobody goes in Contacts.
 */
import { eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import type { GroupCheckState, JoinState } from '../group-checks';
import {
  GROUP_VERDICT_KEYS,
  GROUPS_PAGE,
  GroupSaveInput,
  GroupSaveOutput,
  GroupsInput,
  GroupsOutput,
  GroupsSaveInput,
  GroupsSaveOutput,
  type GroupVerdict,
} from '../groups';
import { outreachAddon } from '../manifest';
import type { Platform } from '../playbooks';
import { byResults } from '../results';
import { groupPeople, groups, myGroups } from '../tables';
import { automationOf } from './automation';
import { EVER, keepGroup, reachedPeople, resultsByGroup } from './activity';
import { inWorkspace, keptProfile, once } from './common';
import { playbooksInUse } from './friends';
import { groupFitOf, peopleLeft, prospectsOf } from './group-checks';

type Facts = Pick<GroupSaveInput, 'group' | 'privacy' | 'members' | 'detail' | 'joined'>;

/** A group kept, with what the page said about it, and whether the person is in it. */
async function keepFacts(
  ctx: CommandContext,
  platform: Platform,
  me: string,
  facts: Facts & { readonly group: Parameters<typeof keepGroup>[2] },
  at: Date,
): Promise<string> {
  const groupId = await keepGroup(ctx, platform, facts.group);
  await ctx.tx
    .update(groups)
    .set({
      ...(facts.privacy ? { privacy: facts.privacy } : {}),
      ...(facts.members !== null && facts.members !== undefined ? { members: facts.members } : {}),
      ...(facts.detail ? { detail: facts.detail } : {}),
      seenAt: at,
    })
    .where(eq(groups.id, groupId));
  if (facts.joined !== null && facts.joined !== undefined)
    await ctx.tx
      .insert(myGroups)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        userId: me,
        groupId,
        joined: facts.joined,
        seenAt: at,
      })
      .onConflictDoUpdate({
        target: [myGroups.workspaceId, myGroups.userId, myGroups.groupId],
        set: { joined: facts.joined, seenAt: at },
      });
  return groupId;
}

export const groupsSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.groups.save',
  description:
    'Save the groups on a Facebook page the person has open (their own groups, or search results), with what the page says about each: public or private, how many members, the line under its name, and whether they are in it. Nothing goes in Contacts.',
  risk: 1,
  input: GroupsSaveInput,
  output: GroupsSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.groups.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      for (const g of input.groups) await keepFacts(ctx, input.platform, me, g, at);
      await ctx.emit({
        type: 'outreach.groups.saved',
        entityType: 'workspace',
        entityId: ctx.scope.workspaceId!,
        payload: { platform: input.platform, groups: input.groups.length },
      });
      return { saved: input.groups.length };
    });
  },
});

export const groupSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.group.save',
  description:
    'Save a Facebook group the person has open and the people on its People tab (or one of its See all pages), with the lines under each name. Admins and moderators are kept as such and never suggested; the full list of them marks the group’s admins as read. Nobody goes in Contacts.',
  risk: 1,
  input: GroupSaveInput,
  output: GroupSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.group.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      const groupId = await keepFacts(ctx, input.platform, me, input, at);
      let runs = 0;
      for (const p of input.people) {
        const profile = await keptProfile(
          ctx,
          { platform: input.platform, profile: p.profile, name: p.name },
          me,
          at,
          { groupId },
          (had) => (had.groupId ? {} : { groupId }),
        );
        if (p.runsGroup) runs++;
        await ctx.tx
          .insert(groupPeople)
          .values({
            workspaceId: ws,
            groupId,
            profileId: profile.id,
            runsGroup: p.runsGroup,
            part: p.part,
            lines: p.lines,
            seenAt: at,
          })
          .onConflictDoUpdate({
            target: [groupPeople.groupId, groupPeople.profileId],
            set: {
              // Once seen running it, always: the list of admins is only seen in full now and then.
              runsGroup: sql`${groupPeople.runsGroup} or excluded.runs_group`,
              part: sql`coalesce(excluded.part, ${groupPeople.part})`,
              lines: sql`case when cardinality(excluded.lines) > 0 then excluded.lines else ${groupPeople.lines} end`,
              seenAt: at,
            },
          });
      }
      if (input.adminsPage)
        await ctx.tx.update(groups).set({ adminsReadAt: at }).where(eq(groups.id, groupId));
      await ctx.emit({
        type: 'outreach.group.saved',
        entityType: 'workspace',
        entityId: ws,
        payload: {
          groupId,
          people: input.people.length,
          runsGroup: runs,
          adminsPage: input.adminsPage,
        },
      });
      return { groupId, people: input.people.length, runsGroup: runs };
    });
  },
});

/** The most groups put in order at once. */
const GROUPS_MOST = 2000;

export const groupsList = defineAddonQuery(outreachAddon, {
  name: 'outreach.groups',
  description:
    'The business’s Facebook groups the extension has seen, each scored against the playbooks in use as Work these, Maybe or Skip with why, with how many people were found there, how many run it, whether its admins have all been read, the friend requests sent to people found there, how many of the people reached from it wrote back and booked a demo, and whether the person is in it. The ones that brought demos and replies first, then the best fit.',
  input: GroupsInput,
  output: GroupsOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const listed = await rows<{
      id: string;
      name: string | null;
      url: string;
      privacy: 'public' | 'private' | null;
      members: number | null;
      detail: string | null;
      joined: boolean | null;
      people: number;
      runs: number;
      admins_read_at: Date | string | null;
      requests: number;
      seen_at: Date | string | null;
      check_state: GroupCheckState | null;
      check_why: string[];
      check_who: string | null;
      check_playbook_id: string | null;
      check_playbook: string | null;
      checked_at: Date | string | null;
      join_state: JoinState | null;
      join_at: Date | string | null;
    }>(
      ctx.tx,
      sql`select g.id, g.name, g.url, g.privacy, g.members, g.detail, g.admins_read_at, g.seen_at,
            g.check_state, g.check_why, g.check_who, g.check_playbook_id, cpb.name as check_playbook, g.checked_at,
            j.state as join_state, j.asked_at as join_at,
            (select m.joined from addon_outreach.my_groups m where m.group_id = g.id and m.user_id = ${me}) as joined,
            (select count(*)::int from addon_outreach.group_people gp where gp.group_id = g.id) as people,
            (select count(*)::int from addon_outreach.group_people gp
              where gp.group_id = g.id and gp.runs_group) as runs,
            (select count(*)::int from addon_outreach.touches t
              where t.group_id = g.id and t.kind = 'friend_request') as requests
          from addon_outreach.groups g
          left join addon_outreach.playbooks cpb on cpb.id = g.check_playbook_id
          left join addon_outreach.joins j on j.group_id = g.id and j.user_id = ${me}
          where g.workspace_id = ${ws} and g.platform = ${input.platform}
          order by g.seen_at desc nulls last, g.created_at desc
          limit ${GROUPS_MOST}`,
    );
    const playbooks = await playbooksInUse(ctx, 'facebook');
    const results = resultsByGroup(await reachedPeople(ctx, { from: EVER, me, everyone: true }));
    // The AI's read of a group goes over what its name says (decision 48).
    const fitted = listed.map((g) => ({ g, fit: groupFitOf(playbooks, g) }));
    const left = await peopleLeft(ctx, me, playbooks);
    const counts = Object.fromEntries(
      GROUP_VERDICT_KEYS.map((v) => [v, fitted.filter((f) => f.fit.verdict === v).length]),
    ) as Record<GroupVerdict, number>;
    const resultsOf = (id: string) => results.get(id) ?? { replies: 0, demos: 0 };
    const search = input.search?.toLowerCase();
    const shown = fitted
      .filter((f) => input.view === 'all' || f.fit.verdict === input.view)
      .filter((f) => !search || (f.g.name ?? '').toLowerCase().includes(search))
      // The ones that brought demos and replies first, so they're worked more; then the best fit.
      .sort(
        (a, b) =>
          byResults(resultsOf(a.g.id), resultsOf(b.g.id)) ||
          b.fit.score - a.fit.score ||
          (b.g.members ?? 0) - (a.g.members ?? 0),
      );
    const total = shown.length;
    const pages = Math.max(1, Math.ceil(total / GROUPS_PAGE));
    const page = Math.min(input.page, pages);
    return {
      counts: { ...counts, all: fitted.length },
      groups: shown.slice((page - 1) * GROUPS_PAGE, page * GROUPS_PAGE).map(({ g, fit }) => ({
        groupId: g.id,
        name: g.name,
        url: g.url,
        privacy: g.privacy,
        members: g.members,
        detail: g.detail,
        joined: g.joined,
        verdict: fit.verdict,
        reasons: [...fit.reasons],
        playbookName: fit.playbookName,
        people: g.people,
        runsGroup: g.runs,
        adminsRead: g.admins_read_at !== null,
        requests: g.requests,
        replies: resultsOf(g.id).replies,
        demos: resultsOf(g.id).demos,
        seenAt: g.seen_at === null ? null : new Date(g.seen_at).toISOString(),
        check: g.check_state
          ? {
              state: g.check_state,
              why: g.check_why,
              who: g.check_who,
              playbookName: g.check_playbook,
              checkedAt: g.checked_at === null ? null : new Date(g.checked_at).toISOString(),
            }
          : null,
        left: left.get(g.id) ?? 0,
        join:
          g.join_state && g.join_at
            ? { state: g.join_state, at: new Date(g.join_at).toISOString() }
            : null,
      })),
      prospects: await prospectsOf(ctx, left),
      joinsOnItsOwn: (await automationOf(ctx, me)).settings.joinGroups,
      page,
      pages,
      total,
    };
  },
});

export const groupCommands = [groupsSave, groupSave] as const;
export const groupQueries = [groupsList] as const;
