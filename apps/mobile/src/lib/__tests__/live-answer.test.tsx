import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as React from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { InViewProvider } from '../in-view';
import { useLiveAnswer } from '../live-answer';

/**
 * The phone's one way of asking HandsFreeOS for what it doesn't keep, and asking again every so often (the speed
 * audit, Nov 2026): a round waits while the one before it is still out, none is asked with the app in the
 * background or with the screen under another or on a tab that isn't picked, and a list asked for with one more page
 * stays on screen until the longer one has come.
 */

jest.mock('@/lib/network', () => ({ useNetwork: () => ({ online: true }) }));

/** An ask that answers when it's told to. */
function asker<T>() {
  const out: ((value: T) => void)[] = [];
  const ask = jest.fn(() => new Promise<T>((done) => out.push(done)));
  return {
    ask,
    /** Answer the oldest ask still out. */
    answer: (value: T) => act(async () => out.shift()!(value)),
  };
}

/** The app's state, as React Native says it, and a way to change it. */
function appState() {
  const listeners: ((state: AppStateStatus) => void)[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    listener: (state: AppStateStatus) => void,
  ) => {
    listeners.push(listener);
    return { remove: () => listeners.splice(listeners.indexOf(listener), 1) };
  }) as never);
  const to = (state: AppStateStatus) => {
    Object.defineProperty(AppState, 'currentState', { value: state, configurable: true });
    return act(async () => listeners.slice().forEach((l) => l(state)));
  };
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  return { to };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const seconds = (n: number) => act(async () => jest.advanceTimersByTime(n * 1000));

describe('asking again every so often', () => {
  it('passes a round over while the one before it is still out, and keeps its answer', async () => {
    appState();
    const { ask, answer } = asker<string>();
    const { result } = await renderHook(() =>
      useLiveAnswer(ask, 'k', 'No signal.', { everySeconds: 5 }),
    );
    expect(ask).toHaveBeenCalledTimes(1);
    // Two rounds go by with the first still out: it isn't asked again, and its answer, when it comes, is shown.
    await seconds(11);
    expect(ask).toHaveBeenCalledTimes(1);
    await answer('first');
    expect(result.current.data).toBe('first');
    // With none out, the next round asks.
    await seconds(5);
    expect(ask).toHaveBeenCalledTimes(2);
    await answer('second');
    expect(result.current.data).toBe('second');
  });

  it('gives up waiting for one that never answers', async () => {
    appState();
    const { ask } = asker<string>();
    await renderHook(() => useLiveAnswer(ask, 'k', 'No signal.', { everySeconds: 5 }));
    await seconds(29);
    expect(ask).toHaveBeenCalledTimes(1);
    await seconds(2);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('asks nothing with the app in the background, and once on the way back', async () => {
    const app = appState();
    const { ask, answer } = asker<string>();
    await renderHook(() => useLiveAnswer(ask, 'k', 'No signal.', { everySeconds: 5 }));
    await answer('first');
    await app.to('background');
    await seconds(60);
    expect(ask).toHaveBeenCalledTimes(1);
    await app.to('active');
    expect(ask).toHaveBeenCalledTimes(2);
    await answer('second');
    // Back and forth with no round missed asks nothing extra.
    await app.to('background');
    await app.to('active');
    expect(ask).toHaveBeenCalledTimes(2);
  });
});

describe('a screen that isn’t the one in view', () => {
  it('asks nothing again from under another screen, and at once when it’s back', async () => {
    appState();
    const { ask, answer } = asker<string>();
    let inView = true;
    const { result, rerender } = await renderHook(
      () => useLiveAnswer(ask, 'k', 'No signal.', { everySeconds: 5 }),
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <InViewProvider value={inView}>{children}</InViewProvider>
        ),
      },
    );
    await answer('first');
    inView = false;
    await rerender({});
    await seconds(60);
    expect(ask).toHaveBeenCalledTimes(1);
    // What it had stays on the screen under the other one.
    expect(result.current.data).toBe('first');
    inView = true;
    await rerender({});
    expect(ask).toHaveBeenCalledTimes(2);
    await answer('second');
    expect(result.current.data).toBe('second');
    // And its rounds go on from there.
    await seconds(5);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('asks nothing extra for a look away shorter than a round', async () => {
    appState();
    const { ask, answer } = asker<string>();
    let inView = true;
    const { rerender } = await renderHook(
      () => useLiveAnswer(ask, 'k', 'No signal.', { everySeconds: 5 }),
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <InViewProvider value={inView}>{children}</InViewProvider>
        ),
      },
    );
    await answer('first');
    inView = false;
    await rerender({});
    await seconds(2);
    inView = true;
    await rerender({});
    expect(ask).toHaveBeenCalledTimes(1);
    await seconds(5);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('still asks for something new, and when told to', async () => {
    appState();
    const { ask, answer } = asker<string>();
    const inView = false;
    let key = 'a';
    const { result, rerender } = await renderHook(
      () => useLiveAnswer(ask, key, 'No signal.', { everySeconds: 5 }),
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <InViewProvider value={inView}>{children}</InViewProvider>
        ),
      },
    );
    // Opened out of view: its first answer is still asked for.
    expect(ask).toHaveBeenCalledTimes(1);
    await answer('a');
    key = 'b';
    await rerender({});
    expect(ask).toHaveBeenCalledTimes(2);
    await answer('b');
    await act(async () => result.current.reload());
    expect(ask).toHaveBeenCalledTimes(3);
  });
});

describe('a list asked for with one more page', () => {
  /** A list (what was searched for) and how many of its pages, as a list screen keys its ask. */
  const list = (of: string, pages: number, says = true) => ({ of, pages, says });
  const hook = (ask: () => Promise<string[]>) =>
    renderHook(
      ({ of, pages, says }: ReturnType<typeof list>) =>
        useLiveAnswer(ask, `${of}:${pages}`, 'No signal.', says ? { moreOf: of } : {}),
      { initialProps: list('friends', 1) },
    );

  it('stays on screen until the longer one has come, when it says what it is more of', async () => {
    appState();
    const { ask, answer } = asker<string[]>();
    const { result, rerender } = await hook(ask);
    await answer(['a']);
    expect(result.current.data).toEqual(['a']);
    await rerender(list('friends', 2));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(['a']);
    expect(result.current.loading).toBe(false);
    await answer(['a', 'b']);
    await waitFor(() => expect(result.current.data).toEqual(['a', 'b']));
  });

  it('leaves the screen for another list, and for a caller that doesn’t say', async () => {
    appState();
    const { ask, answer } = asker<string[]>();
    const { result, rerender } = await hook(ask);
    await answer(['a']);
    // Another list altogether (the search changed): nothing of the old one is shown in its place.
    await rerender(list('friends:dana', 1));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    await answer(['d']);
    expect(result.current.data).toEqual(['d']);
    // A caller that says nothing of it gets the old way: empty until the new answer.
    await rerender(list('friends:dana', 2, false));
    expect(result.current.data).toBeNull();
  });
});
