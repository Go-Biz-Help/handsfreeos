import { act, render, screen } from '@testing-library/react-native';
import * as React from 'react';
import { Text, type GestureResponderEvent } from 'react-native';

import { StripFrame } from '../status-strip';
import { HOLD_FOR_FINGER_MAX_MS, touches, useSettledWhileTouched } from '../touches';

/**
 * The status strip never moves what's under a finger (step 10's finding 15): it opens or closes only once no finger is
 * on the screen, and slides rather than jumps. New words in an open strip change at once.
 */

const touch = (identifier: number) => ({ identifier }) as never;
const event = (current: number[], changed: number[]) =>
  ({
    nativeEvent: { touches: current.map(touch), changedTouches: changed.map(touch) },
  }) as unknown as GestureResponderEvent;

function Probe({ value }: { value: string | null }) {
  const settled = useSettledWhileTouched(value);
  return settled === null ? null : <Text testID="settled">{settled}</Text>;
}

describe('waiting for the finger to lift', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    touches.reset();
  });
  afterEach(() => {
    touches.reset();
    jest.useRealTimers();
  });

  it('counts the fingers down, taking out one a phone still lists after it lifted', () => {
    touches.start(event([1], [1]));
    expect(touches.count()).toBe(1);
    touches.start(event([1, 2], [2]));
    expect(touches.count()).toBe(2);
    // Android can still list the lifted finger among the current touches.
    touches.end(event([1, 2], [2]));
    expect(touches.count()).toBe(1);
    touches.end(event([], [1]));
    expect(touches.count()).toBe(0);
  });

  it('opens only once no finger is down', async () => {
    await render(<Probe value={null} />);
    touches.start(event([1], [1]));
    await screen.rerender(<Probe value="Offline — 2 changes waiting" />);
    expect(screen.queryByTestId('settled')).toBeNull();
    await act(async () => touches.end(event([], [1])));
    expect(screen.getByTestId('settled')).toHaveTextContent('Offline — 2 changes waiting');
  });

  it('closes only once no finger is down, but changes its words at once', async () => {
    await render(<Probe value="Offline — 2 changes waiting" />);
    touches.start(event([1], [1]));
    await screen.rerender(<Probe value="Offline — 3 changes waiting" />);
    expect(screen.getByTestId('settled')).toHaveTextContent('Offline — 3 changes waiting');
    await screen.rerender(<Probe value={null} />);
    expect(screen.getByTestId('settled')).toHaveTextContent('Offline — 3 changes waiting');
    await act(async () => touches.end(event([], [1])));
    expect(screen.queryByTestId('settled')).toBeNull();
  });

  it('stops waiting after a few seconds if the lift never arrives', async () => {
    await render(<Probe value={null} />);
    touches.start(event([1], [1]));
    await screen.rerender(<Probe value="Can’t connect to HandsFreeOS" />);
    expect(screen.queryByTestId('settled')).toBeNull();
    await act(async () => jest.advanceTimersByTime(HOLD_FOR_FINGER_MAX_MS));
    expect(screen.getByTestId('settled')).toHaveTextContent('Can’t connect to HandsFreeOS');
  });
});

describe('the strip’s frame', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('slides open with its words, and keeps them while it slides closed', async () => {
    await render(<StripFrame shown={null} />);
    expect(screen.queryByTestId('status-strip-frame')).toBeNull();

    await screen.rerender(
      <StripFrame shown={{ text: 'Offline — 4 changes waiting', offline: true }} />,
    );
    expect(screen.getByTestId('status-strip-text')).toHaveTextContent(
      'Offline — 4 changes waiting',
    );

    await screen.rerender(<StripFrame shown={null} />);
    // Closing: the words stay while it slides, but it's no longer the strip a person can press.
    expect(screen.getByTestId('status-strip-frame')).toHaveTextContent(
      'Offline — 4 changes waiting',
    );
    expect(screen.queryByTestId('status-strip')).toBeNull();
    await act(async () => jest.advanceTimersByTime(1_000));
    expect(screen.queryByTestId('status-strip-frame')).toBeNull();
  });
});
