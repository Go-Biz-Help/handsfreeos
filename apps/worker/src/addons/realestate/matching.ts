/**
 * Our listings suggested to our buyers (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing core",
 * step 11): the worker runs `realestate.match.run` when a listing goes live, its price changes or a suggestion is
 * decided (for that listing), and when a buyer's profile is saved (for that buyer). The buyer's agents hear about each
 * new suggestion.
 */
import { matchRun } from '@hfos/core/addons/realestate/ops/matching';
import { executeCommand } from '@hfos/core/server';
import { raiseAddonAlert } from '../alerts';
import type { AddonEventContext } from '../types';

const run = (ctx: AddonEventContext, input: { listingDealId?: string; buyerDealId?: string }) =>
  executeCommand(
    ctx.db,
    matchRun,
    { workspaceId: ctx.scope.workspaceId, ...input },
    ctx.actor,
    ctx.meta,
  );

/** A listing live on the MLS, or at a new price: matched again against every buyer still looking. */
export async function matchListing(ctx: AddonEventContext): Promise<void> {
  if (ctx.event.entityId) await run(ctx, { listingDealId: ctx.event.entityId });
}

/** A suggestion added or set aside: its listing's counts again. */
export async function suggestionDecided(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  if (typeof p['listingDealId'] === 'string') await run(ctx, { listingDealId: p['listingDealId'] });
}

/** A buyer's profile saved: every live listing matched against it. */
export async function matchBuyer(ctx: AddonEventContext): Promise<void> {
  if (ctx.event.entityId) await run(ctx, { buyerDealId: ctx.event.entityId });
}

/** New suggestions on a buyer's deal: its agents hear, once per deal and run. */
export async function listingSuggested(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const dealId = ctx.event.entityId;
  const streets = Array.isArray(p['streets']) ? (p['streets'] as string[]) : [];
  if (!dealId || !streets.length) return;
  const owner = typeof p['ownerUserId'] === 'string' ? p['ownerUserId'] : null;
  const team = Array.isArray(p['teamUserIds']) ? (p['teamUserIds'] as string[]) : [];
  const name = typeof p['dealName'] === 'string' ? p['dealName'] : 'a buyer';
  await raiseAddonAlert(ctx, {
    key: `suggested:${dealId}:${String(ctx.event.id)}`,
    severity: 'info',
    title: (streets.length === 1
      ? `Our listing at ${streets[0]} fits ${name}`
      : `${streets.length} of our listings fit ${name}`
    ).slice(0, 200),
    detail: 'Add it to their homes, or set it aside, on the deal’s homes.',
    href: `/a/realestate/deals/${dealId}/homes`,
    permission: 'realestate.use',
    customRecordId: dealId,
    audienceUserIds: [...new Set([...(owner ? [owner] : []), ...team])],
    assigneeUserId: owner,
  });
}
