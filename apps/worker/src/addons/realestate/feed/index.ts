/**
 * Real Estate's listing feed (round five, step 3): the one way the add-on's worker half asks a listing supplier
 * anything.
 *
 * - `askFeed(ctx, query)`: asks the business's feed (its own account before HandsFreeOS's, `connectionFor`), and
 *   records whether it worked, so the business sees its health and what it affects. Null when nothing is connected.
 *   A key turned down asks for it again; a supplier that didn't answer counts as a failure and throws for the caller
 *   to try later; a question it can't answer throws FeedUnsupported with words to show.
 * - `listingDataTesters`: the add-on's key testers for Repliers, AnyProp and a direct RESO feed (its worker
 *   module's `connectors`). With the stand-ins (ADDON_CONNECTORS=fake) nothing leaves the worker.
 */
import { FeedSearchSchema, type FeedSearch } from '@hfos/core/addons/realestate/feed';
import {
  ConnectionRefused,
  connectionFor,
  connectionWorked,
  type AddonConnection,
  type ConnectionTester,
} from '../../connections';
import type { AddonScopeContext } from '../../types';
import { anypropFromFields, tryAnypropFields } from './anyprop';
import { createRepliersFeed, tryRepliersKey } from './repliers';
import { forgetToken, resoFromFields, tryResoFields } from './reso';
import { createStandinFeed, tryStandin } from './standin';
import { FeedUnsupported, type FeedFetch, type FeedPage, type ListingFeed } from './types';

export { FeedUnreachable, FeedUnsupported, type FeedPage, type ListingFeed } from './types';
export { putStandinListing, resetStandin } from './standin';

/** The connector the manifest names. */
export const LISTING_DATA = 'listing_data';

/** The feed for one connection: the stand-in in development and tests, else its supplier. */
export function feedOf(
  connection: AddonConnection,
  opts: { readonly fake: boolean; readonly fetch?: FeedFetch },
): ListingFeed {
  if (opts.fake) return createStandinFeed();
  const fetchImpl = opts.fetch ?? fetch;
  switch (connection.provider) {
    case 'repliers':
      return createRepliersFeed({ apiKey: connection.secret['apiKey'] ?? '', fetch: fetchImpl });
    case 'anyprop':
      return anypropFromFields(connection.secret, connection.id, fetchImpl);
    case 'reso':
      return resoFromFields(connection.secret, connection.id, fetchImpl);
    default:
      throw new FeedUnsupported('HandsFreeOS can’t read that listing supplier yet.');
  }
}

export interface FeedAnswer extends FeedPage {
  /** Which account answered: the business's own, or HandsFreeOS's. */
  readonly connection: Pick<AddonConnection, 'id' | 'provider' | 'auth' | 'label'>;
}

/**
 * Asks the business's listing feed. Null when no feed is connected (or HandsFreeOS's own account has no key here).
 * Every answer, or failure, is recorded on the connection.
 */
export async function askFeed(
  ctx: AddonScopeContext,
  query: FeedSearch,
  opts: { readonly fetch?: FeedFetch; readonly signal?: AbortSignal } = {},
): Promise<FeedAnswer | null> {
  const connection = await connectionFor(ctx, LISTING_DATA);
  if (!connection) return null;
  const q = FeedSearchSchema.parse(query);
  const feed = feedOf(connection, { fake: ctx.addonConnect?.fake ?? true, fetch: opts.fetch });
  try {
    const page = await feed.search(q, opts.signal ?? AbortSignal.timeout(60_000));
    await connectionWorked(ctx, connection, { ok: true });
    return {
      ...page,
      connection: {
        id: connection.id,
        provider: connection.provider,
        auth: connection.auth,
        label: connection.label,
      },
    };
  } catch (e) {
    // A question it can't answer isn't the connection failing.
    if (e instanceof FeedUnsupported) throw e;
    const refused = e instanceof ConnectionRefused;
    if (refused) forgetToken(connection.id);
    await connectionWorked(ctx, connection, {
      ok: false,
      refused,
      error: e instanceof Error ? e.message : 'It didn’t answer.',
    });
    throw e;
  }
}

/** The add-on's key testers: the stand-ins in development and tests. */
export function listingDataTesters(
  fetchImpl?: FeedFetch,
): Readonly<Record<string, ConnectionTester>> {
  return {
    repliers: (fields, ctx) =>
      ctx.fake ? tryStandin('Repliers', fields) : tryRepliersKey(fields, ctx.signal, fetchImpl),
    anyprop: (fields, ctx) =>
      ctx.fake ? tryStandin('AnyProp', fields) : tryAnypropFields(fields, ctx.signal, fetchImpl),
    reso: (fields, ctx) =>
      ctx.fake ? tryStandin('RESO', fields) : tryResoFields(fields, ctx.signal, fetchImpl),
  };
}
