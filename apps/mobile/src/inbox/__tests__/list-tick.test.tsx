import { useQuery } from '@powersync/react-native';
import { act, renderHook } from '@testing-library/react-native';
import * as React from 'react';

import { BusinessProvider } from '@/components/shell/business-context';
import type { Me } from '@/lib/businesses';

import { CONVERSATIONS_SQL } from '../queries';
import { useInboxList } from '../use-inbox';

/**
 * The Inbox's clock (the speed audit, Nov 2026). Every 30 seconds the list re-reads the time, for who has waited too
 * long. That used to group, filter and sort every conversation again, and hand the screen a new list each time,
 * though none of that reads the clock. Now only the counts move with it.
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

const NOW = Date.parse('2026-11-24T18:00:00.000Z');
/** Kim wrote 9 minutes 50 seconds ago and nobody has answered: ten minutes is too long. */
const ROWS = [
  {
    id: 'c-kim',
    channel: 'sms',
    status: 'open',
    folder: 'inbox',
    private_to: null,
    counterpart: '+17135550101',
    person_id: 'p-kim',
    first_name: 'Kim',
    last_name: 'Alvarez',
    assignee_user_id: null,
    unread_count: 1,
    last_direction: 'inbound',
    last_message_at: new Date(NOW - 590_000).toISOString(),
    last_preview: 'Are you still coming today?',
    awaiting_reply_since: new Date(NOW - 590_000).toISOString(),
    snoozed_until: null,
    created_at: '2026-01-01T12:00:00.000Z',
    handled_by: 'none',
    draft_waiting: 0,
  },
];
// The copy hands back the same rows until one changes, as PowerSync's own does.
const NONE: never[] = [];
const FILTER = { box: 'all', status: 'open' } as const;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.mocked(useQuery).mockImplementation(((sql: string) => ({
    data: sql === CONVERSATIONS_SQL ? ROWS : NONE,
    isLoading: false,
    isFetching: false,
  })) as never);
});
afterEach(() => jest.useRealTimers());

describe('the Inbox list as the clock moves on', () => {
  it('counts who has waited too long, and leaves the rows as they were', async () => {
    const { result } = await renderHook(() => useInboxList(FILTER), { wrapper });
    const before = result.current;
    expect(before.items.map((i) => i.conversation.id)).toEqual(['c-kim']);
    expect(before.counts.waiting).toBe(0);
    await act(async () => jest.advanceTimersByTime(30_000));
    expect(result.current.counts.waiting).toBe(1);
    // The very same list: the screen has no rows to lay out again.
    expect(result.current.items).toBe(before.items);
  });
});
