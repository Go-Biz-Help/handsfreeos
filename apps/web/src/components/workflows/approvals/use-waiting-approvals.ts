'use client';
import { useEffect, useState } from 'react';
import { apiBrowser } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';

const CHANGED = 'hfos:approvals-changed';

/** Tells the Approvals counts that this tab decided one (its own live echo is dropped). */
export function approvalsChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * How many pending approvals the viewer can decide (null until known). It follows approvals opened, decided
 * and expired, live, and this tab's own decisions.
 */
export function useWaitingApprovals(workspaceId: string): number | null {
  const version = useLiveVersion(['workflow_approval']);
  const [mine, setMine] = useState(0);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const bump = () => setMine((n) => n + 1);
    window.addEventListener(CHANGED, bump);
    return () => window.removeEventListener(CHANGED, bump);
  }, []);
  useEffect(() => {
    let live = true;
    apiBrowser()
      .POST('/v1/queries/workflow.approval_list', { body: { workspaceId, limit: 100 } })
      .then((r) => {
        if (live && r.data) setCount(r.data.items.filter((a) => a.canDecide).length);
      })
      .catch(() => {
        // The count is a nicety: the page itself says what's waiting.
      });
    return () => {
      live = false;
    };
  }, [workspaceId, version, mine]);
  return count;
}
