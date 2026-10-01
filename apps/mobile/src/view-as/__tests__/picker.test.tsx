import { effectivePermissions } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import ViewAsTeammate from '@/app/app/w/[workspaceId]/(tabs)/(more)/view-as';
import { BusinessProvider } from '@/components/shell/business-context';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { currentView, dropView } from '@/view-as/state';

/**
 * More → View as a teammate (20261016000200): an owner sees the admins and members below them, and picking one opens
 * the business as they see it, with what they see fetched through the view.
 */
jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
    replace: jest.fn(),
    push: jest.fn(),
    canGoBack: () => true,
  },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/auth', () => ({
  session: {
    accessToken: async () => 'token-1',
    getState: () => ({
      status: 'signedIn',
      person: { userId: '11111111-1111-4111-8111-111111111111', name: 'Dale' },
      expiresAt: 0,
    }),
  },
}));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  ApiError: class ApiError extends Error {},
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.'),
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VIEW = '99999999-9999-4999-8999-999999999999';
const person = (
  userId: string,
  fullName: string,
  role: Business['role'],
  permissions = effectivePermissions(role),
) => ({
  userId,
  email: `${fullName.split(' ')[0]!.toLowerCase()}@lonestarhvac.test`,
  fullName,
  avatarUrl: null,
  role,
  permissions,
  joinedAt: '2026-09-01T00:00:00.000Z',
});
const TEAM = [
  person(DALE, 'Dale Ramsey', 'owner'),
  person('22222222-2222-4222-8222-222222222222', 'Pat Owens', 'owner'),
  person('33333333-3333-4333-8333-333333333333', 'Ann Admin', 'admin'),
  person('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Maria Lopez', 'member'),
];

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
  fetchedAt: 0,
};

function show(as: Business = business) {
  return render(
    <BusinessProvider
      value={{ userId: DALE, me, business: as, openSwitcher: () => undefined, viewing: null }}
    >
      <ViewAsTeammate />
    </BusinessProvider>,
  );
}

const post = api.POST as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  dropView();
  post.mockImplementation(async (path: string) => {
    if (path === '/v1/queries/workspace.members')
      return { data: { members: TEAM, organizationAdmins: [] } };
    if (path === '/v1/commands/teammate_view.start')
      return {
        data: {
          view: {
            id: VIEW,
            workspaceId: LONE_STAR,
            person: {
              userId: TEAM[3]!.userId,
              fullName: 'Maria Lopez',
              email: TEAM[3]!.email,
              role: 'member',
            },
            by: 'team',
            startedAt: '2026-10-01T15:00:00.000Z',
          },
        },
      };
    if (path === '/v1/queries/teammate_view.lens')
      return {
        data: {
          person: {
            userId: TEAM[3]!.userId,
            fullName: 'Maria Lopez',
            email: TEAM[3]!.email,
            role: 'member',
            permissions: TEAM[3]!.permissions,
          },
          conversationIds: ['t1'],
          attentionItemIds: [],
          estimateIds: [],
          invoiceIds: [],
        },
      };
    throw new Error(`unexpected ${path}`);
  });
});

describe('View as a teammate', () => {
  it('lists the people below an owner, never another owner or themselves', async () => {
    await show();
    expect(await screen.findByTestId('view-as-row-ann@lonestarhvac.test')).toBeTruthy();
    expect(screen.getByTestId('view-as-row-maria@lonestarhvac.test')).toBeTruthy();
    expect(screen.queryByTestId('view-as-row-pat@lonestarhvac.test')).toBeNull();
    expect(screen.queryByTestId('view-as-row-dale@lonestarhvac.test')).toBeNull();
  });

  it('an admin sees only members, and nobody who can do something they can’t', async () => {
    TEAM[3] = person(TEAM[3]!.userId, 'Maria Lopez', 'member', [
      ...effectivePermissions('member'),
      'permissions.manage',
    ]);
    try {
      await show({ ...business, role: 'admin', permissions: effectivePermissions('admin') });
      expect(await screen.findByTestId('view-as-nobody')).toBeTruthy();
    } finally {
      TEAM[3] = person(TEAM[3]!.userId, 'Maria Lopez', 'member');
    }
  });

  it('opens the business as the one picked, with what they see fetched through the view', async () => {
    await show();
    await fireEvent.press(await screen.findByTestId('view-as-maria@lonestarhvac.test'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/app/w/${LONE_STAR}`));
    expect(post).toHaveBeenCalledWith('/v1/commands/teammate_view.start', {
      body: { workspaceId: LONE_STAR, userId: TEAM[3]!.userId },
    });
    expect(post).toHaveBeenCalledWith('/v1/queries/teammate_view.lens', {
      body: { workspaceId: LONE_STAR },
      headers: { 'x-hfos-view-as': VIEW },
    });
    expect(currentView()).toMatchObject({
      viewerId: DALE,
      workspaceId: LONE_STAR,
      viewId: VIEW,
      person: { fullName: 'Maria Lopez', role: 'member' },
      conversationIds: ['t1'],
    });
  });
});
