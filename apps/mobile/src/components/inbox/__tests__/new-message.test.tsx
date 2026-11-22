import { useQuery } from '@powersync/react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import Inbox from '@/app/app/w/[workspaceId]/(tabs)/inbox';
import { PEOPLE_SQL } from '@/calendar/queries';
import { NewMessageSheet, REACH_SQL } from '@/components/inbox/new-message-sheet';
import { BusinessProvider } from '@/components/shell/business-context';
import { startConversation } from '@/inbox/start';
import type { Me } from '@/lib/businesses';

/**
 * New message, from the Inbox (the owner, 2026-11-22): the button in the top bar, the sheet that finds anyone by
 * name, number or email, Text and Email with where each goes, what's said when one can't reach them or can't start,
 * and their conversation opening once the sheet is gone.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/changes', () => ({ change: jest.fn(), changes: {}, newId: () => 'new-1' }));
jest.mock('@/lib/network', () => ({ useNetwork: () => ({ online: true }) }));
jest.mock('@/inbox/start', () => ({ startConversation: jest.fn() }));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const me = (permissions?: readonly string[]): Me => ({
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Porter' },
  businesses: [
    {
      id: LONE_STAR,
      name: 'Lone Star HVAC & Roofing',
      organizationId: 'org',
      organizationName: 'Lone Star HVAC & Roofing',
      role: 'owner',
      timezone: 'America/Chicago',
      ...(permissions ? { permissions } : {}),
    },
  ],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
});

const wrap = (node: React.ReactNode, who: Me = me()) => (
  <BusinessProvider
    value={{ userId: DALE, me: who, business: who.businesses[0]!, openSwitcher: () => undefined }}
  >
    {node}
  </BusinessProvider>
);

const PEOPLE = [
  {
    id: 'p-amy',
    first_name: 'Amy',
    last_name: 'Adams',
    email: 'Amy@Example.com',
    phone_e164: '+17135550142',
  },
  { id: 'p-greg', first_name: 'Greg', last_name: 'Lyons', email: null, phone_e164: '+17135550168' },
];

beforeEach(() => {
  jest.useFakeTimers();
  jest.mocked(startConversation).mockReset();
  jest.mocked(router.push).mockReset();
  jest.mocked(useQuery).mockImplementation(((sql: string, params: unknown[] = []) => ({
    data:
      sql === PEOPLE_SQL
        ? PEOPLE
        : sql === REACH_SQL
          ? PEOPLE.filter((p) => p.id === params[0])
          : [],
    isLoading: false,
    isFetching: false,
  })) as never);
});
afterEach(() => jest.useRealTimers());

describe('the New message sheet', () => {
  const show = async () => {
    const onClose = jest.fn();
    const onOpened = jest.fn();
    const view = await render(wrap(<NewMessageSheet open onClose={onClose} onOpened={onOpened} />));
    return { onClose, onOpened, view };
  };

  it('finds someone by name and offers a text and an email, with where each goes', async () => {
    await show();
    await fireEvent.changeText(screen.getByTestId('new-message-search'), 'amy');
    expect(screen.queryByTestId('new-message-person-p-greg')).toBeNull();
    await fireEvent.press(screen.getByTestId('new-message-person-p-amy'));
    expect(screen.getByTestId('new-message-to')).toHaveTextContent('Amy Adams');
    expect(screen.getByTestId('new-message-sms')).toHaveTextContent('Text (713) 555-0142');
    expect(screen.getByTestId('new-message-email')).toHaveTextContent('Email amy@example.com');
  });

  it('opens their conversation once the sheet is gone', async () => {
    jest.mocked(startConversation).mockResolvedValue({ ok: true, conversationId: 'c-amy' });
    const { onClose, onOpened, view } = await show();
    const dismiss = screen.root!.props.onDismiss as () => void;
    await fireEvent.press(screen.getByTestId('new-message-person-p-amy'));
    await fireEvent.press(screen.getByTestId('new-message-email'));
    expect(startConversation).toHaveBeenCalledWith({
      workspaceId: LONE_STAR,
      personId: 'p-amy',
      name: 'Amy Adams',
      channel: 'email',
      counterpart: 'amy@example.com',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpened).not.toHaveBeenCalled();
    await view.rerender(
      wrap(<NewMessageSheet open={false} onClose={onClose} onOpened={onOpened} />),
    );
    await act(async () => jest.advanceTimersByTime(1_000));
    await act(async () => dismiss());
    expect(onOpened).toHaveBeenCalledWith('c-amy');
  });

  it('says what’s missing when an email can’t reach them, and leaves the text', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('new-message-person-p-greg'));
    expect(screen.getByTestId('new-message-sms')).toBeEnabled();
    expect(screen.getByTestId('new-message-email')).toBeDisabled();
    expect(screen.getByTestId('new-message-no-email')).toHaveTextContent(
      /Greg Lyons has no email address yet\. Add one to their details/,
    );
    await fireEvent.press(screen.getByTestId('new-message-change'));
    expect(screen.getByTestId('new-message-search')).toBeTruthy();
  });

  it('stays open and says why when the conversation can’t start', async () => {
    jest.mocked(startConversation).mockResolvedValue({
      ok: false,
      message: 'You’re offline, and Amy Adams has no conversation on this phone yet.',
    });
    const { onClose } = await show();
    await fireEvent.press(screen.getByTestId('new-message-person-p-amy'));
    await fireEvent.press(screen.getByTestId('new-message-sms'));
    expect(screen.getByTestId('new-message-problem')).toHaveTextContent(/You’re offline/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers to add whoever was typed when nobody matches', async () => {
    await show();
    await fireEvent.changeText(screen.getByTestId('new-message-search'), 'Dana Smith');
    expect(screen.getByTestId('new-message-nobody')).toHaveTextContent(
      /No one matches “Dana Smith”\./,
    );
    await fireEvent.press(screen.getByTestId('new-message-add-contact'));
    expect(screen.getByTestId('new-contact-name').props.value).toBe('Dana Smith');
  });
});

describe('the Inbox’s New message button', () => {
  it('opens the sheet', async () => {
    await render(wrap(<Inbox />));
    expect(screen.queryByTestId('new-message-search')).toBeNull();
    await fireEvent.press(screen.getByTestId('inbox-new'));
    expect(screen.getByTestId('new-message-search')).toBeTruthy();
  });

  it('isn’t offered to someone who can’t use the inbox', async () => {
    await render(wrap(<Inbox />, me(['workspace.read', 'records.read'])));
    expect(screen.queryByTestId('inbox-new')).toBeNull();
  });
});
