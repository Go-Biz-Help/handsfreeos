import { BELL_WORDS } from '@hfos/core';
import { askCodeAlertWords, askCodeHref } from '@hfos/core/addons/outreach/asks';
import { useQuery } from '@powersync/react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import { change } from '@/changes';
import { BellButton, OPEN_ALERTS_SQL } from '@/components/shell/bell';
import { BusinessProvider } from '@/components/shell/business-context';
import { openWebPath } from '@/home/open';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { pendingLinks } from '@/links/pending';
import { BELL_PAGE, BELL_SQL, BELL_UNSEEN_SQL, bellMarks } from '@/push/bell';

/**
 * The bell beside Ask HandsFreeOS (20261027012600): every push the person's phones were handed in the last 30 days,
 * newest first, from every business they're in, under the add-ons' alerts still open (decision 82 in
 * docs/outreach.md). It counts what's new; opening it sees them, and pressing one reads it and opens its screen once
 * the sheet has gone.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn(), navigate: jest.fn() } }));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/links/pending', () => ({ pendingLinks: { open: jest.fn() } }));
jest.mock('@/changes', () => ({
  change: jest.fn(async () => ({ id: 'change-1', queued: false, output: {} })),
}));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.'),
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const ASK = '22222222-2222-4222-8222-222222222222';
const ALERT = '33333333-3333-4333-8333-333333333333';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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

const NOW = Date.parse('2026-10-26T18:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();

interface Kept {
  id: string;
  workspace_id: string | null;
  push_id: string;
  category: string;
  title: string;
  subtitle: string | null;
  body: string;
  path: string;
  refs: string;
  sent_at: string;
  seen_at: string | null;
  read_at: string | null;
}

const kept = (n: number, over: Partial<Kept> = {}): Kept => ({
  id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`,
  workspace_id: OTHER,
  push_id: `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`,
  category: 'customer_message',
  title: `Customer ${n}`,
  subtitle: 'Text · Bayou Bistro',
  body: `Message ${n}`,
  path: `/app/w/${OTHER}/inbox/conv-${n}`,
  refs: '{}',
  sent_at: new Date(NOW - n * 60_000).toISOString(),
  seen_at: null,
  read_at: null,
  ...over,
});

/** The copy: open alerts for the business on screen, and the person's notifications. */
const copyOf = (alerts: unknown[], notifications: Kept[]) =>
  (useQuery as jest.Mock).mockImplementation((sql: string, params?: unknown[]) => ({
    data:
      sql === OPEN_ALERTS_SQL
        ? alerts
        : sql === BELL_SQL
          ? [...notifications]
              .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
              .slice(0, Number(params?.[0]))
          : sql === BELL_UNSEEN_SQL
            ? notifications.filter((n) => n.seen_at === null)
            : [],
    isLoading: false,
    isFetching: false,
  }));

const post = api.POST as unknown as jest.Mock;
const changed = change as unknown as jest.Mock;

function draw(ws: string) {
  return render(
    <BusinessProvider
      value={{ userId: DALE, me: me(ws), business: business(ws), openSwitcher: () => undefined }}
    >
      <BellButton />
    </BusinessProvider>,
  );
}

/** iOS's word that the sheet's modal is really gone (`Modal`'s `onDismiss`), taken while the sheet is up. */
function modalGone(): () => void {
  type Node = { props: Record<string, unknown>; parent: Node | null };
  let node = screen.getByTestId('bell-sheet') as unknown as Node | null;
  while (node && typeof node.props.onDismiss !== 'function') node = node.parent;
  return node!.props.onDismiss as () => void;
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  post.mockReset();
  changed.mockClear();
  (openWebPath as jest.Mock).mockReset();
  (pendingLinks.open as jest.Mock).mockReset();
  bellMarks.clear();
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
  it('shows no count and says what will show up when nothing is kept or open', async () => {
    copyOf([], []);
    await draw('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(screen.queryByTestId('bell-count')).toBeNull();
    expect(screen.getByLabelText('Notifications')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('bell-button'));
    expect(screen.getByTestId('bell-none')).toHaveTextContent(BELL_WORDS.none);
    expect(post).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('lists every push, newest first, from every business, and sees the new ones as it opens', async () => {
    const ws = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    copyOf(
      [],
      [
        kept(1),
        kept(2, { seen_at: '2026-10-26T17:59:00.000Z' }),
        kept(3, {
          workspace_id: ws,
          subtitle: 'Lone Star HVAC & Roofing',
          seen_at: '2026-10-26T17:59:00.000Z',
          read_at: '2026-10-26T17:59:00.000Z',
        }),
        kept(4),
      ],
    );
    await draw(ws);
    // Two not seen yet, whichever business they're from.
    expect(screen.getByTestId('bell-count')).toHaveTextContent('2');
    expect(screen.getByLabelText('Notifications: 2 new')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('bell-button'));
    const items = screen.getAllByTestId('bell-item');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent(/Customer 1/);
    expect(items[0]).toHaveTextContent(/Text · Bayou Bistro/);
    expect(items[0]).toHaveTextContent(/1 min ago/);
    expect(items[2]).toHaveTextContent(/Lone Star HVAC & Roofing/);
    // Unread until pressed, seen or not: the first, second and fourth.
    expect(screen.getAllByTestId('bell-unread')).toHaveLength(3);
    expect(items[0].props.accessibilityLabel).toMatch(/^Not opened yet\. Customer 1/);
    expect(items[2].props.accessibilityLabel).not.toMatch(/Not opened yet/);
    // Opening it sees everything up to the newest it showed, and the count goes at once.
    expect(changed).toHaveBeenCalledWith('notification.seen', { upTo: kept(1).sent_at });
    expect(screen.queryByTestId('bell-count')).toBeNull();
    expect(screen.queryByText(/Needs you/)).toBeNull();
  });

  it('reads one pressed and opens its screen in its own business once the sheet is gone', async () => {
    const ws = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    copyOf([], [kept(1), kept(2)]);
    await draw(ws);
    await fireEvent.press(screen.getByTestId('bell-button'));
    const gone = modalGone();
    await fireEvent.press(screen.getAllByTestId('bell-item')[1]!);
    expect(changed).toHaveBeenCalledWith('notification.read', { ids: [kept(2).id] });
    await act(async () => jest.advanceTimersByTime(1_000));
    // iOS opens nothing while a modal is still going: the screen opens once the sheet is gone.
    expect(pendingLinks.open).not.toHaveBeenCalled();
    await act(async () => gone());
    expect(pendingLinks.open).toHaveBeenCalledWith(`/app/w/${OTHER}/inbox/conv-2`);
    await fireEvent.press(screen.getByTestId('bell-button'));
    expect(screen.getAllByTestId('bell-unread')).toHaveLength(1);
  });

  it('shows older ones a page at a time', async () => {
    copyOf(
      [],
      Array.from({ length: BELL_PAGE + 3 }, (_, i) => kept(i + 1, { seen_at: NOW_ISO })),
    );
    await draw('abababab-abab-4bab-8bab-abababababab');
    await fireEvent.press(screen.getByTestId('bell-button'));
    expect(screen.getAllByTestId('bell-item')).toHaveLength(BELL_PAGE);
    await fireEvent.press(screen.getByTestId('bell-older'));
    expect(screen.getAllByTestId('bell-item')).toHaveLength(BELL_PAGE + 3);
    expect(screen.queryByTestId('bell-older')).toBeNull();
    // Nothing was new.
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps an open alert at the top, counted once with its push, and opens the code’s own screen', async () => {
    const ws = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    copyOf(
      [alertRow(ws)],
      [
        kept(1, {
          workspace_id: ws,
          category: 'addon_alert',
          title: CODE.title,
          refs: JSON.stringify({ alertId: ALERT }),
          path: `/app/w/${ws}/a/outreach/?view=code&ask=${ASK}`,
        }),
      ],
    );
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
    expect(screen.getByTestId('bell-count')).toHaveTextContent('1');
    // Which add-on raised it and where it opens are HandsFreeOS's answer.
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/queries/attention.list', {
        body: { workspaceId: ws, scope: 'everyone', kinds: ['addon_alert'] },
      }),
    );
    await fireEvent.press(screen.getByTestId('bell-button'));
    expect(screen.getByText(BELL_WORDS.needsYou)).toBeTruthy();
    expect(screen.getByText(BELL_WORDS.recent)).toBeTruthy();
    expect(await screen.findByText('Social Outreach')).toBeTruthy();
    expect(screen.getByText(CODE.detail)).toBeTruthy();
    // Seen, but still open: the alert keeps it counted until it's done.
    expect(screen.getByTestId('bell-count')).toHaveTextContent('1');
    const gone = modalGone();
    await fireEvent.press(screen.getByTestId('bell-alert'));
    await act(async () => jest.advanceTimersByTime(1_000));
    expect(openWebPath).not.toHaveBeenCalled();
    await act(async () => gone());
    expect(openWebPath).toHaveBeenCalledWith(`/app/w/${ws}/a/outreach/?view=code&ask=${ASK}`);
  });

  it('opens Home for an alert the phone can’t place yet, with no signal', async () => {
    const ws = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    copyOf([alertRow(ws)], []);
    post.mockRejectedValue(new Error('No signal'));
    await draw(ws);
    expect(screen.getByLabelText('Notifications: 1 new')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('bell-button'));
    expect(screen.getByText(CODE.title)).toBeTruthy();
    const gone = modalGone();
    await fireEvent.press(screen.getByTestId('bell-alert'));
    await act(async () => jest.advanceTimersByTime(1_000));
    await act(async () => gone());
    expect(openWebPath).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(`/app/w/${ws}`);
  });
});
