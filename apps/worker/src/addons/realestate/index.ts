/**
 * Real Estate Agent in the worker (docs/addon-architecture.md): what it does when something happens in a business, its own
 * jobs, and what it does as it arrives, turns on or off and leaves. The worker hands it work only while it's on,
 * and everything it does through the kernel (with `ctx.actor`) is refused the moment it's turned off.
 *
 * Every hook must be safe to run again: a hook that throws is retried, and the move isn't finished until it
 * succeeds. Declare in the manifest what's here: `events.consumes` for each subscriber, `jobs` for each job,
 * `resources` for what it makes at a provider (and then `releaseResource`).
 *
 * - **A changed wire** (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Wire changes"): reported on a deal, it
 *   raises a critical alert at once, for everyone who sees the deal, at any hour, asking to be acknowledged; the
 *   phone check finishing (done, waived or cancelled) clears it.
 */
import { WIRE_CHECK_KEY } from '@hfos/core/addons/realestate/own-duties';
import { catalogAddon } from '@hfos/core/server';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import type { AddonEventContext, AddonWorkerModule } from '../types';

const payloadOf = (ctx: AddonEventContext) => (ctx.event.payload ?? {}) as Record<string, unknown>;

/** The alert a wire check keeps up, by its duty. */
export const wireAlertKey = (dutyId: string) => `wire:${dutyId}`;

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
  if (p['dutyKey'] !== WIRE_CHECK_KEY || typeof p['dutyId'] !== 'string') return;
  await clearAddonAlert(ctx, wireAlertKey(p['dutyId']), 'done');
}

export const realestateAddonWorker: AddonWorkerModule = {
  manifest: catalogAddon('realestate'),
  subscribers: {
    'realestate.deal.wire_change_reported': wireChangeReported,
    'realestate.duty.completed': dutyFinished,
    'realestate.duty.waived': dutyFinished,
    'realestate.duty.cancelled': dutyFinished,
  },
  // onEnable: arm recurring jobs with scheduleAddonJob, from now: nothing that came due while it was off runs late.
};
