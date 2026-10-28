/**
 * How someone the business reached came along (../journey.ts, docs/outreach.md decision 103): each profile's way so
 * far, for a customer's Social panel (`journeysOf`, read by `outreach.person`), and a group's page of who was found
 * there and how each turned out (`outreach.group.people`). Where someone stands is worked out as the pipeline does it
 * (./stages.ts), for the person.
 */
import { sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { userRef } from '../../../crm/records';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { defineAddonQuery } from '../../server';
import {
  GROUP_OUTCOME_ORDER,
  GROUP_PEOPLE_PAGE,
  GroupPeopleInput,
  GroupPeopleOutput,
  JOURNEY_STEPS_MOST,
  NO_JOURNEY,
  notReachedWhy,
  type Journey,
  type JourneyKind,
  type JourneyStep,
} from '../journey';
import type { TouchStep } from '../limits';
import { outreachAddon } from '../manifest';
import type { Platform } from '../networks';
import { STAGE_KEYS, type Stage } from '../stages';
import { inWorkspace, seesEveryone, type Ctx } from './common';
import { staged, standingOf, type StagedRow } from './stages';

const iso = (at: Date | string) => new Date(at).toISOString();
const idList = (ids: readonly string[]) => `{${ids.join(',')}}`;

/**
 * Each profile's way so far, for the person (`me`): where they stand, the groups they were found in, the person's
 * chat with them as the AI read it, and the steps either way, the latest first. The steps are the person's own; an
 * owner's or admin's are everyone's, a teammate's named.
 */
export async function journeysOf(
  ctx: Ctx,
  me: string,
  profileIds: readonly string[],
): Promise<Map<string, Journey>> {
  const ids = [...new Set(profileIds)];
  if (!ids.length) return new Map();
  const list = idList(ids);
  const now = Date.now();
  const standing = await rows<StagedRow>(
    ctx.tx,
    sql`select s.* from (${staged(ctx, me, sql`p.id = any (${list}::uuid[])`)}) s`,
  );
  const groups = await rows<{
    profile_id: string;
    id: string;
    name: string | null;
    url: string;
  }>(
    ctx.tx,
    sql`select x.profile_id, g.id, g.name, g.url
        from (
          select gp.profile_id, gp.group_id, gp.seen_at from addon_outreach.group_people gp
          where gp.profile_id = any (${list}::uuid[])
          union all
          select p.id, p.group_id, p.last_seen_at from addon_outreach.profiles p
          where p.id = any (${list}::uuid[]) and p.group_id is not null
        ) x
        join addon_outreach.groups g on g.id = x.group_id
        group by x.profile_id, g.id, g.name, g.url
        order by x.profile_id, max(x.seen_at) desc`,
  );
  const chats = await rows<{
    profile_id: string;
    summary: string | null;
    next_step: string | null;
    last_at: Date | string;
    last_from_me: boolean;
  }>(
    ctx.tx,
    sql`select distinct on (c.profile_id) c.profile_id, c.summary, c.next_step, c.last_at, c.last_from_me
        from addon_outreach.file_chats c
        where c.user_id = ${me} and c.profile_id = any (${list}::uuid[])
        order by c.profile_id, c.last_at desc`,
  );
  // The business's lead for them, as the pipeline has it now: one archived or deleted is left out.
  const leads = await rows<{
    profile_id: string;
    id: string;
    title: string;
    stage: string;
    status: 'open' | 'won' | 'lost';
  }>(
    ctx.tx,
    sql`select p.id as profile_id, l.id, l.title, s.name as stage, l.status
        from addon_outreach.profiles p
        join app.leads l on l.id = p.lead_id and l.archived_at is null and l.bin_item_id is null
        join app.pipeline_stages s on s.id = l.stage_id
        where p.id = any (${list}::uuid[])`,
  );
  const everyone = await seesEveryone(ctx, me);
  const whose = (column: string) => (everyone ? sql`true` : sql`${sql.raw(column)} = ${me}`);
  const steps = await rows<{
    profile_id: string;
    kind: JourneyKind;
    step: TouchStep | null;
    at: Date | string;
    auto: boolean;
    user_id: string | null;
    group_name: string | null;
    group_url: string | null;
    post_url: string | null;
    total: number;
  }>(
    ctx.tx,
    sql`select z.* from (
          select s.*, row_number() over (partition by s.profile_id order by s.at desc) as n,
            (count(*) over (partition by s.profile_id))::int as total
          from (
            select t.profile_id, t.kind, t.step, t.at, t.auto, t.user_id, g.name as group_name, g.url as group_url,
              t.post_url
            from addon_outreach.touches t
            left join addon_outreach.groups g on g.id = t.group_id
            where t.profile_id = any (${list}::uuid[]) and ${whose('t.user_id')}
            union all
            select r.profile_id, 'reply', null, r.seen_at, false, r.user_id, null, null, null
            from addon_outreach.replies r
            where r.profile_id = any (${list}::uuid[]) and ${whose('r.user_id')}
            union all
            select d.profile_id, 'demo', null, d.at, false, d.user_id, null, null, null
            from addon_outreach.demos d
            where d.profile_id = any (${list}::uuid[]) and d.undone_at is null and ${whose('d.user_id')}
          ) s
        ) z
        where z.n <= ${JOURNEY_STEPS_MOST}
        order by z.profile_id, z.at desc`,
  );
  const names = new Map<string, string | null>();
  for (const id of new Set(
    steps.flatMap((s) => (s.user_id && s.user_id !== me ? [s.user_id] : [])),
  ))
    names.set(id, (await userRef(ctx.tx, id))?.fullName ?? null);

  const out = new Map<string, Journey>(
    ids.map((id) => [id, { ...NO_JOURNEY, groups: [], steps: [] }]),
  );
  for (const r of standing) {
    const { stage, why, nextStep } = standingOf(r, now);
    out.set(r.profile_id, { ...out.get(r.profile_id)!, stage, why, nextStep });
  }
  for (const g of groups)
    out.get(g.profile_id)!.groups.push({ groupId: g.id, name: g.name, url: g.url });
  for (const c of chats)
    out.set(c.profile_id, {
      ...out.get(c.profile_id)!,
      chat: {
        summary: c.summary,
        nextStep: c.next_step,
        lastAt: iso(c.last_at),
        lastFromMe: c.last_from_me,
      },
    });
  for (const l of leads)
    out.get(l.profile_id)!.lead = {
      leadId: l.id,
      title: l.title,
      stage: l.stage,
      status: l.status,
    };
  for (const s of steps) {
    const journey = out.get(s.profile_id)!;
    const step: JourneyStep = {
      kind: s.kind,
      step: s.step,
      at: iso(s.at),
      auto: s.auto,
      by: s.user_id && s.user_id !== me ? (names.get(s.user_id) ?? 'A teammate') : null,
      group: s.group_url ? { name: s.group_name, url: s.group_url } : null,
      postUrl: s.post_url,
    };
    journey.steps.push(step);
    journey.moreSteps = Math.max(0, s.total - JOURNEY_STEPS_MOST);
  }
  return out;
}

export const groupPeople = defineAddonQuery(outreachAddon, {
  name: 'outreach.group.people',
  description:
    'One group’s page: the group, everyone the extension found in it (its admins and moderators marked), and how each turned out for the person: where they stand (found, warming up, friends, talking, ready to pitch, pitched, booked, a client, not a fit) with why and the AI’s next step, or not reached yet; counted by outcome, the furthest first, one outcome at a time.',
  input: GroupPeopleInput,
  output: GroupPeopleOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_group_people',
    keywords: ['group page', 'who was found in a group', 'how a group turned out', 'group results'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [group] = await rows<{
      id: string;
      platform: Platform;
      name: string | null;
      url: string;
      members: number | null;
      joined: boolean | null;
    }>(
      ctx.tx,
      sql`select g.id, g.platform, g.name, g.url, g.members,
            (select m.joined from addon_outreach.my_groups m where m.group_id = g.id and m.user_id = ${me}) as joined
          from addon_outreach.groups g
          where g.workspace_id = ${ws} and g.id = ${input.groupId}`,
    );
    if (!group)
      throw HfosError.notFound(
        'That group isn’t kept in Social Outreach any more. Go back to Groups and pick it again.',
      );
    const inGroup = sql`exists (select 1 from addon_outreach.group_people gp
      where gp.profile_id = p.id and gp.group_id = ${group.id})`;
    // Everyone found there, each with where they stand for the person when they've been reached.
    const everyone = sql`select s.*, gp.profile_id as member_id, gp.runs_group, gp.part,
        p.person_id as profile_person_id, p.url as profile_url,
        coalesce(nullif(btrim(pp.first_name || ' ' || pp.last_name), ''), p.name) as profile_name,
        coalesce(s.stage, 'not_reached') as outcome
      from addon_outreach.group_people gp
      join addon_outreach.profiles p on p.id = gp.profile_id
      left join app.people pp on pp.id = p.person_id
      left join (${staged(ctx, me, inGroup)}) s on s.profile_id = gp.profile_id
      where gp.group_id = ${group.id} and p.friendship <> 'self'`;
    const counted = await rows<{ outcome: Stage | 'not_reached'; n: number }>(
      ctx.tx,
      sql`select e.outcome, count(*)::int as n from (${everyone}) e group by e.outcome`,
    );
    const counts = {
      all: 0,
      not_reached: 0,
      ...(Object.fromEntries(STAGE_KEYS.map((k) => [k, 0])) as Record<Stage, number>),
    };
    for (const c of counted) {
      counts[c.outcome] = c.n;
      counts.all += c.n;
    }
    const shown = input.view === 'all' ? sql`true` : sql`e.outcome = ${input.view}`;
    const total = input.view === 'all' ? counts.all : counts[input.view];
    const pages = Math.max(1, Math.ceil(total / GROUP_PEOPLE_PAGE));
    const page = Math.min(input.page, pages);
    const order = `{${[...GROUP_OUTCOME_ORDER, 'not_reached'].join(',')}}`;
    const listed = await rows<
      StagedRow & {
        member_id: string;
        runs_group: boolean;
        part: string | null;
        profile_person_id: string | null;
        profile_url: string;
        profile_name: string;
        outcome: Stage | 'not_reached';
      }
    >(
      ctx.tx,
      sql`select e.* from (${everyone}) e where ${shown}
          order by array_position(${order}::text[], e.outcome), e.runs_group desc,
            e.last_at desc nulls last, e.profile_name, e.member_id
          limit ${GROUP_PEOPLE_PAGE} offset ${(page - 1) * GROUP_PEOPLE_PAGE}`,
    );
    const now = Date.now();
    return {
      group: {
        groupId: group.id,
        platform: group.platform,
        name: group.name,
        url: group.url,
        members: group.members,
        joined: group.joined,
      },
      counts,
      people: listed.map((r) => {
        const reached = r.outcome !== 'not_reached' ? standingOf(r, now) : null;
        return {
          profileId: r.member_id,
          personId: r.profile_person_id,
          name: r.profile_name,
          url: r.profile_url,
          runsGroup: r.runs_group,
          part: r.part,
          stage: reached?.stage ?? null,
          why: reached?.why ?? notReachedWhy(r.runs_group),
          nextStep: reached?.nextStep ?? null,
          lastAt: reached?.lastAt ?? null,
        };
      }),
      page,
      pages,
      total,
    };
  },
});

export const journeyQueries = [groupPeople] as const;
