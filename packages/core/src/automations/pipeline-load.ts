/**
 * "Move deals along for you", server side: each open deal with its pipeline's stages and what has happened to it.
 * Read by the worker, which moves a deal the moment something happens, and by the Action Center, whose "Deal in
 * the wrong stage" card (`pipeline_mismatch`) catches a deal that is still behind a day later.
 *
 * What happened to a deal is what's linked to it (`lead_id` on the quote or the visit). A quote or visit linked to
 * no deal counts for the customer's only open deal, when it came after that deal was opened: a customer with two
 * open deals is left alone, since there's no telling which one it was for. A deal a person marks won or lost
 * themselves (`won_by_hand`, as Social Outreach's demos are) is never won by its done visit.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { uuidArray } from '../calendar/load';
import type { DealEvidence, RoleStage } from './pipeline-roles';

export interface DealFacts {
  readonly leadId: string;
  readonly title: string;
  readonly personId: string | null;
  readonly assigneeUserId: string | null;
  readonly pipelineId: string;
  readonly stageId: string;
  readonly status: 'open' | 'won' | 'lost';
  readonly stageEnteredAt: number;
  readonly stages: readonly RoleStage[];
  readonly evidence: readonly DealEvidence[];
}

interface Raw extends Record<string, unknown> {
  id: string;
  title: string;
  person_id: string | null;
  assignee_user_id: string | null;
  pipeline_id: string;
  stage_id: string;
  status: 'open' | 'won' | 'lost';
  stage_entered_at: Date;
  first_response_at: Date | null;
  stages: RoleStage[] | null;
  quoted: { at: string; number: string | null } | null;
  accepted: { at: string; number: string | null } | null;
  booked: { at: string; title: string } | null;
  done: { at: string; title: string } | null;
}

const ms = (d: Date | string): number => new Date(d).getTime();
const quoteWord = (n: string | null) => (n ? `Quote ${n}` : 'A quote');

/**
 * Open deals (not archived) with what happened to them: the ones named, or a customer's, or with `all` every
 * open deal in the business.
 */
export async function dealFacts(
  tx: Tx,
  workspaceId: string,
  which: {
    readonly leadIds?: readonly string[];
    readonly personIds?: readonly string[];
    readonly all?: boolean;
  },
): Promise<DealFacts[]> {
  const leadIds = which.leadIds ?? [];
  const personIds = which.personIds ?? [];
  if (!which.all && leadIds.length === 0 && personIds.length === 0) return [];
  const filter = which.all
    ? sql`true`
    : sql`(l.id = any(${uuidArray([...leadIds])}) or l.person_id = any(${uuidArray([...personIds])}))`;
  // "Linked to this deal, or to nobody and it's the customer's only open deal (and came after it opened)."
  const forDeal = (
    leadCol: ReturnType<typeof sql>,
    personCol: ReturnType<typeof sql>,
    atCol: ReturnType<typeof sql>,
  ) =>
    sql`(${leadCol} = d.id or (${leadCol} is null and d.only_open and ${personCol} = d.person_id
          and ${atCol} > d.created_at))`;
  const list = await rows<Raw>(
    tx,
    sql`with d as (
          select l.id, l.title, l.person_id, l.assignee_user_id, l.pipeline_id, l.stage_id,
            l.status::text as status, l.stage_entered_at, l.first_response_at, l.created_at, l.won_by_hand,
            l.person_id is not null and (select count(*) from app.leads o
              where o.workspace_id = l.workspace_id and o.person_id = l.person_id and o.status = 'open'
                and o.archived_at is null) = 1 as only_open
          from app.leads l
          where l.workspace_id = ${workspaceId} and l.status = 'open' and l.archived_at is null and ${filter}
        )
        select d.id, d.title, d.person_id, d.assignee_user_id, d.pipeline_id, d.stage_id, d.status,
          d.stage_entered_at, d.first_response_at,
          (select json_agg(json_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'position', s.position)
              order by s.position)
            from app.pipeline_stages s where s.pipeline_id = d.pipeline_id) as stages,
          (select json_build_object('at', e.sent_at, 'number', e.number) from app.estimates e
            where e.workspace_id = ${workspaceId} and e.sent_at is not null and e.status <> 'void'
              and ${forDeal(sql`e.lead_id`, sql`e.person_id`, sql`e.sent_at`)}
            order by e.sent_at desc limit 1) as quoted,
          (select json_build_object('at', e.accepted_at, 'number', e.number) from app.estimates e
            where e.workspace_id = ${workspaceId} and e.accepted_at is not null and e.status = 'accepted'
              and ${forDeal(sql`e.lead_id`, sql`e.person_id`, sql`e.accepted_at`)}
            order by e.accepted_at desc limit 1) as accepted,
          (select json_build_object('at', aa.created_at, 'title', a.title) from app.appointments a
            join app.appointment_attendees aa on aa.appointment_id = a.id
            where a.workspace_id = ${workspaceId} and a.status <> 'cancelled' and aa.status <> 'cancelled'
              and ${forDeal(sql`a.lead_id`, sql`aa.person_id`, sql`aa.created_at`)}
            order by aa.created_at desc limit 1) as booked,
          -- A deal a person marks won or lost themselves (lead.wait_for_outcome): its done visit is no win.
          (select json_build_object('at', ev.created_at, 'title', a.title) from app.appointments a
            join app.appointment_attendees aa on aa.appointment_id = a.id
            join lateral (select x.created_at from app.events x
              where x.entity_type = 'appointment' and x.entity_id = a.id
                and x.event_type = 'appointment.completed'
              order by x.created_at desc limit 1) ev on true
            where a.workspace_id = ${workspaceId} and a.status = 'completed' and aa.status = 'attended'
              and not d.won_by_hand
              and ${forDeal(sql`a.lead_id`, sql`aa.person_id`, sql`ev.created_at`)}
            order by ev.created_at desc limit 1) as done
        from d
        order by d.id`,
  );
  return list.map((r) => {
    const evidence: DealEvidence[] = [];
    if (r.first_response_at)
      evidence.push({
        step: 'contacted',
        at: ms(r.first_response_at),
        why: 'Someone got back to them',
      });
    if (r.quoted)
      evidence.push({
        step: 'quoted',
        at: ms(r.quoted.at),
        why: `${quoteWord(r.quoted.number)} went out`,
      });
    if (r.booked)
      evidence.push({ step: 'booked', at: ms(r.booked.at), why: `${r.booked.title} booked` });
    if (r.accepted)
      evidence.push({
        step: 'won',
        at: ms(r.accepted.at),
        why: `${quoteWord(r.accepted.number)} accepted`,
      });
    if (r.done) evidence.push({ step: 'won', at: ms(r.done.at), why: `${r.done.title} done` });
    return {
      leadId: r.id,
      title: r.title,
      personId: r.person_id,
      assigneeUserId: r.assignee_user_id,
      pipelineId: r.pipeline_id,
      stageId: r.stage_id,
      status: r.status,
      stageEnteredAt: ms(r.stage_entered_at),
      stages: (r.stages ?? []).map((s) => ({ ...s, position: Number(s.position) })),
      evidence,
    };
  });
}
