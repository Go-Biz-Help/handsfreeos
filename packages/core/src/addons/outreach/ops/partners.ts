/**
 * Partners (../partners.ts, docs/outreach.md decision 81): who the person's computer reads next for the AI's partner
 * check, what their profile said as it read it, what the AI made of it, the Partners list, and what the person marks
 * on it. Each person's own, like their checks (./checks.ts). Someone found as a partner is never pitched as a
 * customer again, nor are their twins (`partnered` in ./common.ts).
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { outreachAddon } from '../manifest';
import { demoLink, partnerRef, readPartnerRef } from '../demos';
import type { DailyStep } from '../limits';
import { NETWORKS, type Platform } from '../networks';
import {
  PARTNER_AGAIN_DAYS,
  PARTNER_ASKS_PER_DAY,
  PARTNER_FOLLOW_UP_DAYS,
  PARTNER_FOLLOW_UPS,
  PARTNER_REPLY_DAYS,
  PARTNER_WARM_DAYS,
  PARTNER_WORDS,
  PartnerAnswerInput,
  PartnerAnswerOutput,
  PartnerCallInput,
  PartnerCallOutput,
  PARTNER_MIN_FOLLOWERS,
  PARTNER_MIN_MEMBERS,
  PARTNER_QUIET_DAYS,
  PARTNER_RETRY_DAYS,
  PARTNER_STAGE_KEYS,
  PARTNERS_PAGE,
  PartnerLookInput,
  PartnerLookOutput,
  PartnerMarkInput,
  PartnerMarkOutput,
  PartnerSaveInput,
  PartnerSaveOutput,
  PartnersInput,
  PartnersNextInput,
  PartnersNextOutput,
  PartnersOutput,
  partnerKindsOf,
  partnerReadsPerDay,
  type PartnerFit,
  type PartnerKind,
  type PartnerMark,
  type PartnerRow,
  type PartnerStage,
} from '../partners';
import { forPartners, PlaybookDetails, upgradePlaybookDetails } from '../playbooks';
import {
  PARTNER_TODAY_KINDS,
  TODAY_LIMIT,
  TODAY_MOST,
  type PartnerTodayKind,
  type TodayItem,
} from '../today';
import { partners, playbooks, profiles } from '../tables';
import { readsPerDay, readToday } from './checks';
import { inWorkspace, notNever, partnered, type Ctx } from './common';
import { partnerPlaybooksInUse } from './friends';
import { slowsNow, startOfToday, warningOf } from './tidy';

const DAY = 86_400_000;

/** Words in someone's intro that say they run a business: on Alignable everyone does. */
const BUSINESS_WORDS =
  '\\m(owner|co-?owner|founder|co-?founder|ceo|president|proprietor|principal|llc|inc|agency|studio|consulting)\\M';

/**
 * How many the person's computer reads a day for the AI's partner check on a network, and how many more it may today:
 * at most half the network's profiles read a day (`partnerReadsPerDay`), within what the customer checks left.
 */
export async function partnerPerDayFor(ctx: Ctx, me: string, now: number, platform: Platform) {
  const todayStart = await startOfToday(ctx, now);
  const warning = await warningOf(ctx, me, platform, todayStart, now);
  const read = await readToday(ctx, me, platform, todayStart);
  const reads = readsPerDay(platform, slowsNow(warning, now));
  const perDay = partnerReadsPerDay(reads);
  return {
    today: read.partners,
    perDay,
    room: Math.max(0, Math.min(perDay - read.partners, reads - read.checks - read.partners)),
  };
}

export const partnersNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.partners.next',
  description:
    'Who the person’s computer reads next for whether they could partner with the business, in order and no more than today has room for: admins of the biggest groups the business’s customers are in, then people with the biggest followings, then businesses. Only with a Find partners playbook in use on the network; never anyone on Don’t pitch or Never contact, anyone found already, anyone being messaged as a customer lately, nor anyone read lately.',
  input: PartnersNextInput,
  output: PartnersNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const { today, perDay, room: left } = await partnerPerDayFor(ctx, me, now, input.platform);
    const room = Math.min(input.most, left);
    if (!room) return { people: [], today, perDay };
    // The partner playbooks in use on this network say which kinds of partner to look for.
    const kinds = new Set(
      (await partnerPlaybooksInUse(ctx))
        .filter((p) => p.details.platforms.includes(input.platform))
        .flatMap((p) => partnerKindsOf(p.details)),
    );
    if (!kinds.size) return { people: [], today, perDay };
    const ago = (days: number) => new Date(now - days * DAY).toISOString();
    const looks = (kind: PartnerKind) => sql`${kinds.has(kind)}::boolean`;
    const found = await rows<{ id: string; name: string; url: string; kind: PartnerKind }>(
      ctx.tx,
      sql`select x.id, x.name, x.url, x.kind from (
            select p.id, p.name, p.url, p.followers, p.mutual_friends, p.updated_at, gr.members, gr.good,
              case
                when ${looks('group_admin')} and gr.members is not null then 'group_admin'
                when ${looks('creator')} and coalesce(p.followers, 0) >= ${PARTNER_MIN_FOLLOWERS} then 'creator'
                when ${looks('business')}
                  and (p.platform = 'alignable' or array_to_string(p.intro, ' ') ~* ${BUSINESS_WORDS})
                  -- Someone the AI found could be a customer is left to the customer steps.
                  and not exists (select 1 from addon_outreach.checks ch
                    where ch.profile_id = p.id and ch.user_id = ${me} and ch.verdict in ('good', 'maybe'))
                  then 'business'
              end as kind
            from addon_outreach.profiles p
            left join addon_outreach.partners pa on pa.profile_id = p.id and pa.user_id = ${me}
            -- The groups they run with room for an audience, and whether the AI called one the business's people.
            left join lateral (
              select sum(g.members)::int as members, bool_or(g.check_state = 'good') as good
              from addon_outreach.group_people gp join addon_outreach.groups g on g.id = gp.group_id
              where gp.profile_id = p.id and gp.runs_group and g.members >= ${PARTNER_MIN_MEMBERS}
                and g.check_state is distinct from 'not'
            ) gr on true
            where p.workspace_id = ${ws} and p.platform = ${input.platform} and p.friendship <> 'self'
              and ${notNever('p')} and not ${partnered('p')}
              and (pa.id is null
                or (pa.fit = 'not' and pa.checked_at < ${ago(PARTNER_AGAIN_DAYS)}::timestamptz)
                or (pa.fit = 'failed' and pa.looked_at < ${ago(PARTNER_RETRY_DAYS)}::timestamptz))
              -- Not in the middle of being reached as a customer, nor said Not interested.
              and not exists (select 1 from addon_outreach.sends s
                where s.profile_id = p.id and s.user_id = ${me} and s.state in ('waiting', 'approved', 'sent')
                  and coalesce(s.done_at, s.created_at) >= ${ago(PARTNER_QUIET_DAYS)}::timestamptz)
              and not exists (select 1 from addon_outreach.stages st
                where st.profile_id = p.id and st.user_id = ${me} and st.mark = 'lost')
          ) x
          where x.kind is not null
          order by array_position(array['group_admin', 'creator', 'business'], x.kind),
            coalesce(x.good, false) desc, coalesce(x.members, x.followers, 0) desc,
            x.mutual_friends desc nulls last, x.updated_at desc, x.id
          limit ${room}`,
    );
    return {
      people: found.map((p) => ({ profileId: p.id, name: p.name, url: p.url, kind: p.kind })),
      today,
      perDay,
    };
  },
});

export const partnerLook = defineAddonCommand(outreachAddon, {
  name: 'outreach.partner.look',
  description:
    'What someone who could partner with the business says on their profile, and how many follow them, as the person’s computer just read it, for the AI to see whether their audience is the business’s customers; or that the network showed someone else. What their profile said is kept only until the AI has read it.',
  risk: 1,
  input: PartnerLookInput,
  output: PartnerLookOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.partner.looked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [profile] = await rows<{ id: string; name: string; platform: Platform; never: boolean }>(
      ctx.tx,
      sql`select p.id, p.name, p.platform, not ${notNever('p')} as never from addon_outreach.profiles p
          where p.workspace_id = ${ws} and p.id = ${input.profileId}`,
    );
    if (!profile)
      throw HfosError.notFound(
        'That person isn’t kept here anymore. Your computer finds them again as it works.',
      );
    if (profile.never)
      throw HfosError.rule(
        'outreach_partner_never',
        409,
        `${profile.name} is on Don’t pitch or Never contact, so they’re never asked to partner.`,
      );
    // How many follow them, as their profile says now.
    if (!input.missing && input.followers !== null)
      await ctx.tx
        .update(profiles)
        .set({ followers: input.followers, followersAt: at })
        .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, profile.id)));
    const fit: PartnerFit = input.missing ? 'failed' : 'waiting';
    const why = input.missing
      ? [`${NETWORKS[profile.platform].name} didn’t show their profile`]
      : [];
    const lines = input.missing ? [] : input.lines;
    // Someone on the Partners list stays as they are: a read is for one not found yet.
    const [row] = await ctx.tx
      .insert(partners)
      .values({
        workspaceId: ws,
        userId: me,
        profileId: profile.id,
        kind: input.kind,
        lines,
        fit,
        why,
        lookedAt: at,
      })
      .onConflictDoUpdate({
        target: [partners.workspaceId, partners.userId, partners.profileId],
        set: {
          kind: input.kind,
          lines,
          fit,
          // A new read keeps the last answer until the AI's next one.
          ...(input.missing
            ? { why, audience: null, audienceSize: null, nextStep: null, playbookId: null }
            : {}),
          lookedAt: at,
        },
        setWhere: sql`${partners.stage} is null`,
      })
      .returning({ id: partners.id });
    if (!row) {
      const [kept] = await ctx.tx
        .select({ id: partners.id, fit: partners.fit })
        .from(partners)
        .where(
          and(
            eq(partners.workspaceId, ws),
            eq(partners.userId, me),
            eq(partners.profileId, profile.id),
          ),
        );
      return { partnerId: kept!.id, fit: kept!.fit };
    }
    if (fit === 'waiting')
      await ctx.emit({
        type: 'outreach.partner.looked',
        entityType: 'workspace',
        entityId: ws,
        payload: { partnerId: row.id },
      });
    return { partnerId: row.id, fit };
  },
});

export const partnerSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.partner.save',
  description:
    'Worker: what the AI made of someone who could partner with the business: a good partner, might be or not, for which partner playbook, what kind, who their audience is and how big, why and a first warm-up; or that it couldn’t read them. A good or maybe goes on the person’s Partners list and is never pitched as a customer. What their profile said is let go.',
  risk: 0,
  input: PartnerSaveInput,
  output: PartnerSaveOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.partner.saved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [row] = await ctx.tx
      .select()
      .from(partners)
      .where(and(eq(partners.workspaceId, ws), eq(partners.id, input.partnerId)))
      .for('update');
    if (!row) throw HfosError.notFound('That partner check isn’t kept anymore.');
    // Answered already, or read again since: this answer is for lines that are gone.
    if (row.fit !== 'waiting' || row.lookedAt.getTime() !== new Date(input.lookedAt).getTime())
      return { saved: false, fit: row.fit };
    const a = input.answer;
    const fit: PartnerFit = a ? a.fit : 'failed';
    const found = fit === 'good' || fit === 'maybe';
    await ctx.tx
      .update(partners)
      .set({
        lines: [],
        fit,
        kind: a?.kind ?? row.kind,
        playbookId: a?.playbookId ?? null,
        audience: a?.audience ?? null,
        audienceSize: a?.audienceSize ?? null,
        why: a?.why ?? ['The AI couldn’t read them'],
        nextStep: a?.nextStep ?? null,
        checkedAt: at,
        ...(found ? { stage: 'found' as const, foundAt: at } : {}),
      })
      .where(eq(partners.id, row.id));
    // Found as a partner: never pitched as a customer from now, by anyone here, nor are their twins.
    if (found)
      await ctx.tx
        .update(profiles)
        .set({ partnerFoundAt: at })
        .where(
          and(
            eq(profiles.workspaceId, ws),
            eq(profiles.id, row.profileId),
            sql`${profiles.partnerFoundAt} is null`,
          ),
        );
    await ctx.emit({
      type: 'outreach.partner.saved',
      entityType: 'workspace',
      entityId: ws,
      payload: { partnerId: row.id, fit },
    });
    return { saved: true, fit };
  },
});

/** When a row reached its stage, as the list shows it. */
const stageAt = sql`case pa.stage
  when 'found' then pa.found_at when 'warming' then pa.warmed_at when 'asked' then pa.asked_at
  when 'interested' then pa.interested_at when 'call_booked' then pa.call_at when 'partner' then pa.partner_at
  when 'not_now' then pa.not_now_at end`;

export const partnersList = defineAddonQuery(outreachAddon, {
  name: 'outreach.partners',
  description:
    'The person’s Partners list: everyone the AI found could send the business its customers, with how many are at each stage (Found, Warming up, Asked, Interested, Call booked, Partner, Not now), and for each their kind (a group’s admin, a creator, a business), network, audience and how big it is, why they fit and a first warm-up. The best fits with the biggest audiences first; a page at a time.',
  input: PartnersInput,
  output: PartnersOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const onNetwork = input.platform ? sql`p.platform = ${input.platform}` : sql`true`;
    const counted = await rows<{ stage: PartnerStage; n: number }>(
      ctx.tx,
      sql`select pa.stage, count(*)::int as n from addon_outreach.partners pa
          join addon_outreach.profiles p on p.id = pa.profile_id
          where pa.workspace_id = ${ws} and pa.user_id = ${me} and pa.stage is not null and ${onNetwork}
          group by pa.stage`,
    );
    const counts = Object.fromEntries(
      PARTNER_STAGE_KEYS.map((s) => [s, counted.find((c) => c.stage === s)?.n ?? 0]),
    ) as Record<PartnerStage, number>;
    const which = input.view === 'all' ? sql`pa.stage is not null` : sql`pa.stage = ${input.view}`;
    const listed = await rows<{
      id: string;
      profile_id: string;
      name: string;
      url: string;
      platform: Platform;
      kind: PartnerKind;
      fit: 'good' | 'maybe';
      stage: PartnerStage;
      stage_at: Date | string;
      audience: string | null;
      audience_size: number | null;
      followers: number | null;
      why: string[];
      next_step: string | null;
      playbook_id: string | null;
      playbook: string | null;
    }>(
      ctx.tx,
      sql`select pa.id, pa.profile_id,
            coalesce(nullif(btrim(pp.first_name || ' ' || pp.last_name), ''), p.name) as name, p.url, p.platform,
            pa.kind, pa.fit, pa.stage, ${stageAt} as stage_at, pa.audience, pa.audience_size, p.followers,
            pa.why, pa.next_step, pb.id as playbook_id, pb.name as playbook
          from addon_outreach.partners pa
          join addon_outreach.profiles p on p.id = pa.profile_id
          left join app.people pp on pp.id = p.person_id
          left join addon_outreach.playbooks pb on pb.id = pa.playbook_id
          where pa.workspace_id = ${ws} and pa.user_id = ${me} and ${which} and ${onNetwork}
          order by pa.stage = 'not_now', pa.fit = 'maybe', coalesce(pa.audience_size, p.followers) desc nulls last,
            ${stageAt} desc, pa.id
          limit ${PARTNERS_PAGE + 1} offset ${(input.page - 1) * PARTNERS_PAGE}`,
    );
    return {
      counts,
      partners: listed.slice(0, PARTNERS_PAGE).map((r): PartnerRow => ({
        partnerId: r.id,
        profileId: r.profile_id,
        name: r.name,
        url: r.url,
        platform: r.platform,
        kind: r.kind,
        fit: r.fit,
        stage: r.stage,
        stageAt: new Date(r.stage_at).toISOString(),
        audience: r.audience,
        audienceSize: r.audience_size,
        followers: r.followers,
        why: r.why,
        nextStep: r.next_step,
        playbook: r.playbook_id && r.playbook ? { id: r.playbook_id, name: r.playbook } : null,
      })),
      more: listed.length > PARTNERS_PAGE,
    };
  },
});

/** The stage a mark puts someone at, and the moment it keeps: the first time each is reached. */
const MARKED: Record<
  Exclude<PartnerMark, 'again' | 'not_partner'>,
  { stage: PartnerStage; at: 'interestedAt' | 'callAt' | 'partnerAt' | 'notNowAt' }
> = {
  interested: { stage: 'interested', at: 'interestedAt' },
  call_booked: { stage: 'call_booked', at: 'callAt' },
  partner: { stage: 'partner', at: 'partnerAt' },
  not_now: { stage: 'not_now', at: 'notNowAt' },
};

/** Back on the list from Not now: the furthest stage they'd reached before. */
function stageBefore(row: typeof partners.$inferSelect): PartnerStage {
  if (row.partnerAt) return 'partner';
  if (row.callAt) return 'call_booked';
  if (row.interestedAt) return 'interested';
  if (row.askedAt) return 'asked';
  if (row.warmedAt) return 'warming';
  return 'found';
}

export const partnerMark = defineAddonCommand(outreachAddon, {
  name: 'outreach.partner.mark',
  description:
    'Marks someone on the person’s Partners list: interested, call booked, a partner now, not now (they can be asked again in 90 days), back on the list, or not a partner after all, when they’re off the list and may be pitched as a customer again.',
  risk: 1,
  input: PartnerMarkInput,
  output: PartnerMarkOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.partner.marked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [row] = await ctx.tx
      .select()
      .from(partners)
      .where(
        and(
          eq(partners.workspaceId, ws),
          eq(partners.userId, me),
          eq(partners.id, input.partnerId),
        ),
      )
      .for('update');
    if (!row || row.stage === null)
      throw HfosError.notFound('They aren’t on your Partners list anymore. Refresh the page.');
    let stage: PartnerStage | null;
    if (input.mark === 'not_partner') {
      // The AI was wrong: off the list, as if never on it, and pitched as a customer again. Not read again for a while.
      stage = null;
      await ctx.tx
        .update(partners)
        .set({
          fit: 'not',
          stage: null,
          why: ['You said they’re not a partner'],
          nextStep: null,
          foundAt: null,
          warmedAt: null,
          askedAt: null,
          interestedAt: null,
          callAt: null,
          partnerAt: null,
          notNowAt: null,
          checkedAt: at,
        })
        .where(eq(partners.id, row.id));
      await ctx.tx
        .update(profiles)
        .set({ partnerFoundAt: null })
        .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, row.profileId)));
    } else if (input.mark === 'again') {
      // Only someone set aside comes back: anyone else is on the list already.
      if (row.stage !== 'not_now') return { stage: row.stage };
      stage = stageBefore(row);
      await ctx.tx.update(partners).set({ stage, notNowAt: null }).where(eq(partners.id, row.id));
    } else {
      const to = MARKED[input.mark];
      stage = to.stage;
      if (row.stage === stage) return { stage };
      const set: Partial<typeof partners.$inferInsert> = { stage };
      // Not now counts from the latest; every other stage keeps when it was first reached.
      set[to.at] = to.at === 'notNowAt' ? at : (row[to.at] ?? at);
      await ctx.tx.update(partners).set(set).where(eq(partners.id, row.id));
    }
    await ctx.emit({
      type: 'outreach.partner.marked',
      entityType: 'outreach_profile',
      entityId: row.profileId,
      payload: { partnerId: row.id, mark: input.mark, stage },
    });
    return { stage };
  },
});

// ------------------------------------------------------------------------------------------------- reaching them

/** The person's row for a profile on their Partners list, locked to change; none when they aren't on it. */
async function listedRow(ctx: Ctx, me: string, profileId: string) {
  const [row] = await ctx.tx
    .select()
    .from(partners)
    .where(
      and(
        eq(partners.workspaceId, ctx.scope.workspaceId!),
        eq(partners.userId, me),
        eq(partners.profileId, profileId),
        sql`${partners.stage} is not null`,
      ),
    )
    .for('update');
  return row ?? null;
}

/** A like or a comment of the person's on someone just found as a partner: they're warming up (decision 81). */
export async function notePartnerWarmed(ctx: Ctx, me: string, profileId: string, at: Date) {
  await ctx.tx
    .update(partners)
    .set({ stage: 'warming', warmedAt: at })
    .where(
      and(
        eq(partners.workspaceId, ctx.scope.workspaceId!),
        eq(partners.userId, me),
        eq(partners.profileId, profileId),
        eq(partners.stage, 'found'),
      ),
    );
}

/**
 * A partner's message went (`outreach.send.done`): the ask makes them Asked, a new round after Not now included; a
 * follow-up and the details are counted on their row.
 */
export async function notePartnerSent(
  ctx: Ctx,
  me: string,
  sent: { readonly profileId: string; readonly kind: string; readonly at: Date },
) {
  const row = await listedRow(ctx, me, sent.profileId);
  if (!row) return;
  const at = sent.at;
  const set: Partial<typeof partners.$inferInsert> =
    sent.kind === 'partner_ask'
      ? {
          // An ask to someone further along already changes nothing but when it went.
          ...(['found', 'warming', 'not_now'].includes(row.stage!)
            ? { stage: 'asked' as const, notNowAt: null, followUps: 0, followedAt: null }
            : {}),
          askedAt: at,
        }
      : sent.kind === 'partner_follow_up'
        ? { followUps: Math.min(row.followUps + 1, 10), followedAt: at }
        : sent.kind === 'partner_details'
          ? { detailsAt: at }
          : {};
  if (Object.keys(set).length)
    await ctx.tx.update(partners).set(set).where(eq(partners.id, row.id));
}

/** Where an answer puts someone on the Partners list: a yes Interested, not now or no set aside, a question as they were. */
function stageAfter(stage: PartnerStage, answer: PartnerAnswerInput['answer']): PartnerStage {
  if (answer === 'yes')
    return ['found', 'warming', 'asked', 'not_now'].includes(stage) ? 'interested' : stage;
  if (answer === 'later' || answer === 'no') return stage === 'partner' ? stage : 'not_now';
  return stage;
}

export const partnerAnswer = defineAddonCommand(outreachAddon, {
  name: 'outreach.partner.answer',
  description:
    'Worker: what the AI read in a partner’s answer while drafting the reply (yes, a question, not now, no). A yes makes them Interested, and their details follow; not now or no sets them aside, to be asked again in 90 days.',
  risk: 0,
  input: PartnerAnswerInput,
  output: PartnerAnswerOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.partner.marked'],
  async handler(ctx, input) {
    const row = await listedRow(ctx, input.userId, input.profileId);
    if (!row) return { stage: null };
    const at = changeMoment(ctx.meta);
    const stage = stageAfter(row.stage!, input.answer);
    await ctx.tx
      .update(partners)
      .set({
        stage,
        answer: input.answer,
        answeredAt: at,
        ...(stage === 'interested' && row.stage !== 'interested'
          ? { interestedAt: row.interestedAt ?? at, notNowAt: null }
          : {}),
        ...(stage === 'not_now' && row.stage !== 'not_now' ? { notNowAt: at } : {}),
      })
      .where(eq(partners.id, row.id));
    if (stage !== row.stage)
      await ctx.emit({
        type: 'outreach.partner.marked',
        entityType: 'outreach_profile',
        entityId: row.profileId,
        payload: { partnerId: row.id, answer: input.answer, stage },
      });
    return { stage };
  },
});

export const partnerCall = defineAddonCommand(outreachAddon, {
  name: 'outreach.partner.call',
  description:
    'Worker: a call booked through a person’s partner link (its ref starts sp-): the partner it went to is at Call booked, unless they’re a partner already. Never counted as a demo.',
  risk: 0,
  input: PartnerCallInput,
  output: PartnerCallOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.partner.marked'],
  async handler(ctx, input) {
    const who = readPartnerRef(input.ref);
    if (!who) return { noted: false };
    const row = await listedRow(ctx, who.userId, who.profileId);
    if (!row) return { noted: false };
    const at = new Date(input.at);
    const stage: PartnerStage = row.stage === 'partner' ? 'partner' : 'call_booked';
    await ctx.tx
      .update(partners)
      .set({ stage, callAt: row.callAt ?? at, notNowAt: null })
      .where(eq(partners.id, row.id));
    await ctx.emit({
      type: 'outreach.partner.marked',
      entityType: 'outreach_profile',
      entityId: row.profileId,
      payload: { partnerId: row.id, appointmentId: input.appointmentId, stage },
    });
    return { noted: true };
  },
});

/** A partner row as Today reads it. */
type TodayRow = {
  id: string;
  stage: PartnerStage;
  details_at: Date | string | null;
  profile_id: string;
  name: string;
  url: string;
  kind: PartnerKind;
  audience: string | null;
  why: string[];
  next_step: string | null;
  playbook_id: string | null;
  person_id: string | null;
  thread_key: string | null;
  chat_id: string | null;
};

/**
 * Today's partner steps for the person on a network (decision 81), in their kinds' order: replies owed, the details
 * after a yes, follow-ups to an ask gone quiet, asks a day after a warm-up, and warm-ups for those just found. Each
 * within what `left` says the customers' steps left of its daily limit, and at most `PARTNER_ASKS_PER_DAY` asks a
 * day; the best fits with the biggest audiences first.
 */
export async function partnerToday(
  ctx: Ctx,
  me: string,
  o: {
    readonly platform: Platform;
    readonly now: number;
    readonly todayFrom: string;
    readonly left: (step: DailyStep) => number;
  },
): Promise<TodayItem[]> {
  const ws = ctx.scope.workspaceId!;
  const ago = (days: number) => new Date(o.now - days * DAY).toISOString();
  // The partner link for the details: the partner playbook's booking link, with who it's from and to.
  const kept = await ctx.tx
    .select({ id: playbooks.id, name: playbooks.name, details: playbooks.details })
    .from(playbooks)
    .where(and(eq(playbooks.workspaceId, ws), sql`${playbooks.archivedAt} is null`));
  const partnerBooks = kept.flatMap((p) => {
    const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
    return read.success && forPartners(read.data) ? [{ id: p.id, name: p.name, ...read.data }] : [];
  });
  const bookOf = (id: string | null) =>
    partnerBooks.find((b) => b.id === id) ??
    [...partnerBooks].sort((a, b) => a.name.localeCompare(b.name))[0];
  const select = sql`select pa.id, pa.stage, pa.details_at, pa.profile_id, p.name, p.url, pa.kind, pa.audience,
      pa.why, pa.next_step, pa.playbook_id, p.person_id`;
  const from = sql`from addon_outreach.partners pa join addon_outreach.profiles p on p.id = pa.profile_id
      where pa.workspace_id = ${ws} and pa.user_id = ${me} and p.platform = ${o.platform} and ${notNever('p')}`;
  const best = sql`pa.fit = 'maybe', coalesce(pa.audience_size, p.followers) desc nulls last, pa.id`;
  const listOf = (where: ReturnType<typeof sql>, most: number) =>
    most > 0
      ? rows<TodayRow>(
          ctx.tx,
          sql`${select}, null::text as thread_key, null::uuid as chat_id ${from} and ${where}
              order by ${best} limit ${most}`,
        )
      : Promise.resolve([] as TodayRow[]);
  // The latest each way between them in the person's chats and the replies seen: who wrote last, and when.
  const lastTheirs = sql`greatest(
      (select max(r.seen_at) from addon_outreach.replies r where r.profile_id = pa.profile_id and r.user_id = ${me}),
      (select max(c.last_at) from addon_outreach.file_chats c
        where c.profile_id = pa.profile_id and c.user_id = ${me} and not c.last_from_me))`;
  const lastMine = sql`(select max(t.at) from addon_outreach.touches t
      where t.profile_id = pa.profile_id and t.user_id = ${me} and t.kind = 'message')`;
  const [asked] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from addon_outreach.sends s
        where s.workspace_id = ${ws} and s.user_id = ${me} and s.kind = 'partner_ask' and s.state = 'sent'
          and s.done_at >= ${o.todayFrom}::timestamptz`,
  );
  const follows = Math.max(0, o.left('follow_up'));
  const replies = await rows<TodayRow & { wrote_at: Date | string }>(
    ctx.tx,
    sql`${select}, (select c.thread_key from addon_outreach.file_chats c
          where c.profile_id = pa.profile_id and c.user_id = ${me} order by c.last_at desc limit 1) as thread_key,
        (select c.id from addon_outreach.file_chats c
          where c.profile_id = pa.profile_id and c.user_id = ${me} order by c.last_at desc limit 1) as chat_id,
        ${lastTheirs} as wrote_at
        ${from} and pa.stage is not null and ${lastTheirs} >= ${ago(PARTNER_REPLY_DAYS)}::timestamptz
          and ${lastTheirs} > coalesce(${lastMine}, '-infinity'::timestamptz)
        order by ${lastTheirs} desc limit ${TODAY_MOST}`,
  );
  const details = await listOf(sql`pa.stage = 'interested' and pa.details_at is null`, follows);
  const followUps = await listOf(
    sql`pa.stage = 'asked' and pa.follow_ups < ${PARTNER_FOLLOW_UPS}
      and coalesce(pa.followed_at, pa.asked_at) <= ${ago(PARTNER_FOLLOW_UP_DAYS)}::timestamptz
      and (${lastTheirs} is null or ${lastTheirs} < coalesce(pa.followed_at, pa.asked_at))`,
    follows - details.length,
  );
  const asks = await listOf(
    sql`((pa.stage = 'warming' and pa.warmed_at <= ${ago(PARTNER_WARM_DAYS)}::timestamptz and pa.asked_at is null)
      or (pa.stage = 'found' and p.warm_up_missed_at is not null)
      or (pa.stage = 'not_now' and pa.not_now_at <= ${ago(PARTNER_AGAIN_DAYS)}::timestamptz))`,
    Math.min(PARTNER_ASKS_PER_DAY - (asked?.n ?? 0), o.left('first_message')),
  );
  const warmUps = await listOf(
    sql`pa.stage = 'found' and pa.warmed_at is null and p.warm_up_missed_at is null`,
    o.left('like'),
  );
  const byKind: Record<PartnerTodayKind, readonly TodayRow[]> = {
    partner_reply: replies,
    partner_details: details,
    partner_follow_up: followUps,
    partner_ask: asks,
    partner_warm_up: warmUps,
  };
  // Someone on the list once a day: their furthest step.
  const listed = new Set<string>();
  const items: TodayItem[] = [];
  for (const listedAs of PARTNER_TODAY_KINDS)
    for (const r of byKind[listedAs]) {
      if (listed.has(r.profile_id)) continue;
      listed.add(r.profile_id);
      const book = bookOf(r.playbook_id);
      // A yes read in their reply (`outreach.partner.answer`) is answered with the details.
      const kind: PartnerTodayKind =
        listedAs === 'partner_reply' && r.stage === 'interested' && r.details_at === null
          ? 'partner_details'
          : listedAs;
      items.push({
        kind,
        name: r.name,
        profileId: r.profile_id,
        profileUrl: r.url,
        chatId: r.chat_id,
        threadKey: r.thread_key,
        postId: null,
        postUrl: null,
        posted: null,
        post: null,
        asking: false,
        why: [PARTNER_WORDS.todayWhy(r.kind, r.audience), ...r.why],
        summary: r.audience,
        nextStep: r.next_step,
        playbookName: book?.name ?? null,
        // The partner link (./demos.ts): a call booked through it moves them to Call booked, never a demo.
        demoLink:
          kind === 'partner_details' || kind === 'partner_reply'
            ? demoLink(book?.link, partnerRef(me, r.profile_id))
            : null,
        videoLink: null,
        personId: r.person_id,
        demoBooked: false,
        partnerId: r.id,
        send: null,
        recent: [],
      });
    }
  return items;
}

/** How many more of each daily limit Today's partner steps may take, after the customers' on the list. */
export function partnerRoom(
  limits: Readonly<Record<DailyStep, { readonly done: number; readonly most: number }>>,
  planned: readonly Pick<TodayItem, 'kind'>[],
): (step: DailyStep) => number {
  return (step) => {
    const { done, most } = limits[step];
    return Math.max(0, most - done - planned.filter((i) => TODAY_LIMIT[i.kind] === step).length);
  };
}

export const partnerCommands = [
  partnerLook,
  partnerSave,
  partnerMark,
  partnerAnswer,
  partnerCall,
] as const;
export const partnerQueries = [partnersNext, partnersList] as const;
