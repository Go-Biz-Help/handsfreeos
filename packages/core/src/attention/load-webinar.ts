/**
 * The Action Center's loader for someone hot after a webinar (`webinar_hot`, one per app.video_call_leads row;
 * HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md part 5). Server-only, beside load.ts, which runs it.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { uuidArray } from '../calendar/load';
import type { LinkedLeadFacts } from './facts';
import type { AttentionFacts } from './registry';
import { WEBINAR_HOT_DAYS } from './detectors/webinar-hot';

const DAY = 86_400_000;
const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
const nameOf = (first: string | null, last: string | null): string | null =>
  `${first ?? ''} ${last ?? ''}`.trim() || null;

export interface WebinarLeadInfo {
  readonly lead: AttentionFacts<'webinar_hot'>['lead'];
  readonly personId: string;
  readonly personName: string | null;
  /** The AI's one line on why, or what the points came from. */
  readonly reason: string | null;
  readonly openLead: LinkedLeadFacts | null;
  readonly conversationId: string | null;
  readonly assigneeUserId: string | null;
}

/**
 * Webinar leads by id, and in a sweep every hot one a person is asked about, still within its days. `contactedAt` is
 * the latest message or call to them since they were scored, on any of their conversations: whoever reached them, the
 * card asked for it.
 */
export async function loadWebinarLeads(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  all: boolean,
  now: Date,
): Promise<Map<string, WebinarLeadInfo>> {
  if (!ids.length && !all) return new Map();
  const since = new Date(now.getTime() - WEBINAR_HOT_DAYS * DAY).toISOString();
  const list = await rows<{
    id: string;
    label: 'hot' | 'warm' | 'cold';
    follow_up: 'list' | 'home' | 'text';
    outcome: 'sent' | 'drafted' | 'card' | 'skipped' | null;
    scored_at: Date;
    points: number;
    reason: string | null;
    parts: { what?: unknown }[] | null;
    person_id: string;
    first_name: string | null;
    last_name: string | null;
    person_archived: boolean;
    what: string | null;
    lead_id: string | null;
    lead_value: number | null;
    lead_status: 'open' | 'won' | 'lost' | null;
    lead_assignee: string | null;
    contacted_at: Date | null;
    conversation_id: string | null;
    conversation_assignee: string | null;
  }>(
    tx,
    sql`select v.id, v.label, v.follow_up, v.outcome, v.scored_at, v.points, v.reason, v.parts, v.person_id,
          p.first_name, p.last_name, p.archived_at is not null as person_archived,
          coalesce(a.title, f.name) as what,
          l.id as lead_id, l.value_cents::float8 as lead_value, l.status::text as lead_status,
          l.assignee_user_id as lead_assignee,
          greatest(
            (select max(m.occurred_at) from app.messages m join app.conversations c on c.id = m.conversation_id
              where c.workspace_id = v.workspace_id and c.person_id = v.person_id
                and m.direction = 'outbound' and m.occurred_at > v.scored_at),
            (select max(k.started_at) from app.calls k
              where k.workspace_id = v.workspace_id and k.person_id = v.person_id
                and k.started_at > v.scored_at)) as contacted_at,
          lc.id as conversation_id, lc.assignee_user_id as conversation_assignee
        from app.video_call_leads v
        join app.people p on p.id = v.person_id
        join app.video_calls vc on vc.id = v.video_call_id
        left join app.appointments a on a.id = vc.appointment_id
        left join app.forms f on f.id = v.form_id
        left join lateral (select x.id, x.value_cents, x.status, x.assignee_user_id from app.leads x
          where x.workspace_id = v.workspace_id and x.person_id = v.person_id and x.status = 'open'
            and x.archived_at is null
          order by x.created_at desc limit 1) l on true
        left join lateral (select c.id, c.assignee_user_id from app.conversations c
          where c.workspace_id = v.workspace_id and c.person_id = v.person_id
          order by c.last_message_at desc nulls last, c.created_at desc limit 1) lc on true
        where v.workspace_id = ${workspaceId}
          and (v.id = any(${uuidArray([...ids])})
            ${
              all
                ? sql`or (v.label = 'hot' and (v.follow_up = 'home' or v.outcome = 'card')
                        and v.scored_at > ${since}::timestamptz)`
                : sql``
            })`,
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        lead: {
          id: r.id,
          label: r.label,
          followUp: r.follow_up,
          outcome: r.outcome,
          scoredAt: iso(r.scored_at)!,
          points: r.points,
          what: r.what ?? 'Your webinar',
          contactedAt: iso(r.contacted_at),
          personArchived: r.person_archived,
        },
        personId: r.person_id,
        personName: nameOf(r.first_name, r.last_name),
        reason:
          r.reason ??
          ((r.parts ?? [])
            .map((p) => (typeof p.what === 'string' ? p.what : ''))
            .filter(Boolean)
            .join(' · ') ||
            null),
        openLead:
          r.lead_id && r.lead_status
            ? { id: r.lead_id, valueCents: Number(r.lead_value ?? 0), status: r.lead_status }
            : null,
        conversationId: r.conversation_id,
        assigneeUserId: r.conversation_assignee ?? r.lead_assignee,
      },
    ]),
  );
}
