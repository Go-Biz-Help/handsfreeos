import type {
  ExceptionsView,
  TodayView,
  WaitingRoomView,
  WorkloadView,
} from '@hfos/core/addons/realestate/views/coordinate';
import type { VendorRow } from '@hfos/core/addons/realestate/views/vendors';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import * as React from 'react';
import type * as ReactNative from 'react-native';

import { change } from '@/changes';

import { CoordinateView } from '../coordinate';
import { DealsView, NO_FILTERS, filtersOfView, shownDeals, type DealCard } from '../deals';
import { dueChip } from '../deal-bits';
import { DutiesView, dutyGroups, scopeOf } from '../duties';
import { VendorsView } from '../vendors';
import {
  ALVAREZ,
  ANN,
  DANA,
  dealItem,
  duty,
  id,
  JORDAN,
  NOW,
  OKAFOR,
  risks,
  SMITH,
  TZ,
  WS,
} from './deal-fixtures';

/**
 * Deals, My duties, Coordinate and Vendors on the phone (boards 76, 77 and 89): each list as core's views give it,
 * with the board's words, a deal kept as its summary saying so, what waits for signal, and changes going through the
 * queue with the command and input the API takes.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/changes', () => ({
  change: jest.fn(async () => ({ id: 'change-1', queued: true })),
  changes: { addPhoto: jest.fn(async () => ({ id: 'upload-1' })) },
  newId: jest.fn(() => '99999999-9999-4999-8999-999999999999'),
}));
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
}));
jest.mock('@/lib/sync-status', () => ({
  ...jest.requireActual<object>('@/lib/sync-status'),
  useSyncStatus: () => ({
    connection: 'offline',
    waiting: 0,
    asOf: Date.parse('2026-10-03T14:41:00.000Z'),
  }),
}));
jest.mock('@/components/shell/up-to-date', () => ({
  UpToDate: () => {
    const { Text: T } = jest.requireActual<typeof ReactNative>('react-native');
    return <T>Up to date</T>;
  },
}));
jest.mock('@/components/shell/screen', () => ({
  Screen: ({
    title,
    subtitle,
    trailing,
    header,
    children,
    testID,
  }: {
    title?: string;
    subtitle?: string;
    trailing?: React.ReactNode;
    header?: React.ReactNode;
    children?: React.ReactNode;
    testID?: string;
  }) => {
    const RN = jest.requireActual<typeof ReactNative>('react-native');
    return (
      <RN.View testID={testID}>
        <RN.Text testID="screen-title">{title}</RN.Text>
        {subtitle ? <RN.Text testID="screen-subtitle">{subtitle}</RN.Text> : null}
        {trailing}
        {header}
        {children}
      </RN.View>
    );
  },
}));

beforeEach(() => {
  mockOnline = true;
  jest.mocked(change).mockClear();
});

const card = (
  over: Parameters<typeof dealItem>[0],
  reds = 0,
  next: DealCard['next'] = [],
): DealCard => ({
  deal: dealItem(over),
  risks: reds ? risks(over?.dealId ?? SMITH, reds) : { ...risks(over?.dealId ?? SMITH, 0) },
  next,
});

const CARDS: DealCard[] = [
  card({
    health: 'green',
    dealId: ALVAREZ,
    name: 'Alvarez listing',
    side: 'listing',
    stageLabel: 'Active',
    closing: null,
    nextDue: null,
  }),
  card({}, 3, [
    duty({ title: 'Insurance binder', dueAt: '2026-10-04T04:59:00.000Z' }),
    duty({ dutyId: id(9), title: 'Inspection ends', dueAt: '2026-10-08T22:00:00.000Z' }),
  ]),
  card({
    dealId: OKAFOR,
    name: 'Okafor purchase',
    health: 'yellow',
    stageLabel: 'Under contract',
    mine: false,
    mainAgent: { userId: JORDAN, name: 'Jordan Lee' },
    client: { personId: ANN, name: 'Grace Okafor' },
    property: { propertyId: id(91), address: '77 Pecan St' },
    nextDue: { dutyId: id(5), title: 'Appraisal', dueAt: '2026-10-06T22:00:00.000Z' },
    closing: null,
  }),
];

function renderDeals(over: Partial<React.ComponentProps<typeof DealsView>> = {}) {
  const props: React.ComponentProps<typeof DealsView> = {
    businessName: 'Hill Country Realty',
    timeZone: TZ,
    now: NOW,
    seesEveryDeal: true,
    whose: 'mine',
    onWhose: jest.fn(),
    filters: NO_FILTERS,
    onFilters: jest.fn(),
    cards: CARDS,
    counts: { mine: 2, every: 3, atRisk: 1 },
    agents: [
      [DANA, 'Dana Reyes'],
      [JORDAN, 'Jordan Lee'],
    ],
    onOpen: jest.fn(),
    ...over,
  };
  return render(<DealsView {...props} />).then(() => props);
}

describe('Deals (board 76)', () => {
  it('says how many are open, splits mine from every deal, and leads with what needs the person', async () => {
    await renderDeals();
    expect(screen.getByTestId('screen-subtitle')).toHaveTextContent('2 open · Hill Country Realty');
    expect(screen.getByText('Mine · 2')).toBeTruthy();
    expect(screen.getByText('Every deal · 3')).toBeTruthy();
    for (const chip of ['Open', 'Buyers', 'Listings', 'At risk · 1', 'Closing this month'])
      expect(screen.getByText(chip)).toBeTruthy();
    expect(screen.getByText('Needs you')).toBeTruthy();
    // Mine only: the at-risk Smith purchase first, then the listing on track.
    const ids = screen.getAllByTestId(/^re-deal-[0-9a-f-]{36}$/).map((n) => n.props.testID);
    expect(ids).toEqual([`re-deal-${SMITH}`, `re-deal-${ALVAREZ}`]);
    const smith = within(screen.getByTestId(`re-deal-${SMITH}`));
    expect(smith.getByText('123 Main St · Ann Smith')).toBeTruthy();
    expect(smith.getByTestId('re-deal-line')).toHaveTextContent(
      '3 things could stop this closing · closing Oct 14',
    );
    expect(
      smith.getAllByTestId('re-deal-next').map((n) => n.props.children.props.children),
    ).toEqual(['Insurance binder due today', 'Inspection ends due Thu']);
  });

  it('keeps a deal the person isn’t on as its summary, and says so', async () => {
    await renderDeals({ whose: 'every' });
    expect(screen.getByTestId('screen-subtitle')).toHaveTextContent(
      'Every deal · Hill Country Realty',
    );
    const okafor = within(screen.getByTestId(`re-deal-${OKAFOR}`));
    expect(okafor.getByText('77 Pecan St · Grace Okafor · Jordan Lee’s deal')).toBeTruthy();
    expect(okafor.getByTestId('re-deal-line')).toHaveTextContent('Appraisal due Tue');
    expect(okafor.getByText('Summary, duties and dates on this phone')).toBeTruthy();
    expect(screen.getByTestId('re-deals-note')).toHaveTextContent(
      'Deals you’re not on keep their summary, duties and dates here; their documents, history and offers load with signal.',
    );
  });

  it('says what the phone kept with no signal', async () => {
    mockOnline = false;
    await renderDeals();
    // At the phone's own clock: 9:41 AM in Austin.
    expect(screen.getByTestId('re-kept-strip')).toHaveTextContent(
      /^No signal · what this phone kept at \d{1,2}:41 [AP]M$/,
    );
  });

  it('turns the filters on from the chips and the sheet, and opens a deal', async () => {
    const props = await renderDeals();
    await fireEvent.press(screen.getByTestId('re-chip-risk'));
    expect(props.onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, health: 'red' });
    await fireEvent.press(screen.getByTestId('re-chip-buyers'));
    expect(props.onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, side: 'buyer', stage: null });
    await fireEvent.press(screen.getByTestId('re-deals-filters'));
    expect(screen.getByText('Show deals')).toBeTruthy();
    expect(screen.getByText('How they’re doing')).toBeTruthy();
    expect(screen.getByText('Something due soon')).toBeTruthy();
    expect(screen.getByText('Show 2 deals')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('re-sort-closing'));
    expect(props.onFilters).toHaveBeenLastCalledWith({ ...NO_FILTERS, sort: 'closing' });
    await fireEvent.press(screen.getByTestId(`re-deal-${SMITH}`));
    expect(props.onOpen).toHaveBeenCalledWith(SMITH);
  });

  it('says so when nothing matches', async () => {
    await renderDeals({ cards: [], filters: { ...NO_FILTERS, side: 'listing' } });
    expect(screen.getByTestId('re-deals-empty')).toHaveTextContent(
      'No deal matches that.Clear the filters to see every deal again.',
    );
  });

  it('sorts by what needs the person, by closing, or as they came; and reads the web’s ?view=', () => {
    const names = (sort: 'needs' | 'closing' | 'newest') =>
      shownDeals(CARDS, 'every', { ...NO_FILTERS, sort }).map((c) => c.deal.name);
    expect(names('needs')).toEqual(['Smith purchase', 'Okafor purchase', 'Alvarez listing']);
    expect(names('closing')).toEqual(['Smith purchase', 'Alvarez listing', 'Okafor purchase']);
    expect(names('newest')).toEqual(['Alvarez listing', 'Smith purchase', 'Okafor purchase']);
    expect(filtersOfView('all')).toEqual({ whose: 'every', status: 'open' });
    expect(filtersOfView('archived')).toEqual({ whose: 'every', status: 'archived' });
    expect(filtersOfView(undefined)).toEqual({ whose: 'mine', status: 'open' });
  });
});

describe('My duties (board 77)', () => {
  const MINE = [
    duty({
      dutyId: id(11),
      title: 'Send the repair request',
      overdue: true,
      dueAt: '2026-10-03T04:59:00.000Z',
    }),
    duty({ dutyId: id(12), title: 'Get the insurance binder to the lender' }),
    duty({
      dutyId: id(13),
      title: 'Confirm the 4:00 PM showing',
      dealName: 'Alvarez listing',
      dueAt: '2026-10-03T20:00:00.000Z',
    }),
    duty({
      dutyId: id(14),
      title: 'Attend inspection',
      dealName: 'Nguyen purchase',
      dueAt: '2026-10-09T15:00:00.000Z',
    }),
  ];

  it('puts late first, then today and this week, each with when it’s due', async () => {
    const onOpen = jest.fn();
    await render(
      <DutiesView
        scope="mine"
        onScope={jest.fn()}
        lists={{ mine: MINE, watching: [duty({ dutyId: id(20) })], team: MINE }}
        showTeam={false}
        timeZone={TZ}
        now={NOW}
        waiting={new Set([id(12)])}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByTestId('screen-subtitle')).toHaveTextContent('4 open · 1 late');
    expect(screen.getByText('Mine · 4')).toBeTruthy();
    expect(screen.getByText('I’m watching · 1')).toBeTruthy();
    expect(screen.queryByText('Team')).toBeNull();
    expect(screen.getByText('Late  1')).toBeTruthy();
    const due = (dutyId: string) =>
      within(screen.getByTestId(`re-duty-${dutyId}`)).getByTestId('re-duty-due');
    expect(due(id(11))).toHaveTextContent('Yesterday');
    expect(due(id(12))).toHaveTextContent('Today');
    expect(due(id(13))).toHaveTextContent('3:00 PM');
    expect(due(id(14))).toHaveTextContent('Fri');
    expect(
      within(screen.getByTestId(`re-duty-${id(12)}`)).getByText(/waiting to send/),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`re-duty-${id(11)}`));
    expect(onOpen).toHaveBeenCalledWith(id(11));
  });

  it('groups as the board does, and reads the web’s ?scope=', () => {
    expect(dutyGroups(MINE, TZ, NOW).map((g) => [g.key, g.duties.length])).toEqual([
      ['late', 1],
      ['today', 2],
      ['week', 1],
    ]);
    expect(scopeOf('all', true)).toBe('team');
    expect(scopeOf('all', false)).toBe('mine');
    expect(dueChip(null, TZ, NOW, false)).toBeNull();
  });
});

describe('Coordinate (board 77)', () => {
  const today = {
    today: '2026-10-03',
    atRisk: [
      {
        kind: 'reason',
        dealId: SMITH,
        dealName: 'Smith purchase',
        dutyId: null,
        words: 'Rate lock ends a day before closing',
        next: 'Summit Lending’s lock ends Oct 13; closing is Oct 14. Ask for an extension.',
        level: 'red',
        health: 'red',
      },
    ],
    overdue: [],
    dueToday: [
      {
        dutyId: id(1),
        dealId: SMITH,
        dealName: 'Smith purchase',
        title: 'Insurance binder',
        status: 'waiting_external',
        materiality: 'critical',
        accountableName: 'Dana Reyes',
        dueAt: '2026-10-04T04:59:00.000Z',
        health: 'red',
        escalated: false,
        acknowledged: false,
      },
    ],
  } as unknown as TodayView;
  const exceptions = {
    reads: [],
    disagree: [
      {
        dealId: OKAFOR,
        dealName: 'Kim purchase',
        words: 'The contract read says option period ends Oct 9; the duty list says Oct 8.',
        next: 'Pick the one that counts.',
        linked: false,
      },
    ],
    nobodyAccountable: [],
    noProof: [],
    contingencies: [],
    blocked: [],
    partial: true,
  } as ExceptionsView;
  const waiting: WaitingRoomView = { items: [] };
  const workload: WorkloadView = {
    people: [
      {
        userId: DANA,
        name: 'Dana Reyes',
        role: 'member',
        deals: 7,
        openDuties: 14,
        overdue: 1,
        dueSoon: 5,
        atRiskDeals: 1,
      },
      {
        userId: JORDAN,
        name: 'Jordan Lee',
        role: 'member',
        deals: 5,
        openDuties: 11,
        overdue: 2,
        dueSoon: 3,
        atRiskDeals: 0,
      },
    ],
  } as WorkloadView;

  it('shows today, what skipped the normal path, and who carries what', async () => {
    const onDuty = jest.fn();
    const onDeal = jest.fn();
    await render(
      <CoordinateView
        initialTab="today"
        subtitle="Hill Country Realty · Marcus Lee"
        today={today}
        exceptions={exceptions}
        waiting={waiting}
        workload={workload}
        timeZone={TZ}
        now={NOW}
        workspaceId={WS}
        onDuty={onDuty}
        onDeal={onDeal}
      />,
    );
    expect(screen.getByText('Today · 2')).toBeTruthy();
    expect(screen.getByText('Exceptions · 1')).toBeTruthy();
    expect(screen.getByText('Waiting · 0')).toBeTruthy();
    expect(screen.getByText('Due today')).toBeTruthy();
    expect(screen.getByText(/Ask for an extension/)).toBeTruthy();
    await fireEvent.press(within(screen.getAllByTestId('re-today-duty')[0]!).getByText('Open'));
    expect(onDuty).toHaveBeenCalledWith(id(1));

    await fireEvent.press(screen.getByTestId('tab-exceptions'));
    expect(screen.getByText('Dates don’t agree')).toBeTruthy();
    expect(screen.getByText('Fixing it needs signal')).toBeTruthy();
    expect(screen.getByTestId('re-exceptions-partial')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('tab-workload'));
    expect(screen.getByText('14 open · 1 late · 5 due in 2 days')).toBeTruthy();
    expect(screen.getByText('Jordan Lee')).toBeTruthy();
  });

  it('leaves Workload out for someone who doesn’t see every deal', async () => {
    await render(
      <CoordinateView
        initialTab="today"
        subtitle="Hill Country Realty · Dana Reyes"
        today={today}
        exceptions={exceptions}
        waiting={waiting}
        workload={null}
        timeZone={TZ}
        now={NOW}
        workspaceId={WS}
        onDuty={jest.fn()}
        onDeal={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('tab-workload')).toBeNull();
  });
});

describe('Vendors (board 89)', () => {
  const vendor = (over: Partial<VendorRow>): VendorRow => ({
    id: id(40),
    companyId: id(41),
    name: 'Lone Star Inspections',
    email: null,
    phone: '(512) 555-0100',
    services: ['inspection'],
    servicesWords: 'Home inspection',
    areas: ['Austin metro'],
    approved: true,
    approvedAt: '2026-09-01T00:00:00.000Z',
    disclosure: null,
    disclosureWords: 'Nothing to disclose',
    note: null,
    archived: false,
    uses: 3,
    lastUsedAt: null,
    ...over,
  });

  it('lists the approved ones with any disclosure, adds one with no signal, and approves with signal', async () => {
    await render(
      <VendorsView
        businessName="Hill Country Realty"
        workspaceId={WS}
        vendors={[
          vendor({}),
          vendor({
            id: id(42),
            name: 'First Texas Mortgage',
            services: ['lender'],
            servicesWords: 'Lender',
            areas: [],
            disclosure: 'owned in part by Dana',
            disclosureWords: 'Disclosure: owned in part by Dana',
          }),
          vendor({ id: id(43), name: 'Cool Air HVAC', approved: false, servicesWords: 'HVAC' }),
        ]}
        pending={[]}
        manages
      />,
    );
    expect(screen.getByText('Approved  2')).toBeTruthy();
    expect(screen.getByText('Home inspection · Austin metro')).toBeTruthy();
    expect(screen.getByText('Lender · disclosure: owned in part by Dana')).toBeTruthy();
    expect(
      screen.getByText(
        'Adding works with no signal; approving one needs an owner or admin with signal.',
      ),
    ).toBeTruthy();

    await fireEvent.press(screen.getByTestId(`re-vendor-approve-${id(43)}`));
    expect(change).toHaveBeenCalledWith('realestate.vendor.approve', {
      workspaceId: WS,
      vendorId: id(43),
      approved: true,
    });

    await fireEvent.press(screen.getByTestId('re-vendors-add'));
    await fireEvent.changeText(screen.getByTestId('re-vendor-name'), 'Lens & Light Photo');
    await fireEvent.press(screen.getByTestId('re-vendor-service-photos'));
    await fireEvent.changeText(screen.getByTestId('re-vendor-areas'), 'Austin, Round Rock');
    await fireEvent.press(screen.getByTestId('re-vendor-save'));
    expect(change).toHaveBeenLastCalledWith('realestate.vendor.save', {
      workspaceId: WS,
      id: '99999999-9999-4999-8999-999999999999',
      name: 'Lens & Light Photo',
      services: ['photos'],
      areas: ['Austin', 'Round Rock'],
    });
  });

  it('says approving needs signal when there’s none', async () => {
    mockOnline = false;
    await render(
      <VendorsView
        businessName="Hill Country Realty"
        workspaceId={WS}
        vendors={[vendor({ id: id(43), name: 'Cool Air HVAC', approved: false })]}
        pending={[]}
        manages
      />,
    );
    expect(screen.getByTestId(`re-vendor-approve-${id(43)}`)).toHaveTextContent('Needs signal');
    await fireEvent.press(screen.getByTestId(`re-vendor-approve-${id(43)}`));
    expect(change).not.toHaveBeenCalled();
  });
});
