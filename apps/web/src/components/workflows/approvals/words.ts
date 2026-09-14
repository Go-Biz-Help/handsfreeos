/**
 * Reading an approval for people: what its preview holds (the AI-written text the approver can edit, the
 * customer's latest message, the knowledge the AI used), and the plain words the Approvals page and Home use.
 */
import { smsSegments } from '@hfos/core';
import type { Approval } from './types';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ApprovalItem {
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
  readonly items: readonly ApprovalItem[];
}

export function previewOf(a: Approval): ApprovalPreview {
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

export const customerOf = (a: Approval, p: ApprovalPreview = previewOf(a)): string =>
  a.person?.fullName ?? p.customer ?? 'A customer';

/** "An AI-written text for Maria Santos". */
export function approvalTitle(a: Approval, p: ApprovalPreview = previewOf(a)): string {
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
export function nameList(users: readonly { fullName: string }[]): string {
  const first = users.map((u) => u.fullName.split(/\s+/)[0] || u.fullName);
  if (first.length <= 1) return first[0] ?? '';
  return `${first.slice(0, -1).join(', ')} and ${first.at(-1)}`;
}

/** How long it has waited: "12 min", "3 h", "2 d". */
export function waitedFor(iso: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h` : `${Math.round(h / 24)} d`;
}

/** "Expires in 1 h 58 min", or "Expired" once the time has passed. */
export function expiresIn(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const m = Math.ceil((Date.parse(iso) - now) / 60_000);
  if (m <= 0) return 'Expired';
  if (m < 60) return `Expires in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `Expires in ${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `Expires in ${Math.round(h / 24)} days`;
}

/** "Approved by Priya with an edit", "Rejected by Dale: “I’ll call him”", "Expired: nobody decided in time". */
export function decidedLine(a: Approval): string {
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

/** The composer's count for a text: "151 of 160 · 1 text". */
export function segmentLabel(text: string): string {
  const seg = smsSegments(text);
  const single = seg.encoding === 'gsm7' ? 160 : 70;
  const parts = Math.max(1, seg.segments);
  const limit = parts === 1 ? single : parts * seg.perSegment;
  return `${seg.units} of ${limit} · ${parts} ${parts === 1 ? 'text' : 'texts'}`;
}
