/**
 * What a HandsFreeOS video call really used (docs/video-calls.md, "What a call used"): the data each person's call
 * screen downloaded, measured where it lands.
 *
 * LiveKit bills every connection's minutes and every byte it sends down to each one. Its webhooks give the worker the
 * minutes; its own report of each call's bytes needs its most expensive plan. So the web and phone call screens read
 * WebRTC's own byte counters, and report what they've received to the worker (`POST /public/calls/data`, then
 * `video_call.data`), every minute and once more as they leave.
 *
 * Shared by the web and the phone: neither has DOM types here, so the room and its stats are described by shape.
 */

/** How often a call screen reports what it has downloaded. */
export const VIDEO_CALL_DATA_EVERY_MS = 60_000;

/** How often it reads the counters between reports, so what it sends as it leaves is at most this old. */
export const VIDEO_CALL_DATA_SAMPLE_MS = 15_000;

/**
 * The most one connection can download in a minute: 10 HD videos at 1.7 Mbps, about 130 MB. A report past it is cut
 * to it, so no page can run up a business's bill.
 */
export const VIDEO_CALL_DATA_MAX_BYTES_A_MINUTE = 130_000_000;

/** How long after a connection left its last report is still taken: a page's report as it closes comes after. */
export const VIDEO_CALL_DATA_LATE_MS = 5 * 60_000;

/** The most a connection could have downloaded in so long, with a minute's grace for clocks and the first report. */
export const mostDownloadable = (ms: number): number =>
  Math.ceil(((Math.max(0, ms) + 60_000) / 60_000) * VIDEO_CALL_DATA_MAX_BYTES_A_MINUTE);

/** One entry of a WebRTC stats report, as much of it as counting needs. */
export interface CallStat {
  readonly type: string;
  readonly bytesReceived?: number;
  readonly headerBytesReceived?: number;
  readonly nominated?: boolean;
  readonly selected?: boolean;
}

/** A WebRTC stats report: a browser's `RTCStatsReport` and react-native-webrtc's are both maps. */
export interface CallStats {
  forEach(each: (stat: CallStat) => void): void;
}

const count = (n: number | undefined): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

/**
 * Everything one peer connection has received, from its stats. The transport's count is the whole of it: what LiveKit
 * sent, headers and all. A browser without it falls back to the chosen candidate pair's, then to each stream's bytes
 * and headers.
 */
export function bytesReceivedOf(stats: CallStats): number {
  let transport: number | null = null;
  let pair: number | null = null;
  let streams = 0;
  stats.forEach((s) => {
    const b = count(s.bytesReceived);
    if (b === null) return;
    if (s.type === 'transport') transport = (transport ?? 0) + b;
    else if (s.type === 'candidate-pair' && (s.nominated || s.selected)) pair = (pair ?? 0) + b;
    else if (s.type === 'inbound-rtp') streams += b + (count(s.headerBytesReceived) ?? 0);
  });
  return Math.round(transport ?? pair ?? streams);
}

/**
 * What one connection has downloaded altogether, read a peer connection at a time. LiveKit can replace a peer
 * connection while the connection carries on (a network change): the old one's count is kept, so the total only ever
 * goes up.
 */
export class DownloadCount {
  private readonly last = new Map<object, number>();

  /** Notes what one peer connection has received so far. A count that went down is a hiccup, and is ignored. */
  see(pc: object, bytes: number): void {
    if (bytes > (this.last.get(pc) ?? -1)) this.last.set(pc, bytes);
  }

  get total(): number {
    let sum = 0;
    for (const b of this.last.values()) sum += b;
    return sum;
  }
}

/** Something that can be asked for its stats: one of LiveKit's peer connections. */
export interface StatsSource {
  getStats(): Promise<CallStats> | undefined;
}

/** As much of a LiveKit room as measuring needs: livekit-client's `Room`, on the web and the phone. */
export interface MeasuredRoom {
  readonly localParticipant: { readonly sid: string };
  readonly engine?:
    | {
        readonly pcManager?:
          { readonly publisher?: StatsSource; readonly subscriber?: StatsSource } | undefined;
      }
    | undefined;
}

/** One report: what this connection (LiveKit's participant sid) has downloaded so far. */
export interface CallDataReport {
  readonly sid: string;
  readonly bytes: number;
}

export interface CallDataTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: CallDataTimers = {
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/**
 * Measures what a call screen downloads and reports it: read every `VIDEO_CALL_DATA_SAMPLE_MS`, sent every
 * `VIDEO_CALL_DATA_EVERY_MS` when it has grown, and sent once more by `flush` (leaving, the page closing) from the
 * last reading. Each connection is counted on its own from zero, as the worker keeps it: a reload, or LiveKit
 * joining again after a long drop, is a new participant sid and a new count.
 *
 * Sending never throws and never waits: a report that's lost costs a minute of counting, and the next one carries it.
 */
export function watchCallData(
  room: MeasuredRoom,
  send: (report: CallDataReport) => void,
  timers: CallDataTimers = realTimers,
): { flush(): void; stop(): void; read(): Promise<void> } {
  let sid = '';
  let counted = new DownloadCount();
  let sent = { sid: '', bytes: 0 };
  let ticks = 0;
  let stopped = false;

  const read = async () => {
    const now = room.localParticipant.sid;
    if (!now) return;
    if (now !== sid) {
      sid = now;
      counted = new DownloadCount();
    }
    const pcs = room.engine?.pcManager;
    const sources = [pcs?.publisher, pcs?.subscriber].filter((p): p is StatsSource => !!p);
    const forSid = counted;
    for (const pc of sources) {
      const stats = await Promise.resolve(pc.getStats()).catch(() => undefined);
      // A connection that changed while this was read starts its own count; this reading was the old one's.
      if (stats && forSid === counted) counted.see(pc, bytesReceivedOf(stats));
    }
  };

  const flush = () => {
    const bytes = counted.total;
    if (!sid || (sent.sid === sid && bytes <= sent.bytes)) return;
    sent = { sid, bytes };
    try {
      send({ sid, bytes });
    } catch {
      // Never in the way of the call.
    }
  };

  const every = Math.max(1, Math.round(VIDEO_CALL_DATA_EVERY_MS / VIDEO_CALL_DATA_SAMPLE_MS));
  const handle = timers.setInterval(() => {
    ticks += 1;
    void read().then(() => {
      if (!stopped && ticks % every === 0) flush();
    });
  }, VIDEO_CALL_DATA_SAMPLE_MS);

  return {
    flush,
    read,
    stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(handle);
      flush();
    },
  };
}
