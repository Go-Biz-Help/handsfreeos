/**
 * The Action Center's loaders for Automations' health and quality cards (stage 4b): channels gone quiet
 * (`channel_quiet`), connections broken or silent (`connection_error`, `connection_silent`), nobody reviewing the
 * AI teammate (`ai_unreviewed`), lessons from its corrections (`ai_corrections`), the website's weekly re-read
 * (`website_changed`) and questions customers keep asking (`faq_suggestions`). Server-only, beside load.ts.
 *
 * Channels are loaded on the full sweep only: a quiet channel has no row to be woken by, only the passing of time.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import type { WeeklyHours } from '../calendar/config';
import { uuidArray } from '../calendar/load';
import { formatPhone } from '../crm/phone';
import { CHANNEL_QUIET_GAPS, type ChannelKind } from './detectors/channel-quiet';
import type { ConnectionProblem, ConnectionSystem } from './detectors/connection';
import { AI_UNREVIEWED_DAYS } from './detectors/ai-unreviewed';
import { FAQ_SUGGESTION_MIN_ASKS } from './detectors/faq-suggestions';
import { addOpenTime } from './open-time';
import type { AttentionFacts } from './registry';

const DAY = 86_400_000;
const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

// ---------- channels ----------

/** The subject type of each channel's card: the kind is the page that checks it. */
export const CHANNEL_SUBJECT: Readonly<Record<ChannelKind, string>> = {
  text: 'channel_text',
  call: 'channel_call',
  email: 'channel_email',
  chat: 'channel_chat',
};

export interface ChannelInfo {
  readonly channel: AttentionFacts<'channel_quiet'>['channel'];
  readonly subjectType: string;
}

/** The last many of each channel's to work its pace from (a busy one has thousands a month). */
const CHANNEL_SAMPLE = 200;
/** The window a channel's pace is read over. */
const CHANNEL_DAYS = 30;

/** How long a typical open day is: the week's open time over its open days (a whole day with none set). */
export function openDayMs(hours: WeeklyHours): number {
  if (hours.length === 0) return DAY;
  let total = 0;
  const days = new Set<number>();
  for (const h of hours) {
    const [sh, sm] = h.start.split(':').map(Number);
    const [eh, em] = h.end.split(':').map(Number);
    const span = (eh! * 60 + em!) * 60_000 - (sh! * 60 + sm!) * 60_000;
    if (span > 0) {
      total += span;
      days.add(h.day);
    }
  }
  return days.size ? total / days.size : DAY;
}

/** The median of a list (0 when empty). */
const median = (xs: readonly number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * Each channel's pace over the last 30 days: how many came in, the last one, the median time between two, and when
 * it counts as quiet (three of those gaps of open time after the last, and at least an open day). Its subject id is derived from the business and the channel (there is one of each).
 */
export async function loadChannels(
  tx: Tx,
  workspaceId: string,
  now: Date,
  timeZone: string,
  hours: WeeklyHours,
): Promise<Map<string, ChannelInfo>> {
  const list = await rows<{ kind: ChannelKind; id: string; count: number; times: number[] }>(
    tx,
    sql`with ev as (
          select case m.channel when 'sms' then 'text' when 'email' then 'email' else 'chat' end as kind,
            m.occurred_at as at
          from app.messages m
          where m.workspace_id = ${workspaceId} and m.direction = 'inbound'
            and m.occurred_at > ${now.toISOString()}::timestamptz - ${`${CHANNEL_DAYS} days`}::interval
          union all
          select 'call', c.started_at from app.calls c
          where c.workspace_id = ${workspaceId} and c.direction = 'inbound'
            and c.started_at > ${now.toISOString()}::timestamptz - ${`${CHANNEL_DAYS} days`}::interval
        ), ranked as (
          select kind, at, count(*) over (partition by kind) as n,
            row_number() over (partition by kind order by at desc) as r
          from ev
        )
        select kind, md5(${workspaceId}::text || ':channel:' || kind)::uuid as id, max(n)::int as count,
          json_agg((extract(epoch from at) * 1000)::float8 order by at) as times
        from ranked where r <= ${CHANNEL_SAMPLE}
        group by kind`,
  );
  const openDay = openDayMs(hours);
  const out = new Map<string, ChannelInfo>();
  for (const r of list) {
    const times = r.times.map(Number);
    const last = times[times.length - 1] ?? null;
    // The pace in plain time ("every 3 h"); the wait for it counts open time only, and at least an open day.
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
    const gap = median(gaps);
    const quietAt =
      last === null
        ? null
        : addOpenTime(hours, timeZone, last, Math.max(CHANNEL_QUIET_GAPS * gap, openDay));
    out.set(r.id, {
      channel: {
        id: r.id,
        kind: r.kind,
        count: r.count,
        lastInboundAt: iso(last === null ? null : new Date(last)),
        usualGapMs: Math.round(gap),
        quietAt: iso(quietAt === null ? null : new Date(quietAt)),
      },
      subjectType: CHANNEL_SUBJECT[r.kind],
    });
  }
  return out;
}

// ---------- connections ----------

/** The subject type of each connection's card: its own table. */
export const CONNECTION_SUBJECT: Readonly<Record<ConnectionSystem, string>> = {
  payments: 'payment_connection',
  calendar: 'calendar_connection',
  mailbox: 'mailbox',
  reviews: 'review_connection',
  phone: 'phone_number',
};

export interface ConnectionInfo {
  readonly connection: AttentionFacts<'connection_error'>['connection'];
  readonly subjectType: string;
}

/** A syncing connection's normal gap when its row doesn't say (no next sync set). */
const FALLBACK_GAP_MS: Readonly<Partial<Record<ConnectionSystem, number>>> = {
  calendar: 15 * 60_000,
  mailbox: 15 * 60_000,
  reviews: 6 * 60 * 60_000,
};

/**
 * The business's connections that are broken, or sync and may have gone silent, and in a reconcile the ones named.
 * A payment connection the provider took away (revoked, deauthorized, failed) counts as broken for 30 days unless
 * another of the same provider is working; one a person disconnected is nobody's problem.
 */
export async function loadConnections(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
): Promise<Map<string, ConnectionInfo>> {
  if (!all && ids.length === 0) return new Map();
  const named = uuidArray([...ids]);
  const list = await rows<{
    id: string;
    system: ConnectionSystem;
    name: string;
    problem: ConnectionProblem | null;
    broken_since: Date | null;
    last_data_at: Date | null;
    next_at: Date | null;
    user_id: string | null;
  }>(
    tx,
    sql`select * from (
          select pc.id, 'payments' as system,
            initcap(pc.provider::text) || case when pc.environment = 'test' then ' (test)' else '' end as name,
            case
              when pc.status = 'reauth_required' then 'reauth'
              when pc.status = 'error' then 'failed'
              when pc.status = 'disconnected' and pc.disconnected_reason in ('revoked', 'deauthorized')
                and pc.disconnected_at > now() - interval '30 days' then 'revoked'
              when pc.status = 'disconnected' and pc.disconnected_reason = 'failed'
                and pc.disconnected_at > now() - interval '30 days' then 'failed'
            end as problem,
            coalesce(pc.disconnected_at, pc.updated_at) as broken_since,
            null::timestamptz as last_data_at, null::timestamptz as next_at, null::uuid as user_id
          from app.payment_connections pc
          where pc.workspace_id = ${workspaceId}
            and not exists (select 1 from app.payment_connections o
                            where o.workspace_id = pc.workspace_id and o.provider = pc.provider
                              and o.id <> pc.id and o.status = 'active' and pc.status = 'disconnected')
          union all
          select cc.id, 'calendar',
            case cc.provider when 'google' then 'Google Calendar' else 'Outlook Calendar' end
              || coalesce(' · ' || nullif(btrim(u.full_name), ''), ''),
            case cc.status when 'reauth_required' then 'reauth' when 'error' then 'failed' end,
            cc.updated_at, case when cc.status = 'active' then cc.busy_synced_at end, cc.next_sync_at, cc.user_id
          from app.calendar_connections cc left join app.users u on u.id = cc.user_id
          where cc.workspace_id = ${workspaceId}
          union all
          select mc.id, 'mailbox',
            case mc.provider when 'google' then 'Gmail' else 'Outlook' end
              || coalesce(' · ' || mc.account_email, ''),
            case mc.status when 'reauth_required' then 'reauth' when 'error' then 'failed' end,
            mc.updated_at, case when mc.status = 'active' then mc.last_synced_at end, mc.next_sync_at,
            case when mc.shared then null else mc.user_id end
          from app.mailbox_connections mc
          where mc.workspace_id = ${workspaceId}
          union all
          select rc.id, 'reviews',
            case rc.provider when 'google' then 'Google reviews' else 'Facebook reviews' end
              || coalesce(' · ' || rc.display_name, ''),
            case when rc.status = 'needs_attention' then 'reauth' end,
            rc.updated_at, case when rc.status = 'connected' then rc.last_synced_at end, rc.next_sync_at, null
          from app.review_connections rc
          where rc.workspace_id = ${workspaceId}
          union all
          select pn.id, 'phone', pn.e164,
            case when pn.status = 'failed' then 'failed' end,
            pn.updated_at, null, null, null
          from app.phone_numbers pn
          where pn.workspace_id = ${workspaceId}
        ) c
        where c.id = any(${named})
          ${all ? sql`or c.problem is not null or c.last_data_at is not null` : sql``}`,
  );
  const out = new Map<string, ConnectionInfo>();
  for (const r of list) {
    const last = r.last_data_at ? new Date(r.last_data_at).getTime() : null;
    const next = r.next_at ? new Date(r.next_at).getTime() : null;
    const gap =
      last === null
        ? null
        : next !== null && next > last
          ? next - last
          : (FALLBACK_GAP_MS[r.system] ?? null);
    out.set(r.id, {
      connection: {
        id: r.id,
        system: r.system,
        name: r.system === 'phone' ? formatPhone(r.name) : r.name,
        problem: r.problem,
        brokenSince: r.problem ? iso(r.broken_since) : null,
        lastDataAt: r.problem ? null : iso(r.last_data_at),
        usualGapMs: r.problem ? null : gap,
        userId: r.user_id,
      },
      subjectType: CONNECTION_SUBJECT[r.system],
    });
  }
  return out;
}

// ---------- the AI teammate ----------

export interface TeammateInfo {
  readonly teammate: AttentionFacts<'ai_unreviewed'>['teammate'];
}

/**
 * The live AI teammate (one per business), in training or automatic, with its last 7 days of work and the last
 * time a person looked: decided a draft (training), or read, answered or did anything with one of its
 * conversations (automatic).
 */
export async function loadTeammates(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
  now: Date,
): Promise<Map<string, TeammateInfo>> {
  if (!all && ids.length === 0) return new Map();
  const at = sql`${now.toISOString()}::timestamptz`;
  const week = sql`${`${AI_UNREVIEWED_DAYS} days`}::interval`;
  const list = await rows<{
    id: string;
    name: string;
    status: 'off' | 'training' | 'automatic';
    mode_since: Date;
    work: number;
    last_look_at: Date | null;
  }>(
    tx,
    sql`select t.id, t.name, t.status::text as status,
          case t.status when 'training' then coalesce(t.training_started_at, t.created_at)
            else coalesce(t.automatic_since, t.created_at) end as mode_since,
          case t.status
            when 'training' then (select count(*)::int from app.ai_teammate_drafts d
                                  where d.teammate_id = t.id and d.created_at > ${at} - ${week})
            else (select count(distinct m.conversation_id)::int from app.messages m
                  where m.workspace_id = t.workspace_id and m.sent_by_teammate_id = t.id
                    and m.direction = 'outbound' and m.occurred_at > ${at} - ${week})
          end as work,
          case t.status
            when 'training' then (select max(d.decided_at) from app.ai_teammate_drafts d
                                  where d.teammate_id = t.id and d.decided_by is not null)
            else (
              with theirs as (
                select distinct m.conversation_id as id from app.messages m
                where m.workspace_id = t.workspace_id and m.sent_by_teammate_id = t.id
                  and m.occurred_at > ${at} - interval '30 days'
              )
              select greatest(
                (select max(e.created_at) from app.events e
                 where e.workspace_id = t.workspace_id and e.actor_type = 'human'
                   and e.entity_type = 'conversation' and e.entity_id in (select id from theirs)
                   and e.created_at > ${at} - interval '30 days'),
                (select max(m.occurred_at) from app.messages m
                 where m.conversation_id in (select id from theirs) and m.direction = 'outbound'
                   and m.sent_by is not null and m.occurred_at > ${at} - interval '30 days'))
            )
          end as last_look_at
        from app.ai_teammates t
        where t.workspace_id = ${workspaceId} and t.archived_at is null
          and (t.id = any(${uuidArray([...ids])}) ${all ? sql`or t.status <> 'off'` : sql``})`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        teammate: {
          id: r.id,
          name: r.name,
          status: r.status,
          modeSince: iso(r.mode_since)!,
          work: r.work,
          lastLookAt: iso(r.last_look_at),
        },
      },
    ]),
  );
}

export interface LessonInfo {
  readonly lesson: AttentionFacts<'ai_corrections'>['lesson'];
  readonly teammateName: string;
}

/** Open lessons (and in a reconcile the ones named, whatever became of them). */
export async function loadLessons(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
): Promise<Map<string, LessonInfo>> {
  if (!all && ids.length === 0) return new Map();
  const list = await rows<{
    id: string;
    teammate_id: string;
    teammate_name: string;
    line: string;
    why: string | null;
    corrections: number;
    status: 'open' | 'applied' | 'dismissed';
    created_at: Date;
  }>(
    tx,
    sql`select l.id, l.teammate_id, t.name as teammate_name, l.line, l.why,
          cardinality(l.draft_ids) as corrections, l.status, l.created_at
        from app.teammate_lessons l join app.ai_teammates t on t.id = l.teammate_id
        where l.workspace_id = ${workspaceId}
          and (l.id = any(${uuidArray([...ids])}) ${all ? sql`or l.status = 'open'` : sql``})`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        lesson: {
          id: r.id,
          teammateId: r.teammate_id,
          line: r.line,
          why: r.why,
          corrections: r.corrections,
          status: r.status,
          createdAt: iso(r.created_at)!,
        },
        teammateName: r.teammate_name,
      },
    ]),
  );
}

// ---------- the knowledge base ----------

export interface ScanInfo {
  readonly scan: AttentionFacts<'website_changed'>['scan'];
  readonly url: string;
}

/** The weekly re-reads of the website from the last 30 days with updates still waiting, and any named. */
export async function loadScans(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
  now: Date,
): Promise<Map<string, ScanInfo>> {
  if (!all && ids.length === 0) return new Map();
  const list = await rows<{
    id: string;
    automatic: boolean;
    finished_at: Date | null;
    pages_changed: number;
    waiting: number;
    url: string;
  }>(
    tx,
    sql`select * from (
          select s.id, s.automatic, s.finished_at, ks.url,
            (select count(*)::int from jsonb_array_elements(s.pages) p
             where p ->> 'status' in ('new', 'changed')) as pages_changed,
            (select count(*)::int from app.knowledge_suggestions g
             where g.scan_id = s.id and g.status = 'pending') as waiting
          from app.knowledge_scans s join app.knowledge_sources ks on ks.id = s.source_id
          where s.workspace_id = ${workspaceId}
            and (s.id = any(${uuidArray([...ids])})
              ${
                all
                  ? sql`or (s.automatic and s.status = 'done'
                        and s.finished_at > ${now.toISOString()}::timestamptz - interval '30 days')`
                  : sql``
              })
        ) x
        where x.id = any(${uuidArray([...ids])}) or x.waiting > 0`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        scan: {
          id: r.id,
          automatic: r.automatic,
          finishedAt: iso(r.finished_at),
          pagesChanged: r.pages_changed,
          waiting: r.waiting,
        },
        url: r.url,
      },
    ]),
  );
}

export interface GapInfo {
  readonly suggestion: AttentionFacts<'faq_suggestions'>['suggestion'];
}

/** Questions the AI couldn't answer, asked three or more times and still waiting, and any named. */
export async function loadGaps(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
): Promise<Map<string, GapInfo>> {
  if (!all && ids.length === 0) return new Map();
  const list = await rows<{
    id: string;
    question: string;
    asked: number;
    status: 'pending' | 'accepted' | 'rejected';
    created_at: Date;
  }>(
    tx,
    sql`select g.id,
          coalesce(nullif(btrim(g.source ->> 'question'), ''), g.proposed ->> 'title', '') as question,
          g.similar_count as asked, g.status::text as status, g.created_at
        from app.knowledge_suggestions g
        where g.workspace_id = ${workspaceId} and g.reason = 'gap'
          and (g.id = any(${uuidArray([...ids])})
            ${all ? sql`or (g.status = 'pending' and g.similar_count >= ${FAQ_SUGGESTION_MIN_ASKS})` : sql``})`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        suggestion: {
          id: r.id,
          question: r.question,
          asked: r.asked,
          status: r.status,
          createdAt: iso(r.created_at)!,
        },
      },
    ]),
  );
}
