import {
  addonSearchKindKey,
  copyHit,
  copyHolds,
  localDateOf,
  marksIn,
  searchProbes,
  tierOf,
  whyLabel,
  type CopyGroup,
  type SearchProbes,
} from '@hfos/core';
import { RE_DEALS_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import { dealSearchLine, RE_SEARCH_WORDS } from '@hfos/core/addons/realestate/search-words';
import { dealListOfCopy, type DealListItem } from '@hfos/core/addons/realestate/views/deal-list';
import { realestateCopyOf, type RealestateSource } from '@hfos/core/addons/realestate/views/synced';

import type { CopyDb, PhoneAddonSearch } from '@/search/copy-sql';

import {
  RE_DEALS_SQL,
  RE_LINKS_SQL,
  RE_LIST_ROWS_SQL,
  RE_PEOPLE_SQL,
  RE_RECORD_NAMES_SQL,
  RE_USERS_SQL,
} from './copy';

/**
 * Real Estate's part of the phone's own search, with no signal (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, decision
 * 11): its deals, by name, client or address, from the same copy and core view the Deals screen reads
 * (`dealListOfCopy`), so a deal found here is one the Deals screen shows. Each is a hit in core's shape for
 * `searchCopy`, opening the deal's own screen, with the server's line and chip (`dealSearchLine`, "Client",
 * "Address"), so a row reads the same when the server's answer takes its place. Archived deals aren't shown offline,
 * as nothing archived is.
 */

type Row = Record<string, string | number | null>;

/** The group's kind: the add-on's id, then its own key. */
export const RE_DEALS_KIND = addonSearchKindKey('realestate', 'deals');

/** The kinds this search answers from the copy; Listings, Homes and Properties wait for signal. */
export const RE_COPY_KINDS: readonly string[] = [RE_DEALS_KIND];

/** The deals that match, as hits, from the Deals screen's own list. */
export function dealHits(
  deals: readonly DealListItem[],
  p: SearchProbes,
  workspaceId: string,
): CopyGroup['hits'] {
  return deals.flatMap((d) => {
    if (d.archived) return [];
    const client = d.client?.name ?? null;
    const address = d.property?.address ?? null;
    const tier = tierOf(d.name, p);
    // As `realestate.search` says it: the client's name under "Client", the home's address under "Address".
    const why =
      tier !== null
        ? { field: 'name', label: null, text: null }
        : copyHolds([client], p)
          ? { field: 'addon', label: RE_SEARCH_WORDS.client, text: client }
          : copyHolds([address], p)
            ? { field: 'addon', label: whyLabel({ field: 'address' }), text: address }
            : null;
    if (!why) return [];
    return [
      copyHit({
        kind: RE_DEALS_KIND,
        id: d.dealId,
        title: d.name,
        subtitle: dealSearchLine(d.side, d.stage),
        href: `/app/w/${workspaceId}/a/realestate/deals/${d.dealId}`,
        tier: tier ?? 3,
        why: {
          field: why.field,
          label: why.label,
          snippet: why.text ? { text: why.text, marks: marksIn(why.text, p) } : null,
          page: null,
        },
        // A deal that ended keeps its place after the open ones, as finished things do (decision 25).
        badges: d.outcome === 'closed' ? ['won'] : d.outcome ? ['lost'] : [],
        at: d.updatedAt,
      }),
    ];
  });
}

export async function searchRealestateCopy(
  db: CopyDb,
  ask: PhoneAddonSearch,
): Promise<readonly CopyGroup[]> {
  const p = searchProbes(ask.q);
  if (p.tooShort || p.folded.length === 0) return [];
  const records = await db.getAll<Row>(RE_DEALS_SQL, [ask.workspaceId]);
  if (records.length === 0) return [];
  const rows = await db.getAll<Row>(RE_LIST_ROWS_SQL, [ask.workspaceId]);
  const links = await db.getAll<Row>(RE_LINKS_SQL, [ask.workspaceId]);
  const people = await db.getAll<Row>(RE_PEOPLE_SQL, [ask.workspaceId]);
  const users = await db.getAll<Row>(RE_USERS_SQL, []);
  const recordNames = await db.getAll<Row>(RE_RECORD_NAMES_SQL, [ask.workspaceId]);
  const copy = realestateCopyOf({
    records,
    rows,
    links,
    people,
    users,
    recordNames,
  } as unknown as RealestateSource);
  const deals = dealListOfCopy(
    copy,
    { status: 'all', limit: 500 },
    { userId: ask.userId, now: ask.now, today: localDateOf(ask.now, ask.timeZone) },
  );
  const hits = dealHits(deals, p, ask.workspaceId);
  return hits.length
    ? [{ kind: RE_DEALS_KIND, label: RE_DEALS_WORDS.title, icon: 'key', hits }]
    : [];
}
