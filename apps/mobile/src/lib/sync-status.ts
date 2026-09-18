import { plainSpaces } from '@hfos/core';
import { useSyncExternalStore } from 'react';

import { BUSINESS_STREAM, businessParameters } from '@/sync/subscriptions';
import { usePhoneCopy } from '@/sync/hooks';

import { cachedMe, keptBusinessIds } from './businesses';
import { changesWord, useNeedsYouCount, useWaitingCount } from './changes-waiting';
import { deviceStore } from './device-store';
import { useNetwork } from './network';

export { changesWord, useNeedsYouCount, useWaitingCount } from './changes-waiting';

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
  /** Changes made on this phone that haven't reached HandsFreeOS, the ones needing the person included. */
  readonly waiting: number;
  /**
   * Of those, the ones that will never go on their own: a refusal to fix, or a question to answer. The canvas's
   * Changes screen groups them under "Needs you", and the strip says so instead of calling them "waiting to send"
   * (step 13, finding 2).
   */
  readonly needsYou: number;
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
  const needsYou = useNeedsYouCount();
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
    needsYou: Math.min(needsYou, waiting),
    upToDate: connection === 'inStep' && waiting === 0,
    asOf: copy.inStepAt,
  };
}

/** "1 change needs you", the canvas's "Needs you" group in a sentence. */
export function needsYouWord(n: number): string {
  return `${changesWord(n)} ${n === 1 ? 'needs' : 'need'} you`;
}

/**
 * The strip under the top bar, or null when there's nothing to say. A change that needs the person is counted apart
 * from the ones on their way, because saying "1 change waiting to send" about a refusal is a promise the phone can't
 * keep: nothing sends it until the person fixes it (step 13, finding 2).
 */
export function stripText(
  status: Pick<SyncStatus, 'connection' | 'waiting'> & { readonly needsYou?: number },
): string | null {
  const { connection, waiting } = status;
  const needsYou = Math.min(status.needsYou ?? 0, waiting);
  const onTheirWay = waiting - needsYou;
  // After a count, the shorter form: "2 changes waiting to send, 1 needs you".
  const tail = needsYou > 0 ? `, ${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you` : '';
  if (connection === 'offline') {
    if (waiting === 0) return 'Offline';
    if (onTheirWay === 0) return `Offline — ${needsYouWord(needsYou)}`;
    return `Offline — ${changesWord(onTheirWay)} waiting${tail}`;
  }
  if (connection === 'unreachable') {
    if (waiting === 0) return 'Can’t connect to HandsFreeOS';
    if (onTheirWay === 0) return `Can’t connect — ${needsYouWord(needsYou)}`;
    return `Can’t connect — ${changesWord(onTheirWay)} waiting${tail}`;
  }
  if (waiting === 0) return null;
  if (onTheirWay === 0) return needsYouWord(needsYou);
  return `${changesWord(onTheirWay)} waiting to send${tail}`;
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
  status: Pick<SyncStatus, 'connection' | 'waiting' | 'asOf'> & { readonly needsYou?: number },
  nowMs: number,
  compact = false,
): string {
  if (status.connection === 'offline' || status.connection === 'unreachable')
    return asOfText(status.asOf, nowMs);
  const needsYou = Math.min(status.needsYou ?? 0, status.waiting);
  const onTheirWay = status.waiting - needsYou;
  if (status.waiting > 0) {
    if (onTheirWay === 0) return compact ? `${needsYou} need you` : needsYouWord(needsYou);
    return compact ? `${onTheirWay} to send` : `${changesWord(onTheirWay)} to send`;
  }
  return status.connection === 'updating' ? 'Updating…' : 'Up to date';
}
