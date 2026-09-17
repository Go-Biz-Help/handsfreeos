import {
  hasWorkspacePermission,
  namesOfSynced,
  workflowApprovalOfSynced,
  type ApprovalFacts,
  type ProgressFacts,
  type SyncedWorkflowApprovalRow,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';
import { api, errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';

import type { ApprovalListItem, DraftListItem } from './api-types';
import { USERS_SQL, WORKFLOW_APPROVALS_SQL } from './queries';
import { approvalIdOf, useApprovalDecisions } from './use-home';

/**
 * Approvals from the phone's copy, as the web's Approvals page shows them: the workflow approvals waiting for this
 * person's yes (only waiting ones reach phones), and what was decided lately, which needs signal. The AI teammate's
 * waiting drafts come from the drafts' own hook (`@/components/drafts`).
 */

/** How many decided approvals the Decided view lists, as on the web. */
export const DECIDED = 30;

type WorkflowRow = SyncedWorkflowApprovalRow & {
  readonly item_title: string | null;
  readonly item_person_id: string | null;
};

/** The workflow approvals waiting for this person, newest first, less the ones decided on this phone. */
export function useWaitingWorkflowApprovals(now: number): readonly ApprovalFacts[] {
  const { business, userId } = useBusiness();
  const { data } = useQuery<WorkflowRow>(WORKFLOW_APPROVALS_SQL, [business.id]);
  const users = useQuery<{ id: string; full_name: string | null; email: string | null }>(USERS_SQL);
  const decisions = useApprovalDecisions();
  return React.useMemo(() => {
    const names = namesOfSynced(users.data);
    const decided = new Set(
      decisions
        .filter((r) => r.state !== 'refused')
        .map(approvalIdOf)
        .filter(Boolean),
    );
    return data
      .map((r) =>
        workflowApprovalOfSynced(r, {
          names,
          role: business.role,
          userId,
          now,
          item: r.item_title ? { title: r.item_title, personId: r.item_person_id } : null,
        }),
      )
      .filter((a) => a.canDecide && !decided.has(a.id));
  }, [data, users.data, decisions, business.role, userId, now]);
}

export interface DecidedLately {
  readonly workflows: readonly ApprovalListItem[];
  readonly drafts: readonly DraftListItem[];
  readonly progress: ProgressFacts | null;
  /** The last time HandsFreeOS answered, or null when it hasn't this session. */
  readonly fetchedAt: number | null;
  readonly error: string | null;
  readonly loading: boolean;
}

const EMPTY: DecidedLately = {
  workflows: [],
  drafts: [],
  progress: null,
  fetchedAt: null,
  error: null,
  loading: false,
};

/** What each business's Decided view last showed this session, so it still shows with no signal. */
const kept = new Map<string, DecidedLately>();

/**
 * Decided lately (approved, rejected or expired workflow approvals that were this person's, and the AI teammate's
 * decided drafts), and the teammate's training, read from HandsFreeOS when there's signal: decided approvals don't
 * reach phones.
 */
export function useDecidedLately(refreshKey: number): DecidedLately {
  const { business, userId } = useBusiness();
  const { online } = useNetwork();
  const [state, setState] = React.useState<DecidedLately>(() => kept.get(business.id) ?? EMPTY);

  React.useEffect(() => {
    if (!online) return;
    let cancelled = false;
    const workspaceId = business.id;
    setState((s) => ({ ...s, loading: true }));
    const list = (status: 'approved' | 'rejected' | 'expired') =>
      api
        .POST('/v1/queries/workflow.approval_list', {
          body: { workspaceId, status, limit: DECIDED },
        })
        .then((r) => r.data?.items ?? []);
    void Promise.all([
      list('approved'),
      list('rejected'),
      list('expired'),
      api
        .POST('/v1/queries/ai_teammate.draft_list', {
          body: { workspaceId, status: 'decided', limit: DECIDED },
        })
        .then((r) => r.data?.items ?? [])
        .catch(() => []),
      api
        .POST('/v1/queries/ai_teammate.get', { body: { workspaceId } })
        .then((r) => r.data?.progress ?? null)
        .catch(() => null),
    ])
      .then(([approved, rejected, expired, drafts, progress]) => {
        if (cancelled) return;
        const manages = hasWorkspacePermission(business.role, 'workflows.manage');
        const at = (a: ApprovalListItem) => Date.parse(a.decidedAt ?? a.createdAt);
        const workflows = [...approved, ...rejected, ...expired]
          .filter((a) => manages || a.approvers.some((u) => u.id === userId))
          .sort((x, y) => at(y) - at(x))
          .slice(0, DECIDED);
        const next: DecidedLately = {
          workflows,
          drafts,
          progress,
          fetchedAt: Date.now(),
          error: null,
          loading: false,
        };
        kept.set(workspaceId, next);
        setState(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setState((s) => ({ ...s, error: errorMessage(e), loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [online, business.id, business.role, userId, refreshKey]);

  return state;
}
