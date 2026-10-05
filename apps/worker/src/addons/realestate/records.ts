/**
 * Keeping a deal's records (round six, 20261022000200 and 20261022000500): each deal's retention hold, and whether
 * phones keep it.
 *
 * - **Retention** (Chris, 2026-10-03): an open deal is kept with no end; once it ends, until its end date plus the
 *   years the business keeps closed deals (Deal settings → Keeping records, 7 by default). Nothing is ever deleted
 *   on its own; while a hold lasts, core refuses to delete the add-on's data.
 * - **Phones** keep open deals and those that ended in the last 90 days (round six's choice, open to change).
 *
 * A deal opening, ending or reopening sets both at once; a daily pass sets every deal again, so a deal crossing 90
 * days leaves phones and a changed setting reaches every hold.
 */
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';

export const RECORDS_PASS = 'realestate.records_pass';
/** How long phones keep a deal after it ends. */
const PHONE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_YEARS = 7;

type DealRow = {
  record_id: string;
  outcome: string | null;
  outcome_at: Date | string | null;
};

async function keepYears(ctx: AddonScopeContext): Promise<number> {
  const [s] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ years: string | null }>(
      tx,
      sql`select settings ->> 'keepClosedYears' as years from app.addon_installations
          where workspace_id = ${ctx.scope.workspaceId} and addon_id = ${ctx.manifest.id}`,
    ),
  );
  const years = Number(s?.years ?? DEFAULT_YEARS);
  return Number.isInteger(years) && years >= 1 && years <= 30 ? years : DEFAULT_YEARS;
}

/** One deal's hold and phone window, from whether it's open and when it ended. */
async function keep(ctx: AddonScopeContext, deals: readonly DealRow[], years: number, now: number) {
  if (!deals.length) return;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    for (const d of deals) {
      const open = !d.outcome;
      const ended = d.outcome_at ? new Date(d.outcome_at) : null;
      const until = ended ? new Date(ended.getTime()) : null;
      if (until) until.setUTCFullYear(until.getUTCFullYear() + years);
      await rows(
        tx,
        sql`select private.set_retention_hold(${ctx.scope.workspaceId}::uuid, ${d.record_id}::uuid, ${open},
              ${open ? null : (until ?? new Date(now)).toISOString()}::timestamptz)`,
      );
      const onPhones = open || !ended || now - ended.getTime() < PHONE_DAYS * DAY_MS;
      await rows(
        tx,
        sql`select private.record_phone_window(${ctx.scope.workspaceId}::uuid, ${d.record_id}::uuid, ${onPhones})`,
      );
    }
  });
}

/** A deal opened, ended or reopened: its hold and phone window now. */
export async function dealKept(ctx: AddonEventContext): Promise<void> {
  const id = ctx.event.entityId;
  if (!id) return;
  const deals = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<DealRow>(
      tx,
      sql`select record_id, outcome, outcome_at from addon_realestate.deals
          where record_id = ${id}::uuid and workspace_id = ${ctx.scope.workspaceId}::uuid`,
    ),
  );
  await keep(ctx, deals, await keepYears(ctx), Date.now());
}

/** The business changed how long it keeps closed deals: the pass runs now, not tonight. */
export async function settingsSaved(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  if (p['addonId'] !== undefined && p['addonId'] !== ctx.manifest.id) return;
  await armRecordsPass(ctx, Date.now());
}

/** Every deal again, once a day. */
export async function recordsPassJob(ctx: AddonJobContext): Promise<JobResult> {
  const deals = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<DealRow>(
      tx,
      sql`select record_id, outcome, outcome_at from addon_realestate.deals
          where workspace_id = ${ctx.scope.workspaceId}::uuid`,
    ),
  );
  await keep(ctx, deals, await keepYears(ctx), ctx.now);
  return { rescheduleAt: new Date(ctx.now + DAY_MS) };
}

export async function armRecordsPass(
  ctx: AddonScopeContext,
  at: number = Date.now(),
): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: RECORDS_PASS,
        dedupeKey: `${RECORDS_PASS}:${ctx.scope.workspaceId}`,
        runAt: new Date(at),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}
