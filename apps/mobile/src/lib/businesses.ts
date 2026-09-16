import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { api, unwrap } from './api';
import { deviceStore } from './device-store';
import { keptIds, type Business, type KeepChoices } from './keep-rules';
import { useNetwork } from './network';

export {
  ROLE_LABELS,
  chooseBusiness,
  isKept,
  type Business,
  type KeepChoices,
  type Role,
} from './keep-rules';

/**
 * The person's businesses, from the API's `account.me`, kept on the phone so the switcher and the top bar still
 * work with no signal. And which businesses the person keeps on this phone: the one opened last is kept unless they
 * turn it off, and any other they turn on. The sync step (M10 step 9) reads `keptBusinessIds`.
 */

export interface Me {
  readonly user: { readonly id: string; readonly email: string; readonly fullName: string };
  readonly businesses: readonly Business[];
  /** When it came from the API. */
  readonly fetchedAt: number;
}

const meKey = (userId: string) => `person.${userId}.me`;
const lastKey = (userId: string) => `person.${userId}.lastBusiness`;
const keepKey = (userId: string) => `person.${userId}.keep`;

export function cachedMe(userId: string): Me | null {
  return deviceStore.get<Me>(meKey(userId)) ?? null;
}

const inFlight = new Map<string, Promise<Me>>();

/** Fetches the person's businesses and keeps them on the phone. */
export function loadMe(userId: string): Promise<Me> {
  const running = inFlight.get(userId);
  if (running) return running;
  const promise = api
    .POST('/v1/queries/account.me', { body: {} })
    .then((result) => {
      const data = unwrap(result);
      const me: Me = {
        user: { id: data.user.id, email: data.user.email, fullName: data.user.fullName },
        businesses: data.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          organizationId: w.organizationId,
          organizationName: w.organizationName,
          role: w.role,
          timezone: w.timezone,
        })),
        fetchedAt: Date.now(),
      };
      if (me.user.id === userId) deviceStore.set(meKey(userId), me);
      return me;
    })
    .finally(() => inFlight.delete(userId));
  inFlight.set(userId, promise);
  return promise;
}

export type MeStatus = 'loading' | 'ready' | 'error';

/**
 * The person's businesses: the copy on the phone straight away, refreshed from the API when the screen opens and
 * whenever signal returns.
 */
export function useMe(userId: string): {
  me: Me | null;
  status: MeStatus;
  error: unknown;
  reload: () => void;
} {
  const me = useSyncExternalStore(
    deviceStore.subscribe,
    () => cachedMe(userId),
    () => cachedMe(userId),
  );
  const { online } = useNetwork();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    loadMe(userId)
      .catch((err: unknown) => setError(err))
      .finally(() => setLoading(false));
  }, [userId]);

  useEffect(() => {
    if (online) reload();
  }, [online, reload]);

  return {
    me,
    status: me ? 'ready' : loading ? 'loading' : error ? 'error' : 'loading',
    error,
    reload,
  };
}

// ---------------------------------------------------------------------------------------- keeping businesses

export function keepChoices(userId: string): KeepChoices {
  return {
    lastOpened: deviceStore.get<string>(lastKey(userId)) ?? null,
    explicit: deviceStore.get<Record<string, boolean>>(keepKey(userId)) ?? {},
  };
}

/** The businesses to keep on this phone, in the person's order (for the sync step). */
export function keptBusinessIds(userId: string, businesses: readonly Business[]): string[] {
  return keptIds(keepChoices(userId), businesses);
}

export function lastOpenedBusiness(userId: string): string | null {
  return deviceStore.get<string>(lastKey(userId)) ?? null;
}

export function rememberOpened(userId: string, businessId: string): void {
  if (deviceStore.get<string>(lastKey(userId)) !== businessId)
    deviceStore.set(lastKey(userId), businessId);
}

export function setKept(userId: string, businessId: string, keep: boolean): void {
  const explicit = { ...(deviceStore.get<Record<string, boolean>>(keepKey(userId)) ?? {}) };
  explicit[businessId] = keep;
  deviceStore.set(keepKey(userId), explicit);
}

export function useKeepChoices(userId: string): KeepChoices {
  const lastOpened = useSyncExternalStore(
    deviceStore.subscribe,
    () => deviceStore.get<string>(lastKey(userId)) ?? null,
    () => null,
  );
  const explicit = useSyncExternalStore(
    deviceStore.subscribe,
    () => deviceStore.get<Record<string, boolean>>(keepKey(userId)) ?? EMPTY,
    () => EMPTY,
  );
  return { lastOpened, explicit };
}

const EMPTY: Readonly<Record<string, boolean>> = Object.freeze({});
