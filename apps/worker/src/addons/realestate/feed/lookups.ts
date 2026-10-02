/**
 * Real Estate's listing feed at work (round five, step 4): a buyer's home and our own listing looked up on the MLS,
 * and homes sold near a CMA's home found as comps. Core's commands say what's asked and keep what's found
 * (ops/feed.ts); this asks the feed and hands back what it said.
 *
 * - **Finding a home.** By its MLS number when there is one, else by its address (its number and ZIP, then its
 *   street matched here). Of the listings at that address, the one for sale or pending before an older sale.
 * - **Comps.** Sold in the months asked, within the miles asked of the home: where it is comes from the MLS (the
 *   home's own listing), else from looking it up, else from the address's ZIP. Similar homes first (the same kind,
 *   within a fifth of its size); nearest first.
 * - **Trouble.** No feed connected puts it back as it was. A supplier that didn't answer is tried again twice; after
 *   that, and for a refused key or a question it can't answer, the words say what to do.
 */
import {
  cmaCompsFound,
  homeMlsFound,
  listingMlsFound,
} from '@hfos/core/addons/realestate/ops/feed';
import { addressKey, HOME_TYPE_KEYS } from '@hfos/core/addons/realestate/homes';
import {
  addressParts,
  type FeedListing,
  type FeedSearch,
  type FeedStatus,
  type MlsSnapshot,
} from '@hfos/core/addons/realestate/feed';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { ConnectionRefused } from '../../connections';
import type { AddonEventContext } from '../../types';
import { askFeed, FeedUnsupported } from './index';
import { milesBetween } from './reso';

const ALL: FeedStatus[] = ['coming_soon', 'active', 'pending', 'sold', 'off_market'];
/** Which listing at an address is the one meant: for sale before pending before sold before gone. */
const RANK: Record<FeedStatus, number> = {
  active: 0,
  coming_soon: 1,
  pending: 2,
  sold: 3,
  off_market: 4,
};

const payloadOf = (ctx: AddonEventContext) => (ctx.event.payload ?? {}) as Record<string, unknown>;
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

const snapshot = (l: FeedListing): MlsSnapshot => ({ ...l, checkedAt: new Date().toISOString() });

/** Why the feed couldn't be asked, in words a person can act on; null to try again. */
function troubleWords(e: unknown, attempt: number): string | null {
  if (e instanceof ConnectionRefused)
    return 'The listing feed turned its key down. Someone who runs the deal settings can connect it again under Connections.';
  if (e instanceof FeedUnsupported) return e.message.slice(0, 500);
  if (attempt < 3) return null;
  return 'The listing feed didn’t answer. Try looking it up again in a few minutes.';
}

/** The listing at an address, or by its MLS number; null when the MLS has none. */
export async function findListing(
  ctx: AddonEventContext,
  by: { readonly mlsNumber: string | null; readonly address: string | null },
): Promise<{ readonly found: FeedListing | null } | null> {
  const query: FeedSearch = by.mlsNumber
    ? { statuses: ALL, mlsNumbers: [by.mlsNumber], limit: 5 }
    : { statuses: ALL, address: by.address!, limit: 20 };
  const answer = await askFeed(ctx, query);
  if (!answer) return null;
  const want = by.address ? addressParts(by.address) : null;
  const wantUnit = by.address
    ? /(?:#|\bunit\b|\bapt\.?\b|\bsuite\b)\s*([a-z0-9-]+)/i.exec(by.address)?.[1]
    : null;
  const candidates = answer.listings
    .filter((l) => {
      if (by.mlsNumber) return l.mlsNumber.toLowerCase() === by.mlsNumber.toLowerCase();
      const line = addressKey(l.address.line);
      if (want?.number && !line.startsWith(`${want.number.toLowerCase()} `)) return false;
      if (want?.street && !line.includes(addressKey(want.street))) return false;
      if (wantUnit && l.address.unit && l.address.unit.toLowerCase() !== wantUnit.toLowerCase())
        return false;
      return true;
    })
    .sort(
      (a, b) =>
        RANK[a.status] - RANK[b.status] || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    );
  return { found: candidates[0] ?? null };
}

/** `realestate.home.added` (when a feed is connected) and `realestate.home.lookup_requested`. */
export async function homeLookup(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const homeId = text(p['homeId']);
  if (!homeId) return;
  if (ctx.event.eventType === 'realestate.home.added' && p['lookup'] !== true) return;
  const [home] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ address: string; mls_state: string }>(
      tx,
      sql`select address, mls_state from addon_realestate.homes where id = ${homeId}`,
    ),
  );
  if (!home || home.mls_state !== 'looking') return;
  const record = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      homeMlsFound,
      { workspaceId: ctx.scope.workspaceId, homeId, ...input },
      ctx.actor,
      ctx.meta,
    );
  try {
    const result = await findListing(ctx, {
      mlsNumber: text(p['mlsNumber']),
      address: home.address,
    });
    if (!result) await record({ listing: null, noFeed: true });
    else await record({ listing: result.found ? snapshot(result.found) : null });
  } catch (e) {
    const words = troubleWords(e, ctx.attempt);
    if (words === null) throw e;
    await record({ listing: null, failure: words });
  }
}

/** `realestate.listing.lookup_requested`: our own listing on the MLS. */
export async function listingLookup(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const dealId = text(p['dealId']);
  if (!dealId) return;
  const record = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      listingMlsFound,
      { workspaceId: ctx.scope.workspaceId, dealId, ...input },
      ctx.actor,
      ctx.meta,
    );
  try {
    const result = await findListing(ctx, {
      mlsNumber: text(p['mlsNumber']),
      address: text(p['address']),
    });
    if (!result) await record({ listing: null, noFeed: true });
    else await record({ listing: result.found ? snapshot(result.found) : null });
  } catch (e) {
    const words = troubleWords(e, ctx.attempt);
    if (words === null) throw e;
    await record({ listing: null, failure: words });
  }
}

interface CmaRow extends Record<string, unknown> {
  readonly subject_address: string;
  readonly subject_beds: number | null;
  readonly subject_sqft: number | null;
  readonly comps_state: string;
  readonly home_mls: MlsSnapshot | null;
  readonly listing_mls: MlsSnapshot | null;
  readonly home_type: string | null;
}

/** `realestate.cma.comps_requested`: homes sold near the CMA's home. */
export async function compsRequested(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const cmaId = text(p['cmaId']);
  if (!cmaId) return;
  const [cma] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<CmaRow>(
      tx,
      sql`select c.subject_address, c.subject_beds, c.subject_sqft, c.comps_state, h.mls as home_mls,
                 l.mls as listing_mls, coalesce(h.facts ->> 'property_type', l.facts ->> 'property_type') as home_type
          from addon_realestate.cmas c
          left join addon_realestate.homes h on h.workspace_id = c.workspace_id and h.id = c.home_id
          left join addon_realestate.listings l
            on l.workspace_id = c.workspace_id and l.deal_record_id = c.deal_record_id and c.home_id is null
          where c.id = ${cmaId}`,
    ),
  );
  if (!cma || cma.comps_state !== 'finding') return;
  const record = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      cmaCompsFound,
      { workspaceId: ctx.scope.workspaceId, cmaId, comps: [], ...input },
      ctx.actor,
      ctx.meta,
    );
  const miles = Math.min(10, Math.max(0.25, Number(p['miles'] ?? 1)));
  const months = Math.min(24, Math.max(1, Math.round(Number(p['months'] ?? 6))));
  try {
    // Where the home is: its MLS listing, else looking it up, else its ZIP.
    let at = cma.home_mls ?? cma.listing_mls;
    if (!at?.lat) {
      const looked = await findListing(ctx, { mlsNumber: null, address: cma.subject_address });
      if (!looked) return void (await record({ noFeed: true }));
      if (looked.found?.lat) at = snapshot(looked.found);
    }
    const near =
      at?.lat !== null && at?.lat !== undefined && at.lng !== null
        ? { lat: at.lat, lng: at.lng, miles }
        : null;
    const zip = addressParts(cma.subject_address).zip;
    if (!near && !zip)
      return void (await record({
        failure:
          'HandsFreeOS couldn’t tell where the home is from its address. Add its ZIP code to the address, then find comps again.',
      }));
    const sqft = cma.subject_sqft;
    const type = HOME_TYPE_KEYS.find((t) => t === cma.home_type) ?? null;
    const ask = (similar: boolean) =>
      askFeed(ctx, {
        statuses: ['sold'],
        soldWithinDays: months * 30,
        ...(near ? { near } : { zips: [zip!] }),
        ...(similar && sqft
          ? { sqftMin: Math.round(sqft * 0.8), sqftMax: Math.round(sqft * 1.2) }
          : {}),
        ...(similar && type ? { types: [type] } : {}),
        limit: 40,
      });
    let answer = await ask(true);
    if (!answer) return void (await record({ noFeed: true }));
    // Nothing that alike: anything sold there.
    if (!answer.listings.length && (sqft || type)) answer = (await ask(false)) ?? answer;
    const subjectKey = addressKey(cma.subject_address.split(',')[0] ?? cma.subject_address);
    const comps = answer.listings
      .filter((l) => addressKey(l.address.line) !== subjectKey)
      .map((l) => ({
        listing: snapshot(l),
        distanceMiles:
          near && l.lat !== null && l.lng !== null
            ? milesBetween(near, { lat: l.lat, lng: l.lng })
            : null,
      }))
      .sort((a, b) => (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99))
      .slice(0, 40);
    await record({ comps });
  } catch (e) {
    const words = troubleWords(e, ctx.attempt);
    if (words === null) throw e;
    await record({ failure: words });
  }
}
