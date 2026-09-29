/**
 * Reading the vote (0109), server side: what has been picked and where it has got to, each add-on's votes, and the
 * add-ons one business voted for. One query each. The rules they feed are in ./roadmap.ts.
 */
import { rows, sql, type Tx } from '@hfos/db/client';

export type PickHow = 'votes' | 'team' | 'plan';

export interface PickRow {
  readonly addonId: string;
  readonly how: PickHow;
  readonly weekId: string | null;
  /** Its votes when it was picked. */
  readonly votes: number;
  readonly pickedAt: Date;
  readonly votersToldAt: Date | null;
  readonly shippedAt: Date | null;
  readonly shippedToldAt: Date | null;
}

const date = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));

/** Everything picked, newest first. */
export async function loadPicks(tx: Tx): Promise<PickRow[]> {
  const found = await rows<{
    addon_id: string;
    how: PickHow;
    week_id: string | null;
    votes: number;
    picked_at: Date | string;
    voters_told_at: Date | string | null;
    shipped_at: Date | string | null;
    shipped_told_at: Date | string | null;
  }>(
    tx,
    sql`select addon_id, how, week_id, votes, picked_at, voters_told_at, shipped_at, shipped_told_at
        from platform.addon_picks order by picked_at desc, addon_id`,
  );
  return found.map((r) => ({
    addonId: r.addon_id,
    how: r.how,
    weekId: r.week_id,
    votes: Number(r.votes),
    pickedAt: new Date(r.picked_at),
    votersToldAt: date(r.voters_told_at),
    shippedAt: date(r.shipped_at),
    shippedToldAt: date(r.shipped_told_at),
  }));
}

/** Each add-on's votes; one nobody voted for is absent. */
export async function loadVoteCounts(tx: Tx): Promise<Record<string, number>> {
  const found = await rows<{ addon_id: string; votes: number }>(
    tx,
    sql`select addon_id, votes from platform.addon_vote_counts where votes > 0`,
  );
  return Object.fromEntries(found.map((r) => [r.addon_id, Number(r.votes)]));
}

/** The add-ons one business voted for. */
export async function loadBusinessVotes(tx: Tx, workspaceId: string): Promise<Set<string>> {
  const found = await rows<{ addon_id: string }>(
    tx,
    sql`select addon_id from platform.addon_votes where workspace_id = ${workspaceId}::uuid`,
  );
  return new Set(found.map((r) => r.addon_id));
}

/**
 * Add-on ids as a Postgres array literal (`{hvac,roofing}`), for `::text[]`. Ids are letters only, so nothing in one
 * needs quoting; anything else is refused rather than passed on.
 */
export function addonIdArray(ids: readonly string[]): string {
  for (const id of ids) if (!/^[a-z]{2,16}$/.test(id)) throw new Error(`Not an add-on id: ${id}`);
  return `{${ids.join(',')}}`;
}

/**
 * Closes the week that ended at `endsAt` over the add-ons still in the race: the one with the most votes is picked,
 * and a tie or nothing voted for waits for the team (private.close_addon_vote_week). Closing it again returns the
 * same answer. For the worker, as the service actor.
 */
export async function closeAddonVoteWeek(
  tx: Tx,
  endsAt: Date,
  inRace: readonly string[],
): Promise<{
  id: string;
  outcome: 'votes' | 'no_votes' | 'tie';
  addonId: string | null;
  tied: string[];
  topVotes: number;
  teamToldAt: Date | null;
}> {
  const [week] = await rows<{
    id: string;
    outcome: 'votes' | 'no_votes' | 'tie';
    addon_id: string | null;
    tied: string[] | null;
    top_votes: number;
    team_told_at: Date | string | null;
  }>(
    tx,
    sql`select id, outcome, addon_id, tied, top_votes, team_told_at
        from private.close_addon_vote_week(${endsAt.toISOString()}::timestamptz, ${addonIdArray(inRace)}::text[])`,
  );
  if (!week) throw new Error('The week did not close.');
  return {
    id: week.id,
    outcome: week.outcome,
    addonId: week.addon_id,
    tied: week.tied ?? [],
    topVotes: Number(week.top_votes),
    teamToldAt: date(week.team_told_at),
  };
}
