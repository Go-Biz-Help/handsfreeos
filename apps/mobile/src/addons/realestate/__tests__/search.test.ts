import { searchProbes, whyLabel } from '@hfos/core';
import { dealSearchLine, RE_SEARCH_WORDS } from '@hfos/core/addons/realestate/search-words';

import { dealHits, RE_DEALS_KIND } from '../search';

import { dealItem, OKAFOR, SMITH, WS } from './deal-fixtures';

/**
 * Real Estate's deals in the phone's own search, with no signal (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, decision
 * 11): found by name, client or address from the Deals screen's own list, and said as the server's
 * `realestate.search` says them (its line, "Client", "Address"), so a row reads the same when the server's answer
 * takes its place.
 */
describe('Real Estate’s deals offline', () => {
  const deals = [
    dealItem(),
    dealItem({
      dealId: OKAFOR,
      name: 'Okafor purchase',
      side: 'listing',
      stage: 'active',
      stageLabel: 'Active',
      client: { personId: OKAFOR, name: 'Grace Okafor' },
      property: { propertyId: OKAFOR, address: '418 Magnolia St' },
    }),
    dealItem({ dealId: WS, name: 'Old Smith deal', archived: true }),
  ];
  const find = (q: string) => dealHits(deals, searchProbes(q), WS);

  it('finds a deal by its name, with the server’s line and no chip', () => {
    const [smith] = find('smith purchase');
    expect(smith).toMatchObject({
      kind: RE_DEALS_KIND,
      id: SMITH,
      title: 'Smith purchase',
      subtitle: dealSearchLine('buyer', 'inspection'),
      href: `/app/w/${WS}/a/realestate/deals/${SMITH}`,
    });
    expect(whyLabel(smith!.why, smith!.kind)).toBeNull();
  });

  it('says a deal found by its client “Client” and by its home “Address”, as the server does', () => {
    const [byClient] = find('grace');
    expect(byClient).toMatchObject({ id: OKAFOR, why: { field: 'addon' } });
    expect(whyLabel(byClient!.why, byClient!.kind)).toBe(RE_SEARCH_WORDS.client);
    expect(byClient!.why.snippet).toEqual({ text: 'Grace Okafor', marks: [[0, 5]] });
    const [byAddress] = find('magnolia');
    expect(whyLabel(byAddress!.why, byAddress!.kind)).toBe('Address');
    expect(byAddress!.subtitle).toBe(dealSearchLine('listing', 'active'));
  });

  it('leaves archived deals out, as nothing archived shows offline', () => {
    expect(find('old smith')).toEqual([]);
  });
});
