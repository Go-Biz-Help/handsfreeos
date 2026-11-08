import { BILLING_WORDS as W, type PaymentBlock } from '@hfos/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { FixOnTheWeb } from '@/components/billing/fix-on-web';
import { BusinessProvider } from '@/components/shell/business-context';
import type { Business, Me } from '@/lib/businesses';

/**
 * A plan payment that didn't go through is fixed on the web, never on the phone (20261027023600). The phone says so
 * with no price, no payment and no link, and offers Skip for now only while it may still be skipped.
 */

jest.mock('expo-router', () => ({ usePathname: () => '/' }));
jest.mock('@/lib/api', () => ({ api: { POST: jest.fn() }, unwrap: (r: unknown) => r }));
jest.mock('@/lib/device-store', () => ({ deviceStore: { get: jest.fn(), set: jest.fn() } }));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = '22222222-2222-4222-8222-222222222222';

const business: Business = {
  id: LONE_STAR,
  name: 'Lone Star Plumbing',
  organizationId: 'org',
  organizationName: 'Lone Star Plumbing',
  role: 'owner',
  timezone: 'America/Chicago',
  needsPlan: false,
};
const me: Me = {
  user: { id: DALE, email: 'dale@lonestarplumbing.test', fullName: 'Dale Porter' },
  businesses: [business],
  organizations: [{ id: 'org', name: 'Lone Star Plumbing', role: 'owner' }],
  fetchedAt: 0,
};

async function draw(block: PaymentBlock, canManage = true, onSkip = jest.fn()) {
  await render(
    <BusinessProvider value={{ userId: DALE, me, business, openSwitcher: jest.fn() }}>
      <FixOnTheWeb
        block={block}
        askWho="Dana Owner"
        canManage={canManage}
        onSkip={onSkip}
        onCheck={jest.fn()}
      />
    </BusinessProvider>,
  );
  return onSkip;
}

const lockedAt = '2026-11-11T10:00:00.000Z';

it('sends them to the web with no price, no payment and no link', async () => {
  await draw({ show: true, canSkip: true, lockedAt });
  expect(screen.getByTestId('fix-on-web-title')).toHaveTextContent(W.phoneBlockTitle);
  expect(screen.queryByText(/\$|a year|a month|pay|card/i)).toBeNull();
});

it('can be skipped until 72 hours after it failed', async () => {
  const onSkip = await draw({ show: true, canSkip: true, lockedAt });
  await fireEvent.press(screen.getByTestId('fix-on-web-skip'));
  expect(onSkip).toHaveBeenCalled();
});

it('can’t be skipped from 72 hours after it failed', async () => {
  await draw({ show: true, canSkip: false, lockedAt });
  expect(screen.queryByTestId('fix-on-web-skip')).toBeNull();
  expect(screen.getByTestId('fix-on-web-body')).toHaveTextContent(/stays closed on the phone/);
});

it('tells someone who can’t fix it who can', async () => {
  await draw({ show: true, canSkip: true, lockedAt }, false);
  expect(screen.getByTestId('fix-on-web-body')).toHaveTextContent(/Ask Dana Owner/);
});
