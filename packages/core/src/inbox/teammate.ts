/**
 * The AI teammate's words wherever people see its work (the inbox, Approvals, Home; M7, moved to core in M10 so the
 * web and the phone say the same): its name, who approved what it sent, why it handed a conversation to a person, the
 * banner over a thread it handles, what a draft will do, when it expires, why a decision was refused, and what approving
 * or rejecting did. Browser-safe.
 */
import { plainSpaces } from '../intl/spaces';
import { smsSegments } from '../messaging/sms';
import type { ConversationHandoffReason, TeammateStatus } from '../schemas/ai-team';
import { zonedWhen } from './time';

type UserRef = { readonly id: string; readonly fullName: string };
type TeammateRef = { readonly id: string; readonly name: string };

export const firstNameOf = (full: string): string => full.trim().split(/\s+/)[0] || full;

/** "Ava (AI)": how the teammate is named wherever people see what it did. */
export const aiName = (name: string): string => `${name} (AI)`;

/** A message the teammate sent: who approved it (a draft), and whether it was the business's hand-off line. */
export interface TeammateMessage {
  readonly teammate: TeammateRef;
  /** The person whose OK sent it (a draft), or null when it went out on its own. */
  readonly approvedBy: UserRef | null;
  /** The draft it came from. */
  readonly draftId: string | null;
  /** The business's hand-off line, sent as the teammate handed the conversation to a person. */
  readonly handoffLine: boolean;
}

/** The teammate that sent a thread item, and who approved it (null for anyone else's). */
export function teammateMessageOf(item: {
  readonly teammate: TeammateRef | null;
  readonly approvedBy: UserRef | null;
  readonly aiDraftId: string | null;
  readonly handoffLine: boolean;
}): TeammateMessage | null {
  if (!item.teammate) return null;
  return {
    teammate: item.teammate,
    approvedBy: item.approvedBy,
    draftId: item.aiDraftId,
    handoffLine: item.handoffLine,
  };
}

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
  wallet: () => 'the balance ran out, so the AI paused',
  error: (n) => `something went wrong on ${n}’s side`,
  draft_expired: (n) => `nobody approved ${n}’s draft in time`,
  loop: () => 'it looked like an automatic reply talking back',
  other: (n) => `${n} thought a person should take it`,
};

export function handoffWhy(reason: ConversationHandoffReason | null, name: string): string | null {
  return reason ? HANDOFF_REASON[reason](name) : null;
}

// ---------------------------------------------------------------------------- who handles a conversation

/** Who handles a conversation, and why it went to a person. */
export interface ConversationHandling {
  readonly handledBy: 'none' | 'ai' | 'person';
  readonly teammate: TeammateRef | null;
  readonly needsPersonSince: string | null;
  readonly handoffReason: ConversationHandoffReason | null;
  readonly handoffNote: string | null;
  readonly takenOverBy: UserRef | null;
}

/** The state the banner shows: the teammate has it, a person took it, or it waits for a person. */
export type HandlingView = 'ai' | 'person' | 'needs_person' | null;

export function handlingView(h: ConversationHandling | null): HandlingView {
  if (!h) return null;
  if (h.needsPersonSince) return 'needs_person';
  if (h.handledBy === 'ai') return 'ai';
  if (h.handledBy === 'person') return 'person';
  return null;
}

/**
 * The banner's title while the teammate has a conversation: "Ava (AI) is handling this" on the web, "Ava is handling
 * this" on the phone app (its canvas, where the violet banner already says it's the AI).
 */
export function handlingTitle(name: string, surface: 'web' | 'phone'): string {
  return `${surface === 'web' ? aiName(name) : name} is handling this`;
}

/** "Needs a person", the banner's title when the teammate handed a conversation over. */
export const NEEDS_A_PERSON = 'Needs a person';

/** "It replies on its own." after "Ava (AI) is handling this.", from the teammate's status. */
export function handlingHow(status: TeammateStatus | null | undefined): string {
  return status === 'automatic'
    ? 'It replies on its own.'
    : status === 'off'
      ? 'It’s off right now, so it isn’t answering.'
      : 'Each reply waits for an OK.';
}

/** "You", "Marco" or "Someone": who took a conversation over, for "… took over". */
export function whoTookOver(by: UserRef | null, myUserId: string): string {
  return !by ? 'Someone' : by.id === myUserId ? 'You' : firstNameOf(by.fullName);
}

/** "you", "Marco" or "a person": who a conversation was handed to, for "Ava handed this to …". */
export function handedTo(assignee: UserRef | null, myUserId: string): string {
  return !assignee ? 'a person' : assignee.id === myUserId ? 'you' : firstNameOf(assignee.fullName);
}

/** "Needs a person." banner's line after its title: "Ava handed this to you at 3:10 PM." */
export function handedLine(
  name: string,
  assignee: UserRef | null,
  myUserId: string,
  needsPersonSince: string | null,
  timeZone: string,
  now = new Date(),
): string {
  const when = needsPersonSince ? zonedWhen(new Date(needsPersonSince), timeZone, now) : null;
  return `${name} handed this to ${handedTo(assignee, myUserId)}${when ? ` at ${when}` : ''}.`;
}

/** Take over: what the toast says, with or without a draft dropped. */
export function takeOverToast(name: string, draftCancelled: boolean): string {
  return draftCancelled
    ? `You took over. ${name}’s draft was dropped, and it stays quiet until you hand it back.`
    : `It’s yours. ${name} stays quiet until you hand it back.`;
}

/** Hand back: what the toast says. */
export function handBackToast(name: string, who: string): string {
  return `Handed back to ${name}. It answers ${who}’s next message.`;
}

/** "Hand Tom back to Ava?": handing back always asks first. */
export function handBackQuestion(name: string, who: string): { title: string; body: string } {
  return {
    title: `Hand ${who} back to ${name}?`,
    body: `${name} answers ${who}’s next message. It reads what was written here and won’t repeat it.`,
  };
}

/** Above the composer when sending changes who answers. */
export function handoverNote(view: HandlingView, name: string): string | null {
  return view === 'ai'
    ? `Sending takes this conversation over from ${name}. It stays quiet until someone hands it back.`
    : view === 'needs_person'
      ? `Replying takes it. ${name} stays quiet until someone hands it back.`
      : null;
}

// ----------------------------------------------------------------------------------------------- drafts

/** A booking change a draft holds, as the teammate wrote it down. */
export type DraftActionFacts =
  | { readonly kind: 'book'; readonly startsAt: string; readonly summary: string }
  | { readonly kind: 'reschedule'; readonly startsAt: string; readonly summary: string }
  | { readonly kind: 'cancel'; readonly summary: string };

/** What a draft holds, for its words. */
export interface DraftFacts {
  readonly kind: 'reply' | 'approval';
  readonly channel: string | null;
  readonly teammate: TeammateRef;
  readonly person: { readonly fullName: string } | null;
  readonly preview: {
    readonly message: { readonly body: string; readonly subject?: string | null } | null;
    readonly actions: readonly DraftActionFacts[];
    readonly discount: { readonly percent: number; readonly reason: string } | null;
  };
}

/** "Will book Thu, Sep 24 at 9:00 AM on AC tune-up", from what the teammate wrote down when it held it. */
export function draftActionLine(a: DraftActionFacts): string {
  const summary = a.summary.trim();
  if (/^(book|move|cancel)\b/i.test(summary))
    return `Will ${summary[0]!.toLowerCase()}${summary.slice(1)}`;
  const at = 'startsAt' in a ? plainSpaces(new Date(a.startsAt).toLocaleString('en-US')) : '';
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
export function draftTitle(d: DraftFacts): string {
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
export function draftShort(d: DraftFacts): string {
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

/** The teammate's training so far. */
export interface ProgressFacts {
  readonly status: TeammateStatus;
  readonly approvedCount: number;
  readonly approvalsNeeded: number;
}

/** "17 of 20 approved". */
export function progressShort(p: ProgressFacts | null | undefined): string | null {
  return p ? `${p.approvedCount} of ${p.approvalsNeeded} approved` : null;
}

/** What approving did, for the toast: "Approved. Ava makes the change and texts Mike now. 18 of 20 approved." */
export function approvedToast(
  d: DraftFacts,
  progress: ProgressFacts & { readonly becameAutomatic: boolean },
  edited: boolean,
  who: string,
): string {
  const name = d.teammate.name;
  if (progress.becameAutomatic)
    return `Approved. That’s ${progress.approvedCount}: ${name} replies on its own from now on.`;
  const sent = d.preview.message
    ? d.channel === 'email'
      ? `emails ${who}`
      : d.channel === 'chat'
        ? `answers ${who} in the chat`
        : `texts ${who}`
    : null;
  const does = [d.preview.actions.length ? 'makes the change' : null, sent].filter(Boolean);
  const what = does.length ? `${name} ${does.join(' and ')} now.` : 'It goes out now.';
  const count =
    d.kind === 'reply' && progress.status === 'training' ? ` ${progressShort(progress)}.` : '';
  return `${edited ? 'Sent with your edit.' : 'Approved.'} ${what}${count}`;
}

/** What rejecting did, for the toast. */
export function rejectedToast(d: DraftFacts, who: string): string {
  return `Rejected. Nothing went to ${who}${d.preview.actions.length ? ', and nothing changed on the calendar' : ''}.`;
}

/** "132 of 160 · 1 text": a draft's length as texts, while editing it. */
export function draftSegmentsLabel(text: string): string {
  const s = smsSegments(text);
  const single = s.encoding === 'gsm7' ? 160 : 70;
  const parts = Math.max(1, s.segments);
  return `${s.units} of ${parts === 1 ? single : parts * s.perSegment} · ${parts} ${parts === 1 ? 'text' : 'texts'}`;
}

/** The words on a draft card that don't depend on the draft. */
export const DRAFT_WORDS = {
  waiting: ' · waiting for your OK',
  editNote: 'Your version is what goes out. It still counts toward training.',
  safetyPassed: 'Safety check passed',
  ownersDecide: 'Owners and admins decide this one',
  approveAndSend: 'Approve and send',
  approve: 'Approve',
  edit: 'Edit',
  reject: 'Reject…',
  rejectConfirm: 'Reject',
  keepIt: 'Keep it',
  sendMyVersion: 'Send my version',
  cancel: 'Cancel',
  nothingSent: 'Nothing is sent, and nothing is booked.',
  writeIt: 'Write the message, or reject it.',
  rejectPlaceholder: 'Ask which system first. I’ll call him.',
  typingTakesOver: 'typing below takes it over',
  /** The phone, with no signal: the decision waits on the phone like any change. */
  approvedOffline: 'Approved on this phone. It goes as soon as HandsFreeOS can be reached.',
  rejectedOffline: 'Rejected on this phone. HandsFreeOS hears as soon as it can be reached.',
  /** A decision refused with no words of its own. */
  notDecided: 'That draft wasn’t decided.',
  /** Under a draft approved on the phone while it waits for signal. */
  waitingForSignal: 'Waiting for signal',
  sending: 'Sending…',
} as const;

/** "Why? It helps Ava next time (optional)". */
export const rejectReasonLabel = (name: string): string =>
  `Why? It helps ${name} next time (optional)`;

/** "Used Duct cleaning prices" or "Used 3 knowledge items". */
export function knowledgeUsedLine(titles: readonly string[]): string | null {
  if (titles.length === 0) return null;
  return `Used ${titles.length === 1 ? titles[0]! : `${titles.length} knowledge items`}`;
}

/** What became of the last draft, under the thread's newest message. */
export const DRAFT_AFTER = {
  expired: (name: string, at: string | null) =>
    `${name}’s draft expired${at ? ` at ${at}` : ''} before anyone approved it, so this went to a person.`,
  dropped: (name: string, first: string | null) =>
    `${first ?? 'They'} wrote again, so ${name} dropped its draft and answers the new message instead.`,
  retrying: (name: string) => `${name} is writing a new draft…`,
  retryLater: (name: string, first: string | null) =>
    `No new draft yet. ${name} answers ${first ?? 'their'}${first ? '’s' : ''} next message.`,
  rejectedBy: (by: string, name: string) => `${by} rejected ${name}’s draft.`,
  rejectedNext: (who: string) => `Nothing went to ${who}. What next?`,
  tryAgainNote: (name: string, withReason: boolean) =>
    `Try again asks ${name} for a new draft${withReason ? ', with your reason' : ''}.`,
  sendingBy: (by: UserRef | null) => (by ? ` · approved by ${firstNameOf(by.fullName)}` : ''),
} as const;
