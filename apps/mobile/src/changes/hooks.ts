import { usePowerSync, useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useSession } from '@/lib/auth';

import { bookOf, loadNames, type NameBook } from './describe';
import { changes } from './index';
import { listChanges, type ChangeList } from './list';
import type { OutboxRow } from './outbox';
import type { PhotoRow } from './photos';
import { SENT_SHOWN_MS } from './rules';
import type { ChangesSnapshot } from './controller';

/** The queue's counts for the signed-in person: waiting, needing them, and whether this build is too old. */
export function useChanges(): ChangesSnapshot {
  return React.useSyncExternalStore(changes.subscribe, changes.getSnapshot, changes.getSnapshot);
}

/**
 * How many changes made on this phone haven't reached HandsFreeOS: from the open copy, or the last count known for
 * the signed-in person while it isn't open.
 */
export function useWaitingCount(): number {
  const snapshot = useChanges();
  const state = useSession();
  if (state.status !== 'signedIn') return 0;
  if (snapshot.userId === state.person.userId) return snapshot.waiting;
  return changes.lastKnown(state.person.userId);
}

/** Live bytes sent for a photo uploading now, if this app is the one uploading it. */
export function usePhotoProgress(id: string): { sent: number; total: number } | null {
  const subscribe = React.useCallback(
    (listener: () => void) => changes.subscribeProgress(listener),
    [],
  );
  const get = React.useCallback(() => {
    const progress = changes.progressOf(id);
    return progress ? `${progress.sent}/${progress.total}` : '';
  }, [id]);
  const text = React.useSyncExternalStore(subscribe, get, get);
  if (!text) return null;
  const [sent, total] = text.split('/').map(Number);
  return { sent: sent!, total: total! };
}

const EMPTY_BOOK = bookOf({});

/** Changes on this phone, live from the copy: needing the person, waiting, and sent just now. */
export function useChangeList(): ChangeList & { readonly loading: boolean } {
  const db = usePowerSync();
  const since = React.useMemo(() => new Date(Date.now() - SENT_SHOWN_MS).toISOString(), []);
  const { data: rows, isLoading } = useQuery<OutboxRow>(
    `SELECT * FROM outbox WHERE state != 'sent' OR sent_at >= ? ORDER BY seq`,
    [since],
  );
  const { data: photos } = useQuery<PhotoRow>('SELECT * FROM photo_uploads');
  const [names, setNames] = React.useState<NameBook>(EMPTY_BOOK);
  React.useEffect(() => {
    let alive = true;
    void loadNames(db, rows)
      .then((book) => alive && setNames(book))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [db, rows]);
  // Held changes' words and "Still send?" depend on the time as well as the rows.
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const list = React.useMemo(
    () => listChanges({ rows, photos, names, now: Math.max(now, Date.now()) }),
    [rows, photos, names, now],
  );
  return { ...list, loading: isLoading };
}

/** One change, live. */
export function useChange(id: string): OutboxRow | null {
  const { data } = useQuery<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [id]);
  return data[0] ?? null;
}
