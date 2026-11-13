import { CALL_COACH_TEXT_SIZE_START } from '@hfos/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { deviceStore } from '@/lib/device-store';

import { CALL_TEXT_SIZE_KEY, SalescoachCallCard } from '../call-card';

/**
 * The coach's card over a video call on the phone (the owner, 12 Nov 2026: "needs to be able to show the whole text,
 * wrap it if needed … also need to be able to adjust the text size"): every word of its title shows, and A− and A+
 * make its words smaller or bigger, kept on this phone for the next call.
 */

const TITLE =
  'They said it costs too much compared to what they pay for their current tools right now';
const SAY =
  'That makes sense. When you say it costs too much, what are you comparing it to? Is it the price of the tools you use now?';

jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  unwrap: (x: unknown) => x,
  errorMessage: (e: unknown) => String(e),
}));
jest.mock('@/components/ui/toast', () => ({ toast: { show: jest.fn(), error: jest.fn() } }));
jest.mock('@/lib/live-answer', () => ({
  useLiveAnswer: () => ({
    data: {
      call: {
        id: 'call-1',
        state: 'live',
        cards: [
          {
            id: 'card-1',
            kind: 'objection',
            title: TITLE,
            say: SAY,
            tip: 'Slow down and pause after the question.',
            heard: 'It costs too much.',
          },
        ],
      },
    },
    reload: jest.fn(),
  }),
}));

const fontSizeOf = (testID: string) =>
  (StyleSheet.flatten(screen.getByTestId(testID).props.style) as { fontSize?: number } | undefined)
    ?.fontSize;

beforeEach(() => deviceStore.remove(CALL_TEXT_SIZE_KEY));

test('the whole title shows, wrapped rather than cut to one line', async () => {
  await render(<SalescoachCallCard workspaceId="ws-1" />);
  const title = screen.getByTestId('coach-title');
  expect(title.props.numberOfLines).toBeUndefined();
  expect(screen.getByText(TITLE)).toBeTruthy();
  // At the usual size, the card's own sizes stand.
  expect(fontSizeOf('coach-say')).toBeUndefined();
});

test('A+ makes the words bigger, and the phone keeps the size', async () => {
  await render(<SalescoachCallCard workspaceId="ws-1" />);
  await fireEvent.press(screen.getByTestId('coach-bigger'));
  expect(fontSizeOf('coach-say')).toBe(23);
  expect(fontSizeOf('coach-title')).toBe(17);
  expect(deviceStore.get(CALL_TEXT_SIZE_KEY)).toBe(CALL_COACH_TEXT_SIZE_START + 1);

  // The next call starts at that size.
  await screen.unmount();
  await render(<SalescoachCallCard workspaceId="ws-1" />);
  expect(fontSizeOf('coach-say')).toBe(23);
});

test('A− goes down to the smallest size and no further', async () => {
  await render(<SalescoachCallCard workspaceId="ws-1" />);
  await fireEvent.press(screen.getByTestId('coach-smaller'));
  expect(fontSizeOf('coach-say')).toBe(17);
  expect(deviceStore.get(CALL_TEXT_SIZE_KEY)).toBe(0);
  expect(screen.getByTestId('coach-smaller').props.accessibilityState).toMatchObject({
    disabled: true,
  });
});

test('a size kept that no longer exists reads as the usual one', async () => {
  deviceStore.set(CALL_TEXT_SIZE_KEY, 99);
  await render(<SalescoachCallCard workspaceId="ws-1" />);
  expect(fontSizeOf('coach-say')).toBeUndefined();
});
