import type { Outbox } from './outbox';
import { retryLaterDelay } from './rules';
import type { VersionGate } from './version-gate';

/**
 * Sends the changes set aside after a minute without getting through, again and in the order they were made: when
 * signal comes back, when the app comes to the front, when the copy reconnects, and otherwise a little later each
 * round (30 seconds, then a minute, two, five, ten). A change sent resets the rounds. Nothing goes while this build is
 * too old for the API.
 */
export class RetryLater {
  private timer: unknown = null;
  private round = 0;
  private stopped = false;

  constructor(
    private readonly deps: {
      readonly outbox: Outbox;
      readonly gate: VersionGate;
      readonly online: () => boolean;
      /** Queued again: the photo track picks up its own. */
      readonly requeued?: (ids: readonly string[]) => void;
      readonly setTimer?: (run: () => void, ms: number) => unknown;
      readonly clearTimer?: (timer: unknown) => void;
    },
  ) {}

  /** A change was set aside: send it again after this round's wait, unless a wait is already running. */
  aside(): void {
    if (this.stopped || this.timer !== null) return;
    const delay = retryLaterDelay(this.round);
    this.round += 1;
    const set = this.deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
    this.timer = set(() => {
      this.timer = null;
      void this.now();
    }, delay);
  }

  /** A change went through: the next one set aside waits the shortest time again. */
  sent(): void {
    this.round = 0;
  }

  /** Sends every change set aside again now, in order. Returns their ids. */
  async now(): Promise<string[]> {
    this.cancelTimer();
    if (this.stopped || !this.deps.online() || this.deps.gate.tooOld()) return [];
    const aside = await this.deps.outbox.setAside();
    if (aside.length === 0) return [];
    const ids = await this.deps.outbox.requeue(aside.map((row) => row.id));
    if (ids.length > 0) this.deps.requeued?.(ids);
    return ids;
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer();
  }

  private cancelTimer() {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as never)))(this.timer);
    this.timer = null;
  }
}
