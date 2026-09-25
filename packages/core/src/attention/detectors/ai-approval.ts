/**
 * An AI approval: a workflow's approval step or an AI teammate draft, waiting for a person to decide. Never
 * handled on its own. It clears when it's decided or expires.
 */
import { chip, sinceChip, untilChip } from '../chips';
import { leadValue, type BusinessFacts, type LinkedLeadFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { defineDetector, detection, HOUR, ms, valueChips, type Assessment } from './define';

/** Automations' "Approvals about to expire": how long before it expires a decision turns urgent. */
export const APPROVAL_EXPIRY_WARN_MS = 2 * HOUR;

export interface AiApprovalFacts {
  readonly business: BusinessFacts;
  readonly approval: {
    readonly id: string;
    /** workflow: a workflow's approval step (`workflow_approvals`); teammate: a draft (`ai_teammate_drafts`). */
    readonly source: 'workflow' | 'teammate';
    /** A teammate draft's kind: a reply to send, or an action to approve; null for a workflow step. */
    readonly draftKind: 'reply' | 'approval' | 'call' | null;
    readonly status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
    readonly createdAt: string;
    readonly expiresAt: string | null;
    /** A workflow step's named approvers (none: the owners and admins). */
    readonly approvers: readonly string[];
  };
  readonly lead: LinkedLeadFacts | null;
  /** A teammate draft's conversation assignee: who should look first. */
  readonly conversationAssigneeUserId: string | null;
  /** Automations' "Approvals about to expire" is on: it turns urgent two hours before it expires. */
  readonly expiryWarn?: boolean;
}

function assess(f: AiApprovalFacts, settings: AttentionSettings, now: number): Assessment {
  const a = f.approval;
  if (a.status !== 'pending') return null;
  const expires = a.expiresAt ? ms(a.expiresAt) : null;
  if (expires !== null && now >= expires) return null;
  const since = ms(a.createdAt);
  const value = leadValue(f.lead, f.business, settings);
  const what =
    a.source === 'workflow'
      ? chip('approval', 'workflow approval')
      : chip(
          'draft',
          a.draftKind === 'approval'
            ? 'AI action to approve'
            : a.draftKind === 'call'
              ? 'AI call to approve'
              : 'AI reply draft',
        );
  const assignee =
    a.approvers.length === 1
      ? a.approvers[0]!
      : a.source === 'teammate'
        ? f.conversationAssigneeUserId
        : null;
  return detection({
    fingerprint: fingerprintOf('ai_approval', { approval: `${a.source}:${a.id}` }),
    since,
    urgentFrom:
      f.expiryWarn && expires !== null ? Math.max(since, expires - APPROVAL_EXPIRY_WARN_MS) : null,
    dueAt: expires,
    value,
    probability: 0.45,
    confidence: 0.7,
    reasons: [
      ...valueChips(value),
      sinceChip('waiting', since, now),
      what,
      ...(expires !== null ? [untilChip('expires_in', expires, now)] : []),
    ],
    assignee,
    recheckAt: expires,
  });
}

export const { detect, wakeAt } = defineDetector<AiApprovalFacts>('ai_approval', assess);
