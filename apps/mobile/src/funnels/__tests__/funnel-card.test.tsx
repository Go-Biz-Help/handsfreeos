import { FUNNEL_PERSON_WORDS as W } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { FunnelCard } from '@/components/customers/funnel-card';
import { BusinessProvider } from '@/components/shell/business-context';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';

import type { FunnelOfPersonOut } from '../calls';

/**
 * A customer's funnel on the phone (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, "The phone app"): where they
 * are and what's next, with Pause and Remove; the teammate's suggestion with Yes and No; and nothing for someone in
 * no funnel or without the right to change them. It needs signal, so the API stands in.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
  useFocusEffect: () => undefined,
}));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.'),
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SAM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ROW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FUNNEL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const STAGE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const WRITER = ['records.read', 'records.write'];

const business = (permissions: string[]): Business => ({
  id: LONE_STAR,
  name: 'Lone Star HVAC & Roofing',
  organizationId: 'org',
  organizationName: 'Lone Star HVAC & Roofing',
  role: 'owner',
  timezone: 'America/Chicago',
  permissions,
});
const me = (permissions: string[]): Me => ({
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [business(permissions)],
  organizations: [],
  fetchedAt: 0,
});

const post = api.POST as unknown as jest.Mock;
let answer: FunnelOfPersonOut;
const sent = (path: string) =>
  post.mock.calls.filter((c) => c[0] === path).map((c) => (c[1] as { body: unknown }).body);

function wrap(permissions = WRITER) {
  post.mockImplementation(async (path: string) => ({
    data: path === '/v1/queries/funnel.of_person' ? answer : {},
    response: new Response(null, { status: 200 }),
  }));
  return render(
    <BusinessProvider
      value={{
        userId: DALE,
        me: me(permissions),
        business: business(permissions),
        openSwitcher: () => undefined,
      }}
    >
      <FunnelCard workspaceId={LONE_STAR} personId={SAM} />
    </BusinessProvider>,
  );
}

const person = (over: Partial<NonNullable<FunnelOfPersonOut['current']>> = {}) => ({
  id: ROW,
  funnelId: FUNNEL,
  funnelName: 'Recruiting',
  funnelStatus: 'on' as const,
  personId: SAM,
  personName: 'Sam Rivera',
  leadId: null,
  stageId: STAGE,
  stageName: 'Booked',
  status: 'active' as const,
  pausedReason: null,
  leftReason: null,
  stageReachedAt: '2026-10-27T15:00:00.000Z',
  booking: null,
  next: [
    {
      messageId: 'mhourbefore',
      dueAt: '2026-10-30T00:00:00.000Z',
      wording: 'ai' as const,
      text: 'Starts in an hour',
      onlyIf: null,
    },
  ],
  addedBy: 'rule' as const,
  suggestedWhy: null,
  createdAt: '2026-10-27T15:00:00.000Z',
  ...over,
});

beforeEach(() => post.mockReset());

describe('a customer’s funnel on the phone', () => {
  it('says where they are and what’s next, and pauses and removes them', async () => {
    answer = {
      current: person(),
      stages: [],
      suggestion: null,
      canJoin: [],
      timeZone: 'America/Chicago',
    };
    await wrap();
    await waitFor(() => expect(screen.getByTestId('funnel-card')).toBeTruthy());
    expect(screen.getByText('Recruiting')).toBeTruthy();
    expect(screen.getByTestId('funnel-card-where')).toHaveTextContent('Booked');
    expect(screen.getByText(/^Next: “Starts in an hour” at Thu, Oct 29, 7:00 PM$/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('funnel-card-pause'));
    await waitFor(() =>
      expect(sent('/v1/commands/funnel.pause_person')).toEqual([
        { workspaceId: LONE_STAR, funnelPersonId: ROW, paused: true },
      ]),
    );
    await fireEvent.press(screen.getByTestId('funnel-card-remove'));
    await waitFor(() =>
      expect(sent('/v1/commands/funnel.remove_person')).toEqual([
        { workspaceId: LONE_STAR, funnelPersonId: ROW },
      ]),
    );
  });

  it('says why it’s paused, and offers Resume', async () => {
    answer = {
      current: person({ status: 'paused', pausedReason: 'taken_over', next: [] }),
      stages: [],
      suggestion: null,
      canJoin: [],
      timeZone: 'America/Chicago',
    };
    await wrap();
    await waitFor(() => expect(screen.getByText(W.paused('taken_over'))).toBeTruthy());
    expect(screen.getByTestId('funnel-card-pause')).toHaveTextContent(W.resume);
  });

  it('asks yes or no to the teammate’s suggestion', async () => {
    answer = {
      current: null,
      stages: [],
      suggestion: person({
        status: 'suggested',
        stageId: null,
        stageName: null,
        next: [],
        suggestedWhy: 'Asked about the opportunity',
      }),
      canJoin: [],
      timeZone: 'America/Chicago',
    };
    await wrap();
    await waitFor(() =>
      expect(
        screen.getByText(W.suggested('Recruiting', 'Asked about the opportunity')),
      ).toBeTruthy(),
    );
    await fireEvent.press(screen.getByTestId('funnel-card-yes'));
    await waitFor(() =>
      expect(sent('/v1/commands/funnel.decide_suggestion')).toEqual([
        { workspaceId: LONE_STAR, funnelPersonId: ROW, accept: true },
      ]),
    );
  });

  it('shows nothing for someone in no funnel, and no buttons for someone who can’t change them', async () => {
    answer = {
      current: null,
      stages: [],
      suggestion: null,
      canJoin: [],
      timeZone: 'America/Chicago',
    };
    const none = await wrap();
    await waitFor(() => expect(sent('/v1/queries/funnel.of_person')).toHaveLength(1));
    expect(screen.queryByTestId('funnel-card')).toBeNull();
    none.unmount();
    answer = {
      current: person(),
      stages: [],
      suggestion: null,
      canJoin: [],
      timeZone: 'America/Chicago',
    };
    await wrap(['records.read']);
    await waitFor(() => expect(screen.getByTestId('funnel-card')).toBeTruthy());
    expect(screen.queryByTestId('funnel-card-pause')).toBeNull();
  });
});
