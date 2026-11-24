import { useQuery } from '@powersync/react-native';
import { renderHook } from '@testing-library/react-native';
import * as React from 'react';

import { BusinessProvider } from '@/components/shell/business-context';
import type { Me } from '@/lib/businesses';

import { COMPANIES_SQL, LEADS_SQL, MEMBERS_SQL, NOTES_SQL, PEOPLE_SQL } from '../queries';
import { useCustomerSearch } from '../use-customers';

/**
 * The Contacts search on the phone (the speed audit, Nov 2026): it reads nothing until it's turned on, where it kept
 * a second copy of every customer, company, lead and name, and every note's words, under a search box that is empty
 * most of the time; and once on, it doesn't call anything unmatched before its rows have come.
 */

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Porter' },
  businesses: [
    {
      id: LONE_STAR,
      name: 'Lone Star HVAC & Roofing',
      organizationId: 'org',
      organizationName: 'Lone Star HVAC & Roofing',
      role: 'owner',
      timezone: 'America/Chicago',
    },
  ],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
};
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <BusinessProvider
    value={{ userId: DALE, me, business: me.businesses[0]!, openSwitcher: () => undefined }}
  >
    {children}
  </BusinessProvider>
);

// A customer as both of the search's reads of them answer: the whole row, and the name book's `a` and `b`.
const person = (id: string, first: string, last: string) => ({
  id,
  workspace_id: LONE_STAR,
  first_name: first,
  last_name: last,
  a: first,
  b: last,
});
const PEOPLE = [person('p-dana', 'Dana', 'Reyes'), person('p-greg', 'Greg', 'Lyons')];
const NOTES = [
  { id: 'n-1', person_id: 'p-greg', company_id: null, lead_id: null, body: 'Has a dog' },
];

/** The copy as it answers: this business's rows, and none for no business. `fetching` holds the people back. */
function copy({ fetching = false } = {}) {
  jest.mocked(useQuery).mockImplementation(((sql: string, params: unknown[] = []) => {
    const here = params[0] === LONE_STAR;
    const people = sql === PEOPLE_SQL || sql.includes('FROM people');
    return {
      data: !here || (people && fetching) ? [] : people ? PEOPLE : sql === NOTES_SQL ? NOTES : [],
      isLoading: false,
      isFetching: here && people && fetching,
    };
  }) as never);
}

/** Which business each of the search's own reads asked for; who works here is read either way. */
const asked = () =>
  jest
    .mocked(useQuery)
    .mock.calls.filter(([sql]) => sql !== MEMBERS_SQL)
    .map(([, params]) => params?.[0]);

beforeEach(() => jest.mocked(useQuery).mockClear());

describe('the Contacts search', () => {
  it('reads nothing while it’s off', async () => {
    copy();
    const { result } = await renderHook(() => useCustomerSearch('', false), { wrapper });
    for (const sql of [PEOPLE_SQL, COMPANIES_SQL, LEADS_SQL, NOTES_SQL])
      expect(jest.mocked(useQuery)).toHaveBeenCalledWith(sql, ['']);
    expect(asked().every((business) => business === '')).toBe(true);
    expect(result.current).toEqual({ hits: [], loading: false });
  });

  it('finds by name and by a word in a note once it’s on', async () => {
    copy();
    const { result, rerender } = await renderHook(
      ({ typed, when }: { typed: string; when: boolean }) => useCustomerSearch(typed, when),
      { wrapper, initialProps: { typed: '', when: false } },
    );
    await rerender({ typed: 'dana', when: true });
    expect(asked().at(-1)).toBe(LONE_STAR);
    expect(result.current.loading).toBe(false);
    expect(result.current.hits.map((h) => [h.id, h.inNote])).toEqual([['p-dana', false]]);
    await rerender({ typed: 'dog', when: true });
    expect(result.current.hits.map((h) => [h.id, h.title, h.inNote])).toEqual([
      ['p-greg', 'Greg Lyons', true],
    ]);
  });

  it('says it’s still reading until its rows have come, and not again for a later re-read', async () => {
    copy({ fetching: true });
    const { result, rerender } = await renderHook(
      ({ typed, when }: { typed: string; when: boolean }) => useCustomerSearch(typed, when),
      { wrapper, initialProps: { typed: '', when: false } },
    );
    await rerender({ typed: 'dana', when: true });
    expect(result.current).toEqual({ hits: [], loading: true });
    copy();
    await rerender({ typed: 'dana', when: true });
    expect(result.current.loading).toBe(false);
    expect(result.current.hits).toHaveLength(1);
    // A customer syncs in and the copy reads again: what was found stays said.
    copy({ fetching: true });
    await rerender({ typed: 'dana', when: true });
    expect(result.current.loading).toBe(false);
    // Off again (the box was emptied), and on: it waits for its rows once more.
    await rerender({ typed: '', when: false });
    await rerender({ typed: 'dana', when: true });
    expect(result.current.loading).toBe(true);
  });
});
