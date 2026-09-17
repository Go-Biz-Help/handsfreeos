/// <reference types="node" />
import type { AbstractPowerSyncDatabase } from '@powersync/common';

import {
  json,
  noSignal,
  nowSeconds,
  savedSession,
  setup,
  type Responder,
} from '@/lib/auth/__tests__/fake-auth';

import { CopyConnector, REFRESH_AFTER_REFUSAL_MS, uploadNothingYet } from '../connector';

/**
 * The connector against the real SessionStore and supabase-js, with Supabase Auth's answers made up: the sync
 * service's address and a fresh token, nothing when signed out, and a token the sync service refuses leading to a
 * refresh, where only Supabase Auth refusing that ends the sign-in.
 */

const SYNC = 'http://sync.test';

async function settle(promise?: Promise<unknown>) {
  await jest.advanceTimersByTimeAsync(45_000);
  return promise;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

const refreshes = (requests: string[]) =>
  requests.filter((url) => url.includes('grant_type=refresh_token')).length;

describe('the copy’s connector', () => {
  it('gives the sync service’s address and the access token', async () => {
    const saved = savedSession(nowSeconds() + 3600);
    const { store, requests } = setup(noSignal, saved);
    await store.start();
    const connector = new CopyConnector({ endpoint: SYNC, session: store });
    await expect(connector.fetchCredentials()).resolves.toEqual({
      endpoint: SYNC,
      token: saved.access_token,
    });
    expect(refreshes(requests)).toBe(0);
  });

  it('gives nothing when nobody is signed in', async () => {
    const { store } = setup(noSignal, null);
    await store.start();
    await expect(
      new CopyConnector({ endpoint: SYNC, session: store }).fetchCredentials(),
    ).resolves.toBeNull();
  });

  it('refreshes a token that’s about to run out before giving it', async () => {
    const fresh = savedSession(nowSeconds() + 3600, 'refresh-2');
    const respond: Responder = (url) =>
      url.includes('grant_type=refresh_token') ? json(200, fresh) : noSignal(url);
    const { store, requests } = setup(respond, savedSession(nowSeconds() + 30));
    await store.start();
    const credentials = await settle(
      new CopyConnector({ endpoint: SYNC, session: store }).fetchCredentials(),
    );
    expect(refreshes(requests)).toBe(1);
    expect(credentials).toEqual({ endpoint: SYNC, token: fresh.access_token });
  });

  it('gives nothing with no signal and a token that has run out, rather than signing out', async () => {
    const { store } = setup(noSignal, savedSession(nowSeconds() - 3600));
    await store.start();
    const credentials = await settle(
      new CopyConnector({ endpoint: SYNC, session: store }).fetchCredentials(),
    );
    expect(credentials).toBeNull();
    expect(store.getState().status).toBe('signedIn');
  });

  it('asks Supabase Auth for a fresh token when the sync service refuses one, at most once a minute', async () => {
    const fresh = savedSession(nowSeconds() + 3600, 'refresh-2');
    const respond: Responder = (url) =>
      url.includes('grant_type=refresh_token') ? json(200, fresh) : noSignal(url);
    const { store, requests } = setup(respond, savedSession(nowSeconds() + 3000));
    await store.start();
    let now = 1_000_000;
    const refused = jest.fn();
    const connector = new CopyConnector({
      endpoint: SYNC,
      session: store,
      now: () => now,
      onRefused: refused,
    });
    connector.invalidateCredentials();
    await settle();
    connector.invalidateCredentials();
    await settle();
    expect(refused).toHaveBeenCalledTimes(2);
    expect(refreshes(requests)).toBe(1);
    expect(store.getState()).toMatchObject({ status: 'signedIn', expiresAt: fresh.expires_at });
    now += REFRESH_AFTER_REFUSAL_MS;
    connector.invalidateCredentials();
    await settle();
    expect(refreshes(requests)).toBe(2);
  });

  it('signs out only when Supabase Auth refuses the refresh, by the session’s own rules', async () => {
    const refusal = () =>
      json(400, { code: 'refresh_token_not_found', message: 'Invalid Refresh Token' });
    // A token that has run out, refused: the sign-in has ended.
    const ran = setup(refusal, savedSession(nowSeconds() - 60));
    await ran.store.start();
    new CopyConnector({ endpoint: SYNC, session: ran.store }).invalidateCredentials();
    await settle();
    await settle();
    expect(ran.values.has('hfos.session')).toBe(false);
    expect(ran.store.getState()).toEqual({ status: 'signedOut', ended: true });
    // A token that still works, refused: supabase-js keeps it until it runs out, then the same rule applies.
    const valid = setup(refusal, savedSession(nowSeconds() + 3000));
    await valid.store.start();
    new CopyConnector({ endpoint: SYNC, session: valid.store }).invalidateCredentials();
    await settle();
    expect(valid.store.getState().status).toBe('signedIn');
  });

  it('stays signed in when the refresh after a refusal meets no signal or a Wi-Fi login page', async () => {
    for (const respond of [
      noSignal,
      () => new Response('<html>Log in to the Wi-Fi</html>', { status: 511 }),
    ]) {
      const { store } = setup(respond, savedSession(nowSeconds() + 3000));
      await store.start();
      new CopyConnector({ endpoint: SYNC, session: store }).invalidateCredentials();
      await settle();
      await settle();
      expect(store.getState().status).toBe('signedIn');
    }
  });
});

describe('uploading', () => {
  it('has nothing to send until the queue of changes arrives, and says so if something was written', async () => {
    const empty = {
      getNextCrudTransaction: async () => null,
    } as unknown as AbstractPowerSyncDatabase;
    await expect(uploadNothingYet(empty)).resolves.toBeUndefined();
    const written = {
      getNextCrudTransaction: async () => ({ crud: [{ table: 'people' }] }),
    } as unknown as AbstractPowerSyncDatabase;
    await expect(uploadNothingYet(written)).rejects.toThrow('A change to people');
    const connector = new CopyConnector({
      endpoint: SYNC,
      session: { accessToken: async () => null, refreshNow: async () => undefined },
    });
    await expect(connector.uploadData(empty)).resolves.toBeUndefined();
  });
});
