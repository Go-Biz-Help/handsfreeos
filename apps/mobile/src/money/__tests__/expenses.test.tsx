import { EXPENSES_ONLY_MANAGERS } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import Expenses from '@/app/app/w/[workspaceId]/money/expenses';
import { parseDay } from '@/components/money/expense-sheet';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';

/**
 * Money → Expenses on the phone (the owner, 25 Nov 2026: "I snap a receipt, it gets filed, and each month I see money
 * in and money out"): the month's figures, what it went on and its expenses, live from the API; Add expense files
 * one; a member is told it's for money managers. Every business and purchase here is made up.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
const mockRole = { whole: true };
jest.mock('@/money/use-money', () => ({
  useMoneyRole: () => ({
    role: mockRole.whole ? 'owner' : 'member',
    whole: mockRole.whole,
    bill: mockRole.whole,
    tabs: [],
  }),
  useMoneyZone: () => 'America/Chicago',
}));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  ApiError: class extends Error {},
  errorMessage: (e: unknown) =>
    e instanceof Error ? e.message : 'Something went wrong. Try again.',
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHELL = '22222222-2222-4222-8222-222222222222';

const business: Business = {
  id: LONE_STAR,
  name: 'Lone Star HVAC & Roofing',
  organizationId: 'org',
  organizationName: 'Lone Star HVAC & Roofing',
  role: 'owner',
  timezone: 'America/Chicago',
};
const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [business],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
};

const IN_OUT = {
  timeZone: 'America/Chicago',
  thisMonth: '2026-11',
  months: [
    { month: '2026-11', inCents: 500_000, outCents: 4_250, expenseCount: 1 },
    { month: '2026-10', inCents: 0, outCents: 12_000, expenseCount: 2 },
  ],
  breakdown: {
    month: '2026-11',
    inCents: 500_000,
    outCents: 4_250,
    categories: [{ category: 'fuel', label: 'Gas and fuel', cents: 4_250, count: 1 }],
  },
};
const LIST = {
  expenses: [
    {
      id: SHELL,
      spentOn: '2026-11-24',
      amountCents: 4_250,
      taxCents: 312,
      vendor: 'Shell',
      category: 'fuel',
      categoryLabel: 'Gas and fuel',
      paidWith: 'card',
      note: 'Gas for the work truck',
      source: 'assistant',
      receipt: {
        fileId: '33333333-3333-4333-8333-333333333333',
        name: 'Receipt Shell 2026-11-24.jpg',
        mimeType: 'image/jpeg',
        bucket: 'attachments',
        objectPath: 'x/y.jpg',
      },
      createdBy: DALE,
      createdAt: '2026-11-24T18:00:00.000Z',
    },
  ],
  count: 1,
  totalCents: 4_250,
  nextCursor: null,
};

const post = api.POST as unknown as jest.Mock<
  Promise<{ data: unknown }>,
  [string, { body: Record<string, unknown> }]
>;
const sent = (path: string) => post.mock.calls.filter((call) => call[0] === path);

async function show() {
  post.mockImplementation(async (path) => {
    if (path === '/v1/queries/money.in_and_out') return { data: IN_OUT };
    if (path === '/v1/queries/expense.list') return { data: LIST };
    if (path === '/v1/commands/expense.create') return { data: { expenseId: SHELL } };
    return { data: {} };
  });
  await render(
    <BusinessProvider value={{ userId: DALE, me, business, openSwitcher: () => undefined }}>
      <Expenses />
    </BusinessProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRole.whole = true;
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

it('shows the month’s money in, money out, what it went on and its expenses', async () => {
  await show();
  expect(await screen.findByTestId('expenses-in-value')).toHaveTextContent('$5,000.00');
  expect(screen.getByTestId('expenses-out-value')).toHaveTextContent('$42.50');
  expect(screen.getByTestId('expenses-left-value')).toHaveTextContent('$4,957.50');
  expect(screen.getByTestId('expenses-category-fuel')).toHaveTextContent('Gas and fuel$42.50');
  expect(screen.getByTestId(`expense-${SHELL}`)).toHaveTextContent('Shell', { exact: false });
  expect(sent('/v1/queries/expense.list')[0]![1].body).toMatchObject({ month: '2026-11' });
});

it('shows another month when its chip is pressed', async () => {
  await show();
  await fireEvent.press(await screen.findByTestId('expenses-month-2026-10'));
  await waitFor(() =>
    expect(sent('/v1/queries/money.in_and_out').some((c) => c[1].body.month === '2026-10')).toBe(
      true,
    ),
  );
});

it('adds an expense from the sheet', async () => {
  await show();
  await fireEvent.press(await screen.findByTestId('expenses-add'));
  await fireEvent.changeText(screen.getByTestId('expense-vendor'), 'Home Depot');
  await fireEvent.changeText(screen.getByTestId('expense-amount'), '118.40');
  await fireEvent.press(screen.getByTestId('expense-category-materials'));
  await fireEvent.press(screen.getByTestId('expense-paid-card'));
  await fireEvent.press(screen.getByTestId('expense-save'));
  await waitFor(() => expect(sent('/v1/commands/expense.create')).toHaveLength(1));
  expect(sent('/v1/commands/expense.create')[0]![1].body).toMatchObject({
    workspaceId: LONE_STAR,
    vendor: 'Home Depot',
    amountCents: 11_840,
    category: 'materials',
    paidWith: 'card',
  });
  expect(toast.show).toHaveBeenCalledWith('Added $118.40 at Home Depot.');
});

it('won’t add one without what it was for', async () => {
  await show();
  await fireEvent.press(await screen.findByTestId('expenses-add'));
  await fireEvent.changeText(screen.getByTestId('expense-vendor'), 'Home Depot');
  await fireEvent.changeText(screen.getByTestId('expense-amount'), '118.40');
  await fireEvent.press(screen.getByTestId('expense-save'));
  expect(await screen.findByTestId('expense-category-problem')).toHaveTextContent(
    'Pick what it was for.',
  );
  expect(sent('/v1/commands/expense.create')).toHaveLength(0);
});

it('tells a member expenses are for money managers, and asks for nothing', async () => {
  mockRole.whole = false;
  await show();
  expect(screen.getByTestId('expenses-only-managers')).toHaveTextContent(EXPENSES_ONLY_MANAGERS);
  expect(sent('/v1/queries/expense.list')).toHaveLength(0);
});

it('reads a typed day either way, and refuses one that isn’t real', () => {
  expect(parseDay('11/20/2026')).toBe('2026-11-20');
  expect(parseDay('2026-11-20')).toBe('2026-11-20');
  expect(parseDay('2/30/2026')).toBeNull();
  expect(parseDay('soon')).toBeNull();
});
