import { DESK_BUSINESS_WORDS, DESK_WALLET_STAGES, DESK_WALLET_WORDS } from '@hfos/core';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

import { DESK_BUSINESS_PHONE_WORDS } from '@/admin/business-words';
import { DESK_PHONE_WORDS } from '@/admin/words';
import Business from '@/app/app/admin/businesses/[workspaceId]';
import Businesses from '@/app/app/admin/businesses';
import { toast } from '@/components/ui/toast';
import { setTestOffline } from '@/lib/network';

import {
  ADMIN_PERMISSIONS,
  admin,
  agent,
  LONE_STAR,
  RILEY,
  SAM,
  lastBody,
  sent,
  showDesk,
  type Answers,
} from './kit';

/**
 * Businesses on the phone's Support desk (the web's /admin/businesses): the directory with its totals, search, orders
 * and paging, and one business with its counts, people, balance, the model its calls think with and whether it is
 * HandsFreeOS's own. Every change is the web's command with the web's body, and only a role that may make it sees it.
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

const BAYOU = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TICKET = '33333333-3333-4333-8333-333333333333';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const row = (over: Record<string, unknown> = {}) => ({
  workspaceId: LONE_STAR,
  name: 'Lone Star HVAC',
  organizationId: null,
  organizationName: 'Lone Star Group',
  industry: 'hvac',
  timezone: 'America/Chicago',
  memberCount: 4,
  lastActiveAt: minutesAgo(180),
  openTicketCount: 2,
  createdAt: '2026-08-01T15:00:00.000Z',
  ...over,
});

const LIST = {
  businesses: [
    row(),
    row({
      workspaceId: BAYOU,
      name: 'Bayou Plumbing',
      organizationName: '',
      memberCount: 1,
      lastActiveAt: null,
      openTicketCount: 0,
    }),
  ],
  nextCursor: null,
  totals: { businesses: 212, newThisWeek: 9, activeThisWeek: 140 },
};

const DETAIL = {
  business: row(),
  phoneModel: null,
  isPlatform: false,
  people: [
    {
      userId: SAM,
      fullName: 'Dale Ramsey',
      email: 'dale@lonestarhvac.test',
      role: 'owner',
      lastActiveAt: minutesAgo(30),
    },
    {
      userId: RILEY,
      fullName: '',
      email: 'tech@lonestarhvac.test',
      role: 'member',
      lastActiveAt: null,
    },
  ],
  counts: { people: 340, leads: 12, conversations: 88, appointments: 21, invoices: 57 },
  tickets: [
    {
      id: TICKET,
      number: 1042,
      subject: 'Texts not going out',
      status: 'open',
      createdAt: minutesAgo(40),
    },
  ],
  setup: { phone: true, email: true, payments: false, calendar: true, aiTeammate: false },
};

const WALLET = {
  opened: true,
  stage: 'warn',
  balanceCents: 1250,
  autoTopup: true,
  floorCents: 1000,
  topupCents: 2500,
  hasCard: true,
  cardBrand: 'Visa',
  cardLast4: '4242',
  suspendedAt: null,
  suspendedReason: null,
  declinesInRow: 0,
  escalationStep: 0,
  spent30dCents: 4200,
  cost30dCents: 3000,
  toppedUp30dCents: 5000,
};

/** A support admin who may not mark HandsFreeOS's own business, as a staff role without it would be. */
const notOwnMarker = {
  ...admin,
  permissions: ADMIN_PERMISSIONS.filter((p) => p !== 'platform.own_business.manage'),
};

let answers: Answers;

beforeEach(() => {
  jest.clearAllMocks();
  setTestOffline(false);
  mockParams = { workspaceId: LONE_STAR };
  answers = {
    '/v1/queries/platform.business.list': LIST,
    '/v1/queries/platform.business.get': DETAIL,
    '/v1/queries/platform.wallet.get': WALLET,
    '/v1/commands/wallet.set_stage': {
      workspaceId: LONE_STAR,
      was: 'warn',
      stage: 'enforce',
      changed: true,
    },
    '/v1/commands/wallet.adjust': {},
    '/v1/commands/phone_model.set': {
      workspaceId: LONE_STAR,
      was: null,
      model: 'claude-haiku-4-5',
      changed: true,
    },
    '/v1/commands/own_business.set': {
      workspaceId: LONE_STAR,
      was: false,
      on: true,
      changed: true,
    },
  };
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('the directory', () => {
  it('shows the three totals and every business, newest first', async () => {
    await showDesk(<Businesses />, () => answers);
    expect(await screen.findByText('Lone Star HVAC')).toBeTruthy();
    expect(lastBody('/v1/queries/platform.business.list')).toEqual({ sort: 'newest', limit: 25 });
    expect(screen.getByTestId('business-totals')).toHaveTextContent(
      'On HandsFreeOS212Signed up this week9Did something this week140',
    );
    expect(screen.getByText('4 people · last active 3 hours')).toBeTruthy();
    expect(screen.getByText('1 person · last active never')).toBeTruthy();
    expect(screen.getByTestId(`business-open-${LONE_STAR}`)).toHaveTextContent('2 open tickets');
    expect(screen.queryByTestId(`business-open-${BAYOU}`)).toBeNull();
    // Nothing more to page through.
    expect(screen.queryByTestId('businesses-more')).toBeNull();
  });

  it('puts them in another order, and searches a moment after the typing stops', async () => {
    await showDesk(<Businesses />, () => answers);
    await screen.findByText('Lone Star HVAC');
    await fireEvent.press(screen.getByTestId('business-sort-quietest'));
    await waitFor(() =>
      expect(lastBody('/v1/queries/platform.business.list')).toEqual({
        sort: 'quietest',
        limit: 25,
      }),
    );
    answers['/v1/queries/platform.business.list'] = { ...LIST, businesses: [] };
    await fireEvent.changeText(screen.getByTestId('business-search'), 'Bayou ');
    await waitFor(() =>
      expect(lastBody('/v1/queries/platform.business.list')).toEqual({
        search: 'Bayou',
        sort: 'quietest',
        limit: 25,
      }),
    );
    expect(await screen.findByText(DESK_BUSINESS_WORDS.nothingMatches)).toBeTruthy();
  });

  it('shows more, from where the first page stopped', async () => {
    answers['/v1/queries/platform.business.list'] = (body: Record<string, unknown>) =>
      body.cursor
        ? { ...LIST, businesses: [LIST.businesses[1]], nextCursor: null }
        : { ...LIST, businesses: [LIST.businesses[0]], nextCursor: '2026-08-01T15:00:00.000Z' };
    await showDesk(<Businesses />, () => answers);
    await screen.findByText('Lone Star HVAC');
    expect(screen.queryByText('Bayou Plumbing')).toBeNull();
    await fireEvent.press(screen.getByTestId('businesses-more'));
    expect(await screen.findByText('Bayou Plumbing')).toBeTruthy();
    expect(lastBody('/v1/queries/platform.business.list')).toEqual({
      sort: 'newest',
      cursor: '2026-08-01T15:00:00.000Z',
      limit: 25,
    });
    expect(screen.getByText('Lone Star HVAC')).toBeTruthy();
  });

  it('opens on the order and search a link to the web’s page asked for', async () => {
    mockParams = { sort: 'quietest', q: 'bayou' };
    await showDesk(<Businesses />, () => answers);
    await screen.findByText('Lone Star HVAC');
    expect(lastBody('/v1/queries/platform.business.list')).toEqual({
      search: 'bayou',
      sort: 'quietest',
      limit: 25,
    });
    expect(screen.getByTestId('business-search').props.value).toBe('bayou');
  });

  it('opens a business from its row', async () => {
    await showDesk(<Businesses />, () => answers);
    await fireEvent.press(await screen.findByTestId(`business-row-${LONE_STAR}`));
    expect(router.push).toHaveBeenCalledWith(`/app/admin/businesses/${LONE_STAR}`);
  });

  it('says it needs a signal, and asks again once the phone is back in signal', async () => {
    answers['/v1/queries/platform.business.list'] = null;
    setTestOffline(true);
    await showDesk(<Businesses />, () => answers);
    await screen.findByTestId('businesses-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
    answers['/v1/queries/platform.business.list'] = LIST;
    await act(() => setTestOffline(false));
    expect(await screen.findByText('Lone Star HVAC')).toBeTruthy();
  });

  it('says what went wrong, and Try again asks once more', async () => {
    answers['/v1/queries/platform.business.list'] = null;
    await showDesk(<Businesses />, () => answers);
    expect(await screen.findByText('No signal. Try again when you’re back online.')).toBeTruthy();
    answers['/v1/queries/platform.business.list'] = LIST;
    await fireEvent.press(screen.getByTestId('desk-retry'));
    expect(await screen.findByText('Lone Star HVAC')).toBeTruthy();
  });

  it('is left closed to a role without the directory, and asks nothing', async () => {
    await showDesk(<Businesses />, () => answers, { ...agent, permissions: ['support.read'] });
    expect(screen.getByTestId('businesses-not-yours')).toHaveTextContent(
      DESK_BUSINESS_PHONE_WORDS.notYourRole('businesses'),
    );
    expect(sent('/v1/queries/platform.business.list')).toHaveLength(0);
  });
});

describe('one business', () => {
  it('shows who is in it, how much is in it, what is set up and their tickets', async () => {
    await showDesk(<Business />, () => answers);
    expect(await screen.findByTestId('business-name')).toHaveTextContent('Lone Star HVAC');
    expect(lastBody('/v1/queries/platform.business.get')).toEqual({ workspaceId: LONE_STAR });
    expect(lastBody('/v1/queries/platform.wallet.get')).toEqual({ workspaceId: LONE_STAR });
    expect(screen.getByTestId('business-headline')).toHaveTextContent(
      `Lone Star Group · signed up ${new Date('2026-08-01T15:00:00.000Z').toLocaleDateString()} · last active 3 hours ago`,
    );
    expect(screen.getByTestId('business-counts')).toHaveTextContent(
      'Contacts340Leads12Conversations88Appointments21Invoices57',
    );
    expect(screen.getByTestId('business-setup-phone')).toHaveTextContent('Texting and callsYes');
    expect(screen.getByTestId('business-setup-payments')).toHaveTextContent('Taking moneyNot yet');
    expect(screen.getByTestId('business-people')).toHaveTextContent(
      'Dale Ramsey · owner30 minutestech@lonestarhvac.test · membernever',
      { exact: false },
    );
    expect(screen.getByTestId('business-ticket-1042')).toHaveTextContent(
      '#1042 Texts not going out · Open ·',
      { exact: false },
    );
    await fireEvent.press(screen.getByTestId('business-ticket-1042'));
    expect(router.push).toHaveBeenCalledWith(`/app/admin/tickets/${TICKET}`);
  });

  it('says they have never written in', async () => {
    answers['/v1/queries/platform.business.get'] = { ...DETAIL, tickets: [] };
    await showDesk(<Business />, () => answers);
    expect(await screen.findByText(DESK_BUSINESS_WORDS.neverWrittenIn)).toBeTruthy();
  });

  it('shows their balance line by line, cost beside price', async () => {
    await showDesk(<Business />, () => answers);
    await screen.findByTestId('business-wallet');
    expect(screen.getByTestId('wallet-stage')).toHaveTextContent('Warned');
    expect(screen.getByTestId('wallet-lines')).toHaveTextContent(
      'Balance$12.50CardVisa ····4242Automatic top-up$25 below $10Topped up, 30 days$50Charged them, 30 days$42Cost us, 30 days$30 · 1.40×',
    );
    expect(screen.getByText(DESK_WALLET_STAGES.warn.what)).toBeTruthy();
  });

  it('says a balance has never been opened, and when one is suspended', async () => {
    answers['/v1/queries/platform.wallet.get'] = {
      ...WALLET,
      opened: false,
      suspendedAt: '2026-09-20T12:00:00.000Z',
      suspendedReason: null,
    };
    await showDesk(<Business />, () => answers);
    expect(await screen.findByText(DESK_WALLET_WORDS.notOpened)).toBeTruthy();
    expect(screen.getByTestId('wallet-suspended')).toHaveTextContent(
      `Suspended ${new Date('2026-09-20T12:00:00.000Z').toLocaleDateString()} · the card was declined`,
    );
  });

  it('moves them along the rollout with a reason, and asks for the business again', async () => {
    await showDesk(<Business />, () => answers);
    await screen.findByTestId('business-wallet');
    // Every stage but the one they're on.
    expect(screen.queryByTestId('wallet-to-warn')).toBeNull();
    await fireEvent.press(screen.getByTestId('wallet-to-enforce'));
    expect(screen.getByText('Move Lone Star HVAC to stopped at zero')).toBeTruthy();
    expect(screen.getByText(DESK_WALLET_WORDS.enforceWarning)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('wallet-move-confirm'));
    expect(screen.getByTestId('wallet-move-error')).toHaveTextContent(DESK_WALLET_WORDS.sayWhy);
    expect(sent('/v1/commands/wallet.set_stage')).toHaveLength(0);
    await fireEvent.changeText(
      screen.getByTestId('wallet-move-reason'),
      '  First cohort, card on file  ',
    );
    await fireEvent.press(screen.getByTestId('wallet-move-confirm'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/wallet.set_stage')).toEqual({
        workspaceId: LONE_STAR,
        stage: 'enforce',
        reason: 'First cohort, card on file',
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(DESK_BUSINESS_PHONE_WORDS.movedTo('enforce'));
    await waitFor(() => expect(sent('/v1/queries/platform.business.get')).toHaveLength(2));
  });

  it('says what an agency-paid balance moving off writes off', async () => {
    answers['/v1/queries/platform.wallet.get'] = {
      ...WALLET,
      stage: 'agency',
      balanceCents: -1840,
    };
    await showDesk(<Business />, () => answers);
    await fireEvent.press(await screen.findByTestId('wallet-to-warn'));
    expect(screen.getByText(DESK_WALLET_WORDS.writtenOff(1840))).toBeTruthy();
  });

  it('puts a credit on with its own reference, and refuses one with no amount', async () => {
    await showDesk(<Business />, () => answers);
    await fireEvent.press(await screen.findByTestId('wallet-credit'));
    expect(screen.getByTestId('wallet-credit-amount').props.value).toBe('25');
    await fireEvent.changeText(screen.getByTestId('wallet-credit-amount'), 'twelve');
    await fireEvent.changeText(
      screen.getByTestId('wallet-credit-reason'),
      'The outage on the 14th',
    );
    await fireEvent.press(screen.getByTestId('wallet-credit-confirm'));
    expect(screen.getByTestId('wallet-credit-error')).toHaveTextContent(
      DESK_WALLET_WORDS.putInAmount,
    );
    expect(sent('/v1/commands/wallet.adjust')).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId('wallet-credit-amount'), '-7.5');
    await fireEvent.press(screen.getByTestId('wallet-credit-confirm'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/wallet.adjust')).toEqual({
        workspaceId: LONE_STAR,
        amountCents: -750,
        reason: 'The outage on the 14th',
        reference: expect.stringMatching(new RegExp(`^admin:${LONE_STAR}:\\d+$`)),
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(DESK_BUSINESS_PHONE_WORDS.creditPutOn);
  });

  it('shows the API’s words in the sheet when a move is refused', async () => {
    answers['/v1/commands/wallet.set_stage'] = null;
    await showDesk(<Business />, () => answers);
    await fireEvent.press(await screen.findByTestId('wallet-to-off'));
    await fireEvent.changeText(screen.getByTestId('wallet-move-reason'), 'Back to silent');
    await fireEvent.press(screen.getByTestId('wallet-move-confirm'));
    await waitFor(() =>
      expect(screen.getByTestId('wallet-move-error')).toHaveTextContent(
        'No signal. Try again when you’re back online.',
      ),
    );
  });

  it('picks the model their calls think with, and asks for the business again', async () => {
    await showDesk(<Business />, () => answers);
    await fireEvent.press(await screen.findByTestId('phone-model-claude-haiku-4-5'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/phone_model.set')).toEqual({
        workspaceId: LONE_STAR,
        model: 'claude-haiku-4-5',
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(DESK_PHONE_WORDS.saved);
    answers['/v1/queries/platform.business.get'] = { ...DETAIL, phoneModel: 'claude-haiku-4-5' };
    await waitFor(() => expect(sent('/v1/queries/platform.business.get')).toHaveLength(2));
    await screen.findByTestId('phone-model-default');
  });

  it('puts a model back on the default', async () => {
    answers['/v1/queries/platform.business.get'] = { ...DETAIL, phoneModel: 'claude-haiku-4-5' };
    await showDesk(<Business />, () => answers);
    await fireEvent.press(await screen.findByTestId('phone-model-default'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/phone_model.set')).toEqual({
        workspaceId: LONE_STAR,
        model: null,
      }),
    );
  });

  it('marks HandsFreeOS’s own business, for a support admin who may', async () => {
    await showDesk(<Business />, () => answers);
    await fireEvent.press(await screen.findByTestId('own-business-yes'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/own_business.set')).toEqual({
        workspaceId: LONE_STAR,
        on: true,
      }),
    );
  });

  it('shows an agent the page but none of the switches', async () => {
    await showDesk(<Business />, () => answers, agent);
    await screen.findByTestId('business-wallet');
    expect(screen.queryByTestId('wallet-to-off')).toBeNull();
    expect(screen.queryByTestId('wallet-credit')).toBeNull();
    expect(screen.queryByTestId('phone-model-default')).toBeNull();
    expect(screen.getByTestId('phone-model-value')).toHaveTextContent('Default');
    expect(screen.queryByTestId('own-business-no')).toBeNull();
    expect(screen.getByTestId('own-business-value')).toHaveTextContent('No');
    // Looking at the business stays on the web, read-only with a reason.
    const { openWeb } = jest.requireMock('@/lib/open-web') as { openWeb: jest.Mock };
    expect(screen.getByTestId('business-look-on-web')).toHaveTextContent(
      DESK_PHONE_WORDS.lookOnWeb,
    );
    await fireEvent.press(screen.getByTestId('business-look-on-web'));
    expect(openWeb).toHaveBeenCalledWith(`/admin/businesses/${LONE_STAR}`);
  });

  it('keeps own-business marking to those who may, and opens as owner for the founder', async () => {
    await showDesk(<Business />, () => answers, { ...notOwnMarker, founder: true });
    await screen.findByTestId('business-wallet');
    expect(screen.getByTestId('wallet-to-off')).toBeTruthy();
    expect(screen.queryByTestId('own-business-yes')).toBeNull();
    expect(screen.getByTestId('business-look-on-web')).toHaveTextContent(
      DESK_PHONE_WORDS.openAsOwnerOnWeb,
    );
  });

  it('leaves out looking at the business for a role without it', async () => {
    await showDesk(<Business />, () => answers, {
      ...agent,
      permissions: agent.permissions.filter((p) => p !== 'platform.view_as'),
    });
    await screen.findByTestId('business-wallet');
    expect(screen.queryByTestId('business-look-on-web')).toBeNull();
  });

  it('says it needs a signal', async () => {
    answers['/v1/queries/platform.wallet.get'] = null;
    setTestOffline(true);
    await showDesk(<Business />, () => answers);
    await screen.findByTestId('business-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
  });
});
