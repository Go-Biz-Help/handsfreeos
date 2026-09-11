import { rows, sql, type Tx } from '@hfos/db/client';

export const POSITION_GAP = 1024;

/**
 * The position for a lead placed in a stage: after `afterLeadId`, at the top (null), or at the bottom
 * (undefined). Renumbers the stage when two neighbours have no room left between them.
 */
export async function placeInStage(
  tx: Tx,
  stageId: string,
  afterLeadId: string | null | undefined,
  movingLeadId: string | null,
): Promise<number> {
  const ordered = await rows<{ id: string; position: number }>(
    tx,
    sql`select id, position::bigint as position from app.leads where stage_id = ${stageId} and archived_at is null and (${movingLeadId ?? null}::uuid is null or id <> ${movingLeadId ?? null}::uuid) order by position, created_at`,
  );
  const positions = ordered.map((r) => ({ id: r.id, position: Number(r.position) }));
  if (afterLeadId === undefined) {
    const last = positions[positions.length - 1];
    return last ? last.position + POSITION_GAP : POSITION_GAP;
  }
  if (afterLeadId === null) {
    const first = positions[0];
    if (!first) return POSITION_GAP;
    if (first.position > 1) return Math.floor(first.position / 2);
    return await renumberAndReturn(tx, stageId, positions, 0);
  }
  const index = positions.findIndex((p) => p.id === afterLeadId);
  if (index === -1) {
    const last = positions[positions.length - 1];
    return last ? last.position + POSITION_GAP : POSITION_GAP;
  }
  const before = positions[index]!;
  const after = positions[index + 1];
  if (!after) return before.position + POSITION_GAP;
  if (after.position - before.position > 1)
    return Math.floor((before.position + after.position) / 2);
  return await renumberAndReturn(tx, stageId, positions, index + 1);
}

async function renumberAndReturn(
  tx: Tx,
  stageId: string,
  positions: { id: string; position: number }[],
  insertAt: number,
): Promise<number> {
  // Spread the existing leads out again, leaving the gap where the moved lead goes.
  let p = POSITION_GAP;
  let result = 0;
  const updates: { id: string; position: number }[] = [];
  for (let i = 0; i <= positions.length; i++) {
    if (i === insertAt) {
      result = p;
      p += POSITION_GAP;
    }
    const item = positions[i];
    if (item) {
      updates.push({ id: item.id, position: p });
      p += POSITION_GAP;
    }
  }
  for (const u of updates) {
    await tx.execute(
      sql`update app.leads set position = ${u.position} where id = ${u.id} and stage_id = ${stageId}`,
    );
  }
  return result;
}
