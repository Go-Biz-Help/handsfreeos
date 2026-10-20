import { askCodeAlertWords, askCodeHref } from '@hfos/core/addons/outreach/asks';
import { useQuery } from '@powersync/react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import { AlertsButton, OPEN_ALERTS_SQL } from '@/components/shell/alerts-button';
import { BusinessProvider } from '@/components/shell/business-context';
import { openWebPath } from '@/home/open';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';

/**
 * The bell beside Ask HandsFreeOS (decision 82 in docs/outreach.md): the add-ons' alerts still open for this person,
 * counted on it and listed in its sheet, so "Alignable emailed you a code" is one tap from its screen after they've
 * gone elsewhere. Pressing one opens its page once the sheet has gone.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn(), navigate: jest.fn() } }));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.'),
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const ASK = '22222222-2222-4222-8222-222222222222';
const ALERT = '33333333-3333-4333-8333-333333333333';

const business = (id: string): Business => ({
  id,
  name: 'Lone Star HVAC & Roofing',
  organizationId: 'org',
  organizationName: 'Lone Star HVAC & Roofing',
  role: 'owner',
  timezone: 'America/Chicago',
});

const me = (ws: string): Me => ({
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [business(ws)],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
});

const CODE = askCodeAlertWords('alignable');

const alertRow = (ws: string) => ({
  id: 'item-1',
  workspace_id: ws,
  kind: 'addon_alert',
  subject_type: 'addon_alert',
  subject_id: ALERT,
  state: 'open',
  opened_at: '2026-10-20T15:00:00.000Z',
  reasons: JSON.stringify([{ code: 'severity', label: 'Critical' }]),
  title: CODE.title,
  detail: CODE.detail,
});

const rowsFor = (rows: unknown[]) =>
  (useQuery as jest.Mock).mockImplementation((sql: string) => ({
    data: sql === OPEN_ALERTS_SQL ? rows : [],
    isLoading: false,
    isFetching: false,
  }));

const post = api.POST as unknown as jest.Mock;

function draw(ws: string) {
  return render(
    <BusinessProvider
      value={{ userId: DALE, me: me(ws), business: business(ws), openSwitcher: () => undefined }}
    >
      <AlertsButton />
    </BusinessProvider>,
  );
}

/** iOS's word that the sheet's modal is really gone (`Modal`'s `onDismiss`), taken while the sheet is up. */
function modalGone(): () => void {
  let node: { props: Record<string, unknown>; parent: unknown } | null = screen.getByTestId(
    'alerts-sheet',
  ) as never;
  while (node && typeof node.props.onDismiss !== 'function') node = node.parent as never;
  return node!.props.onDismiss as () => void;
}

beforeEach(() => {
  jest.useFakeTimers();
  post.mockReset();
  (openWebPath as jest.Mock).mockReset();
});

afterEach(() => {
  jest.useRealTimers();
  (useQuery as jest.Mock).mockImplementation(() => ({
    data: [],
    isLoading: false,
    isFetching: false,
  }));
});

describe('the notifications bell', () => {
  it('shows no count and says nothing needs them when no alert is open', async () => {
    rowsFor([]);
    await draw('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(screen.queryByTestId('alerts-count')).toBeNull();
    expect(screen.getByLabelText('Notifications')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('alerts-button'));
    expect(screen.getByTestId('alerts-none')).toHaveTextContent('Nothing needs you right now.');
    expect(post).not.toHaveBeenCalled();
  });

  it('counts the code’s notification and opens the code’s own screen from it', async () => {
    const ws = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    rowsFor([alertRow(ws)]);
    post.mockResolvedValue({
      data: {
        items: [
          {
            id: 'item-1',
            addonAlert: {
              alertId: ALERT,
              addonId: 'outreach',
              addonName: 'Social Outreach',
              severity: 'critical',
              href: askCodeHref(ASK),
              needsAck: false,
              acknowledgedAt: null,
            },
          },
        ],
      },
    });
    await draw(ws);
    expect(screen.getByTestId('alerts-count')).toHaveTextContent('1');
    expect(screen.getByLabelText('Notifications: 1 open')).toBeTruthy();
    // Which add-on raised it and where it opens are HandsFreeOS's answer.
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/queries/attention.list', {
        body: { workspaceId: ws, scope: 'everyone', kinds: ['addon_alert'] },
      }),
    );
    await fireEvent.press(screen.getByTestId('alerts-button'));
    expect(await screen.findByText('Social Outreach')).toBeTruthy();
    expect(screen.getByText(CODE.title)).toBeTruthy();
    expect(screen.getByText(CODE.detail)).toBeTruthy();
    const gone = modalGone();
    await fireEvent.press(screen.getByTestId('alerts-item'));
    await act(async () => jest.advanceTimersByTime(1_000));
    // iOS opens nothing while a modal is still going: the page opens once the sheet is gone.
    expect(openWebPath).not.toHaveBeenCalled();
    await act(async () => gone());
    expect(openWebPath).toHaveBeenCalledWith(`/app/w/${ws}/a/outreach/?view=code&ask=${ASK}`);
  });

  it('opens Home for an alert the phone can’t place yet, with no signal', async () => {
    const ws = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    rowsFor([alertRow(ws)]);
    post.mockRejectedValue(new Error('No signal'));
    await draw(ws);
    await fireEvent.press(screen.getByTestId('alerts-button'));
    expect(screen.getByText(CODE.title)).toBeTruthy();
    const gone = modalGone();
    await fireEvent.press(screen.getByTestId('alerts-item'));
    await act(async () => jest.advanceTimersByTime(1_000));
    await act(async () => gone());
    expect(openWebPath).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(`/app/w/${ws}`);
  });
});
