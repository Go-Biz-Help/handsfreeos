import { rows, sql, type Tx } from '@hfos/db/client';

export const POSITION_GAP = 1024;

/** Where a stage's leads are: every read below runs on `leads_board_idx`, and never touches the moving lead. */
interface StageRef {
  readonly workspaceId: string;
  readonly pipelineId: string;
  readonly stageId: string;
  /** The lead being placed, when it is already a row (a move); it is left out of the stage it is placed in. */
  readonly movingLeadId: string | null;
}

const inStage = (s: StageRef) =>
  sql`workspace_id = ${s.workspaceId} and pipeline_id = ${s.pipelineId} and stage_id = ${s.stageId}
      and archived_at is null and (${s.movingLeadId}::uuid is null or id <> ${s.movingLeadId}::uuid)`;

/**
 * The position for a lead placed in a stage: after `afterLeadId`, at the top (null), or at the bottom
 * (undefined). Renumbers the stage when two neighbours have no room left between them.
 */
export async function placeInStage(
  tx: Tx,
  stage: StageRef,
  afterLeadId: string | null | undefined,
): Promise<number> {
  if (afterLeadId === undefined) return await bottomOf(tx, stage);
  if (afterLeadId === null) {
    const [first] = await rows<{ position: number }>(
      tx,
      sql`select position::bigint as position from app.leads where ${inStage(stage)}
          order by position, created_at, id limit 1`,
    );
    if (!first) return POSITION_GAP;
    const position = Number(first.position);
    if (position > 1) return Math.floor(position / 2);
    return await renumberAndReturn(tx, stage, null);
  }
  // The lead to go after, and the one after it: the only two rows the gap between them needs.
  const pair = await rows<{ id: string; position: number }>(
    tx,
    sql`select l.id, l.position::bigint as position
        from (select id, position, created_at from app.leads where ${inStage(stage)}) l,
          (select position, created_at, id from app.leads where ${inStage(stage)} and id = ${afterLeadId}) a
        where (l.position, l.created_at, l.id) >= (a.position, a.created_at, a.id)
        order by l.position, l.created_at, l.id
        limit 2`,
  );
  const before = pair[0];
  if (!before) return await bottomOf(tx, stage);
  const after = pair[1];
  const b = Number(before.position);
  if (!after) return b + POSITION_GAP;
  const a = Number(after.position);
  if (a - b > 1) return Math.floor((b + a) / 2);
  return await renumberAndReturn(tx, stage, afterLeadId);
}

async function bottomOf(tx: Tx, stage: StageRef): Promise<number> {
  const [last] = await rows<{ position: number | null }>(
    tx,
    sql`select max(position)::bigint as position from app.leads where ${inStage(stage)}`,
  );
  return last?.position != null ? Number(last.position) + POSITION_GAP : POSITION_GAP;
}

/**
 * Spread the stage's leads out again in one statement, leaving the gap where the placed lead goes: after
 * `afterLeadId`, or at the top (null). Only the leads whose position changes are written.
 */
async function renumberAndReturn(
  tx: Tx,
  stage: StageRef,
  afterLeadId: string | null,
): Promise<number> {
  const shifted = afterLeadId
    ? sql`(position, created_at, id) > (select position, created_at, id from app.leads where id = ${afterLeadId})`
    : sql`true`;
  const [slot] = await rows<{ position: number }>(
    tx,
    sql`with r as (
          select id, (row_number() over (order by position, created_at, id))::bigint as n, ${shifted} as shifted
          from app.leads where ${inStage(stage)}
        ),
        moved as (
          update app.leads l set position = (r.n + r.shifted::int) * ${POSITION_GAP}
          from r
          where l.id = r.id and l.position <> (r.n + r.shifted::int) * ${POSITION_GAP}
        )
        select ((coalesce(max(r.n) filter (where not r.shifted), 0) + 1) * ${POSITION_GAP})::bigint as position
        from r`,
  );
  return Number(slot!.position);
}
