import { afterEach, describe, expect, it, vi } from 'vitest';
import { pause, WAKE_MOST_MS, WAKE_NOTE, waitFor, wakeAfter, within } from '../src/steady';

// The owner's 12 PM posts of 16 Nov 2026 went up at 1:52 PM: a Facebook Page post's 90-second wait, counted as 225
// looks, took 1 hour 50 minutes in a posting window Chrome hid and woke once a minute.

const here = globalThis as { chrome?: unknown; document?: unknown };

afterEach(() => {
  delete here.chrome;
  delete here.document;
  vi.useRealTimers();
});

/** A page Chrome hides, in the extension's own part of it, whose background answers `answer`. */
function hiddenPage(answer: () => Promise<unknown>) {
  const sendMessage = vi.fn(answer);
  here.chrome = { runtime: { id: 'hfos', sendMessage } };
  here.document = { visibilityState: 'hidden' };
  return sendMessage;
}

describe('waiting in a window Chrome hides', () => {
  it('ends a wait by the clock, however long each look took', async () => {
    vi.useFakeTimers();
    let looks = 0;
    const waiting = waitFor(
      () => {
        looks++;
        // Chrome woke the page once a minute.
        vi.setSystemTime(Date.now() + 60_000);
        return null;
      },
      90_000,
      400,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await waiting).toBeNull();
    // Counted in looks it was 226 of them, so 226 minutes.
    expect(looks).toBeLessThanOrEqual(3);
  });

  it('still finds what shows within the wait, and gives back what it found', async () => {
    vi.useFakeTimers();
    let looks = 0;
    const waiting = waitFor(() => (++looks === 3 ? 'box' : null), 8_000, 400);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await waiting).toBe('box');
    const ready = within(1_500, () => looks++ > 5, 100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await ready).toBe(true);
    const never = within(1_000, () => false, 100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await never).toBe(false);
  });

  it('has the background wake a hidden page, whose own timers Chrome slows', async () => {
    vi.useFakeTimers();
    const sendMessage = hiddenPage(async () => ({ ok: true, value: null }));
    let woke = false;
    void pause(60_000).then(() => (woke = true));
    // No time passes on the page's own timer: the background's woke it.
    await vi.advanceTimersByTimeAsync(0);
    expect(woke).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({ type: WAKE_NOTE, ms: 60_000 });
  });

  it('waits on its own timer when the background doesn’t answer, or the page is in view', async () => {
    vi.useFakeTimers();
    hiddenPage(() => Promise.reject(new Error('The message port closed.')));
    let woke = false;
    void pause(1_000).then(() => (woke = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(woke).toBe(true);

    const sendMessage = hiddenPage(async () => undefined);
    here.document = { visibilityState: 'visible' };
    let shown = false;
    void pause(1_000).then(() => (shown = true));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(shown).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('wakes a page after what it asked, within reason', () => {
    expect(wakeAfter({ type: WAKE_NOTE, ms: 400 })).toBe(400);
    expect(wakeAfter({ type: WAKE_NOTE, ms: 10 * WAKE_MOST_MS })).toBe(WAKE_MOST_MS);
    expect(wakeAfter({ type: WAKE_NOTE, ms: -5 })).toBe(0);
    expect(wakeAfter({ type: WAKE_NOTE })).toBe(0);
    expect(wakeAfter(null)).toBe(0);
  });
});
