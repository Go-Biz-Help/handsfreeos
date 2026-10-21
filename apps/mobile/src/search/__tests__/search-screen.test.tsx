import {
  ROLE_PERMISSIONS,
  SEARCH_WORDS,
  type SearchEverythingOutput,
  type SearchGroup,
  type SearchHit,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';

import Search from '@/app/app/w/[workspaceId]/search';
import { BusinessProvider } from '@/components/shell/business-context';
import { api } from '@/lib/api';
import type { Me } from '@/lib/businesses';
import { asOfText } from '@/lib/sync-status';
import type { PhoneView } from '@/view-as/state';

/**
 * The phone's Search everything (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, boards 5 and 5b): HandsFreeOS's answer
 * with signal, drawn as groups under the best match with Call and Text; with no signal, the phone's own copy and the
 * board's line, with the kinds that wait for signal as chips that can't be picked; a request that fails for want of
 * signal falling back to the copy; viewing as someone with no signal, settings alone; and a kind this build doesn't
 * know skipped. HandsFreeOS and the copy are played by stand-ins.
 */

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/',
}));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline, wifi: true, lastOnlineAt: 0 }),
  networkSnapshot: () => ({ online: mockOnline, wifi: true, lastOnlineAt: 0 }),
  subscribeNetwork: () => () => undefined,
  isTestOffline: () => false,
  appFetch: jest.fn(),
}));
const MOCK_AS_OF = Date.parse('2026-10-20T13:58:00.000Z');
jest.mock('@/lib/sync-status', () => ({
  ...jest.requireActual<object>('@/lib/sync-status'),
  useSyncStatus: () => ({ asOf: MOCK_AS_OF, online: false, connection: 'offline', waiting: 0 }),
}));
jest.mock('@/admin/staff', () => ({ useKeptStaff: () => null }));
jest.mock('@/sync/document-keeper', () => ({ useKeepsDocuments: () => false }));
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
jest.mock('@/inbox/calls', () => ({ startCall: jest.fn() }));

const DALE = '11111111-1111-4111-8111-111111111111';
const DANA = '22222222-2222-4222-8222-222222222222';
const DEAL = '33333333-3333-4333-8333-333333333333';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// Real Estate's offline search, played by a stand-in: the registry is the only way search reaches an add-on.
const mockDealSearch = jest.fn();
jest.mock('@/addons/registry', () => ({
  PHONE_ADDONS: [
    {
      addonId: 'realestate',
      permission: 'realestate.use',
      More: () => null,
      search: (...args: unknown[]) => mockDealSearch(...args),
      searchKinds: ['realestate.deals'],
    },
  ],
}));

/** The phone's copy: the rows each read gives back, by what it reads. */
const mockReads: string[] = [];
const mockDb = {
  getAll: jest.fn(async (sql: string) => {
    mockReads.push(sql);
    if (/FROM people p LEFT JOIN companies c/.test(sql))
      return [
        {
          id: DANA,
          first_name: 'Dana',
          last_name: 'Smith',
          email: 'dana.smith@gmail.com',
          phone: '(504) 555-0142',
          phone_e164: '+15045550142',
          phone_alt: null,
          address_line1: '1042 Oak St',
          address_line2: null,
          city: 'Metairie',
          state: 'LA',
          postal_code: null,
          other_emails: null,
          other_phones: null,
          other_addresses: null,
          company_name: null,
          archived_at: null,
          updated_at: '2026-10-19 15:00:00Z',
        },
      ];
    return [];
  }),
  execute: jest.fn(async () => ({ rows: { _array: [] } })),
};
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
  usePowerSync: () => mockDb,
}));

const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [
    {
      id: LONE_STAR,
      name: 'Lone Star HVAC & Roofing',
      organizationId: 'org',
      organizationName: 'Lone Star HVAC & Roofing',
      role: 'owner',
      timezone: 'America/Chicago',
      permissions: [...ROLE_PERMISSIONS.owner, 'realestate.use'],
    },
  ],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
};

const hit = (h: Partial<SearchHit> & Pick<SearchHit, 'kind' | 'id' | 'title'>): SearchHit => ({
  subtitle: null,
  badges: [],
  why: { field: 'name', label: null, snippet: null, page: null },
  tier: 1,
  exact: false,
  at: null,
  href: `/app/w/${LONE_STAR}/customers/people/${h.id}`,
  contact: null,
  amount: null,
  facts: {},
  duplicateOf: null,
  ...h,
});
const group = (kind: string, items: SearchHit[], more: Partial<SearchGroup> = {}): SearchGroup => ({
  kind,
  label: null,
  icon: null,
  total: items.length,
  capped: false,
  complete: true,
  searchedBack: null,
  unavailable: null,
  items,
  ...more,
});
const danaHit = hit({
  kind: 'contacts',
  id: DANA,
  title: 'Dana Smith',
  badges: ['lead'],
  contact: { personId: DANA, phoneE164: '+15045550142', email: 'dana.smith@gmail.com' },
  facts: { phone: '(504) 555-0142' },
});
const answer = (groups: SearchGroup[]): SearchEverythingOutput => ({
  q: 'smith',
  tooShort: false,
  probes: { looksLike: 'words', phoneE164: null, email: null, number: null },
  total: groups.reduce((n, g) => n + g.total, 0),
  capped: false,
  best: danaHit,
  groups,
  archived: null,
  bin: null,
  close: false,
  noneActive: false,
});
const ok = (data: unknown) => ({ data, response: { ok: true, status: 200 } });
const post = api.POST as unknown as jest.Mock;

beforeEach(() => {
  mockParams = { q: 'smith' };
  mockOnline = true;
  mockReads.length = 0;
  mockDb.getAll.mockClear();
  mockDealSearch.mockReset().mockResolvedValue([]);
  post.mockReset();
  jest.mocked(useQuery).mockImplementation((() => ({
    data: [],
    isLoading: false,
    isFetching: false,
  })) as never);
});

const withBusiness = (viewing: PhoneView | null = null) => (
  <BusinessProvider
    value={{
      userId: DALE,
      me,
      business: me.businesses[0]!,
      openSwitcher: () => undefined,
      viewing,
    }}
  >
    <Search />
  </BusinessProvider>
);

describe('Search everything on the phone', () => {
  it('draws HandsFreeOS’s groups under the best match, with Call and Text, from what’s typed in the body', async () => {
    post.mockResolvedValue(
      ok(
        answer([
          group('contacts', [danaHit, hit({ kind: 'contacts', id: DEAL, title: 'Marcus Smith' })]),
          group('messages', [
            hit({
              kind: 'messages',
              id: '44444444-4444-4444-8444-444444444444',
              title: 'Text from Dana Smith',
              tier: 4,
              href: `/app/w/${LONE_STAR}/inbox/44444444-4444-4444-8444-444444444444`,
              why: {
                field: 'message',
                label: null,
                snippet: { text: '…the house on Smith Ave…', marks: [[14, 19]] },
                page: null,
              },
            }),
          ]),
        ]),
      ),
    );
    await render(withBusiness());
    await screen.findByTestId('search-best-row');
    await waitFor(() => expect(screen.queryByTestId('search-on-phone')).toBeNull());
    expect(post).toHaveBeenCalledWith('/v1/queries/search.everything', {
      body: {
        workspaceId: LONE_STAR,
        q: 'smith',
        perKind: 3,
        depth: 'quick',
        settingsMatched: false,
      },
      signal: expect.anything(),
    });
    expect(screen.getByTestId('search-best-row')).toHaveTextContent(/Dana Smith/);
    expect(screen.getByTestId('search-best-call')).toBeTruthy();
    expect(screen.getByTestId('search-best-text')).toBeTruthy();
    // The best match leaves its group: Marcus is the one left under Contacts.
    expect(screen.getByTestId('search-group-contacts')).toHaveTextContent(/Marcus Smith/);
    expect(screen.getByTestId('search-group-contacts')).not.toHaveTextContent(/Dana Smith/);
    expect(screen.getByTestId('search-group-messages')).toHaveTextContent(/the house on Smith Ave/);
    expect(screen.getByTestId('search-chip-all')).toHaveTextContent('All3');
    expect(screen.queryByTestId('search-offline')).toBeNull();
  });

  it('searches the phone’s own copy with no signal, says so as the board does, and greys the kinds that wait', async () => {
    mockOnline = false;
    await render(withBusiness());
    const line = await screen.findByTestId('search-offline');
    expect(line).toHaveTextContent(`${SEARCH_WORDS.offline} ${asOfText(MOCK_AS_OF, Date.now())}`);
    expect(post).not.toHaveBeenCalled();
    expect(await screen.findByTestId('search-best-row')).toHaveTextContent(/Dana Smith/);
    for (const kind of ['money', 'messages', 'files', 'knowledge']) {
      const chip = screen.getByTestId(`search-chip-${kind}`);
      expect(chip.props.accessibilityState).toMatchObject({ disabled: true });
    }
    // Real Estate is asked for its deals, from its own part of the copy.
    expect(mockDealSearch).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ workspaceId: LONE_STAR, q: 'smith' }),
    );
  });

  it('falls back to the copy when a request fails for want of signal', async () => {
    post.mockRejectedValue(new TypeError('Network request failed'));
    mockDealSearch.mockResolvedValue([
      {
        kind: 'realestate.deals',
        label: 'Deals',
        icon: 'key',
        hits: [
          hit({
            kind: 'realestate.deals',
            id: DEAL,
            title: 'Smith Ave listing',
            subtitle: 'Listing · Active',
            href: `/app/w/${LONE_STAR}/a/realestate/deals/${DEAL}`,
          }),
        ],
      },
    ]);
    await render(withBusiness());
    expect(await screen.findByTestId('search-offline')).toHaveTextContent(SEARCH_WORDS.offline, {
      exact: false,
    });
    expect(await screen.findByTestId('search-group-realestate.deals')).toHaveTextContent(
      /Smith Ave listing/,
    );
    expect(screen.getByTestId('search-heading-realestate.deals')).toHaveTextContent(/Deals/i);
  });

  it('searches only settings when viewing as someone with no signal, and says why', async () => {
    mockOnline = false;
    mockParams = { q: 'quiet hours' };
    const view: PhoneView = {
      viewerId: DALE,
      workspaceId: LONE_STAR,
      viewId: '55555555-5555-4555-8555-555555555555',
      by: 'owner' as PhoneView['by'],
      person: {
        userId: DANA,
        fullName: 'Dana',
        email: 'dana@lonestarhvac.test',
        role: 'admin',
        permissions: [...ROLE_PERMISSIONS.admin],
      },
      conversationIds: null,
      attentionItemIds: null,
      estimateIds: null,
      invoiceIds: null,
      fetchedAt: 0,
    };
    await render(withBusiness(view));
    expect(await screen.findByTestId('search-viewing-offline')).toHaveTextContent(
      SEARCH_WORDS.viewingAsOffline('Dana'),
    );
    expect(await screen.findByTestId('search-group-settings')).toHaveTextContent(/Quiet hours/);
    // The copy is the viewer's, not theirs: it isn't read.
    expect(mockDb.getAll).not.toHaveBeenCalled();
  });

  it.each(['future_kind', 'constructor'])(
    'skips a kind this build doesn’t know (“%s”), in the link and in an answer',
    async (unknown) => {
      mockParams = { q: 'smith', kind: unknown };
      post.mockResolvedValue(
        ok(
          answer([
            group('contacts', [danaHit]),
            group('future_kind', [hit({ kind: 'future_kind', id: DEAL, title: 'Something new' })]),
          ]),
        ),
      );
      await render(withBusiness());
      // Everything is searched, not the kind it can't draw.
      await screen.findByTestId('search-best-row');
      await waitFor(() => expect(screen.queryByTestId('search-on-phone')).toBeNull());
      expect(screen.queryByTestId(`search-kind-${unknown}`)).toBeNull();
      expect(screen.queryByTestId('search-group-future_kind')).toBeNull();
      expect(screen.queryByText('Something new')).toBeNull();
    },
  );

  it('shows every group with all it brought for See all results', async () => {
    const five = (kind: string, n: number) =>
      group(
        kind,
        Array.from({ length: 5 }, (_, i) =>
          hit({
            kind,
            id: `${String(n).repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`,
            title: `${kind} ${i}`,
            tier: 3,
            href: `/app/w/${LONE_STAR}/tasks`,
          }),
        ),
        { total: 9 },
      );
    const groups = [five('messages', 1), five('calendar', 2), five('tasks', 3), five('notes', 4)];
    post.mockResolvedValue(ok({ ...answer(groups), best: null }));
    await render(withBusiness());
    // The box: 2 a group when more than 3 groups show.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('search-group-tasks')).getAllByTestId(/^search-hit-/),
      ).toHaveLength(2),
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('search-see-all'));
    });
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith('/v1/queries/search.everything', {
        body: expect.objectContaining({ depth: 'full', perKind: 5 }),
        signal: expect.anything(),
      }),
    );
    for (const kind of ['messages', 'calendar', 'tasks', 'notes'])
      await waitFor(() =>
        expect(
          within(screen.getByTestId(`search-group-${kind}`)).getAllByTestId(/^search-hit-/),
        ).toHaveLength(5),
      );
  });

  it('marks a setting only the web changes “Opens on the web”, as Settings search does', async () => {
    mockParams = { q: 'quiet hours' };
    post.mockResolvedValue(ok({ ...answer([]), q: 'quiet hours', best: null, total: 0 }));
    await render(withBusiness());
    expect(await screen.findByTestId('search-group-settings')).toHaveTextContent(
      /Quiet hours.*Opens on the web/,
    );
  });

  it('says a kind the phone doesn’t keep waits for signal, not that nothing matched', async () => {
    mockOnline = false;
    mockParams = { q: 'dana', kind: 'messages' };
    await render(withBusiness());
    expect(await screen.findByTestId('search-needs-signal')).toHaveTextContent(
      SEARCH_WORDS.needsSignal('Messages'),
    );
    expect(screen.queryByTestId('search-empty')).toBeNull();
  });

  it('says when an add-on couldn’t be searched, never that nothing matched', async () => {
    const failed = group('realestate', [], {
      label: 'Real Estate Agent',
      complete: false,
      unavailable: 'failed',
    });
    post.mockImplementation((async (path: string) =>
      path.endsWith('search.kind')
        ? ok({
            group: group('realestate.listings', [], {
              label: 'Listings',
              complete: false,
              unavailable: 'failed',
            }),
            nextCursor: null,
            standingCounts: null,
            duplicates: [],
          })
        : ok({ ...answer([failed]), best: null, total: 0 })) as never);
    await render(withBusiness());
    expect(await screen.findByTestId('search-unavailable-realestate')).toHaveTextContent(
      SEARCH_WORDS.failed('Real Estate Agent'),
      { exact: false },
    );
    expect(screen.queryByTestId('search-empty')).toBeNull();
    expect(screen.queryByTestId('search-none-active')).toBeNull();
  });

  it('says one add-on kind’s page couldn’t be searched, with Try again', async () => {
    mockParams = { q: '418 smith', kind: 'realestate.listings' };
    post.mockImplementation((async (path: string) =>
      path.endsWith('search.kind')
        ? ok({
            group: group('realestate.listings', [], {
              label: 'Listings',
              complete: false,
              unavailable: 'failed',
            }),
            nextCursor: null,
            standingCounts: null,
            duplicates: [],
          })
        : ok({ ...answer([]), best: null, total: 0 })) as never);
    await render(withBusiness());
    const line = await screen.findByTestId('search-unavailable-realestate.listings');
    expect(line).toHaveTextContent(SEARCH_WORDS.failed('Listings'), { exact: false });
    expect(line).toHaveTextContent(SEARCH_WORDS.tryAgain, { exact: false });
    expect(screen.queryByTestId('search-empty')).toBeNull();
  });

  it('offers Try again only when it can help', async () => {
    mockParams = { q: 'smith', kind: 'messages' };
    post.mockImplementation((async (path: string) =>
      path.endsWith('search.kind')
        ? {
            error: {
              error: {
                code: 'forbidden',
                message: 'You can’t search Messages.',
                disposition: 'final',
                rule: 'search_kind_not_allowed',
              },
            },
            response: { ok: false, status: 403 },
          }
        : ok(answer([group('contacts', [danaHit])]))) as never);
    await render(withBusiness());
    const error = await screen.findByTestId('search-error');
    expect(error).toHaveTextContent('You can’t search Messages.');
    expect(screen.queryByTestId('search-empty')).toBeNull();
  });

  it('says an add-on kind the copy doesn’t answer waits for signal, by its own name', async () => {
    mockOnline = false;
    mockParams = { q: '418 smith', kind: 'realestate.listings' };
    await render(withBusiness());
    expect(await screen.findByTestId('search-needs-signal')).toHaveTextContent(
      SEARCH_WORDS.needsSignal('Listings'),
    );
    expect(screen.queryByTestId('search-empty')).toBeNull();
  });

  it('asks one kind once more, quietly, after a refusal HandsFreeOS says to retry', async () => {
    mockParams = { q: 'smith', kind: 'contacts' };
    const busy = {
      error: { error: { code: 'unavailable', message: 'Search is busy.', disposition: 'retry' } },
      response: { ok: false, status: 503 },
    };
    const page = ok({
      group: group('contacts', [danaHit]),
      nextCursor: null,
      standingCounts: null,
      duplicates: [],
    });
    post.mockImplementation((async (path: string) =>
      path.endsWith('search.kind')
        ? post.mock.calls.filter(([p]) => String(p).endsWith('search.kind')).length === 1
          ? busy
          : page
        : ok(answer([group('contacts', [danaHit])]))) as never);
    await render(withBusiness());
    expect(
      await screen.findByTestId('search-group-contacts', undefined, { timeout: 4_000 }),
    ).toHaveTextContent(/Dana Smith/);
    expect(screen.queryByTestId('search-error')).toBeNull();
  });

  it('opens one kind 25 at a time from its chip, with Leads and Clients and the banner when two share a number', async () => {
    post.mockImplementation((async (path: string) =>
      path.endsWith('search.kind')
        ? ok({
            group: group('contacts', [danaHit], { total: 9 }),
            nextCursor: 'next',
            standingCounts: { leads: 5, clients: 4 },
            duplicates: [
              { ids: [DANA, DEAL], on: 'phone', value: '(504) 555-0142', name: 'Dana Smith' },
            ],
          })
        : ok(answer([group('contacts', [danaHit], { total: 9 })]))) as never);
    await render(withBusiness());
    const chip = await screen.findByTestId('search-chip-contacts');
    await act(async () => {
      fireEvent.press(chip);
    });
    expect(await screen.findByTestId('search-standing')).toHaveTextContent(
      /All9.*Leads5.*Clients4/,
    );
    expect(screen.getByTestId('search-duplicates')).toHaveTextContent(
      `${SEARCH_WORDS.twoSharePhone('Dana Smith')}${SEARCH_WORDS.compare}`,
    );
    expect(screen.getByTestId('search-show-more')).toHaveTextContent(SEARCH_WORDS.showMoreOf(25));
    expect(post).toHaveBeenCalledWith('/v1/queries/search.kind', {
      body: { workspaceId: LONE_STAR, q: 'smith', kind: 'contacts', limit: 25 },
      signal: expect.anything(),
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('search-standing-lead'));
    });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/queries/search.kind', {
        body: { workspaceId: LONE_STAR, q: 'smith', kind: 'contacts', limit: 25, standing: 'lead' },
        signal: expect.anything(),
      }),
    );
  });
});
