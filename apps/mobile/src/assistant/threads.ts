import * as React from 'react';

import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';

/**
 * Your chats with the Assistant, newest first. Chats are private to their person and live only on HandsFreeOS, so
 * they aren't in the phone's copy: the list needs signal, like the Assistant itself.
 */

export interface ThreadSummary {
  readonly id: string;
  readonly title: string;
  readonly lastMessageAt: string;
}

export interface ThreadList {
  readonly items: readonly ThreadSummary[] | null;
  readonly error: string | null;
  reload(): void;
  /** Takes one out of the list at once, after Archive. */
  forget(threadId: string): void;
  rename(threadId: string, title: string): void;
}

export function useThreads(workspaceId: string, open: boolean): ThreadList {
  const { online } = useNetwork();
  const [items, setItems] = React.useState<readonly ThreadSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [round, setRound] = React.useState(0);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    api
      .POST('/v1/queries/assistant_thread.list', { body: { workspaceId, limit: 30 } })
      .then((result) => {
        if (!cancelled) setItems(unwrap(result).items);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setItems([]);
        setError(online ? errorMessage(e) : 'Your chats need signal.');
      });
    return () => {
      cancelled = true;
    };
  }, [online, open, round, workspaceId]);

  return {
    items,
    error,
    reload: () => setRound((r) => r + 1),
    forget: (threadId) => setItems((all) => all?.filter((t) => t.id !== threadId) ?? null),
    rename: (threadId, title) =>
      setItems((all) => all?.map((t) => (t.id === threadId ? { ...t, title } : t)) ?? null),
  };
}

export async function archiveThread(workspaceId: string, threadId: string): Promise<void> {
  unwrap(
    await api.POST('/v1/commands/assistant_thread.archive', { body: { workspaceId, threadId } }),
  );
}

export async function renameThread(
  workspaceId: string,
  threadId: string,
  title: string,
): Promise<void> {
  unwrap(
    await api.POST('/v1/commands/assistant_thread.rename', {
      body: { workspaceId, threadId, title },
    }),
  );
}
