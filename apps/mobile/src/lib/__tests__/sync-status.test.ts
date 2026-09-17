import {
  asOfText,
  changesWord,
  connectionOf,
  lineText,
  setTestWaiting,
  stripText,
  waitingCount,
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

  it('keeps the stand-in count until the queue arrives', () => {
    expect(waitingCount()).toBe(0);
    setTestWaiting(3);
    expect(waitingCount()).toBe(3);
    setTestWaiting(0);
    expect(waitingCount()).toBe(0);
  });
});
