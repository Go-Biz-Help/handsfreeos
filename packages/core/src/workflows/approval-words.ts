/**
 * Approvals, read for people (M7; in core since M10 so the web's Approvals page and the phone's say the same): what a
 * workflow approval's preview holds (the AI-written text the approver can edit, the customer's latest message, the
 * knowledge the AI used), the card's and the Decided list's words, and a waiting approval from a phone's own copy.
 * Browser-safe.
 */
import { smsSegments } from '../messaging/sms';
import { hasWorkspacePermission, type WorkspaceRole } from '../permissions';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

type UserRef = { readonly id: string; readonly fullName: string };

/** A workflow approval as the Approvals page reads it (`workflow.approval_list`'s item). */
export interface ApprovalFacts {
  readonly id: string;
  readonly workflow: { readonly id: string; readonly name: string };
  readonly runId: string;
  readonly status: string;
  readonly approvers: readonly UserRef[];
  readonly preview: unknown;
  readonly edits: Readonly<Record<string, unknown>> | null;
  readonly reason: string | null;
  readonly decidedBy: UserRef | null;
  readonly decidedAt: string | null;
  readonly via: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly person: UserRef | null;
  readonly canDecide: boolean;
}

export interface ApprovalKnowledgeItem {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
}

export interface ApprovalPreview {
  /** What the workflow's approval step tells the approver. */
  readonly note: string;
  /** The AI-written texts the approver may edit, by the key the run keeps them under (`message`). */
  readonly fields: readonly (readonly [string, string])[];
  /** The channel the AI wrote for, when the preview is an AI-written message. */
  readonly channel: 'sms' | 'email' | null;
  readonly customer: string | null;
  /** The customer's latest message, when the run had one. */
  readonly asked: string | null;
  /** The knowledge items the AI used. */
  readonly items: readonly ApprovalKnowledgeItem[];
}

export function approvalPreviewOf(a: Pick<ApprovalFacts, 'preview'>): ApprovalPreview {
  const p: Record<string, unknown> = isRecord(a.preview) ? a.preview : {};
  const fields = isRecord(p['fields'])
    ? Object.entries(p['fields']).flatMap(([k, v]) =>
        typeof v === 'string' ? [[k, v] as const] : [],
      )
    : [];
  const items = Array.isArray(p['items'])
    ? p['items'].flatMap((i) =>
        isRecord(i) && typeof i['id'] === 'string' && typeof i['title'] === 'string'
          ? [
              {
                id: i['id'],
                kind: typeof i['kind'] === 'string' ? i['kind'] : 'fact',
                title: i['title'],
              },
            ]
          : [],
      )
    : [];
  const asked = typeof p['asked'] === 'string' ? p['asked'].trim() : '';
  return {
    note: typeof p['message'] === 'string' ? p['message'].trim() : '',
    fields,
    channel: p['channel'] === 'sms' || p['channel'] === 'email' ? p['channel'] : null,
    customer: typeof p['customer'] === 'string' && p['customer'] ? p['customer'] : null,
    asked: asked || null,
    items,
  };
}

export const approvalCustomerOf = (
  a: Pick<ApprovalFacts, 'person' | 'preview'>,
  p: ApprovalPreview = approvalPreviewOf(a),
): string => a.person?.fullName ?? p.customer ?? 'A customer';

/** "An AI-written text for Maria Santos". */
export function approvalTitle(
  a: Pick<ApprovalFacts, 'person' | 'preview' | 'workflow'>,
  p: ApprovalPreview = approvalPreviewOf(a),
): string {
  const who = a.person?.fullName ?? p.customer;
  const forWho = who ? ` for ${who}` : '';
  if (p.fields.length && p.channel === 'sms') return `An AI-written text${forWho}`;
  if (p.fields.length && p.channel === 'email') return `An AI-written email${forWho}`;
  if (p.fields.length) return `AI-written words${forWho}`;
  return `${a.workflow.name} is waiting for your OK`;
}

/** What goes out once it's approved: "a text", "an email", or "the next step". */
export function approvalKind(p: ApprovalPreview): string {
  if (p.fields.length && p.channel === 'sms') return 'a text';
  if (p.fields.length && p.channel === 'email') return 'an email';
  return 'the next step';
}

/** "Priya", "Priya and Dale", "Priya, Dale and Sam". */
export function approverNames(users: readonly { fullName: string }[]): string {
  const first = users.map((u) => u.fullName.split(/\s+/)[0] || u.fullName);
  if (first.length <= 1) return first[0] ?? '';
  return `${first.slice(0, -1).join(', ')} and ${first.at(-1)}`;
}

/** "Expires in 1 h 58 min", or "Expired" once the time has passed. */
export function approvalExpiresIn(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const m = Math.ceil((Date.parse(iso) - now) / 60_000);
  if (m <= 0) return 'Expired';
  if (m < 60) return `Expires in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `Expires in ${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `Expires in ${Math.round(h / 24)} days`;
}

/** Where a decision was made, after who made it. */
const whereDecided = (via: string | null): string =>
  via === 'assistant' ? ' in the Assistant' : via === 'mobile' ? ' on the phone' : '';

/** "Approved by Priya with an edit", "Rejected by Dale: “I’ll call him”", "Expired: nobody decided in time". */
export function approvalDecidedLine(
  a: Pick<ApprovalFacts, 'decidedBy' | 'status' | 'edits' | 'via' | 'reason'>,
): string {
  const by = a.decidedBy
    ? ` by ${a.decidedBy.fullName.split(/\s+/)[0] || a.decidedBy.fullName}`
    : '';
  switch (a.status) {
    case 'approved': {
      const edited = a.edits && Object.keys(a.edits).length ? ' with an edit' : '';
      return `Approved${by}${edited}${a.via === 'assistant' ? ' in the Assistant' : ''}`;
    }
    case 'rejected':
      return `Rejected${by}${a.reason ? `: “${a.reason}”` : ''}`;
    case 'expired':
      return 'Expired: nobody decided in time';
    case 'cancelled':
      return 'Cancelled: the run stopped first';
    default:
      return 'Waiting';
  }
}

/** A decided AI teammate draft, as the Decided list reads it. */
export interface DecidedDraftFacts {
  readonly status: string;
  readonly decidedBy: { readonly fullName: string } | null;
  readonly edits: unknown;
  readonly via: string | null;
  readonly reason: string | null;
}

/** "Approved by Dale with an edit on the phone", "Rejected by Dale: “…”", "Expired: nobody decided in time". */
export function draftDecidedLine(d: DecidedDraftFacts): string {
  const by = d.decidedBy
    ? ` by ${d.decidedBy.fullName.trim().split(/\s+/)[0] || d.decidedBy.fullName}`
    : '';
  switch (d.status) {
    case 'approved':
      return `Approved${by}${d.edits ? ' with an edit' : ''}${whereDecided(d.via)}`;
    case 'rejected':
      return `Rejected${by}${d.reason ? `: “${d.reason}”` : ''}`;
    case 'expired':
      return 'Expired: nobody decided in time';
    case 'cancelled':
      return d.reason ? `Dropped: ${d.reason.replace(/\.$/, '').toLowerCase()}` : 'Dropped';
    default:
      return 'Waiting';
  }
}

/** "just now", "12 min ago", "3 h ago", "2 d ago", then the day ("Sep 9"). */
export function relativeTimeAgo(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  const at = new Date(iso);
  return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The composer's count for a text: "151 of 160 · 1 text". */
export function approvalSegmentLabel(text: string): string {
  const seg = smsSegments(text);
  const single = seg.encoding === 'gsm7' ? 160 : 70;
  const parts = Math.max(1, seg.segments);
  const limit = parts === 1 ? single : parts * seg.perSegment;
  return `${seg.units} of ${limit} · ${parts} ${parts === 1 ? 'text' : 'texts'}`;
}

/** Who a workflow approval asks: "asked Priya and Dale", or "for owners and admins". */
export const approvalAsked = (approvers: readonly { fullName: string }[]): string =>
  approvers.length ? `asked ${approverNames(approvers)}` : 'for owners and admins';

/** Above an editable AI-written field. */
export function approvalFieldLabel(p: Pick<ApprovalPreview, 'channel'>, key: string): string {
  if (p.channel === 'sms') return 'The text that will go';
  if (p.channel === 'email') return 'The email that will go';
  return `The AI’s words (${key})`;
}

/** What approving or rejecting a workflow approval did, for the toast. */
export function approvalDecidedToast(decision: 'approve' | 'reject', sends: boolean): string {
  if (decision === 'reject') return 'Rejected. The workflow takes its rejected path.';
  return sends ? 'Approved. It goes out now.' : 'Approved. The workflow carries on.';
}

/** The approvals board's words that don't depend on one approval. */
export const APPROVALS_WORDS = {
  waitingTab: (n: number) => `Waiting · ${n}`,
  decidedTab: (n: number) => `Decided · ${n}`,
  waitingForYou: 'Waiting for you',
  decidedLately: 'Decided lately',
  filterAll: (n: number) => `All · ${n}`,
  filterWorkflows: (n: number) => `Workflows · ${n}`,
  filterTeammate: (name: string, n: number) => `${name} · ${n}`,
  training: (name: string, progress: string) =>
    `${name}’s drafts show here and inline in the inbox. Every approval counts toward its training wheels: ${progress}.`,
  emptyTitle: 'Nothing waiting here',
  emptyBody: (teammateName: string | null) =>
    teammateName
      ? `New drafts from ${teammateName} and workflow approvals show up here, on Home and by email.`
      : 'When a workflow’s approval step needs you, it shows up here, on Home and by email.',
  decidedEmptyTitle: 'Nothing decided lately',
  decidedEmptyBody: 'Approved, rejected and expired approvals show here.',
  review: 'Review',
  youCanEdit: 'you can edit it',
  edited: 'Edited: your version is what goes out.',
  writtenByAi: 'Written by the AI.',
  writeOrReject: 'Write the text, or reject it.',
  carriesOn: (workflow: string, who: string) => `Approving lets ${workflow} carry on for ${who}.`,
  expiredInfo: 'This expired. The workflow goes on as its approval step says.',
  expiryInfo: 'If nobody decides in time, the workflow goes on as its approval step says.',
  latestMessage: (first: string) => `${first}’s latest message`,
  knowledgeUsed: 'Knowledge used:',
  noKnowledge: 'No knowledge items used.',
  pricesAllowed: 'Prices allowed',
  pricesOff: 'Prices are off',
  approveAndSend: 'Approve and send',
  approve: 'Approve',
  approving: 'Approving…',
  reject: 'Reject…',
  rejectConfirm: 'Reject',
  rejecting: 'Rejecting…',
  keepIt: 'Keep it',
  openRun: 'Open the run',
  run: 'Run',
  conversation: 'Conversation',
  rejectTitle: 'Reject it?',
  rejectBody: (workflow: string, who: string) =>
    `${workflow} takes its “If it’s rejected” steps for ${who}, then the run ends.`,
  rejectWhy: 'Why (optional)',
  rejectPlaceholder: 'I’ll call them myself.',
  aCustomer: 'A customer',
} as const;

// ---------- from a phone's copy ----------

/** A synced `workflow_approvals` row (only waiting ones reach phones). */
export interface SyncedWorkflowApprovalRow {
  readonly id: string;
  readonly workflow_id: string | null;
  readonly run_id: string | null;
  readonly status: string | null;
  /** A JSON array of user ids. */
  readonly approvers: string | null;
  readonly preview: string | null;
  readonly edits: string | null;
  readonly expires_at: string | null;
  readonly created_at: string | null;
}

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const WORKFLOW_PREFIX = 'Workflow: ';

/**
 * A waiting workflow approval from the copy. Workflows and their runs don't reach phones, so the workflow's name and
 * the customer come from the approval's Action Center item ("Maria Lopez · Workflow: New lead follow-up"), when there
 * is one.
 */
export function workflowApprovalOfSynced(
  r: SyncedWorkflowApprovalRow,
  o: {
    readonly names: ReadonlyMap<string, string>;
    readonly role: WorkspaceRole | null;
    readonly userId: string;
    readonly now: number;
    /** Its Action Center item: the title, and the customer it names. */
    readonly item: { readonly title: string; readonly personId: string | null } | null;
  },
): ApprovalFacts {
  const ids = json<unknown>(r.approvers, []);
  const approverIds = Array.isArray(ids)
    ? ids.filter((x): x is string => typeof x === 'string')
    : [];
  const at = o.item ? o.item.title.indexOf(' · ') : -1;
  const head = o.item && at >= 0 ? o.item.title.slice(0, at) : null;
  const rest = o.item && at >= 0 ? o.item.title.slice(at + 3) : (o.item?.title ?? null);
  const workflowName =
    rest && rest.startsWith(WORKFLOW_PREFIX) ? rest.slice(WORKFLOW_PREFIX.length) : 'A workflow';
  const expiresAt = r.expires_at ? new Date(r.expires_at).toISOString() : null;
  const pending = r.status === 'pending';
  return {
    id: r.id,
    workflow: { id: r.workflow_id ?? '', name: workflowName },
    runId: r.run_id ?? '',
    status: r.status ?? 'pending',
    approvers: approverIds.map((id) => ({ id, fullName: o.names.get(id) ?? 'Someone' })),
    preview: json<unknown>(r.preview, {}),
    edits: json<Record<string, unknown> | null>(r.edits, null),
    reason: null,
    decidedBy: null,
    decidedAt: null,
    via: null,
    expiresAt,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date(0).toISOString(),
    person: o.item?.personId && head ? { id: o.item.personId, fullName: head } : null,
    canDecide:
      pending &&
      (!expiresAt || Date.parse(expiresAt) > o.now) &&
      (hasWorkspacePermission(o.role, 'workflows.manage') || approverIds.includes(o.userId)),
  };
}
