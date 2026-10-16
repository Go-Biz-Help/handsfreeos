/**
 * Stages, and the moment to pitch (../stages.ts, docs/outreach.md decision 47): where each person the person reached
 * stands, worked out each time from the steps noted, their friends, chats, the AI's checks and demos; the marks the
 * person or the AI keeps beyond that (`stages`); and the pipeline that lists them. Each person's own.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { outreachAddon } from '../manifest';
import { NETWORKS, type Platform } from '../networks';
import {
  STAGE_ORDER,
  STAGE_WORDS,
  StageMarkInput,
  StageMarkOutput,
  STAGES_PAGE,
  StagesInput,
  StagesOutput,
  type PitchRead,
  type Stage,
  type StageView,
} from '../stages';
import { profiles, stages } from '../tables';
import { inWorkspace, pitchable, type Ctx } from './common';
import { noteSent, offerVersionFor, restartConversation } from './conversation';
import type { CheckVerdict } from '../checks';

const DAY = 86_400_000;

/** The marks kept for one person and profile, as they are now: none until something's said. */
async function keptMarks(ctx: Ctx, me: string, profileId: string) {
  const [row] = await ctx.tx
    .select()
    .from(stages)
    .where(
      and(
        eq(stages.workspaceId, ctx.scope.workspaceId!),
        eq(stages.userId, me),
        eq(stages.profileId, profileId),
      ),
    )
    .for('update');
  return row ?? null;
}

/** Keeps marks for one person and profile: a row made the first time. */
async function keepMarks(
  ctx: Ctx,
  me: string,
  profileId: string,
  set: Partial<
    Pick<typeof stages.$inferInsert, 'mark' | 'markedBy' | 'why' | 'markedAt' | 'pitchedAt'>
  >,
): Promise<void> {
  await ctx.tx
    .insert(stages)
    .values({ workspaceId: ctx.scope.workspaceId!, userId: me, profileId, ...set })
    .onConflictDoUpdate({ target: [stages.workspaceId, stages.userId, stages.profileId], set });
}

/** A pitch went to someone (a pitch message sent, or a pitch draft copied): kept the first time. */
export async function notePitched(
  ctx: Ctx,
  me: string,
  profileId: string,
  at: Date,
): Promise<void> {
  const kept = await keptMarks(ctx, me, profileId);
  if (kept?.pitchedAt) return;
  await keepMarks(ctx, me, profileId, { pitchedAt: at });
}

/**
 * The AI's read of a chat with someone (decision 47): a "no" marks them not a fit, with why; any other read takes back
 * a not a fit the AI marked before. A person's own mark is theirs, and the AI never changes it.
 */
export async function noteChatRead(
  ctx: Ctx,
  me: string,
  profileId: string,
  pitch: PitchRead,
  why: string | null,
  at: Date,
): Promise<void> {
  const kept = await keptMarks(ctx, me, profileId);
  if (kept?.markedBy === 'person') return;
  if (pitch === 'not_interested')
    await keepMarks(ctx, me, profileId, {
      mark: 'lost',
      markedBy: 'ai',
      why: why ?? 'Said no for now',
      markedAt: at,
    });
  else if (kept?.mark === 'lost')
    await keepMarks(ctx, me, profileId, { mark: null, markedBy: null, why: null, markedAt: null });
}

/** What's known about each person reached, and the stage it comes to. `which` narrows the profiles. */
function staged(ctx: Ctx, me: string, which: SQL) {
  const ws = ctx.scope.workspaceId!;
  return sql`with reached as (
      select p.id from addon_outreach.profiles p
      where p.workspace_id = ${ws} and p.friendship <> 'self' and ${pitchable('p')} and ${which}
        and (exists (select 1 from addon_outreach.touches t where t.profile_id = p.id and t.user_id = ${me})
          or exists (select 1 from addon_outreach.file_chats c
            where c.profile_id = p.id and c.user_id = ${me} and c.read_state <> 'none')
          or exists (select 1 from addon_outreach.checks ch
            where ch.profile_id = p.id and ch.user_id = ${me} and ch.verdict in ('good', 'maybe'))
          or exists (select 1 from addon_outreach.demos d
            where d.profile_id = p.id and d.user_id = ${me} and d.undone_at is null)
          or exists (select 1 from addon_outreach.stages s where s.profile_id = p.id and s.user_id = ${me}))
    ), facts as (
      select p.id as profile_id, p.person_id, p.platform,
        coalesce(nullif(btrim(pp.first_name || ' ' || pp.last_name), ''), p.name) as name, p.url,
        g.name as group_name, s.mark, s.marked_by, s.why as mark_why, s.pitched_at,
        c.pitch, c.pitch_why, c.next_step as chat_step, c.thread_key, c.read_state, c.last_at as chat_at,
        c.last_from_me, ch.verdict, cpb.name as check_playbook, ch.why as check_why, ch.next_step as check_step, f.state as friend_state,
        (select max(r.seen_at) from addon_outreach.replies r
          where r.profile_id = p.id and r.user_id = ${me}) as replied_at,
        (select max(t.at) from addon_outreach.touches t
          where t.profile_id = p.id and t.user_id = ${me}) as touched_at,
        (select t.kind from addon_outreach.touches t
          where t.profile_id = p.id and t.user_id = ${me} and t.kind in ('like', 'comment', 'friend_request')
          order by t.at desc limit 1) as warm_kind,
        exists (select 1 from addon_outreach.demos d
          where d.profile_id = p.id and d.user_id = ${me} and d.undone_at is null) as booked,
        exists (select 1 from addon_outreach.demos d where d.profile_id = p.id and d.user_id = ${me}
          and d.how = 'marked' and d.undone_at is null) as marked_booked
      from reached x
      join addon_outreach.profiles p on p.id = x.id
      left join app.people pp on pp.id = p.person_id
      left join addon_outreach.groups g on g.id = p.group_id
      left join addon_outreach.stages s on s.profile_id = p.id and s.user_id = ${me}
      left join lateral (
        select c.pitch, c.pitch_why, c.next_step, c.thread_key, c.read_state, c.last_at, c.last_from_me
        from addon_outreach.file_chats c where c.profile_id = p.id and c.user_id = ${me}
        order by c.last_at desc limit 1
      ) c on true
      left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
      left join addon_outreach.playbooks cpb on cpb.id = ch.playbook_id
      left join addon_outreach.friends f on f.profile_id = p.id and f.user_id = ${me}
    )
    select facts.*,
      case
        when booked then 'booked'
        when mark = 'lost' then 'lost'
        when pitched_at is not null then 'pitched'
        when mark = 'ready' or pitch = 'ready' then 'ready'
        when read_state in ('waiting', 'read', 'failed') or replied_at is not null then 'talking'
        when friend_state = 'friends' then 'friends'
        when warm_kind is not null or friend_state = 'request_sent' then 'warming'
        else 'found'
      end as stage,
      greatest(touched_at, chat_at, replied_at) as last_at
    from facts`;
}

type StagedRow = {
  readonly profile_id: string;
  readonly person_id: string | null;
  readonly platform: Platform;
  readonly name: string;
  readonly url: string;
  readonly group_name: string | null;
  readonly mark: 'ready' | 'lost' | null;
  readonly marked_by: 'person' | 'ai' | null;
  readonly mark_why: string | null;
  readonly pitched_at: Date | string | null;
  readonly pitch: PitchRead | null;
  readonly pitch_why: string | null;
  readonly chat_step: string | null;
  readonly thread_key: string | null;
  readonly chat_at: Date | string | null;
  readonly last_from_me: boolean | null;
  readonly verdict: CheckVerdict | null;
  readonly check_playbook: string | null;
  readonly check_why: string[] | null;
  readonly check_step: string | null;
  readonly friend_state: string | null;
  readonly replied_at: Date | string | null;
  readonly warm_kind: 'like' | 'comment' | 'friend_request' | null;
  readonly marked_booked: boolean;
  readonly stage: Stage;
  readonly last_at: Date | string | null;
};

const iso = (at: Date | string | null) => (at === null ? null : new Date(at).toISOString());
const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** "today", "yesterday", "4 days ago". */
function dayWords(at: Date | string, now: number): string {
  const days = Math.floor((now - new Date(at).getTime()) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Why someone is at their stage, in a line or two for the person. */
export function stageWhy(r: StagedRow, now: number): string[] {
  // In their network's words: friends on Facebook, connections on LinkedIn.
  const words = NETWORKS[r.platform].words;
  const fits = r.verdict === 'good' || r.verdict === 'maybe' ? (r.check_why ?? []) : [];
  switch (r.stage) {
    case 'booked':
      return ['Booked a demo'];
    case 'lost':
      return [
        r.mark_why ?? 'Marked not a fit',
        ...(r.marked_by === 'ai' ? [`${STAGE_WORDS.aiSaid} from your chat`] : []),
      ];
    case 'pitched':
      return [`Pitched ${dayWords(r.pitched_at!, now)}`];
    case 'ready':
      return [
        r.mark === 'ready' ? 'You marked them ready' : (r.pitch_why ?? 'Ready for the offer'),
      ];
    case 'talking':
      return r.chat_at && r.last_from_me
        ? [`You wrote last, ${dayWords(r.chat_at, now)}`]
        : [`They wrote ${dayWords((r.replied_at ?? r.chat_at)!, now)}`];
    case 'friends':
      return [`${cap(words.friends)} on ${NETWORKS[r.platform].name}`, ...fits];
    case 'warming':
      return [
        r.warm_kind === 'like'
          ? 'You liked a post of theirs'
          : r.warm_kind === 'comment'
            ? 'You commented on their post'
            : `${cap(words.friendRequest)} sent`,
      ];
    case 'found':
      return [...(r.group_name ? [`Found in ${r.group_name}`] : []), ...fits];
  }
}

/** Where some people stand now, by profile, for the person. */
export async function stagesOf(
  ctx: Ctx,
  me: string,
  profileIds: readonly string[],
): Promise<Map<string, Stage>> {
  if (!profileIds.length) return new Map();
  const found = await rows<{ profile_id: string; stage: Stage }>(
    ctx.tx,
    sql`select s.profile_id, s.stage from (${staged(
      ctx,
      me,
      sql`p.id = any (${`{${profileIds.join(',')}}`}::uuid[])`,
    )}) s`,
  );
  return new Map(found.map((f) => [f.profile_id, f.stage]));
}

export const stageMark = defineAddonCommand(outreachAddon, {
  name: 'outreach.stage.mark',
  description:
    'Say where someone the person reached stands, when they know better than what’s worked out: ready to pitch (Today offers Pitch), pitched, not a fit (nothing on Today reaches them again but a reply), or back in play.',
  risk: 0,
  input: StageMarkInput,
  output: StageMarkOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.stage.marked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [profile] = await ctx.tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, input.profileId)));
    if (!profile) throw HfosError.notFound('That person isn’t kept here anymore. Reload the page.');
    switch (input.mark) {
      case 'ready':
        await keepMarks(ctx, me, profile.id, {
          mark: 'ready',
          markedBy: 'person',
          why: null,
          markedAt: at,
        });
        break;
      case 'pitched':
        await keepMarks(ctx, me, profile.id, { pitchedAt: at });
        // The link went (a draft copied, or marked): follow-ups come after it, as they would after one sent.
        await noteSent(ctx, me, {
          profileId: profile.id,
          kind: 'pitch',
          at,
          offerVersion: await offerVersionFor(ctx, me, profile.id),
        });
        break;
      case 'lost':
        await keepMarks(ctx, me, profile.id, {
          mark: 'lost',
          markedBy: 'person',
          why: input.why,
          markedAt: at,
        });
        break;
      case 'open':
        await keepMarks(ctx, me, profile.id, {
          mark: null,
          markedBy: null,
          why: null,
          markedAt: null,
          pitchedAt: null,
        });
        await restartConversation(ctx, me, profile.id, at);
        break;
    }
    await ctx.emit({
      type: 'outreach.stage.marked',
      entityType: 'workspace',
      entityId: ws,
      payload: { profileId: profile.id, mark: input.mark },
    });
    const stage = (await stagesOf(ctx, me, [profile.id])).get(profile.id) ?? 'found';
    return { profileId: profile.id, stage };
  },
});

export const stagesList = defineAddonQuery(outreachAddon, {
  name: 'outreach.stages',
  description:
    'The person’s pipeline: everyone they reached, on every network or one, by where they stand (found, warming up, friends, talking, ready to pitch, pitched, booked, not a fit), with why, the AI’s next step and the latest either way; counted by stage, one stage or everyone still in play, searched by name.',
  input: StagesInput,
  output: StagesOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const now = Date.now();
    // One network's people, counts too, when asked: every network's otherwise.
    const all = staged(ctx, me, input.platform ? sql`p.platform = ${input.platform}` : sql`true`);
    const counted = await rows<{ stage: Stage; n: number }>(
      ctx.tx,
      sql`select s.stage, count(*)::int as n from (${all}) s group by s.stage`,
    );
    const counts = {
      all: 0,
      found: 0,
      warming: 0,
      friends: 0,
      talking: 0,
      ready: 0,
      pitched: 0,
      booked: 0,
      lost: 0,
    };
    for (const c of counted) {
      counts[c.stage] = c.n;
      if (c.stage !== 'lost') counts.all += c.n;
    }
    const view: StageView = input.view;
    const shown = sql`${view === 'all' ? sql`s.stage <> 'lost'` : sql`s.stage = ${view}`}
      and ${input.search ? sql`position(${input.search.toLowerCase()} in lower(s.name)) > 0` : sql`true`}`;
    const [total] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from (${all}) s where ${shown}`,
    );
    const pages = Math.max(1, Math.ceil((total?.n ?? 0) / STAGES_PAGE));
    const page = Math.min(input.page, pages);
    const order = `{${STAGE_ORDER.join(',')}}`;
    const listed = await rows<StagedRow>(
      ctx.tx,
      sql`select s.* from (${all}) s where ${shown}
          order by array_position(${order}::text[], s.stage), s.last_at desc nulls last, s.profile_id
          limit ${STAGES_PAGE} offset ${(page - 1) * STAGES_PAGE}`,
    );
    return {
      counts,
      people: listed.map((r) => ({
        profileId: r.profile_id,
        personId: r.person_id,
        name: r.name,
        url: r.url,
        platform: r.platform,
        stage: r.stage,
        why: stageWhy(r, now),
        nextStep: r.stage === 'lost' || r.stage === 'booked' ? null : (r.chat_step ?? r.check_step),
        lastAt: iso(r.last_at),
        threadKey: r.thread_key,
        marked: r.marked_by === 'person',
        demoBooked: r.marked_booked,
        check: r.verdict
          ? { verdict: r.verdict, playbookName: r.check_playbook, why: r.check_why ?? [] }
          : null,
      })),
      page,
      pages,
      total: total?.n ?? 0,
    };
  },
});

export const stageCommands = [stageMark] as const;
export const stageQueries = [stagesList] as const;
