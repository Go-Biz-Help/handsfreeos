import {
  ADDON_VOTES_WORDS,
  addonPickDay,
  FOUNDING_WORDS,
  foundingApplicationLine,
  foundingGivenBackLine,
  foundingSeatLine,
  RATES_WORDS,
} from '@hfos/core';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

import type { Ok } from '@/admin/live';
import { MONEY_DESK_WORDS } from '@/admin/money-desk-words';
import { DESK_PHONE_WORDS } from '@/admin/words';
import AddonVotes from '@/app/app/admin/add-ons';
import Founding from '@/app/app/admin/founding';
import Rates from '@/app/app/admin/rates';
import { toast } from '@/components/ui/toast';
import { config } from '@/lib/config';
import { setTestOffline } from '@/lib/network';

import { agent, lastBody, sent, showDesk, type Answers } from './kit';

/**
 * Add-on votes, Rates and Founding on the phone's Support desk (the web's /admin/add-ons, /admin/rates and
 * /admin/founding): what each shows, every change each sends and its exact body, that only a support admin can open
 * them, and that with no signal they say so.
 */

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
    replace: jest.fn(),
    push: jest.fn(),
    setParams: jest.fn(),
    canGoBack: () => true,
  },
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/',
  useFocusEffect: () => undefined,
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) =>
    e instanceof Error ? e.message : 'Something went wrong. Try again.',
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const NO_SIGNAL = 'No signal. Try again when you’re back online.';

const W1 = '11111111-aaaa-4aaa-8aaa-000000000001';
const W2 = '11111111-aaaa-4aaa-8aaa-000000000002';
const W3 = '11111111-aaaa-4aaa-8aaa-000000000003';
const W4 = '11111111-aaaa-4aaa-8aaa-000000000004';

const race = (n = 3) => [
  { addonId: 'realestate', name: 'Real estate', category: 'industry', votes: 3 },
  { addonId: 'fleet', name: 'Fleet tracking', category: 'operations', votes: 3 },
  { addonId: 'loyalty', name: 'Loyalty points', category: 'customers', votes: 1 },
  ...Array.from({ length: Math.max(0, n - 3) }, (_, i) => ({
    addonId: `planned-${i + 1}`,
    name: `Planned ${i + 1}`,
    category: 'sales',
    votes: 0,
  })),
];

const OVERVIEW = {
  waiting: [
    {
      weekId: W1,
      endsAt: '2026-09-27T04:00:00.000Z',
      outcome: 'tie',
      tied: ['realestate', 'fleet'],
      topVotes: 3,
    },
    { weekId: W2, endsAt: '2026-09-20T04:00:00.000Z', outcome: 'no_votes', tied: [], topVotes: 0 },
  ],
  weeks: [
    {
      weekId: W3,
      endsAt: '2026-09-13T04:00:00.000Z',
      outcome: 'votes',
      addonId: 'reviews',
      name: 'Review requests',
      topVotes: 7,
      decidedAt: null,
      decidedBy: null,
    },
    {
      weekId: W1,
      endsAt: '2026-09-27T04:00:00.000Z',
      outcome: 'tie',
      addonId: null,
      name: null,
      topVotes: 3,
      decidedAt: null,
      decidedBy: null,
    },
    {
      weekId: W4,
      endsAt: '2026-09-06T04:00:00.000Z',
      outcome: 'no_votes',
      addonId: 'payroll',
      name: 'Payroll',
      topVotes: 0,
      decidedAt: '2026-09-07T15:00:00.000Z',
      decidedBy: 'Riley',
    },
  ],
  race: race(),
  comingSoon: [
    {
      addonId: 'reviews',
      name: 'Review requests',
      how: 'votes',
      pickedAt: '2026-09-13T04:00:00.000Z',
      votes: 7,
      shippedAt: null,
    },
  ],
  nextPickAt: '2026-10-04T04:00:00.000Z',
};

const RATES = {
  version: 3,
  since: '2026-08-31T00:00:00.000Z',
  lines: [
    {
      key: 'sms.outbound.segment',
      unit: 'segment',
      costMicros: 10_900,
      markupBp: 15_000,
      minChargeCents: 0,
      roundUpTo: 'segment',
      unitPriceCents: 2,
      notes: 'One text segment, in the US',
      realised: { events: 120, chargedCents: 240, costCents: 131, markup: 1.83 },
    },
    {
      key: 'voice.minute',
      unit: 'minute',
      costMicros: 14_000,
      markupBp: 15_000,
      minChargeCents: 0,
      roundUpTo: 'minute',
      unitPriceCents: 2,
      notes: 'A minute of a call',
      realised: { events: 40, chargedCents: 80, costCents: 75, markup: 1.07 },
    },
    {
      key: 'ai.input.token',
      unit: 'token',
      costMicros: 3_000,
      markupBp: 15_000,
      minChargeCents: 0,
      roundUpTo: 'token',
      unitPriceCents: 1,
      notes: '',
      realised: null,
    },
  ],
};

const A1 = '33333333-aaaa-4aaa-8aaa-000000000001';
const A2 = '33333333-aaaa-4aaa-8aaa-000000000002';
const A3 = '33333333-aaaa-4aaa-8aaa-000000000003';
const G1 = '44444444-aaaa-4aaa-8aaa-000000000001';
const G2 = '44444444-aaaa-4aaa-8aaa-000000000002';
const G3 = '44444444-aaaa-4aaa-8aaa-000000000003';
const G4 = '44444444-aaaa-4aaa-8aaa-000000000004';
const WS1 = '55555555-aaaa-4aaa-8aaa-000000000001';
const WS2 = '55555555-aaaa-4aaa-8aaa-000000000002';
const ORG1 = '66666666-aaaa-4aaa-8aaa-000000000001';
const ORG2 = '66666666-aaaa-4aaa-8aaa-000000000002';
const TOKEN = 'k3y-0f-the-seat-for-lone-star-hvac';

type Queue = Ok<'/v1/queries/platform.founding'>;

const offer = (over: Partial<Queue['offers'][number]>): Queue['offers'][number] => ({
  offerId: 'founding_partner',
  name: 'Founding partner',
  status: 'open',
  seatCap: 25,
  claimed: 24,
  remaining: 1,
  priceCents: 0,
  billing: 'once',
  opensAfterOfferId: null,
  opensAfterCount: null,
  openedAt: '2026-09-01T15:00:00.000Z',
  ...over,
});

const application = (
  over: Partial<Queue['applications'][number]>,
): Queue['applications'][number] => ({
  applicationId: A1,
  offerId: 'founding_partner',
  businessName: 'Lone Star HVAC',
  contactName: 'Dale Ramsey',
  email: 'dale@lonestarhvac.test',
  phone: '512-555-0142',
  website: null,
  industry: 'HVAC',
  teamSize: '2-5',
  note: 'We answer every call ourselves.\nTwo trucks, one phone.',
  source: 'website',
  status: 'pending',
  decisionNote: '',
  createdAt: '2026-09-25T15:00:00.000Z',
  reviewedAt: null,
  theirBusinesses: [
    {
      workspaceId: WS1,
      workspaceName: 'Lone Star HVAC',
      organizationId: ORG1,
      organizationName: 'Lone Star Group',
      role: 'owner',
    },
  ],
  ...over,
});

const grant = (over: Partial<Queue['grants'][number]>): Queue['grants'][number] => ({
  grantId: G1,
  offerId: 'founding_partner',
  organizationId: ORG1,
  organizationName: 'Lone Star Group',
  workspaceId: WS1,
  status: 'reserved',
  reservedAt: '2026-09-26T15:00:00.000Z',
  expiresAt: '2026-10-10T15:00:00.000Z',
  activatedAt: null,
  revokedAt: null,
  revokeReason: '',
  graceEndsAt: null,
  checkoutStatus: null,
  checkoutProblem: '',
  ...over,
});

const QUEUE: Queue = {
  offers: [
    offer({}),
    offer({
      offerId: 'founding_lifetime',
      name: 'Founding lifetime',
      status: 'draft',
      seatCap: 100,
      claimed: 0,
      remaining: 100,
      priceCents: 49_700,
      opensAfterOfferId: 'founding_partner',
      openedAt: null,
    }),
    offer({
      offerId: 'monthly',
      name: 'Monthly',
      status: 'draft',
      seatCap: 0,
      claimed: 0,
      remaining: 0,
      priceCents: 9_700,
      billing: 'monthly',
      opensAfterOfferId: 'founding_lifetime',
      opensAfterCount: 10,
      openedAt: null,
    }),
  ],
  applications: [
    application({}),
    application({
      applicationId: A2,
      businessName: 'Hill Country Plumbing',
      contactName: 'Rosa Vega',
      email: 'rosa@hcplumbing.test',
      phone: null,
      industry: null,
      note: '',
      status: 'waitlisted',
      theirBusinesses: [],
    }),
    application({ applicationId: A3, businessName: 'Declined Co', status: 'declined' }),
  ],
  grants: [
    grant({ checkoutStatus: 'open' }),
    grant({
      grantId: G2,
      organizationId: ORG2,
      organizationName: 'Gulf Coast Roofing',
      status: 'active',
      activatedAt: '2026-09-10T15:00:00.000Z',
    }),
    grant({
      grantId: G3,
      organizationName: 'Pecan Street Pest',
      status: 'revoked',
      revokedAt: '2026-09-20T15:00:00.000Z',
      revokeReason: 'Never answered our emails',
      graceEndsAt: '2026-10-04T15:00:00.000Z',
      checkoutStatus: 'paid',
      checkoutProblem: 'Paid $497, but the seat was taken back while they were paying.',
    }),
    grant({
      grantId: G4,
      organizationName: 'Bluebonnet Cleaning',
      status: 'expired',
      expiresAt: '2026-09-15T15:00:00.000Z',
    }),
  ],
};

let answers: Answers;

beforeEach(() => {
  jest.clearAllMocks();
  setTestOffline(false);
  mockParams = {};
  answers = {
    '/v1/queries/addon_pick.overview': OVERVIEW,
    '/v1/commands/addon_pick.choose': (body: Record<string, unknown>) => body,
    '/v1/queries/platform.rates': RATES,
    '/v1/queries/platform.founding': QUEUE,
    '/v1/queries/platform.business.list': {
      businesses: [
        {
          workspaceId: WS2,
          name: 'Hill Country Plumbing',
          organizationId: ORG2,
          organizationName: 'Hill Country Services',
          industry: 'plumbing',
          timezone: 'America/Chicago',
          memberCount: 3,
          lastActiveAt: null,
          openTicketCount: 0,
          createdAt: '2026-09-01T15:00:00.000Z',
        },
      ],
      nextCursor: null,
      totals: { businesses: 1, newThisWeek: 0, activeThisWeek: 0 },
    },
    '/v1/commands/founding.approve': {
      grantId: G1,
      offerId: 'founding_partner',
      expiresAt: '2026-10-14T15:00:00.000Z',
      claimToken: TOKEN,
      remaining: 0,
    },
    '/v1/commands/founding.decline': { applicationId: A1, status: 'declined' },
    '/v1/commands/founding.revoke': { grantId: G1 },
    '/v1/commands/founding.restore': { grantId: G3 },
    '/v1/commands/founding.set_cap': { offerId: 'founding_partner' },
    '/v1/commands/founding.set_status': { offerId: 'founding_partner' },
  };
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('Add-on votes', () => {
  it('shows the weeks waiting on us, Coming soon, the race and how the last weeks closed', async () => {
    await showDesk(<AddonVotes />, () => answers);
    expect(await screen.findByTestId('addon-votes-intro')).toHaveTextContent(
      `${ADDON_VOTES_WORDS.intro} Next pick: ${ADDON_VOTES_WORDS.nextPickAt(OVERVIEW.nextPickAt)}.`,
    );
    expect(lastBody('/v1/queries/addon_pick.overview')).toEqual({});
    expect(screen.getByText('Waiting on you · 2')).toBeTruthy();
    expect(
      screen.getByText(
        'A tie between Real estate, Fleet tracking, with 3 votes each. Choose one of them.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(ADDON_VOTES_WORDS.noVotes)).toBeTruthy();
    // The tie starts on the first tied add-on; nobody voting starts on the race's leader.
    expect(screen.getByTestId(`addon-week-choice-${W1}`)).toHaveTextContent(
      'Real estate (3 votes)',
    );
    expect(screen.getByText('Coming soon · 1')).toBeTruthy();
    expect(screen.getByTestId('addon-soon-reviews')).toHaveTextContent(
      `Review requestsWon the vote7 votes · picked ${addonPickDay('2026-09-13T04:00:00.000Z')}`,
    );
    expect(screen.getByText('The race · 3')).toBeTruthy();
    expect(screen.getByTestId('addon-race-fleet')).toHaveTextContent('Fleet trackingOperations3');
    expect(screen.getByText('Won with 7 votes')).toBeTruthy();
    expect(screen.getByText('Tie, waiting on you')).toBeTruthy();
    expect(screen.getByText('Chosen by Riley')).toBeTruthy();
  });

  it('chooses among the tied ones, and says the voters are being told', async () => {
    await showDesk(<AddonVotes />, () => answers);
    await fireEvent.press(await screen.findByTestId(`addon-week-choice-${W1}`));
    // Only the tied ones are offered for a tie.
    expect(screen.queryByTestId('addon-pick-loyalty')).toBeNull();
    await fireEvent.press(screen.getByTestId('addon-pick-fleet'));
    await fireEvent.press(screen.getByTestId(`addon-week-choose-${W1}`));
    await waitFor(() =>
      expect(lastBody('/v1/commands/addon_pick.choose')).toEqual({ weekId: W1, addonId: 'fleet' }),
    );
    expect(toast.show).toHaveBeenCalledWith(
      'Fleet tracking is coming soon. The businesses that voted for it are being told.',
    );
    await waitFor(() => expect(sent('/v1/queries/addon_pick.overview')).toHaveLength(2));
  });

  it('offers the whole race for a week nobody voted in, and says why when it can’t', async () => {
    answers['/v1/commands/addon_pick.choose'] = null;
    await showDesk(<AddonVotes />, () => answers);
    await fireEvent.press(await screen.findByTestId(`addon-week-choice-${W2}`));
    expect(screen.getByTestId('addon-pick-loyalty')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('addon-pick-loyalty'));
    await fireEvent.press(screen.getByTestId(`addon-week-choose-${W2}`));
    await waitFor(() =>
      expect(lastBody('/v1/commands/addon_pick.choose')).toEqual({
        weekId: W2,
        addonId: 'loyalty',
      }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NO_SIGNAL));
  });

  it('shows the first 25 of the race until Show all, and finds one by name', async () => {
    answers['/v1/queries/addon_pick.overview'] = { ...OVERVIEW, race: race(30) };
    await showDesk(<AddonVotes />, () => answers);
    expect(await screen.findByText('The race · 30')).toBeTruthy();
    expect(screen.getByTestId('addon-race-planned-22')).toBeTruthy();
    expect(screen.queryByTestId('addon-race-planned-23')).toBeNull();
    await fireEvent.press(screen.getByTestId('addon-race-all'));
    expect(screen.getByTestId('addon-race-planned-27')).toBeTruthy();
    expect(screen.queryByTestId('addon-race-all')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('addon-race-search'), 'fleet');
    expect(screen.getByTestId('addon-race-fleet')).toBeTruthy();
    expect(screen.queryByTestId('addon-race-realestate')).toBeNull();
  });

  it('is for support admins only, and asks HandsFreeOS nothing for anyone else', async () => {
    await showDesk(<AddonVotes />, () => answers, agent);
    expect(screen.getByText(MONEY_DESK_WORDS.onlyAdmins('Add-on votes'))).toBeTruthy();
    expect(sent('/v1/queries/addon_pick.overview')).toHaveLength(0);
  });

  it('says it needs a signal, asks again on Try again, and by itself once back in signal', async () => {
    answers['/v1/queries/addon_pick.overview'] = null;
    setTestOffline(true);
    await showDesk(<AddonVotes />, () => answers);
    await screen.findByTestId('addon-votes-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('desk-retry'));
    await waitFor(() => expect(sent('/v1/queries/addon_pick.overview')).toHaveLength(2));
    answers['/v1/queries/addon_pick.overview'] = OVERVIEW;
    await act(async () => setTestOffline(false));
    expect(await screen.findByText('Waiting on you · 2')).toBeTruthy();
  });
});

describe('Rates', () => {
  it('shows each line’s cost, price and what it realised, and warns about the thin one', async () => {
    await showDesk(<Rates />, () => answers);
    expect(await screen.findByTestId('rates-measured')).toHaveTextContent(
      'Card version 3 · measured over the last 30 days',
    );
    expect(lastBody('/v1/queries/platform.rates')).toEqual({ days: 30 });
    expect(screen.getByTestId('rates-thin')).toHaveTextContent(
      'One line is charging under 1.2× what it costs us: voice.minute. Either the cost moved or the price is wrong.',
    );
    const sms = screen.getByTestId('rate-sms.outbound.segment');
    expect(sms).toHaveTextContent('One text segment, in the US', { exact: false });
    expect(sms).toHaveTextContent('Costs us$0.01', { exact: false });
    expect(sms).toHaveTextContent('Charged$0.02 · 1.50×', { exact: false });
    expect(screen.getByTestId('rate-sms.outbound.segment-realised')).toHaveTextContent(
      'Realised1.83×120 · $2.40 on $1.31',
    );
    expect(screen.getByTestId('rate-ai.input.token')).toHaveTextContent('Costs us0.300¢', {
      exact: false,
    });
    expect(screen.getByTestId('rate-ai.input.token-realised')).toHaveTextContent(
      `Realised${RATES_WORDS.nothingYet}`,
    );
  });

  it('measures over another window', async () => {
    await showDesk(<Rates />, () => answers);
    await screen.findByTestId('rates-measured');
    await fireEvent.press(screen.getByTestId('rates-window-90'));
    await waitFor(() => expect(lastBody('/v1/queries/platform.rates')).toEqual({ days: 90 }));
    expect(await screen.findByText('Card version 3 · measured over the last 90 days')).toBeTruthy();
  });

  it('says nothing is thin when every line holds', async () => {
    answers['/v1/queries/platform.rates'] = { ...RATES, lines: [RATES.lines[0], RATES.lines[2]] };
    await showDesk(<Rates />, () => answers);
    await screen.findByTestId('rate-sms.outbound.segment');
    expect(screen.queryByTestId('rates-thin')).toBeNull();
  });

  it('is for support admins only', async () => {
    await showDesk(<Rates />, () => answers, agent);
    expect(screen.getByText(MONEY_DESK_WORDS.onlyAdmins('Rates'))).toBeTruthy();
    expect(sent('/v1/queries/platform.rates')).toHaveLength(0);
  });

  it('says it needs a signal', async () => {
    answers['/v1/queries/platform.rates'] = null;
    setTestOffline(true);
    await showDesk(<Rates />, () => answers);
    await screen.findByTestId('rates-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
  });
});

describe('Founding', () => {
  it('shows the offers, the applications waiting, the seats out and the seats given back', async () => {
    await showDesk(<Founding />, () => answers);
    const partner = await screen.findByTestId('founding-offer-founding_partner');
    expect(lastBody('/v1/queries/platform.founding')).toEqual({ limit: 100 });
    expect(partner).toHaveTextContent('Free · open', { exact: false });
    expect(partner).toHaveTextContent('1 of 25 left', { exact: false });
    expect(screen.getByTestId('founding-status-founding_partner')).toHaveTextContent('Close');

    const lifetime = screen.getByTestId('founding-offer-founding_lifetime');
    expect(lifetime).toHaveTextContent('$497 · draft', { exact: false });
    expect(lifetime).toHaveTextContent(
      'Opens by itself when Founding partner is full — 24 of 25 now.',
      { exact: false },
    );
    expect(lifetime).toHaveTextContent(FOUNDING_WORDS.paidNote, { exact: false });
    expect(screen.getByTestId('founding-status-founding_lifetime')).toHaveTextContent('Open now');

    const monthly = screen.getByTestId('founding-offer-monthly');
    expect(monthly).toHaveTextContent('$97/month · draft', { exact: false });
    expect(monthly).toHaveTextContent(FOUNDING_WORDS.monthlyNote, { exact: false });
    expect(monthly).toHaveTextContent(
      'Opens by itself when Founding lifetime has 10 seats out — 0 of 10 now.',
      { exact: false },
    );
    expect(screen.queryByTestId('founding-cap-monthly')).toBeNull();

    // Pending and waitlisted wait on us; a declined one doesn't.
    expect(screen.getByText('Waiting on you · 2')).toBeTruthy();
    expect(screen.queryByTestId(`founding-application-${A3}`)).toBeNull();
    const first = screen.getByTestId(`founding-application-${A1}`);
    expect(first).toHaveTextContent(foundingApplicationLine(QUEUE.applications[0]!), {
      exact: false,
    });
    expect(first).toHaveTextContent('Two trucks, one phone.', { exact: false });
    expect(screen.getByTestId(`founding-application-${A2}`)).toHaveTextContent(
      'Hill Country Plumbing · waitlisted',
      { exact: false },
    );

    expect(screen.getByText('Seats out · 2')).toBeTruthy();
    const paying = foundingSeatLine(QUEUE.grants[0]!);
    expect(paying.endsWith(' · paying now')).toBe(true);
    expect(screen.getByText(paying)).toBeTruthy();
    expect(screen.getByText(foundingSeatLine(QUEUE.grants[1]!))).toBeTruthy();

    expect(screen.getByText(FOUNDING_WORDS.givenBack)).toBeTruthy();
    expect(screen.getByText(foundingGivenBackLine(QUEUE.grants[2]!))).toBeTruthy();
    expect(
      screen.getByText('Paid $497, but the seat was taken back while they were paying.'),
    ).toBeTruthy();
    expect(screen.getByText(foundingGivenBackLine(QUEUE.grants[3]!))).toBeTruthy();
    // Only a revoked seat can be undone; one nobody took up has simply gone back.
    expect(screen.getByTestId(`founding-undo-${G3}`)).toBeTruthy();
    expect(screen.queryByTestId(`founding-undo-${G4}`)).toBeNull();
  });

  it('raises a cap, and says so when what’s typed isn’t a number of seats', async () => {
    await showDesk(<Founding />, () => answers);
    const box = await screen.findByTestId('founding-cap-founding_partner');
    await fireEvent.changeText(box, 'lots');
    await fireEvent.press(screen.getByTestId('founding-cap-save-founding_partner'));
    expect(screen.getByText(MONEY_DESK_WORDS.capNotNumber)).toBeTruthy();
    expect(sent('/v1/commands/founding.set_cap')).toHaveLength(0);
    await fireEvent.changeText(box, '30');
    await fireEvent.press(screen.getByTestId('founding-cap-save-founding_partner'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/founding.set_cap')).toEqual({
        offerId: 'founding_partner',
        seatCap: 30,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith('Founding partner now has 30 seats.');
    await waitFor(() => expect(sent('/v1/queries/platform.founding')).toHaveLength(2));
  });

  it('closes an open offer and opens one that would open by itself', async () => {
    await showDesk(<Founding />, () => answers);
    await fireEvent.press(await screen.findByTestId('founding-status-founding_partner'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/founding.set_status')).toEqual({
        offerId: 'founding_partner',
        status: 'closed',
      }),
    );
    await waitFor(() => expect(sent('/v1/queries/platform.founding')).toHaveLength(2));
    await fireEvent.press(screen.getByTestId('founding-status-founding_lifetime'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/founding.set_status')).toEqual({
        offerId: 'founding_lifetime',
        status: 'open',
      }),
    );
  });

  it('shows the database’s refusal in its own words', async () => {
    answers['/v1/commands/founding.set_status'] = null;
    await showDesk(<Founding />, () => answers);
    await fireEvent.press(await screen.findByTestId('founding-status-founding_partner'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NO_SIGNAL));
  });

  it('declines an application', async () => {
    await showDesk(<Founding />, () => answers);
    await fireEvent.press(await screen.findByTestId(`founding-decline-${A1}`));
    await waitFor(() =>
      expect(lastBody('/v1/commands/founding.decline')).toEqual({ applicationId: A1 }),
    );
    expect(toast.show).toHaveBeenCalledWith('Declined Lone Star HVAC.');
  });

  it('approves onto the one business they run, and shows the claim link once', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await showDesk(<Founding />, () => answers);
    await fireEvent.press(await screen.findByTestId(`founding-approve-${A1}`));
    expect(screen.getByText('Approve Lone Star HVAC')).toBeTruthy();
    expect(screen.getByTestId(`founding-business-${WS1}`)).toHaveTextContent(
      'Lone Star HVAC · in Lone Star Group · owner',
    );
    expect(screen.getByTestId(`founding-business-${WS1}`).props.accessibilityState).toMatchObject({
      checked: true,
    });
    await fireEvent.changeText(screen.getByTestId('founding-note'), 'Early, and they’ll talk.');
    await fireEvent.press(screen.getByTestId('founding-approve-go'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/founding.approve')).toEqual({
        applicationId: A1,
        organizationId: ORG1,
        note: 'Early, and they’ll talk.',
      }),
    );
    const link = `${config.webUrl}/founding/${TOKEN}`;
    expect(await screen.findByText('Send Lone Star HVAC their link')).toBeTruthy();
    expect(screen.getByTestId('founding-link')).toHaveTextContent(link);
    await waitFor(() => expect(sent('/v1/queries/platform.founding')).toHaveLength(2));
    await fireEvent.press(screen.getByTestId('founding-link-share'));
    expect(share).toHaveBeenCalledWith({ message: link, url: link });
    // Once it's closed, the link is gone for good: opening Approve again starts a new approval.
    await fireEvent.press(screen.getByTestId('founding-link-done'));
    await fireEvent.press(screen.getByTestId(`founding-approve-${A1}`));
    expect(screen.getByTestId('founding-approve-go')).toBeTruthy();
    expect(screen.getByTestId('founding-note').props.value).toBe('');
    expect(screen.queryByTestId('founding-link')).toBeNull();
  });

  it('finds another business by name for someone who signed up with a different email', async () => {
    await showDesk(<Founding />, () => answers);
    await fireEvent.press(await screen.findByTestId(`founding-approve-${A2}`));
    expect(screen.getByText(FOUNDING_WORDS.noneTheirsHint('rosa@hcplumbing.test'))).toBeTruthy();
    // Nothing is theirs, so it starts on the search, with nothing to approve onto yet.
    expect(screen.getByTestId('founding-business-another').props.accessibilityState).toMatchObject({
      checked: true,
    });
    expect(screen.getByTestId('founding-approve-go').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent.changeText(screen.getByTestId('founding-search'), 'hill');
    await waitFor(() =>
      expect(lastBody('/v1/queries/platform.business.list')).toEqual({
        search: 'hill',
        sort: 'name',
        limit: 20,
      }),
    );
    await fireEvent.press(await screen.findByTestId(`founding-found-${WS2}`));
    expect(screen.getByText(FOUNDING_WORDS.notTheirsHint('rosa@hcplumbing.test'))).toBeTruthy();
    await fireEvent.press(screen.getByTestId('founding-approve-go'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/founding.approve')).toEqual({
        applicationId: A2,
        organizationId: ORG2,
        note: '',
      }),
    );
  });

  it('says in the sheet why an approval was refused', async () => {
    answers['/v1/commands/founding.approve'] = null;
    await showDesk(<Founding />, () => answers);
    await fireEvent.press(await screen.findByTestId(`founding-approve-${A1}`));
    await fireEvent.press(screen.getByTestId('founding-approve-go'));
    expect(await screen.findByTestId('founding-approve-problem')).toHaveTextContent(NO_SIGNAL);
    expect(screen.queryByTestId('founding-link')).toBeNull();
  });

  it('takes a seat back only with a reason, and undoes a revocation', async () => {
    await showDesk(<Founding />, () => answers);
    await fireEvent.press(await screen.findByTestId(`founding-revoke-${G1}`));
    expect(screen.getByText('Take the seat back from Lone Star Group')).toBeTruthy();
    expect(screen.getByTestId('founding-revoke-go').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent.changeText(
      screen.getByTestId('founding-revoke-reason'),
      '  Never took it up, and asked us to.  ',
    );
    await fireEvent.press(screen.getByTestId('founding-revoke-go'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/founding.revoke')).toEqual({
        grantId: G1,
        reason: 'Never took it up, and asked us to.',
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(MONEY_DESK_WORDS.revoked('Lone Star Group'));

    await fireEvent.press(screen.getByTestId(`founding-undo-${G3}`));
    await waitFor(() => expect(lastBody('/v1/commands/founding.restore')).toEqual({ grantId: G3 }));
    expect(toast.show).toHaveBeenCalledWith('Pecan Street Pest has its seat back.');
  });

  it('is for support admins only', async () => {
    await showDesk(<Founding />, () => answers, agent);
    expect(screen.getByText(MONEY_DESK_WORDS.onlyAdmins('Founding'))).toBeTruthy();
    expect(sent('/v1/queries/platform.founding')).toHaveLength(0);
  });

  it('says it needs a signal, asks again on Try again, and by itself once back in signal', async () => {
    answers['/v1/queries/platform.founding'] = null;
    setTestOffline(true);
    await showDesk(<Founding />, () => answers);
    await screen.findByTestId('founding-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('desk-retry'));
    await waitFor(() => expect(sent('/v1/queries/platform.founding')).toHaveLength(2));
    answers['/v1/queries/platform.founding'] = QUEUE;
    await act(async () => setTestOffline(false));
    expect(await screen.findByTestId('founding-offer-founding_partner')).toBeTruthy();
  });
});
