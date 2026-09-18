import type { StageRef } from '@hfos/core';

import { change } from '@/changes';

/**
 * Moving a lead, and setting what happens next. Both work with no signal: the lead moves on the phone at once and the
 * change waits in the queue. A move sends only where it came from and where it goes, so if a teammate moved it first
 * theirs stands and this one comes back refused with the reason (the canvas's line under Move to…).
 */

const nowIso = () => new Date().toISOString();

export async function moveLead(
  workspaceId: string,
  lead: { readonly id: string; readonly title: string; readonly stageId: string },
  stage: StageRef,
  lostReason?: string,
): Promise<{ readonly id: string }> {
  const at = nowIso();
  const status = stage.kind === 'open' ? 'open' : stage.kind;
  return change(
    'lead.move_stage',
    {
      workspaceId,
      leadId: lead.id,
      stageId: stage.id,
      ...(lostReason ? { lostReason } : {}),
    } as never,
    {
      optimistic: (tx) =>
        tx.execute(
          `UPDATE leads SET stage_id = ?, status = ?, stage_entered_at = ?,
             won_at = CASE WHEN ? = 'won' THEN ? ELSE NULL END,
             lost_at = CASE WHEN ? = 'lost' THEN ? ELSE NULL END,
             lost_reason = CASE WHEN ? = 'lost' THEN ? ELSE NULL END,
             updated_at = ?
           WHERE id = ?`,
          [stage.id, status, at, status, at, status, at, status, lostReason ?? null, at, lead.id],
        ),
    },
  );
}

/** Say what happens next on a lead, and when. Clearing it sends an empty next action, as the web's dialog does. */
export async function setNextAction(
  workspaceId: string,
  leadId: string,
  text: string,
  dueAt: string | null,
): Promise<{ readonly id: string }> {
  const trimmed = text.trim();
  return change('lead.set_next_action', { workspaceId, leadId, text: trimmed, dueAt } as never, {
    optimistic: (tx) =>
      tx.execute(
        'UPDATE leads SET next_action = ?, next_action_at = ?, updated_at = ? WHERE id = ?',
        [trimmed || null, dueAt, nowIso(), leadId],
      ),
  });
}
