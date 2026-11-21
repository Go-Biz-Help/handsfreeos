/**
 * Drive times between visits (docs/outreach.md, decision 179): on a calendar that leaves time to drive between
 * visits, the worker times the drives by road for one customer's place, and the engine keeps them clear. A visit
 * can't start sooner after someone's appointment than the drive from it takes, or end later than the drive to their
 * next one allows; and the first visit of a day leaves time to drive from where their day starts.
 *
 * The drives are data: the engine stays pure, and an appointment the worker didn't time (no address, or one
 * that couldn't be found on a map) keeps only its usual buffers.
 */
import type { Interval } from './intervals';
import type { StaffInput } from './types';
import { localDateOf } from './zoned';

const MIN = 60_000;

/** Minutes of driving, worked out for one customer's place. */
export interface Drives {
  /** From where each person's day starts to the customer, by user id. */
  readonly fromStart: Readonly<Record<string, number>>;
  /** Between each appointment's place and the customer's, either way, by appointment id. */
  readonly around: Readonly<Record<string, number>>;
}

/** Each person's first open minute of each local day. */
function dayOpenings(windows: readonly Interval[], timeZone: string): number[] {
  const first = new Map<string, number>();
  for (const w of windows) {
    const day = localDateOf(w.start, timeZone);
    const at = first.get(day);
    if (at === undefined || w.start < at) first.set(day, w.start);
  }
  return [...first.values()];
}

/**
 * The staff with the drives kept clear: each timed appointment's blocked span grows by the drive on both sides,
 * and the start of each day is busy for as long as the drive from where it starts.
 */
export function withDrives(
  staff: readonly StaffInput[],
  drives: Drives,
  timeZone: string,
): StaffInput[] {
  return staff.map((s) => {
    const fromStart = drives.fromStart[s.userId] ?? 0;
    return {
      ...s,
      busy:
        fromStart > 0
          ? [
              ...s.busy,
              ...dayOpenings(s.windows, timeZone).map((at) => ({
                start: at,
                end: at + fromStart * MIN,
              })),
            ]
          : s.busy,
      bookings: s.bookings.map((b) => {
        const m = b.appointmentId ? (drives.around[b.appointmentId] ?? 0) : 0;
        return m > 0
          ? { ...b, blocked: { start: b.blocked.start - m * MIN, end: b.blocked.end + m * MIN } }
          : b;
      }),
    };
  });
}
