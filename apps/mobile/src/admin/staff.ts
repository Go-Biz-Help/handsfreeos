import type { StaffRole } from '@hfos/core';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { api, unwrap } from '@/lib/api';
import { deviceStore } from '@/lib/device-store';
import { useNetwork } from '@/lib/network';

/**
 * Whether the signed-in person works at HandsFreeOS, from `platform.me`, as the web's /admin asks it on every page.
 *
 * The answer is kept on the phone, so More can show the Support desk row with no signal. It is only ever a hint for
 * what to show: every page of the desk asks the API, and the API refuses a person who no longer works here.
 */

export interface Staff {
  readonly userId: string;
  readonly role: StaffRole;
  readonly displayName: string;
  readonly permissions: readonly string[];
  /** Opens any business as its owner, on the web (20261013002100). */
  readonly founder: boolean;
}

/** What the phone keeps: the answer, which is `null` for the people who don't work here. */
interface Kept {
  readonly staff: Staff | null;
  readonly fetchedAt: number;
}

const staffKey = (userId: string) => `person.${userId}.staff`;

export function cachedStaff(userId: string): Kept | null {
  return deviceStore.get<Kept>(staffKey(userId)) ?? null;
}

const inFlight = new Map<string, Promise<Staff | null>>();

/** Asks whether the person works here, and keeps the answer. */
export function loadStaff(userId: string): Promise<Staff | null> {
  const running = inFlight.get(userId);
  if (running) return running;
  const promise = api
    .POST('/v1/queries/platform.me', { body: {} })
    .then((result) => {
      const { staff } = unwrap(result);
      const kept: Kept = {
        staff: staff
          ? {
              userId: staff.userId,
              role: staff.role,
              displayName: staff.displayName,
              permissions: staff.permissions,
              founder: staff.founder,
            }
          : null,
        fetchedAt: Date.now(),
      };
      if (!staff || staff.userId === userId) deviceStore.set(staffKey(userId), kept);
      return kept.staff;
    })
    .finally(() => inFlight.delete(userId));
  inFlight.set(userId, promise);
  return promise;
}

export type StaffStatus = 'loading' | 'ready' | 'error';

/**
 * The person's standing at HandsFreeOS: the kept answer straight away, asked again when the screen opens and whenever
 * signal returns. `ready` with `staff: null` is a clear no.
 */
export function useStaff(userId: string): {
  staff: Staff | null;
  status: StaffStatus;
  error: unknown;
  reload: () => void;
} {
  const kept = useSyncExternalStore(
    deviceStore.subscribe,
    () => cachedStaff(userId),
    () => cachedStaff(userId),
  );
  const { online } = useNetwork();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    loadStaff(userId)
      .catch((err: unknown) => setError(err))
      .finally(() => setLoading(false));
  }, [userId]);

  useEffect(() => {
    if (online) reload();
  }, [online, reload]);

  return {
    staff: kept?.staff ?? null,
    status: kept ? 'ready' : loading ? 'loading' : error ? 'error' : 'loading',
    error,
    reload,
  };
}

/** Whether a support person may do something: the permission is in the list `platform.me` gave. */
export const staffCan = (staff: Staff | null, permission: string): boolean =>
  staff?.permissions.includes(permission) ?? false;
