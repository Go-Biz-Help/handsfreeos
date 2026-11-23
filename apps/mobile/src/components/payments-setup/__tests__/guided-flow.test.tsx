import {
  defaultMoneySettings,
  GUIDED_SETUP_WORDS as G,
  PAYMENTS_SETUP_WORDS as W,
  type MoneySettings,
} from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as React from 'react';

import PaymentsSetup from '@/app/app/w/[workspaceId]/payments-setup';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';

/**
 * The guided payments setup on the phone (the owner, 23 Nov 2026, P1 to P4 a), with HandsFreeOS played by a stand-in:
 * the seven questions one a screen, starting from what a roofer usually picks, through Check it over to Save and the
 * Stripe sign-in last; the same questions without the first once an account is connected; and someone who can't
 * change the business's payments.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })),
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));
jest.mock('@/lib/config', () => ({
  config: {
    ...jest.requireActual<{ config: object }>('@/lib/config').config,
    workerUrl: 'https://worker.test',
    payPalEnabled: false,
  },
}));
jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
}));
jest.mock('@/lib/auth', () => ({
  session: { accessToken: async () => 'token-1', signOut: jest.fn(async () => undefined) },
  useSession: () => ({
    status: 'signedIn',
    person: { userId: '11111111-1111-4111-8111-111111111111', name: 'Dale' },
    expiresAt: 0,
  }),
}));
jest.mock('@/admin/staff', () => ({ useStaff: () => ({ staff: null, status: 'ready' }) }));
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: true, lastOnlineAt: 0 }),
  networkSnapshot: () => ({ online: true, lastOnlineAt: 0 }),
  subscribeNetwork: () => () => undefined,
  isTestOffline: () => false,
  appFetch: jest.fn(),
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const stripe = (capabilities: Record<string, boolean>) => ({
  id: ACCOUNT,
  provider: 'stripe',
  status: 'active',
  label: null,
  displayName: 'Lone Star HVAC',
  isDefault: true,
  capabilities,
});

let answers: Record<string, unknown>;
const post = api.POST as unknown as jest.Mock<
  Promise<{ data?: unknown; error?: unknown; response: Response }>,
  [string, { body: Record<string, unknown> }]
>;
const sent = (path: string) => post.mock.calls.filter((c) => c[0] === path).map((c) => c[1].body);

function serve() {
  post.mockImplementation(async (path, { body }) => {
    const answer = answers[path];
    const value = typeof answer === 'function' ? (answer as (b: unknown) => unknown)(body) : answer;
    return { data: value ?? {}, response: new Response(null, { status: 200 }) };
  });
}

const open = (role: Business['role'] = 'owner') => {
  const business: Business = {
    id: LONE_STAR,
    name: 'Lone Star HVAC',
    organizationId: 'org',
    organizationName: 'Lone Star HVAC',
    role,
    timezone: 'America/Chicago',
  };
  const me: Me = {
    user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
    businesses: [business],
    organizations: [],
    fetchedAt: 0,
  };
  return render(
    <BusinessProvider value={{ userId: DALE, me, business, openSwitcher: () => undefined }}>
      <PaymentsSetup />
    </BusinessProvider>,
  );
};
const next = () => fireEvent.press(screen.getByTestId('payments-setup-next'));
const money = (settings: MoneySettings = defaultMoneySettings()) => ({
  settings,
  nextEstimateNumber: 'EST-1001',
  nextInvoiceNumber: 'INV-1001',
});

beforeEach(() => {
  jest.clearAllMocks();
  answers = {
    '/v1/queries/workspace.get': {
      workspace: {
        id: LONE_STAR,
        name: 'Lone Star HVAC',
        industry: 'roofing',
        settings: {
          address: {
            line1: '2210 Oak St',
            line2: '',
            city: 'Houston',
            state: 'TX',
            postalCode: '77002',
          },
        },
      },
    },
    '/v1/queries/money.settings': money(),
    '/v1/queries/payment_connection.list': { connections: [] },
    '/v1/queries/guided_setup.get_draft': { setup: 'payments', answers: null, savedAt: null },
    '/v1/commands/guided_setup.save_draft': { savedAt: '2026-11-23T07:00:00.000Z' },
    '/v1/commands/guided_setup.clear_draft': { cleared: true },
    '/v1/commands/money.save_settings': ({ settings }: { settings: MoneySettings }) => ({
      workspaceId: LONE_STAR,
      settings,
      nextEstimateNumber: 'EST-1001',
      nextInvoiceNumber: 'INV-1001',
      changed: true,
    }),
    '/v1/commands/payment_connection.connect': { connectionId: ACCOUNT, state: 'st-1' },
  };
  serve();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('a business with no account yet', () => {
  it('asks the seven questions, saves, then opens the Stripe sign-in last', async () => {
    await open();
    // 1. Where payments go: Stripe, with the starting answers from what a roofer usually picks.
    await screen.findByTestId('payments-setup-screen-where');
    expect(screen.getByText(G.question(1, 7))).toBeTruthy();
    expect(screen.getByTestId('payments-setup-where-stripe')).toBeChecked();
    expect(screen.getByTestId('payments-setup-usual')).toHaveTextContent(W.usualFor('Roofing'));
    // PayPal isn't open yet.
    expect(screen.getByTestId('payments-setup-where-paypal')).toBeDisabled();
    await next();

    // 2. Ways to pay: bank transfer on.
    await screen.findByTestId('payments-setup-screen-ways');
    await next();

    // 3. Sales tax: never guessed, so Next asks; then a rate.
    await screen.findByTestId('payments-setup-screen-tax');
    await next();
    expect(screen.getByText(W.problems.tax)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('payments-setup-tax-yes'));
    await fireEvent.changeText(screen.getByTestId('payments-setup-tax-rate'), '30');
    await next();
    expect(screen.getByText(W.problems.taxRate)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('payments-setup-tax-rate'), '8.25');
    await next();

    // 4. Due in 14 days, as roofers usually pick.
    await screen.findByTestId('payments-setup-screen-due');
    expect(screen.getByTestId('payments-setup-due-net_14')).toBeChecked();
    await next();

    // 5. Estimates good for 30 days, a quarter up front.
    await screen.findByTestId('payments-setup-screen-estimates');
    expect(screen.getByTestId('payments-setup-estimate-days')).toHaveDisplayValue('30');
    expect(screen.getByTestId('payments-setup-deposit-percent-value')).toHaveDisplayValue('25');
    await next();

    // 6. The usual reminders.
    await screen.findByTestId('payments-setup-screen-reminders');
    expect(screen.getByTestId('payments-setup-reminders-usual')).toBeChecked();
    await next();

    // 7. What goes on every invoice: the address from setup.
    await screen.findByTestId('payments-setup-screen-documents');
    expect(screen.getByTestId('payments-setup-address')).toHaveDisplayValue(
      '2210 Oak St\nHouston, TX 77002',
    );
    expect(screen.getByText(G.checkItOver)).toBeTruthy();
    await next();

    // Check it over.
    await screen.findByTestId('payments-setup-screen-review');
    expect(screen.getByTestId('payments-review-tax')).toHaveTextContent(
      '8.25%, called “Sales tax”',
      { exact: false },
    );
    await waitFor(() =>
      expect(sent('/v1/commands/guided_setup.save_draft').at(-1)).toMatchObject({
        workspaceId: LONE_STAR,
        setup: 'payments',
        answers: { mode: 'new', at: 'review', tax: 'yes', taxRate: '8.25' },
      }),
    );

    // Save and connect Stripe: the settings, then Stripe's own sign-in, which comes back still checking.
    answers['/v1/queries/payment_connection.list'] = { connections: [stripe({})] };
    await fireEvent.press(screen.getByTestId('payments-setup-next'));
    await waitFor(() => expect(sent('/v1/commands/money.save_settings')).toHaveLength(1));
    expect(sent('/v1/commands/money.save_settings')[0]).toMatchObject({
      workspaceId: LONE_STAR,
      settings: {
        terms: 'net_14',
        tax: { rateBp: 825, name: 'Sales tax' },
        estimateGoodForDays: 30,
        deposit: { kind: 'percent', percentBp: 2500 },
        businessAddress: '2210 Oak St\nHouston, TX 77002',
      },
    });
    await waitFor(() =>
      expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(
        'https://worker.test/oauth/stripe/start?state=st-1',
      ),
    );
    expect(sent('/v1/commands/payment_connection.connect')).toEqual([
      { workspaceId: LONE_STAR, provider: 'stripe' },
    ]);
    await screen.findByText(W.done.title);
    expect(await screen.findByText(W.done.checking('Stripe'))).toBeTruthy();
    expect(sent('/v1/commands/guided_setup.clear_draft')).toHaveLength(1);
    expect(screen.getByTestId('payments-setup-done-chips')).toHaveTextContent('8.25% sales tax', {
      exact: false,
    });
  });

  it('saves without a sign-in for Not now, and skips ways to pay', async () => {
    await open();
    await screen.findByTestId('payments-setup-screen-where');
    await fireEvent.press(screen.getByTestId('payments-setup-where-later'));
    await next();
    await screen.findByTestId('payments-setup-screen-tax');
    expect(screen.getByText(G.question(2, 6))).toBeTruthy();
  });
});

describe('a business with an account connected', () => {
  it('asks the same questions without the first, from its own settings, and goes back once saved', async () => {
    answers['/v1/queries/payment_connection.list'] = { connections: [stripe({ card: true })] };
    answers['/v1/queries/money.settings'] = money({
      ...defaultMoneySettings(),
      terms: 'net_30',
      tax: { rateBp: 700, name: 'Tax', newProductsTaxable: true },
    });
    await open();
    await screen.findByTestId('payments-setup-screen-ways');
    expect(screen.getByText(G.question(1, 6))).toBeTruthy();
    for (const q of ['tax', 'due', 'estimates', 'reminders', 'documents']) {
      await next();
      await screen.findByTestId(`payments-setup-screen-${q}`);
    }
    await next();
    await screen.findByTestId('payments-setup-screen-review');
    expect(screen.getByText(W.review.save)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('payments-setup-next'));
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(sent('/v1/commands/money.save_settings')[0]).toMatchObject({
      settings: { terms: 'net_30', tax: { rateBp: 700, name: 'Tax' } },
    });
    expect(toast.show).toHaveBeenCalledWith(W.review.saved);
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });
});

it('is only for someone who can change the business’s payments', async () => {
  await open('member');
  expect(await screen.findByTestId('payments-setup-not-allowed')).toHaveTextContent(W.notAllowed);
  expect(post).not.toHaveBeenCalled();
});
