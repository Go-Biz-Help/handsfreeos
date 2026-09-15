/**
 * The plain words the inbox, Approvals and Home use for the AI teammate: its labels, why it handed a
 * conversation to a person, what a draft will do, when it expires, and why a decision was refused.
 */
import {
  parseTeammateConfig,
  type ConversationHandoffReason,
  type TeammateConfig,
} from '@hfos/core';
import { zonedWhen } from '@/lib/inbox';
import type { DraftAction, TeammateDraft, TeammateGetOut, TeammateMessage } from './inbox-types';

export const firstNameOf = (full: string): string => full.trim().split(/\s+/)[0] || full;

/** "Ava (AI)": how the teammate is named wherever people see what it did. */
export const aiName = (name: string): string => `${name} (AI)`;

/** "Ava (AI)", or "Ava (AI) · approved by Dale" for a message a person's OK sent. */
export function teammateLabel(m: TeammateMessage): string {
  if (m.handoffLine) return `${aiName(m.teammate.name)} · hand-off message`;
  return m.approvedBy
    ? `${aiName(m.teammate.name)} · approved by ${firstNameOf(m.approvedBy.fullName)}`
    : aiName(m.teammate.name);
}

/** Why it went to a person, after "Why: ". */
const HANDOFF_REASON: Readonly<Record<ConversationHandoffReason, (name: string) => string>> = {
  asked_for_person: () => 'they asked for a person',
  frustrated: () => 'they sounded frustrated',
  cant_answer: (n) => `${n} couldn’t answer it from your Knowledge`,
  sensitive: () => 'it’s a topic a person should handle',
  emergency: () => 'it sounded like an emergency, so they got the safety message',
  legal: () => 'it mentioned legal action',
  complaint: () => 'it’s a complaint',
  refund: () => 'they asked about a refund',
  cancellation: () => 'they want to cancel their service',
  limit: (n) => `${n} reached today’s reply limit in this conversation`,
  budget: (n) => `${n} used its share of today’s AI limit`,
  error: (n) => `something went wrong on ${n}’s side`,
  draft_expired: (n) => `nobody approved ${n}’s draft in time`,
  loop: () => 'it looked like an automatic reply talking back',
  other: (n) => `${n} thought a person should take it`,
};

export function handoffWhy(reason: ConversationHandoffReason | null, name: string): string | null {
  return reason ? HANDOFF_REASON[reason](name) : null;
}

/** "Will book Thu, Sep 24 at 9:00 AM on AC tune-up", from what the teammate wrote down when it held it. */
export function draftActionLine(a: DraftAction): string {
  const summary = a.summary.trim();
  if (/^(book|move|cancel)\b/i.test(summary))
    return `Will ${summary[0]!.toLowerCase()}${summary.slice(1)}`;
  const at = 'startsAt' in a ? new Date(a.startsAt).toLocaleString('en-US') : '';
  switch (a.kind) {
    case 'book':
      return `Will book a visit${at ? ` for ${at}` : ''}`;
    case 'reschedule':
      return `Will move their visit${at ? ` to ${at}` : ''}`;
    case 'cancel':
      return 'Will cancel their visit';
  }
}

export const CHANNEL_WORD: Readonly<Record<string, string>> = {
  sms: 'text',
  email: 'email',
  chat: 'website chat',
};

/** "Ava’s reply to Mike Johnson, with a booking"; "Ava asks to offer Mike Johnson 10% off". */
export function draftTitle(d: TeammateDraft): string {
  const who = d.person?.fullName ?? 'a customer';
  if (d.kind === 'approval')
    return d.preview.discount
      ? `${d.teammate.name} asks to offer ${who} ${d.preview.discount.percent}% off`
      : `${d.teammate.name} asks for your OK about ${who}`;
  const kinds = new Set(d.preview.actions.map((a) => a.kind));
  const extra = kinds.has('book')
    ? ', with a booking'
    : kinds.has('reschedule')
      ? ', with a change to their visit'
      : kinds.has('cancel')
        ? ', with a cancellation'
        : '';
  return d.preview.message
    ? `${d.teammate.name}’s reply to ${who}${extra}`
    : `${d.teammate.name}’s change for ${who}`;
}

/** One line on a draft for Home: "Ava’s reply and a booking for Thu, Sep 24 at 9:00 AM". */
export function draftShort(d: TeammateDraft): string {
  const name = d.teammate.name;
  if (d.kind === 'approval' && d.preview.discount)
    return `${name} asks to offer ${d.preview.discount.percent}% off`;
  const book = d.preview.actions.find((a) => a.kind === 'book');
  if (book) {
    const when = /^Book (.+?) on .+$/.exec(book.summary.trim())?.[1];
    return `${name}’s reply and a booking${when ? ` for ${when}` : ''}`;
  }
  if (d.preview.actions.some((a) => a.kind === 'reschedule'))
    return `${name}’s reply and a change to their visit`;
  if (d.preview.actions.some((a) => a.kind === 'cancel'))
    return `${name}’s reply and a cancellation`;
  const body = d.preview.message?.body.replace(/\s+/g, ' ').trim() ?? '';
  return body
    ? `${name}’s reply: “${body.length > 60 ? `${body.slice(0, 59)}…` : body}”`
    : `${name}’s reply`;
}

/** "Expires 12:36 PM" (in the business's zone), or "Expired" once the time has passed. */
export function expiresLine(iso: string | null, timeZone: string, now = Date.now()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (at.getTime() <= now) return 'Expired';
  return `Expires ${zonedWhen(at, timeZone, new Date(now))}`;
}

/** Why a decision didn't go through, in words (decide_draft's refusals). */
export function decideRefusal(rule: string | null, who: string, name: string): string | null {
  switch (rule) {
    case 'customer_wrote_again':
      return `${who} wrote again after this draft, so it may not fit anymore. ${name} writes a new one for what they said.`;
    case 'draft_expired':
      return `This draft expired before anyone approved it, so the conversation went to a person.`;
    case 'draft_decided':
      return 'Someone already decided this draft.';
    case 'not_an_approver':
      return 'Only owners and admins decide what the AI teammate asks approval for.';
    default:
      return null;
  }
}

/** "17 of 20 approved". */
export function progressShort(p: TeammateGetOut['progress']): string | null {
  return p ? `${p.approvedCount} of ${p.approvalsNeeded} approved` : null;
}

/** The teammate's settings, or null when they can't be read here. */
export function teammateConfigOf(raw: unknown): TeammateConfig | null {
  try {
    return parseTeammateConfig(raw);
  } catch {
    return null;
  }
}

/**
 * The teammate texts new leads itself (its Respond skill, by text), so a workflow that texts them too makes
 * two first texts. The same test as the teammate's own `double_texting` warning.
 */
export function teammateTextsNewLeads(config: TeammateConfig | null): boolean {
  if (!config) return false;
  const r = config.respond;
  return r.enabled && r.newLeads.enabled && r.newLeads.channel === 'sms' && config.channels.sms;
}

/** What the inbox, Approvals and the workflow editor need to know about the teammate. */
export interface TeammateBrief {
  readonly id: string;
  readonly name: string;
  readonly status: 'off' | 'training' | 'automatic';
  readonly progress: TeammateGetOut['progress'];
  /** Owners and admins: they decide approval drafts and change the teammate. */
  readonly canManage: boolean;
  /** Its Respond skill texts new leads (the double-texting warning). */
  readonly textsNewLeads: boolean;
}

export function teammateBriefOf(got: TeammateGetOut): TeammateBrief | null {
  if (!got.teammate) return null;
  return {
    id: got.teammate.id,
    name: got.teammate.name,
    status: got.teammate.status,
    progress: got.progress,
    canManage: got.canManage,
    textsNewLeads: teammateTextsNewLeads(teammateConfigOf(got.teammate.config)),
  };
}
