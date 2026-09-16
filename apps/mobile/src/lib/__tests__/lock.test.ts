import { LOCK_AFTER_MS, lock, lockEnabledFor, lockOnReturn, setLockEnabledFor } from '../lock';

describe('the lock', () => {
  it('locks again only after a few minutes away', () => {
    const now = 10_000_000;
    expect(lockOnReturn(null, now)).toBe(false);
    expect(lockOnReturn(now - 60_000, now)).toBe(false);
    expect(lockOnReturn(now - LOCK_AFTER_MS, now)).toBe(true);
    expect(lockOnReturn(now - 60 * 60_000, now)).toBe(true);
  });

  it('is on for each person unless they turn it off', () => {
    expect(lockEnabledFor('dale')).toBe(true);
    setLockEnabledFor('dale', false);
    expect(lockEnabledFor('dale')).toBe(false);
    expect(lockEnabledFor('marco')).toBe(true);
    setLockEnabledFor('dale', true);
    expect(lockEnabledFor('dale')).toBe(true);
  });

  it('tells its listeners when it locks and unlocks', () => {
    const seen: boolean[] = [];
    const stop = lock.subscribe(() => seen.push(lock.isLocked()));
    lock.lock();
    lock.lock();
    lock.unlock();
    stop();
    expect(seen).toEqual([true, false]);
  });
});
