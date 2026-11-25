import type { AssistantRoutineOut } from '@hfos/core';
import * as React from 'react';

import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';

/**
 * What you asked the Assistant to do on its own: questions it asks on a schedule, and alerts. They're private to you
 * and live only on HandsFreeOS, not in the phone's copy, so the list needs signal, like the Assistant itself.
 */

export interface RoutineList {
  readonly items: readonly AssistantRoutineOut[] | null;
  readonly error: string | null;
  reload(): void;
  /** Shows a change at once, after Pause, Turn on again or Delete. */
  patch(routineId: string, change: Partial<AssistantRoutineOut> | null): void;
}

export function useRoutines(workspaceId: string): RoutineList {
  const { online } = useNetwork();
  const [items, setItems] = React.useState<readonly AssistantRoutineOut[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [round, setRound] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .POST('/v1/queries/assistant_routine.list', { body: { workspaceId } })
      .then((result) => {
        if (!cancelled) setItems(unwrap(result).items as readonly AssistantRoutineOut[]);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setItems((had) => had ?? []);
        setError(online ? errorMessage(e) : 'What you asked the Assistant for needs signal.');
      });
    return () => {
      cancelled = true;
    };
  }, [online, round, workspaceId]);

  return {
    items,
    error,
    reload: () => setRound((r) => r + 1),
    patch: (routineId, change) =>
      setItems(
        (all) =>
          all?.flatMap((r) => (r.id !== routineId ? [r] : change ? [{ ...r, ...change }] : [])) ??
          null,
      ),
  };
}

export async function pauseRoutine(
  workspaceId: string,
  routineId: string,
  paused: boolean,
): Promise<string | null> {
  const out = unwrap(
    await api.POST('/v1/commands/assistant_routine.update', {
      body: { workspaceId, routineId, paused },
    }),
  );
  return out.nextRunAt;
}

export async function deleteRoutine(workspaceId: string, routineId: string): Promise<void> {
  unwrap(
    await api.POST('/v1/commands/assistant_routine.delete', { body: { workspaceId, routineId } }),
  );
}
