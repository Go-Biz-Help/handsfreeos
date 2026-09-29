/**
 * Voting on what's next (0109, docs/addon-architecture.md): the worker closes each week's vote and tells people.
 *
 * - **The week closes** every Sunday at midnight, US Eastern (`addon_roadmap.week`, one job per week, armed for the
 *   next as each one finishes and again whenever the worker starts). The planned add-on with the most votes becomes
 *   Coming soon, in the same transaction that closes the week (private.close_addon_vote_week), and the owners and
 *   admins of every business that voted for it are emailed. Nothing voted for, or a tie: nothing is picked, and the
 *   team who choose are emailed to pick on /admin/add-ons (the owner's decision, 2026-09-28).
 * - **The team's pick** (`platform.addon_picked`) is told to its voters the same way.
 * - **Shipping** is a deploy: the catalogue makes a picked add-on available. An hourly check (and one soon after the
 *   worker starts, which a deploy does) notices, writes it down, and tells the voters they can add it. It also
 *   finishes telling anyone a failed run left out.
 *
 * Retries tell nobody twice: each email sent is written down at once (platform.addon_pick_deliveries), and each
 * pick and week says when everybody was told.
 */
import {
  ADDON_CATALOG,
  type Catalog,
  addonIdArray,
  addonsInRace,
  closeAddonVoteWeek,
  findAddon,
  loadOverrides,
  loadPicks,
  nextAddonPickAt,
  pickStageOf,
  scheduleJob,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { addonPickedEmail, addonPickNeededEmail, addonShippedEmail } from '../emails/templates';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import type { WorkerServices } from '../services';

export const ROADMAP_JOBS = {
  /** One per week: closes the vote that ended at `payload.endsAt`. */
  week: 'addon_roadmap.week',
  /** Hourly and global: picks that shipped, and anyone not told yet. */
  shipCheck: 'addon_roadmap.ship_check',
} as const;
export const addonWeekKey = (endsAt: Date): string => `addon-week:${endsAt.toISOString()}`;
export const ADDON_SHIP_CHECK_KEY = 'check:addon_ships';

const MIN = 60_000;
const HOUR = 60 * MIN;

type Teller = Pick<WorkerServices, 'db' | 'mailer' | 'webUrl' | 'log'>;
type NewsKind = 'picked' | 'shipped';

/** The job for the week that closes next after `now`, unless it's already waiting. */
async function armWeek(tx: Tx, now: number): Promise<void> {
  const endsAt = nextAddonPickAt(now);
  await scheduleJob(tx, {
    kind: ROADMAP_JOBS.week,
    dedupeKey: addonWeekKey(endsAt),
    runAt: endsAt,
    payload: { endsAt: endsAt.toISOString() },
    workspaceId: null,
    organizationId: null,
  });
}

/**
 * On every start: this week's close, and a ship check within minutes (a deploy is what ships an add-on, so the
 * hourly check waiting already is pulled earlier).
 */
export async function ensureAddonVoting(tx: Tx, now: number): Promise<void> {
  await armWeek(tx, now);
  await scheduleJob(
    tx,
    {
      kind: ROADMAP_JOBS.shipCheck,
      dedupeKey: ADDON_SHIP_CHECK_KEY,
      runAt: new Date(now + 5 * MIN),
      payload: {},
      workspaceId: null,
      organizationId: null,
    },
    { pullEarlier: true },
  );
}

/**
 * The worker's side of the vote, over a catalogue: the real one below, a made-up one in the tests (so they never
 * pick one of HandsFreeOS's own).
 */
export function addonRoadmapWorker(catalog: Catalog) {
  /** The owners and admins of every business that voted for it, each told once. */
  async function tellVoters(ctx: Teller, addonId: string, kind: NewsKind): Promise<number> {
    const m = findAddon(catalog, addonId);
    if (!m) return 0;
    const people = await asWorker(ctx.db, {}, (tx) =>
      rows<{
        user_id: string;
        email: string;
        first_name: string;
        workspace_id: string;
        business: string;
      }>(
        tx,
        sql`select user_id, email, first_name, workspace_id, business
            from private.addon_voters_to_tell(${addonId}, ${kind})`,
      ),
    );
    for (const person of people) {
      const page = `${ctx.webUrl}/app/w/${person.workspace_id}/add-ons`;
      const input = {
        firstName: person.first_name,
        name: m.name,
        summary: m.summary,
        business: person.business,
        link: kind === 'shipped' ? `${page}?addon=${addonId}` : page,
      };
      const email = kind === 'shipped' ? addonShippedEmail(input) : addonPickedEmail(input);
      await ctx.mailer.send({ to: person.email, ...email });
      await asWorker(ctx.db, {}, (tx) =>
        rows(
          tx,
          sql`insert into platform.addon_pick_deliveries (addon_id, kind, user_id)
              values (${addonId}, ${kind}, ${person.user_id}::uuid) on conflict do nothing`,
        ),
      );
    }
    await asWorker(ctx.db, {}, (tx) =>
      rows(
        tx,
        kind === 'shipped'
          ? sql`update platform.addon_picks set shipped_told_at = now() where addon_id = ${addonId}`
          : sql`update platform.addon_picks set voters_told_at = now() where addon_id = ${addonId}`,
      ),
    );
    ctx.log.info({ addonId, kind, told: people.length }, 'add-on voters told');
    return people.length;
  }

  /** The team who choose, when a week closed with nothing voted for or a tie. */
  async function askTeam(
    ctx: Teller,
    week: { id: string; outcome: 'no_votes' | 'tie'; tied: string[]; topVotes: number },
  ): Promise<void> {
    const team = await asWorker(ctx.db, {}, (tx) =>
      rows<{ email: string; first_name: string }>(
        tx,
        sql`select email, first_name from private.addon_pickers_to_tell()`,
      ),
    );
    for (const person of team) {
      const email = addonPickNeededEmail({
        firstName: person.first_name,
        outcome: week.outcome,
        tied: week.tied.map((id) => findAddon(catalog, id)?.name ?? id),
        votes: week.topVotes,
        link: `${ctx.webUrl}/admin/add-ons`,
      });
      await ctx.mailer.send({ to: person.email, ...email });
    }
    await asWorker(ctx.db, {}, (tx) =>
      rows(
        tx,
        sql`update platform.addon_vote_weeks set team_told_at = now() where id = ${week.id}`,
      ),
    );
    ctx.log.info(
      { weekId: week.id, outcome: week.outcome, told: team.length },
      'add-on team asked to pick',
    );
  }

  /** `addon_roadmap.week`: the week's vote closes, and the next week's close is armed. */
  const closeAddonWeek: JobHandler = async (ctx) => {
    const endsAt = new Date(String((ctx.job.payload as { endsAt?: unknown }).endsAt ?? ''));
    if (Number.isNaN(endsAt.getTime())) {
      ctx.log.warn({ jobId: ctx.job.id }, 'add-on week job without its week');
      await asWorker(ctx.db, {}, (tx) => armWeek(tx, ctx.now));
      return;
    }
    const week = await asWorker(ctx.db, {}, async (tx) => {
      const [overrides, picks] = await Promise.all([loadOverrides(tx), loadPicks(tx)]);
      const race = addonsInRace(catalog, overrides, new Set(picks.map((p) => p.addonId)));
      return closeAddonVoteWeek(tx, endsAt, race);
    });
    ctx.log.info({ endsAt, outcome: week.outcome, addonId: week.addonId }, 'add-on week closed');
    if (week.outcome === 'votes' && week.addonId) await tellVoters(ctx, week.addonId, 'picked');
    else if (week.outcome !== 'votes' && !week.addonId && !week.teamToldAt)
      await askTeam(ctx, {
        id: week.id,
        outcome: week.outcome,
        tied: week.tied,
        topVotes: week.topVotes,
      });
    // The next one, a week on from this one (not from now: a late run must not skip a week).
    await asWorker(ctx.db, {}, (tx) =>
      armWeek(tx, Math.max(endsAt.getTime(), ctx.now - 7 * 24 * HOUR)),
    );
  };

  /** `addon_roadmap.ship_check`: picks the catalogue now makes available, and anybody not told yet. */
  const checkAddonShips: JobHandler = async (ctx) => {
    const { shipped, unannounced } = await asWorker(ctx.db, {}, async (tx) => {
      const [overrides, picks] = await Promise.all([loadOverrides(tx), loadPicks(tx)]);
      const stage = (id: string) => pickStageOf(catalog, overrides, id);
      const nowShipped = picks
        .filter((p) => !p.shippedAt && stage(p.addonId) === 'shipped')
        .map((p) => p.addonId);
      if (nowShipped.length)
        await rows(
          tx,
          sql`update platform.addon_picks set shipped_at = now()
              where addon_id = any(${addonIdArray(nowShipped)}::text[]) and shipped_at is null`,
        );
      return {
        shipped: picks
          .filter((p) => (p.shippedAt || nowShipped.includes(p.addonId)) && !p.shippedToldAt)
          .map((p) => p.addonId),
        unannounced: picks
          .filter((p) => !p.votersToldAt && stage(p.addonId) === 'coming_soon')
          .map((p) => p.addonId),
      };
    });
    for (const id of unannounced) await tellVoters(ctx, id, 'picked');
    for (const id of shipped) await tellVoters(ctx, id, 'shipped');
    return { rescheduleAt: new Date(ctx.now + HOUR) };
  };

  /** The team chose a week's pick (addon_pick.choose): its voters hear it's coming soon. */
  const onAddonPicked: EventHandler = async (ctx) => {
    const { addonId } = ctx.event.payload as { addonId?: string };
    if (addonId) await tellVoters(ctx, addonId, 'picked');
  };

  return {
    tellVoters,
    jobs: {
      [ROADMAP_JOBS.week]: closeAddonWeek,
      [ROADMAP_JOBS.shipCheck]: checkAddonShips,
    },
    handlers: {
      'platform.addon_picked': [onAddonPicked],
    },
  };
}

const real = addonRoadmapWorker(ADDON_CATALOG);
export const tellAddonVoters = real.tellVoters;
export const roadmapJobs = real.jobs;
export const roadmapHandlers = real.handlers;
