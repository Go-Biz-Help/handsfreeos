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
 * How many things wait for the viewer's yes (null until known): the workflow approvals they can decide and
 * the AI teammate's drafts. It follows approvals and drafts opened, decided and expired, live, and this tab's
 * own decisions.
 */
export function useWaitingApprovals(workspaceId: string): number | null {
  const version = useLiveVersion(['workflow_approval', 'ai_teammate_draft']);
  const [mine, setMine] = useState(0);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const bump = () => setMine((n) => n + 1);
    window.addEventListener(CHANGED, bump);
    return () => window.removeEventListener(CHANGED, bump);
  }, []);
  useEffect(() => {
    let live = true;
    const api = apiBrowser();
    Promise.all([
      api
        .POST('/v1/queries/workflow.approval_list', { body: { workspaceId, limit: 100 } })
        .then((r) => (r.data ? r.data.items.filter((a) => a.canDecide).length : null)),
      // A business without an AI teammate has no drafts; a refusal counts as none.
      api
        .POST('/v1/queries/ai_teammate.draft_list', {
          body: { workspaceId, status: 'pending', limit: 100 },
        })
        .then((r) => (r.data ? r.data.items.filter((d) => d.canDecide).length : 0))
        .catch(() => 0),
    ])
      .then(([flows, drafts]) => {
        if (live && flows !== null) setCount(flows + drafts);
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
