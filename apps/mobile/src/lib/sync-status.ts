import { plainSpaces } from '@hfos/core';
import { useSyncExternalStore } from 'react';

import { BUSINESS_STREAM, businessParameters } from '@/sync/subscriptions';
import { usePhoneCopy } from '@/sync/hooks';

import { cachedMe, keptBusinessIds } from './businesses';
import { changesWord, useWaitingCount } from './changes-waiting';
import { deviceStore } from './device-store';
import { useNetwork } from './network';

export { changesWord, useWaitingCount } from './changes-waiting';

/**
 * What the status line says: "Up to date", "As of 8:58 AM", "Offline — 4 changes waiting". It reads the phone's signal,
 * PowerSync's own status for this person's copy, and the queue of changes on the phone.
 */

/**
 * - `offline`: no signal (or the test build's No signal switch);
 * - `unreachable`: signal, but the copy can't connect to the sync service;
 * - `updating`: connecting, or a download still to finish (a first copy, or a kept business's);
 * - `inStep`: connected, and every download finished.
 */
export type Connection = 'offline' | 'unreachable' | 'updating' | 'inStep';

export interface SyncStatus {
  readonly online: boolean;
  readonly connection: Connection;
  /** Changes made on this phone that haven't reached HandsFreeOS. */
  readonly waiting: number;
  /** In step with HandsFreeOS, and every change has gone. */
  readonly upToDate: boolean;
  /** The last moment this phone's copy was known to be up to date: what "As of 8:58 AM" shows. */
  readonly asOf: number | null;
}

export interface CopyState {
  readonly connected: boolean;
  readonly downloading: boolean;
  /** The first sync of this person's copy finished at some point. */
  readonly hasSynced: boolean;
  /** The last attempt to connect or download failed, and nothing has synced since. */
  readonly failing: boolean;
  /** Every business kept on the phone has its first copy. */
  readonly keptComplete: boolean;
}

export function connectionOf(online: boolean, copy: CopyState | null): Connection {
  if (!online) return 'offline';
  if (!copy) return 'updating';
  if (!copy.connected && copy.failing) return 'unreachable';
  if (!copy.connected || copy.downloading || !copy.hasSynced || !copy.keptComplete)
    return 'updating';
  return 'inStep';
}

export function useSyncStatus(): SyncStatus {
  const network = useNetwork();
  const waiting = useWaitingCount();
  const copy = usePhoneCopy();
  const userId = copy.state.status === 'open' ? copy.state.userId : null;
  // Kept businesses change with the keep switches and the person's list, both in the device store.
  const kept = useSyncExternalStore(deviceStore.subscribe, () =>
    userId ? keptBusinessIds(userId, cachedMe(userId)?.businesses ?? []).join(',') : '',
  );
  const sync = copy.sync;
  const online = network.online && !copy.heldOffline;
  const connection = connectionOf(
    online,
    sync
      ? {
          connected: sync.connected,
          downloading: sync.downloading,
          hasSynced: sync.hasSynced === true,
          failing: sync.downloadError !== undefined,
          keptComplete: kept
            .split(',')
            .filter(Boolean)
            .every(
              (id) =>
                sync.forStream({ name: BUSINESS_STREAM, parameters: businessParameters(id) })
                  ?.subscription.hasSynced === true,
            ),
        }
      : null,
  );
  return {
    online,
    connection,
    waiting,
    upToDate: connection === 'inStep' && waiting === 0,
    asOf: copy.inStepAt,
  };
}

/** The strip under the top bar, or null when there's nothing to say. */
export function stripText(status: Pick<SyncStatus, 'connection' | 'waiting'>): string | null {
  const { connection, waiting } = status;
  if (connection === 'offline')
    return waiting > 0 ? `Offline — ${changesWord(waiting)} waiting` : 'Offline';
  if (connection === 'unreachable')
    return waiting > 0
      ? `Can’t connect — ${changesWord(waiting)} waiting`
      : 'Can’t connect to HandsFreeOS';
  return waiting > 0 ? `${changesWord(waiting)} waiting to send` : null;
}

/** "8:58 AM", in the phone's own time and with plain spaces (iPhones and Android write U+202F before "AM"). */
export function clockTime(ms: number): string {
  return plainSpaces(
    new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
  );
}

/** "As of 8:58 AM" today, "As of Sep 14, 8:58 AM" before. */
export function asOfText(asOf: number | null, nowMs: number): string {
  if (asOf === null) return 'Not updated yet';
  const then = new Date(asOf);
  const sameDay = then.toDateString() === new Date(nowMs).toDateString();
  const day = then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `As of ${sameDay ? '' : `${day}, `}${clockTime(asOf)}`;
}

/**
 * The quiet line on Home and in More: "Up to date"; "As of 8:58 AM" with no signal or no connection; "Updating…"; or
 * how many changes are still to go (`compact` for the end of a list row: "3 to send").
 */
export function lineText(
  status: Pick<SyncStatus, 'connection' | 'waiting' | 'asOf'>,
  nowMs: number,
  compact = false,
): string {
  if (status.connection === 'offline' || status.connection === 'unreachable')
    return asOfText(status.asOf, nowMs);
  if (status.waiting > 0)
    return compact ? `${status.waiting} to send` : `${changesWord(status.waiting)} to send`;
  return status.connection === 'updating' ? 'Updating…' : 'Up to date';
}
