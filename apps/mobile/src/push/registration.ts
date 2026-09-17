import type { SessionState } from '@/lib/auth/session';

/**
 * This phone's place on the person's list of phones that get notifications (`push_device.register` and
 * `push_device.remove`, apps/worker/src/push/README.md):
 *
 * - **Registered** when they sign in, every time the app comes to the front, and whenever the phone's push token
 *   changes: its platform, token, the app's version and the phone's name. Both commands are online-only, so without
 *   signal it registers once signal is back.
 * - **Removed** when they sign out (`signed_out`, before the sign-in ends, so the API still knows who they are), and
 *   when notifications are turned off for HandsFreeOS in the phone's settings (`turned_off`); turned back on, it
 *   registers again.
 * - **Its token** comes from Expo's push service, which needs the app's Expo project id. Builds made without one (until
 *   the Expo account exists) register nothing, and Settings says so. Test builds register a stand-in token instead
 *   (`ExponentPushToken[e2e-…]`, the shape the database takes), so the flows exercise registration and the worker's
 *   stand-in pushes.
 */

export type PushPermission = 'granted' | 'denied' | 'undetermined';

export type RegistrationStatus =
  /** On the person's list of phones: pushes come here. */
  | 'registered'
  | 'registering'
  /** Nobody is signed in. */
  | 'signed-out'
  /** The phone doesn't let HandsFreeOS send notifications (not asked yet, or turned off). */
  | 'no-permission'
  /** This build has no Expo project id, so it can't get a push token. */
  | 'no-project'
  /** It registers once there's signal. */
  | 'waiting-for-signal'
  /** HandsFreeOS or the phone refused; `message` says why. */
  | 'failed';

export interface RegistrationSnapshot {
  readonly status: RegistrationStatus;
  readonly permission: PushPermission | null;
  /** Whether the phone would show its own prompt if asked (false once the person said no for good). */
  readonly canAskAgain: boolean;
  /** This phone's token, once it has one. Test builds show it; nothing logs it. */
  readonly token: string | null;
  readonly registeredAt: number | null;
  readonly message: string | null;
}

export interface Registered {
  readonly userId: string;
  readonly token: string;
  readonly at: number;
}

export interface RegistrationStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

export interface PushRegistrationDeps {
  readonly platform: 'ios' | 'android';
  /** The app's Expo project id (app config `extra.eas.projectId`), or null until the Expo account exists. */
  readonly projectId: string | null;
  /** Test builds: a stand-in token for the worker's stand-in push service. */
  readonly standInTokens: boolean;
  readonly appVersion: () => string;
  readonly deviceName: () => string | null;
  readonly notifications: {
    /** Android's notification channel and every category's buttons, before asking or getting a token. */
    prepare(): Promise<void>;
    getPermissions(): Promise<{ status: PushPermission; canAskAgain: boolean }>;
    requestPermissions(): Promise<{ status: PushPermission; canAskAgain: boolean }>;
    expoPushToken(projectId: string): Promise<string>;
    /** Calls back when the phone's push token changes. */
    onTokenChange(listener: () => void): () => void;
  };
  /** Sends an online-only command; throws with the words to show when it can't. */
  readonly register: (input: {
    platform: 'ios' | 'android';
    token: string;
    appVersion: string;
    deviceName?: string | null;
  }) => Promise<void>;
  readonly remove: (input: { token: string; reason: 'signed_out' | 'turned_off' }) => Promise<void>;
  readonly session: { getState(): SessionState; subscribe(listener: () => void): () => void };
  readonly network: { online(): boolean; subscribe(listener: () => void): () => void };
  /** The app coming to the front (and whether it's in front now). */
  readonly appActive: { isActive(): boolean; subscribe(listener: () => void): () => void };
  readonly store: RegistrationStore;
  readonly newId: () => string;
  readonly now?: () => number;
  readonly log?: (message: string, error?: unknown) => void;
}

const REGISTERED_KEY = 'push.registered';
const STAND_IN_KEY = 'push.standInId';
const ASKED_KEY = 'push.askedAt';

/** The stand-in token test builds register: the shape 0058's check takes, one per install. */
export function standInToken(installId: string): string {
  return `ExponentPushToken[e2e-${installId}]`;
}

const INITIAL: RegistrationSnapshot = {
  status: 'signed-out',
  permission: null,
  canAskAgain: true,
  token: null,
  registeredAt: null,
  message: null,
};

export class PushRegistration {
  private snapshot: RegistrationSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private signingOut = false;
  private prepared: Promise<void> | null = null;
  /** A sync asked for that hasn't started yet: asking again (the app starting, signing in, coming to the front) joins it. */
  private waiting: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: PushRegistrationDeps) {
    this.now = deps.now ?? Date.now;
  }

  readonly getSnapshot = (): RegistrationSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<RegistrationSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Runs one step after another; a failure is logged and never stops the next. */
  private run(step: () => Promise<void>): Promise<void> {
    const next = this.queue.then(step).catch((error: unknown) => {
      this.deps.log?.('Registering this phone for notifications', error);
    });
    this.queue = next;
    return next;
  }

  /** Waits for every step asked for so far. */
  settled(): Promise<void> {
    return this.queue;
  }

  /** What's registered on this phone, for whom. */
  registered(): Registered | null {
    const value = this.deps.store.get<Registered>(REGISTERED_KEY);
    return value && typeof value.token === 'string' && typeof value.userId === 'string'
      ? value
      : null;
  }

  /** Follows the sign-in, signal, the app coming to the front and token changes from now on. */
  start(): void {
    if (this.started) return;
    this.started = true;
    let userId = this.userId();
    this.deps.session.subscribe(() => {
      const next = this.userId();
      if (next === userId) return;
      userId = next;
      void this.sync();
    });
    let online = this.deps.network.online();
    this.deps.network.subscribe(() => {
      const next = this.deps.network.online();
      if (next && !online && this.snapshot.status !== 'registered') void this.sync();
      online = next;
    });
    this.deps.appActive.subscribe(() => void this.sync());
    this.deps.notifications.onTokenChange(() => void this.sync());
    if (this.deps.appActive.isActive()) void this.sync();
  }

  private userId(): string | null {
    const state = this.deps.session.getState();
    return state.status === 'signedIn' ? state.person.userId : null;
  }

  private prepare(): Promise<void> {
    this.prepared ??= this.deps.notifications.prepare().catch((error: unknown) => {
      this.prepared = null;
      throw error;
    });
    return this.prepared;
  }

  /** The token this build registers, or null for a build without an Expo project id. */
  private async token(): Promise<string | null> {
    if (this.deps.standInTokens) {
      let id = this.deps.store.get<string>(STAND_IN_KEY);
      if (typeof id !== 'string' || !id) {
        id = this.deps.newId();
        this.deps.store.set(STAND_IN_KEY, id);
      }
      return standInToken(id);
    }
    if (!this.deps.projectId) return null;
    return this.deps.notifications.expoPushToken(this.deps.projectId);
  }

  /**
   * Brings this phone's registration in line with the sign-in and the phone's permission: registers it (again), or
   * removes it once notifications are turned off. Runs on sign-in, when the app comes to the front, with signal back
   * and when the token changes.
   */
  sync(): Promise<void> {
    if (this.waiting) return this.waiting;
    const next = this.run(async () => {
      this.waiting = null;
      const userId = this.userId();
      if (!userId || this.signingOut) {
        this.update({ status: 'signed-out', token: null, registeredAt: null, message: null });
        return;
      }
      await this.prepare();
      const permission = await this.deps.notifications.getPermissions();
      this.update({ permission: permission.status, canAskAgain: permission.canAskAgain });
      const earlier = this.registered();

      if (permission.status !== 'granted') {
        // Turned off in the phone's settings: off the list, until it's turned back on.
        if (earlier?.userId === userId) await this.removeRegistration(earlier, 'turned_off');
        this.update({ status: 'no-permission', registeredAt: null, message: null });
        return;
      }

      const token = await this.token();
      if (!token) {
        this.update({ status: 'no-project', token: null, registeredAt: null, message: null });
        return;
      }
      if (!this.deps.network.online()) {
        this.update({ status: 'waiting-for-signal', token, message: null });
        return;
      }
      // A new token for this person: the old one comes off the list first.
      if (earlier && earlier.userId === userId && earlier.token !== token)
        await this.removeRegistration(earlier, 'turned_off').catch(() => undefined);
      this.update({ status: 'registering', token, message: null });
      try {
        await this.deps.register({
          platform: this.deps.platform,
          token,
          appVersion: this.deps.appVersion(),
          ...(this.deps.deviceName() ? { deviceName: this.deps.deviceName() } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.update({
          status: this.deps.network.online() ? 'failed' : 'waiting-for-signal',
          message,
        });
        return;
      }
      const at = this.now();
      this.deps.store.set(REGISTERED_KEY, { userId, token, at } satisfies Registered);
      this.update({ status: 'registered', token, registeredAt: at, message: null });
    });
    this.waiting = next;
    return next;
  }

  private async removeRegistration(
    registered: Registered,
    reason: 'signed_out' | 'turned_off',
  ): Promise<void> {
    if (!this.deps.network.online()) return;
    await this.deps.remove({ token: registered.token, reason });
    this.deps.store.remove(REGISTERED_KEY);
  }

  /**
   * The person is signing out: this phone comes off their list first, while the API still knows who they are. With no
   * signal it can't be told; whoever signs in next on this phone takes the token over, and the same person signing in
   * again turns it back on.
   */
  async beforeSignOut(): Promise<void> {
    this.signingOut = true;
    try {
      // A registration on its way finishes first (briefly), so it can't put the phone back on the list afterwards.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.queue,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 2_000);
        }),
      ]);
      clearTimeout(timer);
      const userId = this.userId();
      const registered = this.registered();
      this.deps.store.remove(REGISTERED_KEY);
      this.update({ status: 'signed-out', registeredAt: null, message: null });
      if (!registered || registered.userId !== userId || !this.deps.network.online()) return;
      await this.deps.remove({ token: registered.token, reason: 'signed_out' });
    } catch (error) {
      this.deps.log?.('Taking this phone off the list at sign-out', error);
    } finally {
      this.signingOut = false;
    }
  }

  /**
   * Asks the phone for permission to show notifications, the first time only (the phone shows its own prompt; on
   * Android 13 and later that's POST_NOTIFICATIONS), then registers.
   */
  askOnce(): Promise<void> {
    return this.run(async () => {
      if (!this.userId()) return;
      if (this.deps.store.get<number>(ASKED_KEY)) return;
      await this.prepare();
      const current = await this.deps.notifications.getPermissions();
      if (current.status !== 'undetermined' || !current.canAskAgain) {
        this.deps.store.set(ASKED_KEY, this.now());
        return;
      }
      this.deps.store.set(ASKED_KEY, this.now());
      const answer = await this.deps.notifications.requestPermissions();
      this.update({ permission: answer.status, canAskAgain: answer.canAskAgain });
    }).then(() => this.sync());
  }

  /** Settings → Notifications: "Allow notifications" asks again when the phone still can. */
  async ask(): Promise<PushPermission> {
    await this.run(async () => {
      await this.prepare();
      const answer = await this.deps.notifications.requestPermissions();
      this.update({ permission: answer.status, canAskAgain: answer.canAskAgain });
    });
    await this.sync();
    return this.snapshot.permission ?? 'undetermined';
  }
}
