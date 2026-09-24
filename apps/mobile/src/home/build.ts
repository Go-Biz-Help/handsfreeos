import {
  attentionListOut,
  attentionListView,
  attentionRowOfSynced,
  attentionToday,
  attentionViewerOfSynced,
  hintFactsOfSynced,
  inAttentionList,
  isAttentionKind,
  itemHintsOf,
  namesOfSynced,
  visibleTo,
  type AttentionListOutput,
  type AttentionRow,
  type AttentionScope,
  type SyncedApproval,
  type SyncedAttentionRow,
  type SyncedHintRows,
  type WorkspaceRole,
} from '@hfos/core';

import type { OutboxRow } from '@/changes/outbox';

/**
 * Home from the phone's copy (the plan's "What the phone works out"): the Action Center items the server detected,
 * with this phone's own changes laid over them, ranked, counted and worded by core exactly as `attention.list` does on
 * the server. A snooze or a dismissal made here takes its card off at once and keeps it off while it waits; a refused
 * one brings the card back with the API's words.
 */

export type HomeCommand =
  | 'attention.snooze'
  | 'attention.dismiss'
  | 'attention.assign'
  | 'attention.let_handle'
  | 'attention.cancel_auto'
  | 'attention.restore';

/** One of Home's changes on this phone. */
export interface HomeChange {
  readonly row: OutboxRow;
  readonly name: HomeCommand;
  readonly itemId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** How long a sent change keeps its card as it made it, while the server's own row comes down. */
export const SENT_KEEP_MS = 30_000;

const PENDING: ReadonlySet<string> = new Set(['waiting', 'sending', 'held', 'ask', 'retry']);

function parse(input: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Home's changes from the outbox, in the order they were made. */
export function homeChangesOf(rows: readonly OutboxRow[]): HomeChange[] {
  return rows.flatMap((row) => {
    const input = parse(row.input);
    return typeof input.itemId === 'string'
      ? [{ row, name: row.name as HomeCommand, itemId: input.itemId, input }]
      : [];
  });
}

/** Whether a change still stands in for the server's row: not through yet, or sent a moment ago. */
export function changeStands(row: OutboxRow, now: number): boolean {
  if (PENDING.has(row.state)) return true;
  if (row.state !== 'sent') return false;
  const at = Date.parse(row.sent_at ?? row.settled_at);
  return Number.isFinite(at) && now - at < SENT_KEEP_MS;
}

const date = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export interface Overlaid {
  readonly rows: AttentionRow[];
  /** Items whose latest change here was refused: the card shows why. */
  readonly refused: ReadonlyMap<string, HomeChange>;
  /** Items HandsFreeOS was asked to handle on its own from here, not through yet. */
  readonly handing: ReadonlySet<string>;
  /** This phone's changes not through yet, newest last. */
  readonly waiting: readonly HomeChange[];
}

/** The copy's rows with this phone's changes over them. */
export function overlay(
  rows: readonly AttentionRow[],
  changes: readonly HomeChange[],
  now: number,
): Overlaid {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const refused = new Map<string, HomeChange>();
  const handing = new Set<string>();
  const hidden = new Set<string>();
  for (const c of changes) {
    const current = byId.get(c.itemId);
    if (c.row.state === 'refused') {
      refused.set(c.itemId, c);
      continue;
    }
    if (!changeStands(c.row, now)) continue;
    refused.delete(c.itemId);
    if (!current) continue;
    switch (c.name) {
      case 'attention.snooze':
        byId.set(c.itemId, {
          ...current,
          state: 'snoozed',
          snoozedUntil: date(c.input.until) ?? current.snoozedUntil,
        });
        break;
      case 'attention.dismiss':
        byId.set(c.itemId, { ...current, state: 'dismissed', dismissedAt: new Date(now) });
        break;
      case 'attention.restore':
        hidden.delete(c.itemId);
        handing.delete(c.itemId);
        byId.set(c.itemId, { ...current, state: 'open', snoozedUntil: null, dismissedAt: null });
        break;
      case 'attention.assign':
        byId.set(c.itemId, {
          ...current,
          assigneeUserId:
            typeof c.input.assigneeUserId === 'string' ? c.input.assigneeUserId : null,
        });
        break;
      case 'attention.cancel_auto':
        handing.delete(c.itemId);
        byId.set(c.itemId, { ...current, autoState: 'cancelled', autoScheduledFor: null });
        break;
      case 'attention.let_handle':
        // Asked to do one thing (a reply, a hand-off, a next action): the card goes, as on the web. On its own: it
        // stays, and says it goes when HandsFreeOS can be reached.
        if (typeof c.input.action === 'string') hidden.add(c.itemId);
        else if (c.row.state !== 'sent') handing.add(c.itemId);
        break;
    }
  }
  return {
    rows: [...byId.values()].filter((r) => !hidden.has(r.id)),
    refused,
    handing,
    waiting: changes.filter((c) => c.row.state !== 'sent' && c.row.state !== 'refused'),
  };
}

export interface HomeInput {
  readonly userId: string;
  readonly role: WorkspaceRole | null;
  /** What the business lets them do (0106), when the copy holds it; else their role's defaults. */
  readonly permissions?: readonly string[] | null;
  readonly timeZone: string;
  readonly now: number;
  /** Mine or Everyone; null for this person's default. */
  readonly scope: AttentionScope | null;
  readonly items: readonly SyncedAttentionRow[];
  readonly approvals: readonly SyncedApproval[];
  readonly users: readonly {
    readonly id: string;
    readonly full_name: string | null;
    readonly email: string | null;
  }[];
  readonly hintRows: SyncedHintRows;
  readonly outbox: readonly OutboxRow[];
  /** Approvals and drafts this phone decided, still standing: their cards go at once. */
  readonly decided: ReadonlySet<string>;
}

export interface HomeList extends Omit<Overlaid, 'rows'> {
  readonly list: AttentionListOutput;
  /** Every item's title on the phone, for the changes waiting to send. */
  readonly titles: ReadonlyMap<string, string>;
}

/** Home's list, worked out as the server's `attention.list` with today's handled items. */
export function buildHome(o: HomeInput): HomeList {
  const today = attentionToday(o.now, o.timeZone);
  // Only the kinds this copy of the app knows. The API ships within minutes of a merge and the phones' update an hour
  // or more later, after CI, and a phone that hasn't fetched it yet runs older code still. A card of a newer kind has
  // no icon, ranking or permissions here, and drawing one threw and closed the app (build 8, 23 September, on three
  // kinds the server began that evening). It shows once the phone has the update that knows its kind.
  const known = o.items.filter((r) => isAttentionKind(r.kind));
  const over = overlay(known.map(attentionRowOfSynced), homeChangesOf(o.outbox), o.now);
  const viewer = attentionViewerOfSynced(
    o.userId,
    { role: o.role, permissions: o.permissions ?? null },
    o.approvals,
  );
  const rows = over.rows.filter(
    (r) =>
      inAttentionList(r, today) &&
      visibleTo(viewer, r) &&
      !(r.kind === 'ai_approval' && o.decided.has(r.subjectId)),
  );
  const view = attentionListView(rows, { me: o.userId, role: o.role, now: o.now, scope: o.scope });
  const shown = [...view.ranked, ...view.handled];
  const hints = itemHintsOf(shown, hintFactsOfSynced(o.hintRows, o.now));
  const list = attentionListOut(view, {
    viewer,
    names: namesOfSynced(o.users),
    hints,
    now: o.now,
    includeHandled: true,
  });
  return {
    list,
    refused: over.refused,
    handing: over.handing,
    waiting: over.waiting,
    titles: new Map(o.items.map((r) => [r.id, r.title ?? ''])),
  };
}
