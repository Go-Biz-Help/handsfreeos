/**
 * Real Estate Agent in the worker (docs/addon-architecture.md): what it does when something happens in a business, its own
 * jobs, and what it does as it arrives, turns on or off and leaves. The worker hands it work only while it's on,
 * and everything it does through the kernel (with `ctx.actor`) is refused the moment it's turned off.
 *
 * Every hook must be safe to run again: a hook that throws is retried, and the move isn't finished until it
 * succeeds. Declare in the manifest what's here: `events.consumes` for each subscriber, `jobs` for each job,
 * `resources` for what it makes at a provider (and then `releaseResource`).
 *
 * - **The sweep** (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Health and alerts"): every fifteen minutes while
 *   it's on, the add-on's own command works each open deal out again and says where each duty is on the ladder;
 *   this raises one alert per duty that climbs as it goes, and clears the rest. Turned back on, it's armed from
 *   then: a rung reached while it was off becomes a Home card, never a late push or email. An acknowledged alert
 *   stops climbing.
 * - **A changed wire:** reported on a deal, it raises a critical alert at once, for everyone who sees the deal, at
 *   any hour, asking to be acknowledged; the phone check finishing (done, waived or cancelled) clears it.
 */
import { ladderAlert, rungSince, SEVERITY_RANK } from '@hfos/core/addons/realestate/ladder';
import { sweep } from '@hfos/core/addons/realestate/ops/health';
import { WIRE_CHECK_KEY } from '@hfos/core/addons/realestate/own-duties';
import { catalogAddon, executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type {
  AddonEventContext,
  AddonJobContext,
  AddonScopeContext,
  AddonWorkerModule,
} from '../types';

const SWEEP = 'realestate.sweep';
const EVERY = 15 * 60_000;

const payloadOf = (ctx: AddonEventContext) => (ctx.event.payload ?? {}) as Record<string, unknown>;

/** The alert a wire check keeps up, by its duty. */
export const wireAlertKey = (dutyId: string) => `wire:${dutyId}`;
/** The alert a duty's ladder keeps up. */
export const dutyAlertKey = (dutyId: string) => `duty:${dutyId}`;

async function wireChangeReported(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const dutyId = typeof p['dutyId'] === 'string' ? p['dutyId'] : null;
  const dealId = ctx.event.entityId;
  if (!dutyId || !dealId) return;
  const name = typeof p['name'] === 'string' ? p['name'] : 'a deal';
  await raiseAddonAlert(ctx, {
    key: wireAlertKey(dutyId),
    severity: 'critical',
    title: `Wiring instructions changed on ${name}`.slice(0, 200),
    detail:
      'Hold every payment. Call the title or escrow company at a number you found yourself, not one in the message, before anyone sends money.',
    href: `/a/realestate/deals/${dealId}`,
    permission: 'realestate.use',
    customRecordId: dealId,
    assigneeUserId: typeof p['ownerUserId'] === 'string' ? p['ownerUserId'] : null,
    needsAck: true,
  });
}

async function dutyFinished(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  if (typeof p['dutyId'] !== 'string') return;
  if (p['dutyKey'] === WIRE_CHECK_KEY)
    await clearAddonAlert(ctx, wireAlertKey(p['dutyId']), 'done');
  // Its ladder's card goes now, not at the next sweep.
  else await clearAddonAlert(ctx, dutyAlertKey(p['dutyId']), 'done');
}

/** Arms the sweep from now. */
async function armSweep(ctx: AddonScopeContext): Promise<void> {
  const now = Date.now();
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: SWEEP,
        dedupeKey: `${SWEEP}:${ctx.scope.workspaceId}`,
        runAt: new Date(now),
        payload: { armedAt: now },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

/** `realestate.sweep`: every open deal worked out again, and each duty's alert where the ladder says. */
async function runSweep(ctx: AddonJobContext): Promise<JobResult> {
  const armedAt = Number(ctx.job.payload['armedAt'] ?? 0);
  const { output } = await executeCommand(
    ctx.db,
    sweep,
    { workspaceId: ctx.scope.workspaceId },
    ctx.actor,
    ctx.meta,
  );
  const current = new Map(
    (
      await asWorker(ctx.db, ctx.scope, (tx) =>
        rows<{ key: string; severity: keyof typeof SEVERITY_RANK; acknowledged: boolean }>(
          tx,
          sql`select key, severity, acknowledged_at is not null as acknowledged from app.addon_alerts
              where workspace_id = ${ctx.scope.workspaceId} and addon_id = ${ctx.manifest.id}
                and key like 'duty:%' and cleared_at is null`,
        ),
      )
    ).map((a) => [a.key, a]),
  );
  const wanted = new Set<string>();
  for (const a of output.alerts) {
    const key = dutyAlertKey(a.dutyId);
    wanted.add(key);
    const duty = { ...a, id: a.dutyId };
    const say = ladderAlert(a.rung, duty);
    const was = current.get(key);
    // Someone said they've seen it: it stops climbing.
    if (was?.acknowledged && SEVERITY_RANK[say.severity] > SEVERITY_RANK[was.severity]) continue;
    const answering = a.accountableUserId ?? a.mainAgentUserId;
    // Critical: the deal's team and the business's alert person (its owners, unless it picked someone).
    const audience =
      say.audience === 'escalated'
        ? [answering, a.mainAgentUserId, ...a.coordinatorUserIds, ...output.alertPersonUserIds]
        : say.audience === 'team'
          ? [answering, a.mainAgentUserId, ...a.coordinatorUserIds]
          : [answering];
    // A rung reached before the add-on was last turned on is caught up as a Home card only.
    const quiet = rungSince(a.rung, duty) < armedAt;
    await raiseAddonAlert(ctx, {
      key,
      severity: say.severity,
      title: say.title.slice(0, 200),
      detail: `${a.dealName}.`,
      href: `/a/realestate/deals/${a.dealId}`,
      permission: 'realestate.use',
      customRecordId: a.dealId,
      audienceUserIds: [...new Set(audience.filter((u): u is string => !!u))],
      assigneeUserId: a.accountableUserId,
      dueAt: new Date(a.dueAt),
      needsAck: say.needsAck,
      notify: say.notify && !quiet,
      email: say.email,
    });
  }
  for (const key of current.keys()) if (!wanted.has(key)) await clearAddonAlert(ctx, key, 'done');
  return { rescheduleAt: new Date(ctx.now + EVERY) };
}

export const realestateAddonWorker: AddonWorkerModule = {
  manifest: catalogAddon('realestate'),
  subscribers: {
    'realestate.deal.wire_change_reported': wireChangeReported,
    'realestate.duty.completed': dutyFinished,
    'realestate.duty.waived': dutyFinished,
    'realestate.duty.cancelled': dutyFinished,
  },
  jobs: { [SWEEP]: runSweep },
  onEnable: armSweep,
};
