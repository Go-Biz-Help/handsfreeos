/**
 * The Action Center from a phone's own copy (M10): synced `attention_items` rows turned into the rows the list is
 * built from (`view.ts`), who may decide each approval, the names the cards show, and the facts the hints need, read
 * from the synced seats, customers, conversations, opt-outs and the business's numbers and addresses. Rows are as the
 * copy holds them: snake_case, times as ISO text, booleans as 1 or 0, JSON as text. Browser-safe.
 *
 * What a copy can't know, and how it's worked out instead:
 * - Items cleared today (`resolved`) never reach phones, so "handled today" counts only the handled ones there.
 * - Texting is ready when the business has an active number (the carriers' registrations don't sync); email can go
 *   when it has an address on the shared domain or a verified one.
 */
import { openHoursOf } from '../schemas/workspace';
import type { Grants } from '../permissions';
import type { HintConsent, HintConversation, HintFacts, HintSeat } from './hint-facts';
import { isOpenAt } from './open-time';
import type { ReachBusiness } from './reach';
import { mayDecideApproval, type AttentionRow, type AttentionViewer } from './view';

type Text = string | null;

const date = (v: Text | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** A synced `attention_items` row. */
export interface SyncedAttentionRow {
  readonly id: string;
  readonly kind: Text;
  readonly subject_type: Text;
  readonly subject_id: Text;
  readonly person_id: Text;
  readonly lead_id: Text;
  readonly conversation_id: Text;
  readonly state: Text;
  readonly opened_at: Text;
  readonly since_at: Text;
  readonly urgent_from: Text;
  readonly due_at: Text;
  readonly value_cents: number | null;
  readonly value_is_estimate: number | boolean | null;
  readonly money_key: Text;
  readonly probability: number | null;
  readonly confidence: number | null;
  readonly reasons: Text;
  readonly title: Text;
  readonly detail: Text;
  readonly assignee_user_id: Text;
  readonly snoozed_until: Text;
  readonly dismissed_at: Text;
  readonly dismiss_reason: Text;
  readonly handled_at: Text;
  readonly handled_by: Text;
  readonly handled_via: Text;
  readonly auto_state: Text;
  readonly auto_scheduled_for: Text;
  readonly auto_done_at: Text;
  readonly auto_skip_reason: Text;
  readonly created_at?: Text;
}

const STATES: ReadonlySet<string> = new Set([
  'open',
  'snoozed',
  'dismissed',
  'handled',
  'resolved',
]);

/** A synced row as the list takes it. */
export function attentionRowOfSynced(r: SyncedAttentionRow): AttentionRow {
  return {
    id: r.id,
    kind: r.kind ?? '',
    subjectType: r.subject_type ?? '',
    subjectId: r.subject_id ?? '',
    personId: r.person_id,
    leadId: r.lead_id,
    conversationId: r.conversation_id,
    state: (STATES.has(r.state ?? '') ? r.state : 'open') as AttentionRow['state'],
    openedAt: date(r.opened_at) ?? date(r.created_at) ?? new Date(0),
    sinceAt: date(r.since_at),
    urgentFrom: date(r.urgent_from),
    dueAt: date(r.due_at),
    valueCents: r.value_cents === null ? null : Number(r.value_cents),
    valueIsEstimate: bool(r.value_is_estimate),
    moneyKey: r.money_key,
    probability: r.probability ?? 1,
    confidence: r.confidence ?? 1,
    reasons: json<unknown[]>(r.reasons, []),
    title: r.title ?? '',
    detail: r.detail,
    assigneeUserId: r.assignee_user_id,
    snoozedUntil: date(r.snoozed_until),
    dismissedAt: date(r.dismissed_at),
    dismissReason: r.dismiss_reason,
    handledAt: date(r.handled_at),
    handledBy: r.handled_by,
    handledVia: r.handled_via,
    autoState: r.auto_state,
    autoScheduledFor: date(r.auto_scheduled_for),
    autoDoneAt: date(r.auto_done_at),
    autoSkipReason: r.auto_skip_reason,
  };
}

/** A waiting approval on the phone: a workflow's approval step, or an AI teammate's draft. */
export interface SyncedApproval {
  readonly id: string;
  readonly source: 'workflow' | 'teammate';
  /** A workflow step's approvers (a JSON array of user ids); null for a draft. */
  readonly approvers: Text;
  /** A draft's kind; null for a workflow step. */
  readonly kind: Text;
  readonly status: Text;
}

/** Who is looking, with the waiting approvals they may decide (only waiting ones reach phones). */
export function attentionViewerOfSynced(
  userId: string,
  who: Grants,
  approvals: readonly SyncedApproval[],
): AttentionViewer {
  const decidable = new Set<string>();
  for (const a of approvals) {
    if (a.status !== 'pending') continue;
    const approvers = json<unknown>(a.approvers, []);
    if (
      mayDecideApproval(who, userId, {
        source: a.source,
        approvers: Array.isArray(approvers)
          ? approvers.filter((x): x is string => typeof x === 'string')
          : [],
        kind: a.kind,
      })
    )
      decidable.add(a.id);
  }
  return { userId, role: who.role, permissions: who.permissions ?? null, decidable };
}

/** People's names by id, as the server's `userNames` gives them: the full name, else the email. */
export function namesOfSynced(
  users: readonly { readonly id: string; readonly full_name: Text; readonly email?: Text }[],
): Map<string, string> {
  return new Map(users.map((u) => [u.id, u.full_name || u.email || 'Someone']));
}

const consentOf = (v: Text): HintConsent => (v === 'opted_in' || v === 'opted_out' ? v : 'unknown');

/** What the hints read from the copy. */
export interface SyncedHintRows {
  /** Seats with their appointment's start and the customer's consent joined in. */
  readonly seats: readonly {
    readonly id: string;
    readonly appointment_id: Text;
    readonly starts_at: Text;
    readonly contact_phone_e164: Text;
    readonly contact_email: Text;
    readonly sms_ok: number | boolean | null;
    readonly sms_consent: Text;
  }[];
  readonly people: readonly {
    readonly id: string;
    readonly phone_e164: Text;
    readonly email: Text;
    readonly sms_consent: Text;
  }[];
  readonly conversations: readonly {
    readonly id: string;
    readonly person_id: Text;
    readonly channel: Text;
    readonly counterpart: Text;
    readonly last_message_at: Text;
  }[];
  readonly optOuts: readonly {
    readonly counterpart_e164: Text;
    readonly opted_out: number | boolean | null;
  }[];
  /** Only suppressions not released reach phones. */
  readonly suppressions: readonly { readonly address: Text }[];
  readonly phoneNumbers: readonly { readonly status: Text }[];
  readonly emailAddresses: readonly {
    readonly email_domain_id: Text;
    readonly verified_at: Text;
  }[];
  /** The business's settings (JSON text) and time zone. */
  readonly settings: Text;
  readonly timezone: Text;
}

/** Whether the business can text and email on its own, as far as its copy says. */
export function reachBusinessOfSynced(
  rows: Pick<SyncedHintRows, 'phoneNumbers' | 'emailAddresses'>,
): ReachBusiness {
  return {
    textingReady: rows.phoneNumbers.some((n) => n.status === 'active'),
    canEmail: rows.emailAddresses.some((a) => !a.email_domain_id || !!a.verified_at),
  };
}

/** The hints' facts from the copy, at a moment. */
export function hintFactsOfSynced(rows: SyncedHintRows, now: number): HintFacts {
  const settings = json<Record<string, unknown> | null>(rows.settings, null);
  return {
    seats: new Map<string, HintSeat>(
      rows.seats.flatMap((s) =>
        s.appointment_id && s.starts_at
          ? [
              [
                s.id,
                {
                  id: s.id,
                  appointmentId: s.appointment_id,
                  startsAt: new Date(s.starts_at).toISOString(),
                  phone: s.contact_phone_e164,
                  email: s.contact_email,
                  smsOk: bool(s.sms_ok),
                  consent: consentOf(s.sms_consent),
                },
              ] as const,
            ]
          : [],
      ),
    ),
    people: new Map(
      rows.people.map((p) => [
        p.id,
        { id: p.id, phone: p.phone_e164, email: p.email, consent: consentOf(p.sms_consent) },
      ]),
    ),
    conversations: rows.conversations.flatMap((c): HintConversation[] =>
      c.channel === 'sms' || c.channel === 'email' || c.channel === 'chat'
        ? [
            {
              id: c.id,
              personId: c.person_id,
              channel: c.channel,
              counterpart: c.counterpart ?? '',
              // The server reads this through `String(Date)`, which keeps whole seconds.
              lastMessageAt: c.last_message_at
                ? Math.floor(Date.parse(c.last_message_at) / 1000) * 1000
                : null,
            },
          ]
        : [],
    ),
    stoppedNumbers: new Set(
      rows.optOuts.flatMap((o) =>
        bool(o.opted_out) && o.counterpart_e164 ? [o.counterpart_e164] : [],
      ),
    ),
    stoppedEmails: new Set(
      rows.suppressions.flatMap((s) => (s.address ? [s.address.toLowerCase()] : [])),
    ),
    business: reachBusinessOfSynced(rows),
    openNow: isOpenAt(openHoursOf(settings), rows.timezone || 'UTC', now),
  };
}
