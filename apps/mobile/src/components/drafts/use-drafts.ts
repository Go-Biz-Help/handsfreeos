import { holds, teammateDraftOf, type TeammateDraftRow, type TeammateDraftShape } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';
import { useGrants } from '@/lib/grants';
import type { OutboxRow } from '@/changes/outbox';
import { SENT_SHOWN_MS } from '@/changes/rules';

/**
 * The AI teammate's drafts on the phone: the ones waiting for someone's OK (only those reach phones), each with what
 * this phone already decided about it. A decision waits in the outbox like any change, so the card leaves at once and
 * comes back with the API's words if it's refused. The inbox's thread, Home and Approvals all read drafts here.
 */

export const DECIDE_DRAFT = 'ai_teammate.decide_draft';

export interface DraftDecisionRow {
  readonly row: OutboxRow;
  readonly draftId: string;
  readonly decision: 'approve' | 'reject';
  /** What the person changed before approving, when they did. */
  readonly edits: { readonly body?: string; readonly subject?: string } | null;
}

export interface WaitingDraft {
  readonly draft: TeammateDraftShape;
  /** This phone's decision about it, if it made one: waiting, asked about, refused, or sent just now. */
  readonly decision: DraftDecisionRow | null;
}

/** A decision the phone made that still stands in for the draft (anything but a refusal). */
export const decisionStands = (d: DraftDecisionRow | null): boolean =>
  !!d && d.row.state !== 'refused';

const DRAFTS_SQL = `
  SELECT d.id, d.teammate_id, t.name AS teammate_name, d.conversation_id, c.channel, d.person_id,
    p.first_name, p.last_name, d.lead_id, d.kind, d.status, d.preview, d.edits, d.expires_at, d.created_at
  FROM ai_teammate_drafts d
  LEFT JOIN ai_teammates t ON t.id = d.teammate_id
  LEFT JOIN conversations c ON c.id = d.conversation_id
  LEFT JOIN people p ON p.id = d.person_id
  WHERE d.workspace_id = ? AND d.status = 'pending'
    AND (? IS NULL OR d.conversation_id = ?)
    AND (? IS NULL OR d.kind = ?)
  ORDER BY d.created_at, d.id`;

function decisionOf(row: OutboxRow): DraftDecisionRow | null {
  try {
    const input = JSON.parse(row.input) as {
      draftId?: unknown;
      decision?: unknown;
      edits?: { body?: string; subject?: string };
    };
    if (typeof input.draftId !== 'string') return null;
    return {
      row,
      draftId: input.draftId,
      decision: input.decision === 'reject' ? 'reject' : 'approve',
      edits: input.edits ?? null,
    };
  } catch {
    return null;
  }
}

/** This phone's latest decision about each draft in a business: every one not through, and those sent just now. */
export function useDraftDecisions(workspaceId: string): ReadonlyMap<string, DraftDecisionRow> {
  const since = React.useMemo(() => new Date(Date.now() - SENT_SHOWN_MS).toISOString(), []);
  const { data } = useQuery<OutboxRow>(
    `SELECT * FROM outbox WHERE workspace_id = ? AND name = ? AND (state != 'sent' OR sent_at >= ?) ORDER BY seq`,
    [workspaceId, DECIDE_DRAFT, since],
  );
  return React.useMemo(() => {
    const byDraft = new Map<string, DraftDecisionRow>();
    for (const row of data) {
      const decision = decisionOf(row);
      if (decision) byDraft.set(decision.draftId, decision);
    }
    return byDraft;
  }, [data]);
}

/**
 * The drafts waiting for an OK in the business on screen, oldest first: one conversation's, or one kind's. Each comes
 * with this phone's decision about it; `visible` leaves out the ones a decision on this phone stands in for.
 */
export function useWaitingDrafts(
  filter: { readonly conversationId?: string | null; readonly kind?: 'reply' | 'approval' } = {},
): {
  readonly items: readonly WaitingDraft[];
  readonly visible: readonly WaitingDraft[];
  readonly loading: boolean;
} {
  const { business } = useBusiness();
  const conversationId = filter.conversationId ?? null;
  const kind = filter.kind ?? null;
  const { data, isLoading } = useQuery<TeammateDraftRow>(DRAFTS_SQL, [
    business.id,
    conversationId,
    conversationId,
    kind,
    kind,
  ]);
  const decisions = useDraftDecisions(business.id);
  const canManage = holds(useGrants(), 'ai_team.manage');
  return React.useMemo(() => {
    const items = data.map((row) => ({
      draft: teammateDraftOf(row, { canManage }),
      decision: decisions.get(row.id) ?? null,
    }));
    return {
      items,
      visible: items.filter((item) => !decisionStands(item.decision)),
      loading: isLoading,
    };
  }, [data, decisions, canManage, isLoading]);
}
