import { act, renderHook } from '@testing-library/react-native';

import {
  asOfText,
  changesWord,
  connectionOf,
  lineText,
  SETTLE_MS,
  stripText,
  useSettledConnection,
  type Connection,
  type CopyState,
} from '../sync-status';

const inStep: CopyState = {
  connected: true,
  downloading: false,
  hasSynced: true,
  failing: false,
  keptComplete: true,
};
// 8:58 AM on Wednesday in the test's time zone.
const AS_OF = new Date(2026, 8, 16, 8, 58).getTime();
const LATER = new Date(2026, 8, 16, 11, 5).getTime();

describe('the status line', () => {
  it('reads the phone’s signal and PowerSync’s status', () => {
    expect(connectionOf(false, inStep)).toBe('offline');
    expect(connectionOf(true, inStep)).toBe('inStep');
    expect(connectionOf(true, null)).toBe('updating');
    expect(connectionOf(true, { ...inStep, connected: false })).toBe('updating');
    expect(connectionOf(true, { ...inStep, downloading: true })).toBe('updating');
    expect(connectionOf(true, { ...inStep, hasSynced: false })).toBe('updating');
    expect(connectionOf(true, { ...inStep, keptComplete: false })).toBe('updating');
    // Signal, but the sync service can't be reached or refuses: say so, not "Offline".
    expect(connectionOf(true, { ...inStep, connected: false, failing: true })).toBe('unreachable');
    expect(connectionOf(false, { ...inStep, connected: false, failing: true })).toBe('offline');
  });

  it('says "Up to date" only once in step with nothing waiting', () => {
    const now = LATER;
    expect(lineText({ connection: 'inStep', waiting: 0, asOf: AS_OF }, now)).toBe('Up to date');
    expect(lineText({ connection: 'updating', waiting: 0, asOf: AS_OF }, now)).toBe('Updating…');
    expect(lineText({ connection: 'inStep', waiting: 3, asOf: AS_OF }, now)).toBe(
      '3 changes to send',
    );
    expect(lineText({ connection: 'inStep', waiting: 3, asOf: AS_OF }, now, true)).toBe(
      '3 to send',
    );
  });

  it('says "As of" the last moment the copy was up to date while offline or unable to connect', () => {
    expect(lineText({ connection: 'offline', waiting: 4, asOf: AS_OF }, LATER)).toBe(
      'As of 8:58 AM',
    );
    expect(lineText({ connection: 'unreachable', waiting: 0, asOf: AS_OF }, LATER)).toBe(
      'As of 8:58 AM',
    );
    expect(asOfText(AS_OF, new Date(2026, 8, 18, 9, 0).getTime())).toBe('As of Sep 16, 8:58 AM');
    expect(asOfText(null, LATER)).toBe('Not updated yet');
    // Plain spaces only, whatever the phone's Intl gives.
    expect(asOfText(AS_OF, LATER)).not.toMatch(/[\u202f\u00a0]/);
  });

  it('uses the canvas’s words in the strip', () => {
    expect(stripText({ connection: 'offline', waiting: 4 })).toBe('Offline — 4 changes waiting');
    expect(stripText({ connection: 'offline', waiting: 1 })).toBe('Offline — 1 change waiting');
    expect(stripText({ connection: 'offline', waiting: 0 })).toBe('Offline');
    expect(stripText({ connection: 'unreachable', waiting: 0 })).toBe(
      'Can’t connect to HandsFreeOS',
    );
    expect(stripText({ connection: 'unreachable', waiting: 2 })).toBe(
      'Can’t connect — 2 changes waiting',
    );
    expect(stripText({ connection: 'inStep', waiting: 3 })).toBe('3 changes waiting to send');
    expect(stripText({ connection: 'updating', waiting: 3 })).toBe('3 changes waiting to send');
    expect(stripText({ connection: 'inStep', waiting: 0 })).toBeNull();
    expect(stripText({ connection: 'updating', waiting: 0 })).toBeNull();
    expect(changesWord(7)).toBe('7 changes');
  });
});

describe('settling the connection before the line says it', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const settling = () =>
    renderHook((c: Connection) => useSettledConnection(c), {
      initialProps: 'inStep' as Connection,
    });

  it('keeps "Up to date" through a burst that settles quickly', async () => {
    const { result, rerender } = await settling();
    expect(result.current).toBe('inStep');
    // PowerSync writing a batch: downloading flips on and off well inside the settle window.
    await rerender('updating');
    await act(async () => jest.advanceTimersByTime(200));
    expect(result.current).toBe('inStep');
    await rerender('inStep');
    await act(async () => jest.advanceTimersByTime(200));
    await rerender('updating');
    await act(async () => jest.advanceTimersByTime(200));
    expect(result.current).toBe('inStep');
  });

  it('says "Updating…" once it really is, and goes back at once', async () => {
    const { result, rerender } = await settling();
    await rerender('updating');
    await act(async () => jest.advanceTimersByTime(SETTLE_MS));
    expect(result.current).toBe('updating');
    // Nothing is gained by holding "Updating…" once the copy is in step.
    await rerender('inStep');
    expect(result.current).toBe('inStep');
  });

  it('never delays losing signal', async () => {
    const { result, rerender } = await settling();
    await rerender('offline');
    expect(result.current).toBe('offline');
    await rerender('unreachable');
    expect(result.current).toBe('unreachable');
  });
});
