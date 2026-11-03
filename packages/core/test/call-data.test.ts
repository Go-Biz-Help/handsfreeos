/**
 * What a call screen downloaded (docs/video-calls.md, "What a call used"), counted where it lands: the web and the
 * phone read WebRTC's own counters with core's `watchCallData` and report them to the worker.
 *
 * What's worth holding:
 *   - a peer connection's total is its transport's count, else its chosen candidate pair's, else its streams';
 *   - the total only goes up, and a peer connection LiveKit replaced keeps what it counted;
 *   - a report goes every minute when the count grew, and once more as the screen goes, from the last reading;
 *   - a new connection (a new participant sid) is counted from zero, as the worker keeps it.
 */
import { describe, expect, it } from 'vitest';
import {
  bytesReceivedOf,
  DownloadCount,
  mostDownloadable,
  VIDEO_CALL_DATA_EVERY_MS,
  VIDEO_CALL_DATA_MAX_BYTES_A_MINUTE,
  VIDEO_CALL_DATA_SAMPLE_MS,
  watchCallData,
  type CallDataReport,
  type CallStat,
  type MeasuredRoom,
} from '../src/meetings/call-data';

const report = (...stats: CallStat[]) => new Map(stats.map((s, i) => [String(i), s]));

describe('a peer connection’s count', () => {
  it('is its transport’s, which is the whole of what it received', () => {
    expect(
      bytesReceivedOf(
        report(
          { type: 'transport', bytesReceived: 9_000 },
          { type: 'candidate-pair', nominated: true, bytesReceived: 8_900 },
          { type: 'inbound-rtp', bytesReceived: 7_000, headerBytesReceived: 500 },
        ),
      ),
    ).toBe(9_000);
  });

  it('falls back to the chosen candidate pair, then to each stream with its headers', () => {
    expect(
      bytesReceivedOf(
        report(
          { type: 'candidate-pair', nominated: false, bytesReceived: 50 },
          { type: 'candidate-pair', nominated: true, bytesReceived: 8_900 },
        ),
      ),
    ).toBe(8_900);
    expect(
      bytesReceivedOf(
        report(
          { type: 'inbound-rtp', bytesReceived: 7_000, headerBytesReceived: 500 },
          { type: 'inbound-rtp', bytesReceived: 1_000 },
          { type: 'outbound-rtp' },
        ),
      ),
    ).toBe(8_500);
    expect(bytesReceivedOf(report({ type: 'transport' }))).toBe(0);
  });
});

describe('a connection’s total', () => {
  it('only goes up, and keeps what a replaced peer connection counted', () => {
    const count = new DownloadCount();
    const first = {};
    const second = {};
    count.see(first, 1_000);
    count.see(first, 4_000);
    count.see(first, 3_000);
    expect(count.total).toBe(4_000);
    count.see(second, 500);
    expect(count.total).toBe(4_500);
  });

  it('is never past what 10 HD videos could carry in the time, with a minute’s grace', () => {
    expect(mostDownloadable(0)).toBe(VIDEO_CALL_DATA_MAX_BYTES_A_MINUTE);
    expect(mostDownloadable(9 * 60_000)).toBe(10 * VIDEO_CALL_DATA_MAX_BYTES_A_MINUTE);
  });
});

/** A room whose subscriber has received what `bytes` says, and a clock the test turns. */
function world() {
  let bytes = 0;
  let pc = { getStats: () => Promise.resolve(report({ type: 'transport', bytesReceived: bytes })) };
  const room: { localParticipant: { sid: string } } & MeasuredRoom = {
    localParticipant: { sid: 'PA_one' },
    engine: {
      get pcManager() {
        return { subscriber: pc };
      },
    },
  };
  let tick: (() => void) | null = null;
  const sent: CallDataReport[] = [];
  const watch = watchCallData(room, (r) => sent.push(r), {
    setInterval: (run) => {
      tick = run;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    room,
    sent,
    watch,
    set: (n: number) => {
      bytes = n;
    },
    newPeerConnection: () => {
      pc = { getStats: () => Promise.resolve(report({ type: 'transport', bytesReceived: bytes })) };
    },
    /** One reading's worth of time passes. */
    async tick() {
      tick?.();
      await settle();
    },
    ticking: () => tick !== null,
  };
}

describe('reporting', () => {
  const perReport = VIDEO_CALL_DATA_EVERY_MS / VIDEO_CALL_DATA_SAMPLE_MS;

  it('sends every minute when the count grew, and once more as the screen goes', async () => {
    const w = world();
    w.set(1_000);
    for (let i = 0; i < perReport; i++) await w.tick();
    expect(w.sent).toEqual([{ sid: 'PA_one', bytes: 1_000 }]);
    // Nothing new: nothing sent.
    for (let i = 0; i < perReport; i++) await w.tick();
    expect(w.sent).toHaveLength(1);
    // Read between reports, then the screen goes: the last reading goes with it, once.
    w.set(2_500);
    await w.tick();
    w.watch.stop();
    w.watch.stop();
    expect(w.sent).toEqual([
      { sid: 'PA_one', bytes: 1_000 },
      { sid: 'PA_one', bytes: 2_500 },
    ]);
    expect(w.ticking()).toBe(false);
  });

  it('keeps counting across a replaced peer connection, and starts again from zero on a new connection', async () => {
    const w = world();
    w.set(3_000);
    await w.tick();
    w.newPeerConnection();
    w.set(200);
    await w.tick();
    w.watch.flush();
    expect(w.sent.at(-1)).toEqual({ sid: 'PA_one', bytes: 3_200 });
    // LiveKit joined again after a long drop: a new participant sid, counted on its own.
    w.room.localParticipant.sid = 'PA_two';
    w.newPeerConnection();
    w.set(700);
    await w.tick();
    w.watch.flush();
    expect(w.sent.at(-1)).toEqual({ sid: 'PA_two', bytes: 700 });
  });

  it('sends nothing before it’s in a room, and never throws for a send that fails', async () => {
    const room: MeasuredRoom = { localParticipant: { sid: '' } };
    let tick: (() => void) | null = null;
    const watch = watchCallData(
      room,
      () => {
        throw new Error('offline');
      },
      {
        setInterval: (run) => {
          tick = run;
          return 1;
        },
        clearInterval: () => undefined,
      },
    );
    (tick as (() => void) | null)?.();
    expect(() => watch.stop()).not.toThrow();
  });
});
