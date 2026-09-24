/**
 * What a conversation's thread says about each thing in it, the same on the web and the phone (M10): who sent a
 * message and where it is (Delivered, Not delivered and why), an email's subject and problems, a call or a voicemail,
 * a text held until quiet hours end, and a customer texting STOP or START. Browser-safe.
 */
import type { ButtonReply, RichText } from '@hfos/db/schema';
import { smsKeyword } from '../messaging/sms';
import { firstName } from './list';
import { teammateLabel, teammateMessageOf, type TeammateMessage } from './teammate';
import { callClock, heldWhen, weekdayClock } from './time';

type UserRef = { readonly id: string; readonly fullName: string };

/** What a thread item needs for its words (the API's ThreadItem, or one the phone makes from its copy). */
export interface ThreadItemFacts {
  readonly type: 'message' | 'call';
  readonly id: string;
  readonly occurredAt: string;
  readonly direction: 'inbound' | 'outbound';
  readonly status: string;
  readonly channel: 'sms' | 'email' | 'chat' | null;
  readonly body: string | null;
  readonly subject: string | null;
  readonly fromAddress: string | null;
  readonly media: readonly { readonly name: string }[];
  readonly sentBy: UserRef | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly durationSeconds: number | null;
  readonly isVoicemail: boolean;
  /** Whether the recording reached our storage: without it there is nothing to play. */
  readonly hasRecording?: boolean;
  readonly transcript?: string | null;
  /** Where the words got to: null before anything was asked, then pending, completed or failed. */
  readonly transcriptStatus?: 'pending' | 'completed' | 'failed' | null;
  readonly answeredVia: 'browser' | 'forwarding' | 'bridge' | 'ai' | null;
  readonly answeredBy: UserRef | null;
  readonly scheduledFor: string | null;
  readonly teammate: { readonly id: string; readonly name: string } | null;
  readonly approvedBy: UserRef | null;
  readonly aiDraftId: string | null;
  readonly handoffLine: boolean;
  /**
   * Texts (0103): which way it went — SMS, MMS or RCS — and when an RCS message was read, what it carried and
   * which button a customer's reply came from. The web's thread and the phone's copy both carry them; optional so
   * a thread item made without them (a fixture, a reply still on the phone) needn't say.
   */
  readonly transport?: 'sms' | 'mms' | 'rcs' | null;
  readonly readAt?: string | null;
  readonly rich?: Pick<RichText, 'kind' | 'title' | 'buttons' | 'cards' | 'smsText'> | null;
  readonly buttonReply?: Pick<ButtonReply, 'type' | 'title' | 'via'> | null;
}

/** Statuses of a text or email that didn't arrive. */
export const FAILED_STATUSES: ReadonlySet<string> = new Set(['failed', 'undelivered']);
/** An email address that stopped taking mail: it bounced, or they marked us as spam. */
export const STOPPED_EMAIL_STATUSES: ReadonlySet<string> = new Set(['bounced', 'complained']);

/** Why a text didn't arrive, in words a person can act on (carrier codes are the common ones). */
export function textFailureHelp(item: Pick<ThreadItemFacts, 'errorCode' | 'errorMessage'>): string {
  switch (item.errorCode) {
    case '30003':
    case '30005':
    case '30006':
      return 'This number can’t receive texts. It may be a landline.';
    case '21610':
      return 'This customer texted STOP, so the carrier blocked it.';
    case '30007':
      return 'The carrier filtered this text. Try wording it differently.';
    case '30032':
    case '30034':
      return 'Texting isn’t approved for this number yet.';
    default:
      return item.errorMessage || 'The carrier didn’t deliver this text.';
  }
}

/**
 * Where a reply is: "Sending…", "Sent", "Delivered" (or "Seen" in a website chat), "Read" (an RCS message the
 * customer opened), "Not delivered".
 */
export type DeliveryState = 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | null;

export function deliveryStateOf(status: string): DeliveryState {
  if (status === 'queued' || status === 'sending') return 'sending';
  if (status === 'sent') return 'sent';
  if (status === 'delivered') return 'delivered';
  if (status === 'read') return 'read';
  if (FAILED_STATUSES.has(status)) return 'failed';
  return null;
}

/** Whether it got there: delivered, or read, which only ever follows delivered. */
export const arrived = (state: DeliveryState): boolean => state === 'delivered' || state === 'read';

export function deliveryWords(state: DeliveryState, chat = false): string | null {
  switch (state) {
    case 'sending':
      return 'Sending…';
    case 'sent':
      return 'Sent';
    case 'delivered':
      return chat ? 'Seen' : 'Delivered';
    case 'read':
      return 'Read';
    case 'failed':
      return 'Not delivered';
    default:
      return null;
  }
}

/** Who a message is from, under it: the teammate's label, the teammate's first name, or HandsFreeOS. */
export function senderOf(item: ThreadItemFacts): {
  readonly ai: TeammateMessage | null;
  readonly label: string;
} {
  const ai = item.direction === 'outbound' ? teammateMessageOf(item) : null;
  if (ai) return { ai, label: teammateLabel(ai) };
  return { ai: null, label: item.sentBy ? firstName(item.sentBy.fullName) : 'HandsFreeOS' };
}

/** A customer's STOP or START: "Mike opted out of texts" under their message. */
export function keywordLine(
  item: Pick<ThreadItemFacts, 'direction' | 'body'>,
  customerFirstName: string | null,
): { readonly kind: 'stop' | 'start'; readonly text: string } | null {
  if (item.direction === 'outbound' || !item.body) return null;
  const keyword = smsKeyword(item.body);
  const who = customerFirstName ?? 'This number';
  if (keyword === 'stop') return { kind: 'stop', text: `${who} opted out of texts` };
  if (keyword === 'start') return { kind: 'start', text: `${who} opted back in to texts` };
  return null;
}

/** "Dale · Sends at 8:00 AM, when quiet hours end": a text held for quiet hours. */
export function heldLine(
  item: Pick<ThreadItemFacts, 'sentBy'>,
  scheduledFor: string,
  now = new Date(),
): string {
  const sender = item.sentBy ? firstName(item.sentBy.fullName) : 'HandsFreeOS';
  return `${sender} · Sends ${heldWhen(scheduledFor, now)}, when quiet hours end`;
}

/** A photo's names under a customer's message with no words: "IMG_2041.jpg · 7:15 AM". */
export function mediaOnlyLine(item: Pick<ThreadItemFacts, 'body' | 'media'>, time: string): string {
  const names = item.media.map((m) => m.name).join(', ');
  return !item.body && names ? `${names} · ${time}` : time;
}

export const THREAD_WORDS = {
  empty: 'No messages yet. Say hello below.',
  showEarlier: 'Show earlier messages',
  retry: 'Retry',
  tryAgain: 'Try again',
  cancel: 'Cancel',
  sendingNow: 'You · now · Sending…',
  voicemail: 'Missed call · left a voicemail',
  transcribed: 'Transcribed automatically, so it may contain mistakes.',
  /** A recorded call's words open rather than filling the thread: they can run to thousands of them. */
  showRecord: 'Recording and transcript',
  hideRecord: 'Hide',
  /**
   * What a voicemail with nothing to play or read says. Before this the card simply showed less, so a recording
   * that never reached us and one that arrived silent looked exactly the same — and looked like a bug.
   */
  noRecording: 'The recording didn’t reach HandsFreeOS, so there’s nothing to play.',
  /**
   * The words arrived and the audio did not. They are read from the carrier's own copy of the recording, so a
   * storage that is down or misconfigured costs the business the message but not what was said in it.
   */
  wordsOnly: 'The recording didn’t reach HandsFreeOS. These are the words the caller left.',
  transcribing: 'Working out what they said…',
  noWords: 'This one couldn’t be transcribed. The recording still plays.',
  noWordsNoRecording: 'Nothing was recorded, so there’s nothing to play or read.',
  noSubject: '(no subject)',
  /** Under a rich text that went to a phone without RCS (0103): it opens to the plain text that phone got. */
  wentAsText: 'Went as a text, with the choices listed',
} as const;

/** When an RCS message was read, beside "Read": "Read Tue 2:14 PM". */
export function readLine(readAt: string | null | undefined): string {
  return readAt ? `Read ${weekdayClock(readAt)}` : 'Read';
}

/** Why an email didn't arrive, after its card: "Bounced: …", "Marked as spam", "Not sent: …". */
export function emailProblem(item: Pick<ThreadItemFacts, 'status' | 'errorMessage'>): string {
  if (item.status === 'complained') return 'Marked as spam';
  if (item.status === 'bounced')
    return `Bounced: ${item.errorMessage || 'it could not be delivered'}`;
  return `Not sent: ${item.errorMessage || 'the mail service refused it'}`;
}

/** Where an email we sent is: its problem, "Delivered", "Sent" or "Sending…". */
export function emailStatusLine(item: Pick<ThreadItemFacts, 'status' | 'errorMessage'>): {
  readonly bad: boolean;
  readonly text: string;
} {
  if (STOPPED_EMAIL_STATUSES.has(item.status) || FAILED_STATUSES.has(item.status))
    return { bad: true, text: emailProblem(item) };
  if (item.status === 'delivered') return { bad: false, text: 'Delivered' };
  if (item.status === 'sent') return { bad: false, text: 'Sent' };
  return { bad: false, text: 'Sending…' };
}

/** Who an email is from on its card: the teammate's label, the teammate, HandsFreeOS, or the customer. */
export function emailSender(item: ThreadItemFacts, customerName: string | null): string {
  if (item.direction === 'outbound') {
    const ai = teammateMessageOf(item);
    return ai ? teammateLabel(ai) : (item.sentBy?.fullName ?? 'HandsFreeOS');
  }
  return customerName ?? item.fromAddress ?? 'Someone';
}

const LIVE_CALL: ReadonlySet<string> = new Set(['initiated', 'ringing', 'in_progress']);

/** What a call card shows: its title, the line under it, how it looks, and its length once it's over. */
export interface CallCardWords {
  readonly kind: 'voicemail' | 'call';
  readonly title: string;
  /** After the time: "answered on a forwarding phone", "from their cell, showing the business number". */
  readonly detail: string | null;
  readonly icon: 'voicemail' | 'missed' | 'incoming' | 'outgoing';
  readonly tone: 'warning' | 'success' | 'accent';
  /** "4:12", for a call that was answered and is over. */
  readonly length: string | null;
  readonly live: boolean;
  /** Why there is nothing to play or read, when there isn't. Null when the card has what it should. */
  readonly note: string | null;
}

/**
 * A voicemail that cannot be played or read says which of the two it is. The recording and the words fail
 * separately — the audio may never have reached our storage, or it reached it and the transcriber found nothing —
 * and a card that just showed less made both look like the app being broken.
 */
function voicemailNote(
  item: Pick<ThreadItemFacts, 'hasRecording' | 'transcript' | 'transcriptStatus'>,
): string | null {
  const recorded = item.hasRecording ?? true;
  const waiting = item.transcriptStatus === 'pending' || item.transcriptStatus == null;
  if (recorded) {
    if (item.transcript) return null;
    return waiting ? THREAD_WORDS.transcribing : THREAD_WORDS.noWords;
  }
  // No audio of our own. The words can still be here: they are taken from the carrier's copy when ours is
  // missing, so "no recording" no longer has to mean the business learns nothing about the call.
  if (item.transcript) return THREAD_WORDS.wordsOnly;
  if (waiting) return THREAD_WORDS.transcribing;
  return item.transcriptStatus === 'failed'
    ? THREAD_WORDS.noWordsNoRecording
    : THREAD_WORDS.noRecording;
}

/** A call in the conversation: a voicemail, or a call with who answered and its length. */
export function callCardWords(item: ThreadItemFacts): CallCardWords {
  if (item.isVoicemail)
    return {
      kind: 'voicemail',
      title: THREAD_WORDS.voicemail,
      detail: null,
      icon: 'voicemail',
      tone: 'warning',
      length: null,
      live: false,
      note: voicemailNote(item),
    };
  const inbound = item.direction === 'inbound';
  const live = LIVE_CALL.has(item.status);
  const answered = inbound ? !!item.answeredVia : item.status === 'completed';
  const missed = !live && !answered;
  // A call a teammate placed through their own cell (M10): "Dale called · from their cell".
  const bridge = !inbound && item.answeredVia === 'bridge';
  const caller = item.sentBy ?? item.answeredBy;
  const callerFirst = caller?.fullName.trim().split(/\s+/)[0] || null;
  const title = live
    ? inbound
      ? 'Incoming call'
      : 'Calling…'
    : answered
      ? inbound
        ? 'Incoming call'
        : bridge && callerFirst
          ? `${callerFirst} called`
          : 'Outgoing call'
      : inbound
        ? 'Missed call'
        : 'Call not answered';
  const answeredLine =
    item.answeredVia === 'forwarding'
      ? 'answered on a forwarding phone'
      : item.answeredVia === 'ai'
        ? 'your AI teammate answered'
        : item.answeredBy
          ? `${item.answeredBy.fullName} answered`
          : null;
  const detail = live
    ? item.status === 'in_progress'
      ? 'in progress'
      : 'ringing'
    : inbound
      ? answered
        ? answeredLine
        : null
      : bridge
        ? answered
          ? 'from their cell, showing the business number'
          : caller
            ? `${caller.fullName} called from their cell`
            : 'called from a cell'
        : item.sentBy
          ? `${item.sentBy.fullName} called`
          : null;
  return {
    kind: 'call',
    title,
    detail,
    icon: missed ? 'missed' : inbound ? 'incoming' : 'outgoing',
    tone: missed ? 'warning' : inbound ? 'success' : 'accent',
    length: answered && !live ? callClock(item.durationSeconds) : null,
    live,
    // A plain call carries no note: nothing is promised for it to be missing.
    note: null,
  };
}
