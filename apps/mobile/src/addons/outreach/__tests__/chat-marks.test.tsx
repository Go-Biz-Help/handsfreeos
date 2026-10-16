import type { ChatsOutput } from '@hfos/core/addons/outreach/chat-read';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { ChangeError } from '@/changes';
import { toast } from '@/components/ui/toast';

import { ChatsBody } from '../chats';
import { id } from './mocks';

/**
 * Don't pitch and Never contact on the phone's Chats screen, as on the web's Chats tab and Friends rows: switched on
 * each chat whose person is kept as a profile, sent with signal only, and flipped back with why when refused.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/changes', () => ({
  change: jest.fn(async () => ({ id: 'change-1', queued: false, output: {} })),
  ChangeError: class extends Error {
    constructor(_kind: string, message: string) {
      super(message);
    }
  },
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));
jest.mock('@/components/ui/toast', () => ({
  ...jest.requireActual<object>('@/components/ui/toast'),
  toast: { show: jest.fn(), error: jest.fn() },
}));

const chat = (over: Partial<ChatsOutput['chats'][number]> = {}): ChatsOutput['chats'][number] => ({
  chatId: id(70),
  name: 'Drew Moss',
  platform: 'facebook',
  personId: null,
  lastAt: '2026-10-10T15:00:00.000Z',
  lastFromMe: true,
  messages: 2,
  readState: 'read',
  summary: 'Asked about the price.',
  tags: [],
  prospect: true,
  nextStep: null,
  threadKey: null,
  profileId: id(71),
  dontPitch: false,
  neverContact: false,
  onCard: false,
  ...over,
});

const body = (
  chats: ChatsOutput['chats'],
  props: Partial<React.ComponentProps<typeof ChatsBody>> = {},
) => (
  <ChatsBody
    view="read"
    onView={jest.fn()}
    tag=""
    onTag={jest.fn()}
    search=""
    onSearch={jest.fn()}
    chats={{
      contactsFromChats: 'prospects',
      counts: { prospects: 1, tagged: 0, read: 1, waiting: 0 },
      tags: [],
      chats,
      page: 1,
      pages: 1,
      total: chats.length,
    }}
    error={null}
    onRetry={jest.fn()}
    onMore={jest.fn()}
    onCustomer={jest.fn()}
    {...props}
  />
);

beforeEach(() => {
  jest.mocked(toast.show).mockClear();
  jest.mocked(toast.error).mockClear();
});

describe('Don’t pitch and Never contact on a chat, on the phone', () => {
  it('switches Don’t pitch for who the chat is with, and says so', async () => {
    const onMark = jest.fn(async () => {});
    await render(body([chat()], { onMark }));
    await fireEvent(screen.getByTestId('chats-dont-pitch'), 'checkedChange', true);
    await waitFor(() => expect(onMark).toHaveBeenCalledWith(id(71), { dontPitch: true }));
    expect(toast.show).toHaveBeenCalledWith(
      'Drew Moss is on Don’t pitch. Nobody here sends them outreach.',
    );
  });

  it('flips back with why when it’s refused', async () => {
    const onMark = jest.fn(async () => {
      throw new ChangeError('refused', 'Only they or an owner or admin can take them off.');
    });
    await render(body([chat({ neverContact: true })], { onMark }));
    await fireEvent(screen.getByTestId('chats-never-contact'), 'checkedChange', false);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Only they or an owner or admin can take them off.'),
    );
    expect(screen.getByTestId('chats-never-contact').props.accessibilityState.checked).toBe(true);
  });

  it('can’t be switched with no signal, and shows nothing for a chat with no profile', async () => {
    const onMark = jest.fn(async () => {});
    await render(
      body([chat(), chat({ chatId: id(72), profileId: null })], { onMark, online: false }),
    );
    expect(screen.getAllByTestId('chats-dont-pitch')).toHaveLength(1);
    expect(screen.getByTestId('chats-dont-pitch').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText(/need signal/)).toBeTruthy();
  });
});
