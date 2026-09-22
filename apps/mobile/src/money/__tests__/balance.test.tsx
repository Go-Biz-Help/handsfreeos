import { BALANCE_WORDS } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import Balance from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings/usage';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';

/**
 * Settings → Balance: what the business has left and what it means, the statement behind it, and the three things a
 * person may do to it — each asked for first, because a tap in a pocket charges a card. A member sees the number and
 * none of the buttons (`money.read` without `money.manage`), and with nothing coming back the screen says so rather
 * than showing a balance it doesn't have.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
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

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const business = (role: Business['role']): Business => ({
  id: LONE_STAR,
  name: 'Lone Star HVAC & Roofing',
  organizationId: 'org',
  organizationName: 'Lone Star HVAC & Roofing',
  role,
  timezone: 'America/Chicago',
});

const me = (role: Business['role']): Me => ({
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [business(role)],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
});

const CARD = {
  brand: 'Visa',
  last4: '4242',
  expiryMonth: 4,
  expiryYear: 2028,
  provider: 'stripe',
};

const WALLET = {
  opened: true,
  balanceCents: 2143,
  autoTopup: true,
  floorCents: 1000,
  topupCents: 5000,
  overdraftCents: 0,
  maxTopupCents: 20_000,
  card: CARD,
  cardRequested: false,
  suspended: null,
  spent30dCents: 8800,
  spentThisMonthCents: 4000,
  pendingTopUpCents: null,
  escalation: null,
};

const PRICES = {
  version: 3,
  items: [{ key: 'sms_out', what: 'A text you send', unit: 'each', cents: 2 }],
};

const STATEMENT = {
  items: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'spend',
      amountCents: -2,
      balanceAfterCents: 2143,
      subject: 'A text to Rosa Ortega',
      rateKey: 'sms_out',
      quantity: 1,
      unit: 'message',
      entityType: null,
      entityId: null,
      occurredAt: '2026-09-21T16:12:00.000Z',
    },
  ],
  nextCursor: null,
};

const PAGE_TWO = {
  items: [
    {
      ...STATEMENT.items[0]!,
      id: '33333333-3333-4333-8333-333333333333',
      subject: 'A minute of a call with Rosa Ortega',
      amountCents: -14,
      balanceAfterCents: 2145,
    },
  ],
  nextCursor: null,
};

/** What the API says, per path. A path given a `null` answer fails instead, as no signal does. */
let answers: Record<string, unknown>;

/** The stand-in API, typed plainly: openapi-fetch's own signature is too deep for a mock to wear. */
const post = api.POST as unknown as jest.Mock<
  Promise<{ data: unknown }>,
  [string, { body: Record<string, unknown> }]
>;

function mockApi() {
  post.mockImplementation(async (path, init) => {
    // The statement's second page is a different page, as it is in life.
    if (path === '/v1/queries/usage.statement' && init.body.cursor) return { data: PAGE_TWO };
    const answer = answers[path];
    if (answer === undefined) return { data: {} };
    if (answer === null) throw new Error('No signal. Try again when you’re back online.');
    return { data: answer };
  });
}

async function show(role: Business['role'] = 'owner') {
  mockApi();
  await render(
    <BusinessProvider
      value={{
        userId: DALE,
        me: me(role),
        business: business(role),
        openSwitcher: () => undefined,
      }}
    >
      <Balance />
    </BusinessProvider>,
  );
  await waitFor(() => expect(sent('/v1/queries/wallet.get')).toHaveLength(1));
}

const sent = (path: string) => post.mock.calls.filter((call) => call[0] === path);

beforeEach(() => {
  jest.clearAllMocks();
  answers = {
    '/v1/queries/wallet.get': WALLET,
    '/v1/queries/usage.prices': PRICES,
    '/v1/queries/usage.statement': STATEMENT,
    '/v1/commands/wallet.top_up': {
      rechargeId: DALE,
      workspaceId: LONE_STAR,
      amountCents: 5000,
      status: 'pending',
    },
    '/v1/commands/wallet.set_auto_topup': { workspaceId: LONE_STAR },
    '/v1/commands/wallet.forget_card': { workspaceId: LONE_STAR, hasCard: false },
  };
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

it('shows what is left, what it means, the prices and the statement', async () => {
  await show();
  expect(await screen.findByTestId('balance-left')).toHaveTextContent('$21.43');
  expect(screen.getByTestId('balance-headline')).toHaveTextContent('You’re fine');
  expect(screen.getByText(BALANCE_WORDS.thisMonth(4000))).toBeTruthy();
  expect(screen.getByText('A text you send')).toBeTruthy();
  expect(screen.getAllByTestId('balance-statement-row')).toHaveLength(1);
  expect(screen.getByText('A text to Rosa Ortega')).toBeTruthy();
  // The card the top-ups are charged to, the way the web writes it.
  expect(screen.getByText('Visa ending 4242 · expires 04/28')).toBeTruthy();
});

it('says what a balance that has run out means, and what stopped', async () => {
  answers['/v1/queries/wallet.get'] = {
    ...WALLET,
    balanceCents: 0,
    suspended: { at: '2026-09-21T16:00:00.000Z', reason: 'The card was declined.' },
    pendingTopUpCents: 5000,
  };
  await show();
  expect(await screen.findByTestId('balance-headline')).toHaveTextContent(
    'Texts and calls have stopped',
  );
  expect(screen.getByTestId('balance-suspended')).toHaveTextContent(
    `The card was declined. ${BALANCE_WORDS.suspendedTail}`,
  );
  expect(screen.getByTestId('balance-pending')).toHaveTextContent(BALANCE_WORDS.onItsWay(5000));
});

it('asks with the amount and the card before it charges anything', async () => {
  await show();
  await fireEvent.press(await screen.findByTestId('balance-top-up'));
  expect(
    screen.getByText(BALANCE_WORDS.topUpAsk(5000, 'Visa ending 4242 · expires 04/28')),
  ).toBeTruthy();
  expect(sent('/v1/commands/wallet.top_up')).toHaveLength(0);

  await fireEvent.press(screen.getByTestId('balance-top-up-confirm'));
  await waitFor(() => expect(sent('/v1/commands/wallet.top_up')).toHaveLength(1));
  expect(toast.show).toHaveBeenCalledWith(BALANCE_WORDS.toppingUp);
  // Every command is followed by reading the balance back: it has just changed.
  await waitFor(() => expect(sent('/v1/queries/wallet.get')).toHaveLength(2));
});

it('refuses a top-up under the smallest one, then saves the amount', async () => {
  await show();
  await fireEvent.press(await screen.findByTestId('balance-amount'));
  await fireEvent.changeText(screen.getByTestId('balance-amount-input'), '2');
  await fireEvent.press(screen.getByTestId('balance-amount-save'));
  expect(screen.getByTestId('balance-amount-refused')).toHaveTextContent(
    BALANCE_WORDS.amountTooSmall,
  );
  expect(sent('/v1/commands/wallet.set_auto_topup')).toHaveLength(0);

  await fireEvent.changeText(screen.getByTestId('balance-amount-input'), '25');
  await fireEvent.press(screen.getByTestId('balance-amount-save'));
  await waitFor(() => expect(sent('/v1/commands/wallet.set_auto_topup')).toHaveLength(1));
  expect(sent('/v1/commands/wallet.set_auto_topup')[0]![1]).toEqual({
    body: { workspaceId: LONE_STAR, topupCents: 2500 },
  });
});

it('turns automatic top-up off through the same command', async () => {
  await show();
  await fireEvent(await screen.findByTestId('balance-auto-switch'), 'checkedChange', false);
  await waitFor(() => expect(sent('/v1/commands/wallet.set_auto_topup')).toHaveLength(1));
  expect(sent('/v1/commands/wallet.set_auto_topup')[0]![1]).toEqual({
    body: { workspaceId: LONE_STAR, autoTopup: false },
  });
  expect(toast.show).toHaveBeenCalledWith(BALANCE_WORDS.autoOff);
});

it('asks before taking the card off', async () => {
  await show();
  await fireEvent.press(await screen.findByTestId('balance-forget-card'));
  expect(sent('/v1/commands/wallet.forget_card')).toHaveLength(0);
  await fireEvent.press(screen.getByTestId('balance-forget-card-confirm'));
  await waitFor(() => expect(sent('/v1/commands/wallet.forget_card')).toHaveLength(1));
  expect(toast.show).toHaveBeenCalledWith(BALANCE_WORDS.cardRemoved);
});

it('sends somebody with no card to the page a card is typed on', async () => {
  answers['/v1/queries/wallet.get'] = { ...WALLET, card: null, autoTopup: false };
  await show();
  expect(await screen.findByText(BALANCE_WORDS.cardNone)).toBeTruthy();
  expect(screen.getByTestId('balance-add-card')).toBeTruthy();
  // Nothing to charge, so neither the top-up nor the switch is live.
  expect(screen.getByTestId('balance-top-up')).toBeDisabled();
  expect(screen.getByTestId('balance-auto-switch')).toBeDisabled();
});

it('shows a member the balance and none of the ways to spend it', async () => {
  await show('member');
  expect(await screen.findByTestId('balance-left')).toHaveTextContent('$21.43');
  expect(screen.getByTestId('balance-member')).toHaveTextContent(BALANCE_WORDS.memberNote);
  expect(screen.queryByTestId('balance-top-up')).toBeNull();
  expect(screen.queryByTestId('balance-forget-card')).toBeNull();
  expect(screen.queryByTestId('balance-add-card')).toBeNull();
  // The two amounts are shown, and open nothing.
  expect(screen.getByTestId('balance-floor')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('balance-floor'));
  expect(screen.queryByTestId('balance-amount-input')).toBeNull();
});

it('says when it has nothing rather than a balance it does not have, and tries again', async () => {
  answers['/v1/queries/wallet.get'] = null;
  await show();
  expect(await screen.findByTestId('balance-error')).toBeTruthy();
  expect(screen.queryByTestId('balance-card')).toBeNull();

  answers['/v1/queries/wallet.get'] = WALLET;
  await fireEvent.press(screen.getByTestId('balance-retry'));
  expect(await screen.findByTestId('balance-left')).toHaveTextContent('$21.43');
});

it('asks for the next page of the statement', async () => {
  answers['/v1/queries/usage.statement'] = { ...STATEMENT, nextCursor: 'next-page' };
  await show();
  await fireEvent.press(await screen.findByTestId('balance-statement-more'));
  await waitFor(() => expect(sent('/v1/queries/usage.statement')).toHaveLength(2));
  expect(sent('/v1/queries/usage.statement')[1]![1]).toEqual({
    body: { workspaceId: LONE_STAR, limit: 25, cursor: 'next-page' },
  });
  // The page is added under the first one rather than replacing it.
  expect(await screen.findAllByTestId('balance-statement-row')).toHaveLength(2);
  expect(screen.getByText('A minute of a call with Rosa Ortega')).toBeTruthy();
});
