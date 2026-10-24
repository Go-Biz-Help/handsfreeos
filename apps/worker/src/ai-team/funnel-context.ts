/**
 * Where a customer is in their funnel, for every run that talks to them (teammate funnels, "Answering"): the funnel,
 * the stage, its goal and talking points, what moves them on, and what comes next. So "What's the comp plan?" in the
 * middle of the overview gets an answer, then a nudge back to the video.
 */
import { definitionOf, funnelMoveWords, funnelNextWords, funnelUpcoming } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';

export interface RunFunnel {
  readonly funnelId: string;
  readonly funnelPersonId: string;
  readonly name: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly goal: string;
  readonly knows: string;
  /** The moves the teammate judges from what they write (`funnel_move_on`). */
  readonly replyMoves: readonly {
    readonly id: string;
    readonly says: string;
    readonly to: string;
    readonly toName: string;
  }[];
  /** The ones HandsFreeOS takes by itself, in a line each ("They book → Booked"). */
  readonly otherMoves: readonly string[];
  /** The funnel's next message to them and when, in a line; null with nothing ahead. */
  readonly next: string | null;
}

/** Their funnel while it's on and they're in it (not paused), or null. */
export async function funnelOf(
  tx: Tx,
  workspaceId: string,
  personId: string,
  timeZone: string,
  now: number,
): Promise<RunFunnel | null> {
  const [r] = await rows<{
    id: string;
    funnel_id: string;
    name: string;
    definition: unknown;
    pipeline_id: string;
    stage_id: string | null;
    stage_reached_at: Date | string;
    sent: string[];
    seen: string[];
    booking_at: Date | string | null;
  }>(
    tx,
    sql`select fp.id, fp.funnel_id, f.name, f.definition, f.pipeline_id, fp.stage_id, fp.stage_reached_at,
          fp.sent, fp.seen, a.starts_at as booking_at
        from app.funnel_people fp join app.funnels f on f.id = fp.funnel_id
        left join app.appointments a on a.id = fp.appointment_id and a.status <> 'cancelled'
        where fp.workspace_id = ${workspaceId} and fp.person_id = ${personId} and fp.status = 'active'
          and f.status = 'on'
        limit 1`,
  );
  if (!r?.stage_id) return null;
  const stage = definitionOf({ definition: r.definition as never }).stages.find(
    (s) => s.stageId === r.stage_id,
  );
  if (!stage) return null;
  const names = new Map(
    (
      await rows<{ id: string; name: string }>(
        tx,
        sql`select id, name from app.pipeline_stages where pipeline_id = ${r.pipeline_id}`,
      )
    ).map((s) => [s.id, s.name]),
  );
  const next = funnelUpcoming(stage, {
    reachedAt: new Date(r.stage_reached_at).getTime(),
    booking: r.booking_at ? { startsAt: new Date(r.booking_at).getTime() } : null,
    timeZone,
    sent: r.sent,
    seen: r.seen,
    now,
  })[0];
  return {
    funnelId: r.funnel_id,
    funnelPersonId: r.id,
    name: r.name,
    stageId: r.stage_id,
    stageName: names.get(r.stage_id) ?? 'their stage',
    goal: stage.goal,
    knows: stage.knows,
    replyMoves: stage.moves.flatMap((m) =>
      m.kind === 'reply'
        ? [{ id: m.id, says: m.says, to: m.to, toName: names.get(m.to) ?? 'the next stage' }]
        : [],
    ),
    otherMoves: stage.moves
      .filter((m) => m.kind !== 'reply')
      .map((m) => funnelMoveWords(m, { stages: names })),
    next: next ? funnelNextWords(next.message.text, next.dueAt, timeZone) : null,
  };
}

/**
 * Whether a funnel that's on has them (in it, or paused for the team): its own messages and moves stand in for the
 * teammate's follow-ups and first messages (the plan's "One voice").
 */
export async function inFunnel(tx: Tx, personId: string | null): Promise<boolean> {
  if (!personId) return false;
  const [r] = await rows<{ yes: boolean }>(
    tx,
    sql`select exists (select 1 from app.funnel_people fp join app.funnels f on f.id = fp.funnel_id
          where fp.person_id = ${personId} and fp.status in ('active', 'paused') and f.status = 'on') as yes`,
  );
  return !!r?.yes;
}
