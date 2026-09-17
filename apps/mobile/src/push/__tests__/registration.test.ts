import { expoPushToken } from '@hfos/core';

import type { SessionState } from '@/lib/auth/session';

import {
  PushRegistration,
  standInToken,
  type PushPermission,
  type PushRegistrationDeps,
} from '../registration';

/**
 * This phone on the person's list of phones that get notifications: registered on sign-in, when the app comes to the
 * front and when its token changes; removed at sign-out and when notifications are turned off on the phone; nothing
 * registered by a build without an Expo project id; a stand-in token in test builds.
 */

const DALE = '11111111-1111-4111-8111-111111111111';
const MARCO = '22222222-2222-4222-8222-222222222222';

class Watch {
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  fire() {
    for (const listener of this.listeners) listener();
  }
}

function setup(
  options: Partial<PushRegistrationDeps> & { permission?: PushPermission; online?: boolean } = {},
) {
  const calls: { command: 'register' | 'remove'; input: unknown }[] = [];
  const values = new Map<string, unknown>();
  let session: SessionState = {
    status: 'signedIn',
    person: { userId: DALE, email: 'dale@lonestarhvac.test', name: 'Dale Ramsey' },
    expiresAt: 0,
  };
  let permission: PushPermission = options.permission ?? 'granted';
  let canAskAgain = true;
  let token = 'ExponentPushToken[real-1]';
  let online = options.online ?? true;
  let ids = 0;
  const sessionWatch = new Watch();
  const network = new Watch();
  const active = new Watch();
  const tokenWatch = new Watch();
  const requests: string[] = [];
  const failures: string[] = [];

  const registration = new PushRegistration({
    platform: 'android',
    projectId: 'hfos-project',
    standInTokens: false,
    appVersion: () => '1.0.0',
    deviceName: () => 'Pixel 9',
    notifications: {
      prepare: async () => undefined,
      getPermissions: async () => ({ status: permission, canAskAgain }),
      requestPermissions: async () => {
        requests.push('asked');
        permission = 'granted';
        return { status: permission, canAskAgain };
      },
      expoPushToken: async () => token,
      onTokenChange: (listener) => tokenWatch.subscribe(listener),
    },
    register: async (input) => {
      const failure = failures.shift();
      if (failure) throw new Error(failure);
      calls.push({ command: 'register', input });
    },
    remove: async (input) => void calls.push({ command: 'remove', input }),
    session: { getState: () => session, subscribe: sessionWatch.subscribe },
    network: { online: () => online, subscribe: network.subscribe },
    appActive: { isActive: () => true, subscribe: active.subscribe },
    store: {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: (key, value) => void values.set(key, value),
      remove: (key) => void values.delete(key),
    },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    now: () => 1_000,
    ...options,
  });

  return {
    registration,
    calls,
    values,
    requests,
    failures,
    signIn(userId: string) {
      session = {
        status: 'signedIn',
        person: { userId, email: 'x@hfos.test', name: null },
        expiresAt: 0,
      };
      sessionWatch.fire();
    },
    signOut() {
      session = { status: 'signedOut', ended: false };
      sessionWatch.fire();
    },
    setPermission(next: PushPermission, askAgain = true) {
      permission = next;
      canAskAgain = askAgain;
    },
    setToken(next: string) {
      token = next;
      tokenWatch.fire();
    },
    setOnline(next: boolean) {
      online = next;
      network.fire();
    },
    returnToApp: () => active.fire(),
  };
}

describe('registering this phone', () => {
  it('registers on start with its platform, token, the app’s version and the phone’s name', async () => {
    const t = setup();
    t.registration.start();
    await t.registration.settled();
    expect(t.calls).toEqual([
      {
        command: 'register',
        input: {
          platform: 'android',
          token: 'ExponentPushToken[real-1]',
          appVersion: '1.0.0',
          deviceName: 'Pixel 9',
        },
      },
    ]);
    expect(t.registration.getSnapshot()).toMatchObject({
      status: 'registered',
      token: 'ExponentPushToken[real-1]',
    });
    // And again each time the app comes to the front (the API refreshes the same row).
    t.returnToApp();
    await t.registration.settled();
    expect(t.calls.map((c) => c.command)).toEqual(['register', 'register']);
  });

  it('registers once when several reasons to register arrive together (starting, signing in, coming to the front)', async () => {
    const t = setup();
    t.registration.start();
    t.returnToApp();
    t.setToken('ExponentPushToken[real-1]');
    void t.registration.sync();
    await t.registration.settled();
    expect(t.calls.map((c) => c.command)).toEqual(['register']);
  });

  it('registers nothing in a build without an Expo project id, and says so', async () => {
    const t = setup({ projectId: null });
    t.registration.start();
    await t.registration.settled();
    expect(t.calls).toEqual([]);
    expect(t.registration.getSnapshot()).toMatchObject({ status: 'no-project', token: null });
  });

  it('registers a stand-in token in test builds, the shape the database takes, the same for the install', async () => {
    const t = setup({ projectId: null, standInTokens: true });
    t.registration.start();
    await t.registration.settled();
    const token = standInToken('00000000-0000-4000-8000-000000000001');
    expect(token).toBe('ExponentPushToken[e2e-00000000-0000-4000-8000-000000000001]');
    expect(expoPushToken.safeParse(token).success).toBe(true);
    expect(t.calls).toEqual([{ command: 'register', input: expect.objectContaining({ token }) }]);
    t.returnToApp();
    await t.registration.settled();
    expect(t.calls.map((c) => (c.input as { token: string }).token)).toEqual([token, token]);
  });

  it('registers the new token when the phone’s token changes, and takes the old one off the list', async () => {
    const t = setup();
    t.registration.start();
    await t.registration.settled();
    t.setToken('ExponentPushToken[real-2]');
    await t.registration.settled();
    expect(t.calls).toEqual([
      {
        command: 'register',
        input: expect.objectContaining({ token: 'ExponentPushToken[real-1]' }),
      },
      { command: 'remove', input: { token: 'ExponentPushToken[real-1]', reason: 'turned_off' } },
      {
        command: 'register',
        input: expect.objectContaining({ token: 'ExponentPushToken[real-2]' }),
      },
    ]);
  });

  it('waits for signal to register, then registers', async () => {
    const t = setup({ online: false });
    t.registration.start();
    await t.registration.settled();
    expect(t.calls).toEqual([]);
    expect(t.registration.getSnapshot().status).toBe('waiting-for-signal');
    t.setOnline(true);
    await t.registration.settled();
    expect(t.calls.map((c) => c.command)).toEqual(['register']);
  });

  it('says what went wrong when HandsFreeOS refuses, and tries again', async () => {
    const t = setup();
    t.failures.push('This version of HandsFreeOS is too old. Update it to keep going.');
    t.registration.start();
    await t.registration.settled();
    expect(t.registration.getSnapshot()).toMatchObject({
      status: 'failed',
      message: 'This version of HandsFreeOS is too old. Update it to keep going.',
    });
    await t.registration.sync();
    expect(t.registration.getSnapshot().status).toBe('registered');
  });
});

describe('taking this phone off the list', () => {
  it('removes it at sign-out, while the API still knows who is signing out', async () => {
    const t = setup();
    t.registration.start();
    await t.registration.settled();
    await t.registration.beforeSignOut();
    expect(t.calls).toEqual([
      { command: 'register', input: expect.anything() },
      { command: 'remove', input: { token: 'ExponentPushToken[real-1]', reason: 'signed_out' } },
    ]);
    t.signOut();
    await t.registration.settled();
    expect(t.registration.getSnapshot().status).toBe('signed-out');
    expect(t.calls).toHaveLength(2);
    // Signing in again adds it again.
    t.signIn(DALE);
    await t.registration.settled();
    expect(t.calls.map((c) => c.command)).toEqual(['register', 'remove', 'register']);
  });

  it('signs out with no signal without waiting (whoever signs in next takes the token over)', async () => {
    const t = setup();
    t.registration.start();
    await t.registration.settled();
    t.setOnline(false);
    await t.registration.beforeSignOut();
    expect(t.calls.map((c) => c.command)).toEqual(['register']);
    expect(t.registration.registered()).toBeNull();
    t.setOnline(true);
    t.signIn(MARCO);
    await t.registration.settled();
    expect(t.calls[1]).toEqual({
      command: 'register',
      input: expect.objectContaining({ token: 'ExponentPushToken[real-1]' }),
    });
  });

  it('removes it when notifications are turned off on the phone, and registers again when they’re back on', async () => {
    const t = setup();
    t.registration.start();
    await t.registration.settled();
    t.setPermission('denied', false);
    t.returnToApp();
    await t.registration.settled();
    expect(t.calls[1]).toEqual({
      command: 'remove',
      input: { token: 'ExponentPushToken[real-1]', reason: 'turned_off' },
    });
    expect(t.registration.getSnapshot()).toMatchObject({
      status: 'no-permission',
      permission: 'denied',
      canAskAgain: false,
    });
    t.setPermission('granted');
    t.returnToApp();
    await t.registration.settled();
    expect(t.calls.map((c) => c.command)).toEqual(['register', 'remove', 'register']);
  });
});

describe('asking for permission', () => {
  it('asks once, at its moment, then registers', async () => {
    const t = setup({ permission: 'undetermined' });
    t.registration.start();
    await t.registration.settled();
    expect(t.calls).toEqual([]);
    await t.registration.askOnce();
    await t.registration.settled();
    expect(t.requests).toEqual(['asked']);
    expect(t.calls.map((c) => c.command)).toEqual(['register']);
    await t.registration.askOnce();
    await t.registration.settled();
    expect(t.requests).toEqual(['asked']);
  });

  it('doesn’t ask when the phone already answered', async () => {
    const t = setup({ permission: 'denied' });
    await t.registration.askOnce();
    await t.registration.settled();
    expect(t.requests).toEqual([]);
  });
});
