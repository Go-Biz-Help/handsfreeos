/**
 * Attention items as people see them (M8): who may decide an approval item (only they see it), and one stored
 * row as the list, the banners and the commands show it, with its chips, rank and allowed actions worked out at
 * the moment of reading. Server-only.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { uuidArray } from '../calendar/load';
import { hasWorkspacePermission, type WorkspaceRole } from '../permissions';
import type { AttentionItemOut } from '../schemas/attention';
import { chipText } from './chips';
import {
  ATTENTION_HANDLE_LABELS,
  autoActionOf,
  letHandleModeOf,
  mayTakeAttentionAction,
  type AttentionAction,
  type AttentionKind,
} from './kinds';
import type { AttentionItemRow } from './load';
import { isUrgent, scoreOf, urgencyOf, type Scorable } from './score';
import { REASON_CODES, type AttentionChip } from './types';

/** Who is looking: their role, and the approval items they may decide. */
export interface AttentionViewer {
  readonly userId: string;
  readonly role: WorkspaceRole | null;
  /** Subject ids of the approval items this person may decide. */
  readonly decidable: ReadonlySet<string>;
}

/**
 * The approvals (workflow approval steps and AI teammate drafts) this person may decide, by id: a workflow's by
 * the people it names or anyone who manages workflows; a teammate's reply draft by anyone in the inbox, what it
 * asks approval for by owners and admins. One they can't read isn't theirs to decide.
 */
export async function decidableApprovals(
  tx: Tx,
  workspaceId: string,
  role: WorkspaceRole | null,
  userId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length) return out;
  const list = await rows<{
    id: string;
    source: 'workflow' | 'teammate';
    approvers: string[] | null;
    kind: string | null;
  }>(
    tx,
    sql`select id, 'workflow' as source, approvers, null as kind from app.workflow_approvals
        where workspace_id = ${workspaceId} and id = any(${uuidArray(ids)})
        union all
        select id, 'teammate', array[]::uuid[], kind from app.ai_teammate_drafts
        where workspace_id = ${workspaceId} and id = any(${uuidArray(ids)})`,
  );
  for (const a of list) {
    const ok =
      a.source === 'workflow'
        ? hasWorkspacePermission(role, 'workflows.manage') || (a.approvers ?? []).includes(userId)
        : a.kind === 'approval'
          ? hasWorkspacePermission(role, 'ai_team.manage')
          : hasWorkspacePermission(role, 'inbox.use');
    if (ok) out.add(a.id);
  }
  return out;
}

/** The viewer for a set of rows: their approval items are looked up once. */
export async function viewerFor(
  tx: Tx,
  workspaceId: string,
  role: WorkspaceRole | null,
  userId: string,
  items: readonly Pick<AttentionItemRow, 'kind' | 'subjectId'>[],
): Promise<AttentionViewer> {
  const ids = items.filter((i) => i.kind === 'ai_approval').map((i) => i.subjectId);
  return { userId, role, decidable: await decidableApprovals(tx, workspaceId, role, userId, ids) };
}

/** Whether the viewer sees this item at all: approval items only for the people who can decide them. */
export const visibleTo = (v: AttentionViewer, item: Pick<AttentionItemRow, 'kind' | 'subjectId'>) =>
  item.kind !== 'ai_approval' || v.decidable.has(item.subjectId);

/** Whether the viewer may take an action on an item (its permissions, and deciding an approval). */
export function mayAct(
  v: AttentionViewer,
  item: Pick<AttentionItemRow, 'kind' | 'subjectId'>,
  action: AttentionAction,
): boolean {
  return visibleTo(v, item) && mayTakeAttentionAction(v.role, item.kind as AttentionKind, action);
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const KNOWN_CODES: ReadonlySet<string> = new Set(REASON_CODES);

/** Its stored chips (any this app doesn't know left out). */
export const chipsOf = (row: Pick<AttentionItemRow, 'reasons'>): AttentionChip[] =>
  (Array.isArray(row.reasons) ? (row.reasons as unknown as AttentionChip[]) : []).filter(
    (c) => c && typeof c === 'object' && KNOWN_CODES.has(c.code),
  );

/** What scoring reads from a stored row. */
export function scorableOf(row: AttentionItemRow): Scorable & { id: string } {
  return {
    id: row.id,
    kind: row.kind as AttentionKind,
    value: Number(row.valueCents ?? 0),
    probability: row.probability,
    confidence: row.confidence,
    since: iso(row.sinceAt),
    dueAt: iso(row.dueAt),
    urgentFrom: iso(row.urgentFrom),
    reasons: chipsOf(row),
  };
}

/** What an item carries beside its row: a "Not confirmed" item's appointment, and the channel it would use. */
export interface ItemHints {
  readonly appointmentId: string | null;
  readonly startsAt: string | null;
  readonly reach: 'sms' | 'email' | 'chat' | null;
  /** There's a number to ring and the business is open: a money card offers the call first. */
  readonly callable: boolean;
}
export const NO_HINTS: ItemHints = {
  appointmentId: null,
  startsAt: null,
  reach: null,
  callable: false,
};

/** One row as people see it at `now`: ticking chips recounted, its rank, and what this person may do. */
export function itemOut(
  row: AttentionItemRow,
  v: AttentionViewer,
  names: ReadonlyMap<string, string>,
  now: number,
  hints: ItemHints = NO_HINTS,
): AttentionItemOut {
  const kind = row.kind as AttentionKind;
  const reasons = chipsOf(row);
  const s = scorableOf(row);
  const mode = letHandleModeOf(kind, reasons);
  const person = (id: string | null) => (id ? { id, fullName: names.get(id) ?? 'Someone' } : null);
  const may = (a: AttentionAction) => mayAct(v, row, a);
  return {
    id: row.id,
    kind,
    state: row.state,
    subject: { type: row.subjectType, id: row.subjectId },
    personId: row.personId,
    leadId: row.leadId,
    conversationId: row.conversationId,
    appointmentId: hints.appointmentId,
    startsAt: hints.startsAt,
    reach: hints.reach,
    callable: hints.callable,
    title: row.title,
    detail: row.detail,
    valueCents: s.value,
    valueIsEstimate: row.valueIsEstimate,
    reasons: reasons.map((c) => ({
      code: c.code,
      label: c.label,
      text: chipText(c, now),
      ...(c.since ? { since: c.since } : {}),
      ...(c.until ? { until: c.until } : {}),
    })),
    urgent: isUrgent(s, now),
    score: Math.round(scoreOf(s, now) * 100) / 100,
    urgency: Math.round(urgencyOf(s, now) * 1000) / 1000,
    since: s.since,
    urgentFrom: s.urgentFrom,
    dueAt: s.dueAt,
    openedAt: row.openedAt.toISOString(),
    assignee: person(row.assigneeUserId),
    snoozedUntil: iso(row.snoozedUntil),
    dismissedAt: iso(row.dismissedAt),
    dismissReason: row.dismissReason,
    handled:
      row.handledAt && row.handledVia
        ? {
            at: row.handledAt.toISOString(),
            via: row.handledVia as 'person' | 'let_handle' | 'auto',
            by: person(row.handledBy),
          }
        : null,
    auto: {
      action: autoActionOf(kind, reasons),
      state: (row.autoState as 'scheduled' | 'sent' | 'skipped' | 'cancelled' | null) ?? null,
      scheduledFor: iso(row.autoScheduledFor),
      doneAt: iso(row.autoDoneAt),
      skipReason: row.autoSkipReason,
    },
    letHandleMode: mode,
    handleLabel: ATTENTION_HANDLE_LABELS[kind],
    actions: {
      handle: may('handle'),
      letHandle: mode !== 'none' && may('let_handle'),
      assign: may('assign'),
      snooze: may('snooze'),
      dismiss: may('dismiss'),
    },
  };
}

/** The people an item names (assignee, who handled it), for their names. */
export const userIdsOf = (list: readonly AttentionItemRow[]): string[] => [
  ...new Set(list.flatMap((r) => [r.assigneeUserId, r.handledBy]).filter((u): u is string => !!u)),
];
