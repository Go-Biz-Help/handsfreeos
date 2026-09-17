/**
 * "This version of HandsFreeOS is too old": once the API refuses this build (426), nothing more is sent from it and
 * every change stays on the phone. It's remembered for this build only, so updating the app sends everything that
 * waited, in order.
 */

export const TOO_OLD_WORDS = 'This version of HandsFreeOS is too old. Update it to keep going.';

const KEY = 'changes.tooOld';

export interface GateStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  subscribe(listener: () => void): () => void;
}

interface Stored {
  /** The build the API refused. */
  readonly version: string;
  readonly minVersion: string | null;
  readonly at: number;
}

export class VersionGate {
  constructor(
    private readonly store: GateStore,
    private readonly appVersion: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  private stored(): Stored | null {
    const value = this.store.get<Stored>(KEY);
    return value && typeof value.version === 'string' ? value : null;
  }

  /** The API refused this build: stop sending until it's updated. */
  tooOld = (): boolean => this.stored()?.version === this.appVersion();

  /** The oldest build the API takes, when it said. */
  minVersion(): string | null {
    return this.tooOld() ? (this.stored()?.minVersion ?? null) : null;
  }

  markTooOld(minVersion: string | null): void {
    if (this.tooOld() && this.stored()?.minVersion === minVersion) return;
    this.store.set(KEY, { version: this.appVersion(), minVersion, at: this.now() });
  }

  /** Try this build again (the API may have been changed back): the next refusal marks it again. */
  clear(): void {
    this.store.remove(KEY);
  }

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);
}
