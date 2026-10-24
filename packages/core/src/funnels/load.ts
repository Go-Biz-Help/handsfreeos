/**
 * Funnels, server side: reading a funnel and its pipeline, where a person is, and the line a screen shows for them.
 * Every read is in the caller's transaction, under its row security.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { funnelPeople, funnels, pipelineStages, pipelines } from '@hfos/db/schema';
import { teammateConfigOf, loadTeammate } from '../ai-team/load';
import { uuidArray } from '../calendar/load';
import { HfosError } from '../errors';
import type { FunnelPersonOut, FunnelStageRow } from '../schemas/funnel';
import {
  FunnelDefinition,
  type FunnelAddedBy,
  type FunnelLeftReason,
  type FunnelPauseReason,
  type FunnelPersonStatus,
  type FunnelStatus,
} from './definition';
import { funnelUpcoming } from './schedule';
import { funnelOnlyIfWords } from './words';
import type { FunnelIssueContext } from './issues';

export type FunnelRow = typeof funnels.$inferSelect;
export type FunnelPersonRow = typeof funnelPeople.$inferSelect;

export const funnelGone = () =>
  HfosError.notFound(
    'That funnel isn’t there anymore. Someone may have archived it. Refresh to see your funnels.',
  );

export const funnelPersonGone = () =>
  HfosError.notFound(
    'They aren’t in that funnel anymore. Someone may have taken them out. Refresh to see where they are.',
  );

/** The definition as saved, read leniently: one saved by an older version still opens. */
export function definitionOf(row: Pick<FunnelRow, 'definition'>): FunnelDefinition {
  const parsed = FunnelDefinition.safeParse(row.definition);
  return parsed.success ? parsed.data : FunnelDefinition.parse({});
}

export async function requireFunnel(
  tx: Tx,
  workspaceId: string,
  funnelId: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<FunnelRow> {
  const q = tx
    .select()
    .from(funnels)
    .where(and(eq(funnels.id, funnelId), eq(funnels.workspaceId, workspaceId)));
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  if (!row || row.status === 'archived') throw funnelGone();
  return row;
}

/** The pipeline's name and its stages, in order. */
export async function pipelineOf(
  tx: Tx,
  pipelineId: string,
): Promise<{ readonly name: string; readonly stages: FunnelStageRow[] }> {
  const [p] = await tx
    .select({ name: pipelines.name })
    .from(pipelines)
    .where(eq(pipelines.id, pipelineId));
  const stages = await tx
    .select({
      id: pipelineStages.id,
      name: pipelineStages.name,
      kind: pipelineStages.kind,
      position: pipelineStages.position,
    })
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, pipelineId))
    .orderBy(asc(pipelineStages.position));
  return { name: p?.name ?? 'the pipeline', stages: stages as FunnelStageRow[] };
}

/** The funnel running on a pipeline (on, paused or a draft), if any. */
export async function funnelOfPipeline(tx: Tx, pipelineId: string): Promise<FunnelRow | null> {
  const [row] = await rows<{ id: string }>(
    tx,
    sql`select id from app.funnels where pipeline_id = ${pipelineId} and status <> 'archived' limit 1`,
  );
  if (!row) return null;
  const [f] = await tx.select().from(funnels).where(eq(funnels.id, row.id));
  return f ?? null;
}

/** The person's current funnel row (active or paused), if any. */
export async function currentFunnelRow(
  tx: Tx,
  personId: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<FunnelPersonRow | null> {
  const q = tx
    .select()
    .from(funnelPeople)
    .where(
      and(eq(funnelPeople.personId, personId), inArray(funnelPeople.status, ['active', 'paused'])),
    );
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  return row ?? null;
}

export async function requireFunnelPerson(
  tx: Tx,
  workspaceId: string,
  id: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<FunnelPersonRow> {
  const q = tx
    .select()
    .from(funnelPeople)
    .where(and(eq(funnelPeople.id, id), eq(funnelPeople.workspaceId, workspaceId)));
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  if (!row) throw funnelPersonGone();
  return row;
}

/** The business's time zone and name. */
export async function businessOf(
  tx: Tx,
  workspaceId: string,
): Promise<{ timeZone: string; name: string }> {
  const [w] = await rows<{ timezone: string | null; name: string }>(
    tx,
    sql`select timezone, name from app.workspaces where id = ${workspaceId}`,
  );
  return { timeZone: w?.timezone || 'America/Chicago', name: w?.name ?? '' };
}

/**
 * The open leads already at the funnel's open stages whose person is in no funnel: what "Also add the leads already
 * here" takes in. One a person, however many leads they have there.
 */
export async function waitingLeadCount(
  tx: Tx,
  pipelineId: string,
  openStageIds: readonly string[],
): Promise<number> {
  if (!openStageIds.length) return 0;
  const [r] = await rows<{ n: number }>(
    tx,
    sql`select count(*)::int as n from (${waitingLeadsSql(pipelineId, openStageIds)}) w`,
  );
  return r?.n ?? 0;
}

/** Each waiting person's latest open lead there (person_id, lead_id, stage_id), for the worker to add. */
export function waitingLeadsSql(pipelineId: string, openStageIds: readonly string[]) {
  return sql`select distinct on (l.person_id) l.person_id, l.id as lead_id, l.stage_id
      from app.leads l
      join app.people p on p.id = l.person_id and p.bin_item_id is null and p.erased_at is null
      where l.pipeline_id = ${pipelineId} and l.status = 'open' and l.archived_at is null
        and l.stage_id = any(${uuidArray(openStageIds)})
        and not exists (select 1 from app.funnel_people fp
                        where fp.person_id = l.person_id and fp.status in ('active', 'paused'))
      order by l.person_id, l.stage_entered_at desc`;
}

/** What the "Before it goes on" checks need besides the definition. */
export async function issueContextOf(
  tx: Tx,
  workspaceId: string,
  pipelineId: string,
): Promise<FunnelIssueContext> {
  const p = await pipelineOf(tx, pipelineId);
  const t = await loadTeammate(tx, workspaceId);
  const overlapping = await rows<{ name: string }>(
    tx,
    sql`select w.name from app.workflows w
        where w.workspace_id = ${workspaceId} and w.status = 'active' and w.trigger_kind = 'event'
          and w.trigger_event = 'lead.created'
          and exists (select 1 from app.workflow_versions v
                      where v.id = w.active_version_id and v.definition::text like '%"send_text"%')
        order by w.name limit 5`,
  );
  return {
    pipelineName: p.name,
    stages: p.stages,
    teammate: t
      ? {
          name: t.name,
          status: t.status as 'off' | 'training' | 'automatic',
          approved: t.approvedCount,
          needed: teammateConfigOf(t).autonomy.approvalsNeeded,
        }
      : null,
    overlappingWorkflows: overlapping.map((o) => o.name),
  };
}

/** A person's row as the screens show it: where they are, their booking, and what's next. */
export async function funnelPersonOut(
  tx: Tx,
  row: FunnelPersonRow,
  opts: { readonly now: number; readonly timeZone: string; readonly funnel?: FunnelRow },
): Promise<FunnelPersonOut> {
  const funnel =
    opts.funnel ?? (await tx.select().from(funnels).where(eq(funnels.id, row.funnelId)))[0] ?? null;
  const def = funnel ? definitionOf(funnel) : FunnelDefinition.parse({});
  const [info] = await rows<{
    person_name: string;
    stage_name: string | null;
    appt_starts: Date | string | null;
    appt_title: string | null;
  }>(
    tx,
    sql`select trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) as person_name,
          s.name as stage_name, a.starts_at as appt_starts, a.title as appt_title
        from app.people p
        left join app.pipeline_stages s on s.id = ${row.stageId}
        left join app.appointments a on a.id = ${row.appointmentId} and a.status <> 'cancelled'
        where p.id = ${row.personId}`,
  );
  const booking =
    row.appointmentId && info?.appt_starts
      ? {
          appointmentId: row.appointmentId,
          startsAt: new Date(info.appt_starts).toISOString(),
          title: info.appt_title ?? '',
        }
      : null;
  const stage = def.stages.find((s) => s.stageId === row.stageId);
  const live = row.status === 'active' && funnel?.status === 'on';
  const next =
    live && stage
      ? funnelUpcoming(stage, {
          reachedAt: row.stageReachedAt.getTime(),
          booking: booking ? { startsAt: Date.parse(booking.startsAt) } : null,
          timeZone: opts.timeZone,
          sent: row.sent,
          seen: row.seen,
          now: opts.now,
        })
          .slice(0, 3)
          .map((n) => ({
            messageId: n.message.id,
            dueAt: new Date(n.dueAt).toISOString(),
            wording: n.message.wording,
            text: n.message.text,
            onlyIf: n.message.onlyIf ? funnelOnlyIfWords(n.message.onlyIf) : null,
          }))
      : [];
  return {
    id: row.id,
    funnelId: row.funnelId,
    funnelName: funnel?.name ?? 'A funnel',
    funnelStatus: (funnel?.status ?? 'archived') as FunnelStatus,
    personId: row.personId,
    personName: info?.person_name || 'Someone',
    leadId: row.leadId,
    stageId: row.stageId,
    stageName: info?.stage_name ?? null,
    status: row.status as FunnelPersonStatus,
    pausedReason: (row.pausedReason as FunnelPauseReason | null) ?? null,
    leftReason: (row.leftReason as FunnelLeftReason | null) ?? null,
    stageReachedAt: row.stageReachedAt.toISOString(),
    booking,
    next,
    addedBy: row.addedBy as FunnelAddedBy,
    suggestedWhy: row.suggestedWhy,
    createdAt: row.createdAt.toISOString(),
  };
}
