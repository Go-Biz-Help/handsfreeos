import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import { AddonSuggestionCard } from '@/components/add-ons/suggestion-card';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';

import { forgetAddonSuggestions } from '../use-add-ons';
import { ADDON_PHONE_WORDS } from '../words';

/**
 * Home's add-on card (the owner's decision, 2026-09-28): now and then, for an owner or an admin, an add-on that fits
 * the business, easy to set aside. Nobody else is ever asked about one, and with nothing to suggest there's nothing
 * on Home at all.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const SUGGESTION = {
  addonId: 'fxprop',
  name: 'Property Management',
  summary: 'Properties, units, tenants and leases.',
  does: ['Properties and units', 'Leases', 'Tenants', 'Owners'],
};

let answers: Record<string, unknown>;
const post = api.POST as unknown as jest.Mock<
  Promise<{ data?: unknown; error?: unknown; response: Response }>,
  [string, { body: Record<string, unknown> }]
>;
const sent = (path: string) => post.mock.calls.filter((call) => call[0] === path);

async function show(role: Business['role'] = 'owner') {
  post.mockImplementation(async (path) => {
    const answer = answers[path];
    if (answer === null) throw new TypeError('Network request failed');
    return { data: answer ?? {}, response: new Response(null, { status: 200 }) };
  });
  const business: Business = {
    id: LONE_STAR,
    name: 'Lone Star HVAC & Roofing',
    organizationId: 'org',
    organizationName: 'Lone Star HVAC & Roofing',
    role,
    timezone: 'America/Chicago',
  };
  const me: Me = {
    user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
    businesses: [business],
    organizations: [],
    fetchedAt: 0,
  };
  await render(
    <BusinessProvider value={{ userId: DALE, me, business, openSwitcher: () => undefined }}>
      <AddonSuggestionCard />
    </BusinessProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  forgetAddonSuggestions();
  answers = {
    '/v1/queries/addon.suggestion': { suggestion: SUGGESTION },
    '/v1/commands/addon.dismiss_suggestion': { addonId: 'fxprop', choice: 'not_now' },
  };
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

it('shows an owner the add-on that fits, and opens its own screen', async () => {
  await show();
  expect(await screen.findByTestId('addon-suggestion-name')).toHaveTextContent(
    'Property Management',
  );
  expect(screen.getByText(ADDON_PHONE_WORDS.suggested)).toBeTruthy();
  expect(screen.getByText('Properties, units, tenants and leases.')).toBeTruthy();
  // Three of what it does; its own screen has the rest.
  expect(screen.getByTestId('addon-suggestion-does')).toHaveTextContent(
    'Properties and units · Leases · Tenants',
  );
  expect(sent('/v1/queries/addon.suggestion')[0]![1]).toEqual({
    body: { workspaceId: LONE_STAR },
  });
  await fireEvent.press(screen.getByTestId('addon-suggestion-see'));
  expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/add-ons/fxprop`);
});

it('sets it aside for now at once, and tells HandsFreeOS', async () => {
  await show('admin');
  await fireEvent.press(await screen.findByTestId('addon-suggestion-not-now'));
  expect(screen.queryByTestId('addon-suggestion')).toBeNull();
  await waitFor(() => expect(sent('/v1/commands/addon.dismiss_suggestion')).toHaveLength(1));
  expect(sent('/v1/commands/addon.dismiss_suggestion')[0]![1]).toEqual({
    body: { workspaceId: LONE_STAR, addonId: 'fxprop', choice: 'not_now' },
  });
  await waitFor(() => expect(toast.show).toHaveBeenCalledWith(ADDON_PHONE_WORDS.notNowDone));
});

it('comes back when HandsFreeOS can’t be told they aren’t interested', async () => {
  answers['/v1/commands/addon.dismiss_suggestion'] = null;
  await show();
  await fireEvent.press(await screen.findByTestId('addon-suggestion-not-interested'));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('No signal. Try again when you’re back online.'),
  );
  expect(sent('/v1/commands/addon.dismiss_suggestion')[0]![1].body.choice).toBe('not_interested');
  expect(await screen.findByTestId('addon-suggestion')).toBeTruthy();
});

it('shows nothing when there is nothing to suggest', async () => {
  answers['/v1/queries/addon.suggestion'] = { suggestion: null };
  await show();
  await waitFor(() => expect(sent('/v1/queries/addon.suggestion')).toHaveLength(1));
  expect(screen.queryByTestId('addon-suggestion')).toBeNull();
});

it('never asks for someone who can’t add add-ons', async () => {
  await show('member');
  await waitFor(() => expect(screen.queryByTestId('addon-suggestion')).toBeNull());
  expect(post).not.toHaveBeenCalled();
});

it('asks once in a while rather than every time Home opens', async () => {
  await show();
  await screen.findByTestId('addon-suggestion');
  await screen.unmount();
  await show();
  expect(await screen.findByTestId('addon-suggestion')).toBeTruthy();
  expect(sent('/v1/queries/addon.suggestion')).toHaveLength(1);
});
