import { changesWord, setTestWaiting, stripText, waitingCount } from '../sync-status';

describe('the status line', () => {
  it('uses the canvas’s words', () => {
    expect(stripText({ online: false, waiting: 4 })).toBe('Offline — 4 changes waiting');
    expect(stripText({ online: false, waiting: 1 })).toBe('Offline — 1 change waiting');
    expect(stripText({ online: false, waiting: 0 })).toBe('Offline');
    expect(stripText({ online: true, waiting: 3 })).toBe('3 changes waiting to send');
    expect(stripText({ online: true, waiting: 0 })).toBeNull();
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
