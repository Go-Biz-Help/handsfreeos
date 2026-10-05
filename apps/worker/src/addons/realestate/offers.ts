/**
 * The offer clock in the worker (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): each
 * version of an offer with a time it must be answered by gets three moments, two hours before, at the deadline and an
 * hour after, each an alert on the deal's main agent's Home and phone while nobody has recorded an answer or a newer
 * version (`realestate.offer_clock`). An answer, or a newer version, clears it. Turning the add-on off cancels the
 * clock with the rest of its work; turning it on again arms what's still ahead.
 */
import { fmtTime } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';

export const OFFER_CLOCK = 'realestate.offer_clock';
const HOUR = 60 * 60_000;
const MOMENTS = [
  { key: 'soon', offset: -2 * HOUR },
  { key: 'due', offset: 0 },
  { key: 'passed', offset: HOUR },
] as const;
type Moment = (typeof MOMENTS)[number]['key'];

export const offerAlertKey = (offerId: string) => `offer:${offerId}`;
export const offerClockKey = (versionId: string, moment: Moment) =>
  `${OFFER_CLOCK}:${versionId}:${moment}`;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The moments still ahead for one version. */
async function armClock(
  ctx: AddonScopeContext,
  tx: Tx,
  offerId: string,
  versionId: string,
  respondBy: Date,
): Promise<void> {
  const now = Date.now();
  for (const m of MOMENTS) {
    const at = respondBy.getTime() + m.offset;
    if (at <= now) continue;
    await scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: OFFER_CLOCK,
        dedupeKey: offerClockKey(versionId, m.key),
        runAt: new Date(at),
        payload: { offerId, versionId, moment: m.key },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    );
  }
}

/** `realestate.offer.version_added`: the last version's alert goes, and this one's clock starts. */
export async function offerVersionAdded(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const offerId = str(p['offerId']);
  const versionId = str(p['versionId']);
  if (!offerId || !versionId) return;
  await clearAddonAlert(ctx, offerAlertKey(offerId), 'done');
  const respondBy = str(p['respondBy']);
  if (respondBy)
    await asWorker(ctx.db, ctx.scope, (tx) =>
      armClock(ctx, tx, offerId, versionId, new Date(respondBy)),
    );
}

/** `realestate.offer.answered`: nothing more to watch. */
export async function offerAnswered(ctx: AddonEventContext): Promise<void> {
  const offerId = str(((ctx.event.payload ?? {}) as Record<string, unknown>)['offerId']);
  if (offerId) await clearAddonAlert(ctx, offerAlertKey(offerId), 'done');
}

/** `realestate.offer_clock`: one moment of a version's deadline, if it's still the one waiting. */
export async function offerClockJob(ctx: AddonJobContext): Promise<JobResult> {
  const offerId = str(ctx.job.payload['offerId']);
  const versionId = str(ctx.job.payload['versionId']);
  const moment = str(ctx.job.payload['moment']) as Moment | null;
  if (!offerId || !versionId || !moment) return;
  const [o] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{
      status: string;
      deal: string;
      owner: string | null;
      address: string;
      newest: string;
      side: 'us' | 'them';
      respond_by: Date | string | null;
      tz: string;
    }>(
      tx,
      sql`select o.status, o.deal_record_id as deal, r.owner_user_id as owner, h.address, v.id as newest, v.side,
            v.respond_by, w.timezone as tz
          from addon_realestate.offers o
          join addon_realestate.homes h on h.id = o.home_id
          join app.custom_records r on r.id = o.deal_record_id
          join app.workspaces w on w.id = o.workspace_id
          join lateral (select id, side, respond_by from addon_realestate.offer_versions
                        where offer_id = o.id order by number desc limit 1) v on true
          where o.id = ${offerId}`,
    ),
  );
  if (
    !o ||
    !['waiting_them', 'waiting_us'].includes(o.status) ||
    o.newest !== versionId ||
    !o.respond_by
  )
    return;
  const home = o.address.split(',')[0]!.trim();
  const at = fmtTime(new Date(o.respond_by).getTime(), o.tz || 'America/Chicago');
  const ours = o.side === 'them';
  const title =
    moment === 'soon'
      ? ours
        ? `Your answer to the seller’s counter on ${home} is due at ${at}`
        : `The seller’s answer on ${home} is due at ${at}`
      : moment === 'due'
        ? ours
          ? `Your answer to the seller’s counter on ${home} is due now`
          : `The seller’s answer on ${home} is due now`
        : ours
          ? `The seller’s counter on ${home} passed at ${at} with no answer`
          : `The seller didn’t answer on ${home} by ${at}`;
  await raiseAddonAlert(ctx, {
    key: offerAlertKey(offerId),
    severity: moment === 'soon' ? 'at_risk' : 'critical',
    title: title.slice(0, 200),
    detail:
      moment === 'passed'
        ? 'Record their answer, or mark the offer expired.'
        : ours
          ? 'Counter, accept or decline, and record it on the offer.'
          : 'Record their answer on the offer as soon as it comes in.',
    href: `/a/realestate/deals/${o.deal}/offers/${offerId}`,
    permission: 'realestate.use',
    customRecordId: o.deal,
    assigneeUserId: o.owner,
    dueAt: new Date(o.respond_by),
  });
}

/** Turned on again: every open offer's clock, from now. */
export async function armOfferClocks(ctx: AddonScopeContext): Promise<void> {
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const open = await rows<{ offer: string; version: string; respond_by: Date | string }>(
      tx,
      sql`select o.id as offer, v.id as version, v.respond_by
          from addon_realestate.offers o
          join lateral (select id, respond_by from addon_realestate.offer_versions
                        where offer_id = o.id order by number desc limit 1) v on true
          where o.workspace_id = ${ctx.scope.workspaceId} and o.status in ('waiting_them', 'waiting_us')
            and v.respond_by > now() - interval '1 hour'`,
    );
    for (const x of open) await armClock(ctx, tx, x.offer, x.version, new Date(x.respond_by));
  });
}
