/**
 * The Action Center's list as people see it (M8; browser-safe since M10 so the phone ranks its synced copy exactly as
 * the server does): who may decide an approval item (only they see it), one stored row as the list, the banners and
 * the commands show it, and the whole `attention.list` answer from a set of rows, a viewer and the moment. The server
 * (`queries/attention.ts`) and the phone (`apps/mobile/src/home`) both build the list here.
 */
import { localDateOf, startOfLocalDay } from '../calendar/engine/zoned';
import { hasWorkspacePermission, type WorkspaceRole } from '../permissions';
import type { AttentionItemOut, AttentionListOutput } from '../schemas/attention';
import { chipText } from './chips';
import {
  ATTENTION_HANDLE_LABELS,
  autoActionOf,
  letHandleModeOf,
  mayTakeAttentionAction,
  type AttentionAction,
  type AttentionKind,
} from './kinds';
import { affectedCents, isUrgent, rankItems, scoreOf, urgencyOf, type Scorable } from './score';
import { REASON_CODES, type AttentionChip } from './types';

/**
 * One stored attention item, as the server's row has it (`app.attention_items`). The phone turns its synced rows into
 * this shape (`attentionRowOfSynced`); the columns phones never receive (`resolution`, `resolved_at`) are optional.
 */
export interface AttentionRow {
  readonly id: string;
  readonly kind: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly personId: string | null;
  readonly leadId: string | null;
  readonly conversationId: string | null;
  readonly state: 'open' | 'snoozed' | 'dismissed' | 'handled' | 'resolved';
  readonly openedAt: Date;
  readonly sinceAt: Date | null;
  readonly urgentFrom: Date | null;
  readonly dueAt: Date | null;
  readonly valueCents: number | null;
  readonly valueIsEstimate: boolean;
  readonly moneyKey: string | null;
  readonly probability: number;
  readonly confidence: number;
  readonly reasons: unknown;
  readonly title: string;
  readonly detail: string | null;
  readonly assigneeUserId: string | null;
  readonly snoozedUntil: Date | null;
  readonly dismissedAt: Date | null;
  readonly dismissReason: string | null;
  readonly handledAt: Date | null;
  readonly handledBy: string | null;
  readonly handledVia: string | null;
  readonly autoState: string | null;
  readonly autoScheduledFor: Date | null;
  readonly autoDoneAt: Date | null;
  readonly autoSkipReason: string | null;
  readonly resolvedAt?: Date | null;
  readonly resolution?: string | null;
}

/** Resolutions that mean someone (or HandsFreeOS) dealt with it: they count as handled today. */
export const DONE_RESOLUTIONS = [
  'contacted',
  'replied',
  'confirmed',
  'decided',
  'done',
  'next_action_set',
  'closed',
  // Money: the customer answered the estimate, or the invoice was paid. An estimate that expired and an
  // invoice that was withdrawn are not wins, so they stay out.
  'answered',
  'paid',
  // Automations' pipeline and jobs: a deal put on the right stage, a visit given its address.
  'moved',
  'address_added',
] as const;
const DONE: ReadonlySet<string> = new Set(DONE_RESOLUTIONS);

/** Who is looking: their role, and the approval items they may decide. */
export interface AttentionViewer {
  readonly userId: string;
  readonly role: WorkspaceRole | null;
  /** Subject ids of the approval items this person may decide. */
  readonly decidable: ReadonlySet<string>;
}

/** What deciding an approval depends on: where it comes from, a workflow step's approvers, a draft's kind. */
export interface ApprovalDecider {
  readonly source: 'workflow' | 'teammate';
  readonly approvers: readonly string[] | null;
  /** A teammate draft's kind (`reply` or `approval`); null for a workflow step. */
  readonly kind: string | null;
}

/**
 * Whether a person may decide an approval: a workflow's by the people it names or anyone who manages workflows; a
 * teammate's reply draft by anyone in the inbox, what it asks approval for by owners and admins.
 */
export function mayDecideApproval(
  role: WorkspaceRole | null,
  userId: string,
  a: ApprovalDecider,
): boolean {
  if (a.source === 'workflow')
    return hasWorkspacePermission(role, 'workflows.manage') || (a.approvers ?? []).includes(userId);
  return a.kind === 'approval'
    ? hasWorkspacePermission(role, 'ai_team.manage')
    : hasWorkspacePermission(role, 'inbox.use');
}

/** Whether the viewer sees this item at all: approval items only for the people who can decide them. */
export const visibleTo = (v: AttentionViewer, item: Pick<AttentionRow, 'kind' | 'subjectId'>) =>
  item.kind !== 'ai_approval' || v.decidable.has(item.subjectId);

/** Whether the viewer may take an action on an item (its permissions, and deciding an approval). */
export function mayAct(
  v: AttentionViewer,
  item: Pick<AttentionRow, 'kind' | 'subjectId'>,
  action: AttentionAction,
): boolean {
  return visibleTo(v, item) && mayTakeAttentionAction(v.role, item.kind as AttentionKind, action);
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const KNOWN_CODES: ReadonlySet<string> = new Set(REASON_CODES);

/** Its stored chips (any this app doesn't know left out). */
export const chipsOf = (row: Pick<AttentionRow, 'reasons'>): AttentionChip[] =>
  (Array.isArray(row.reasons) ? (row.reasons as unknown as AttentionChip[]) : []).filter(
    (c) => c && typeof c === 'object' && KNOWN_CODES.has(c.code),
  );

/** What scoring reads from a stored row. */
export function scorableOf(row: AttentionRow): Scorable & { id: string } {
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
  row: AttentionRow,
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
    // A job card is about the visit itself.
    appointmentId:
      hints.appointmentId ?? (row.subjectType === 'appointment' ? row.subjectId : null),
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
export const userIdsOf = (list: readonly AttentionRow[]): string[] => [
  ...new Set(list.flatMap((r) => [r.assigneeUserId, r.handledBy]).filter((u): u is string => !!u)),
];

// ---------- the list ----------

export type AttentionScope = 'mine' | 'everyone';

/** Members see Mine (theirs and unassigned) by default; owners and admins see Everyone. */
export const defaultAttentionScope = (role: WorkspaceRole | null): AttentionScope =>
  role === 'member' ? 'mine' : 'everyone';

/** Yours, or nobody's. */
export const attentionIsMine = (row: Pick<AttentionRow, 'assigneeUserId'>, me: string): boolean =>
  row.assigneeUserId === null || row.assigneeUserId === me;

/** The start of today in the business's time zone: handled and cleared items from then on count as today's. */
export function attentionToday(now: number, timeZone: string): number {
  return startOfLocalDay(localDateOf(now, timeZone), timeZone);
}

/**
 * Whether a row belongs in the list at all: open and snoozed items, and those handled or cleared today (the server's
 * own `where`, for a copy that holds more).
 */
export function inAttentionList(row: AttentionRow, today: number): boolean {
  if (row.state === 'open' || row.state === 'snoozed') return true;
  if (row.state === 'handled') return !!row.handledAt && row.handledAt.getTime() >= today;
  if (row.state === 'resolved') return !!row.resolvedAt && row.resolvedAt.getTime() >= today;
  return false;
}

/** The rows the list is made from, sorted into what shows: before names and hints are looked up. */
export interface AttentionListView {
  readonly scope: AttentionScope;
  /** Of the kinds asked for, every row the viewer sees. */
  readonly wanted: readonly AttentionRow[];
  /** Those in the scope. */
  readonly inScope: readonly AttentionRow[];
  /** Open ones in the scope, in rank order. */
  readonly ranked: readonly AttentionRow[];
  /** Handled today in the scope, newest first. */
  readonly handled: readonly AttentionRow[];
}

/** Sorts rows already in the list (`inAttentionList`) and visible to the viewer into what the list shows. */
export function attentionListView(
  list: readonly AttentionRow[],
  o: {
    readonly me: string;
    readonly role: WorkspaceRole | null;
    readonly now: number;
    readonly scope?: AttentionScope | null;
    readonly kinds?: readonly string[] | null;
  },
): AttentionListView {
  const kinds = o.kinds ? new Set<string>(o.kinds) : null;
  const wanted = kinds ? list.filter((r) => kinds.has(r.kind)) : list;
  const scope = o.scope ?? defaultAttentionScope(o.role);
  const inScope = wanted.filter((r) => scope === 'everyone' || attentionIsMine(r, o.me));
  const open = inScope.filter((r) => r.state === 'open');
  const ranked = rankItems(
    open.map((r) => ({ ...scorableOf(r), row: r })),
    o.now,
  ).map((x) => x.row);
  const handled = inScope
    .filter((r) => r.state === 'handled')
    .sort((a, b) => (b.handledAt?.getTime() ?? 0) - (a.handledAt?.getTime() ?? 0));
  return { scope, wanted, inScope, ranked, handled };
}

/** The whole `attention.list` answer from a view, the names and hints looked up for it, and the moment. */
export function attentionListOut(
  view: AttentionListView,
  o: {
    readonly viewer: AttentionViewer;
    readonly names: ReadonlyMap<string, string>;
    readonly hints: ReadonlyMap<string, ItemHints>;
    readonly now: number;
    readonly includeHandled: boolean;
  },
): AttentionListOutput {
  const { viewer, names, hints, now } = o;
  const me = viewer.userId;
  const open = view.inScope.filter((r) => r.state === 'open');
  const out = (r: AttentionRow) => itemOut(r, viewer, names, now, hints.get(r.id));
  const scheduled = open
    .flatMap((r) => {
      const action = autoActionOf(r.kind as AttentionKind, chipsOf(r));
      return r.autoState === 'scheduled' && r.autoScheduledFor && action
        ? [
            {
              itemId: r.id,
              kind: r.kind as AttentionKind,
              title: r.title,
              action,
              scheduledFor: r.autoScheduledFor.toISOString(),
            },
          ]
        : [];
    })
    .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
  const openVisible = view.wanted.filter((r) => r.state === 'open');
  return {
    now: new Date(now).toISOString(),
    scope: view.scope,
    items: view.ranked.map(out),
    handled: o.includeHandled ? view.handled.map(out) : [],
    scheduled,
    affectedCents: affectedCents(
      open.map((r) => ({
        value: Number(r.valueCents ?? 0),
        valueIsEstimate: r.valueIsEstimate,
        moneyKey: r.moneyKey,
        leadId: r.leadId,
      })),
    ),
    counts: {
      total: open.length,
      urgent: open.filter((r) => isUrgent(scorableOf(r), now)).length,
      snoozed: view.inScope.filter((r) => r.state === 'snoozed').length,
      mine: openVisible.filter((r) => attentionIsMine(r, me)).length,
      everyone: openVisible.length,
    },
    handledToday: view.inScope.filter(
      (r) => r.state === 'handled' || (r.state === 'resolved' && DONE.has(r.resolution ?? '')),
    ).length,
  };
}
