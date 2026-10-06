/**
 * What a conversation's thread says about each thing in it, the same on the web and the phone (M10): who sent a
 * message and where it is (Delivered, Not delivered and why), an email's subject and problems, a call or a voicemail,
 * a text held until quiet hours end, and a customer texting STOP or START. Browser-safe.
 */
import type { ButtonReply, RichText, SocialExtras } from '@hfos/db/schema';
import { smsKeyword } from '../messaging/sms';
import {
  isSocialChannel,
  SOCIAL_CHANNEL_NAMES,
  SOCIAL_SENT_ELSEWHERE,
  SOCIAL_SHARED_WORDS,
} from '../messaging/social';
import type { ConversationChannel } from '../schemas/conversation';
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
  readonly channel: ConversationChannel | null;
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
  /**
   * Messenger and Instagram (20261025000200): what it shared besides words and files, what it answers, and whether
   * the business wrote it in Facebook's or Instagram's own inbox; and when the customer changed or took it back.
   * The phone's copy doesn't hold these yet.
   */
  readonly social?: SocialExtras | null;
  readonly editedAt?: string | null;
  readonly unsentAt?: string | null;
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
  timeZone: string,
  now = new Date(),
): string {
  const sender = item.sentBy ? firstName(item.sentBy.fullName) : 'HandsFreeOS';
  return `${sender} · Sends ${heldWhen(scheduledFor, timeZone, now)}, when quiet hours end`;
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
  /** A photo opened full size over the thread, as the phone's Messages app shows one. */
  closePhoto: 'Close',
  downloadPhoto: 'Download',
  sharePhoto: 'Share',
  photoWontLoad: 'This photo didn’t load. Check your signal and try again.',
  photoWontDownload: 'That photo couldn’t be downloaded. Try again in a minute.',
  photoWontShare: 'That photo couldn’t be shared. Check your signal and try again.',
  /** A video played in the same viewer: the buttons say the same, and these are its own troubles. */
  videoWontLoad: 'This video didn’t load. Check your signal and try again.',
  /** The web has Download at the top; the phone has Share, which hands it to an app that can play it. */
  videoWontPlayDownload: 'This video can’t play here. Download it to watch it.',
  videoWontPlayShare: 'This video can’t play here. Tap Share to open it in another app.',
  videoWontDownload: 'That video couldn’t be downloaded. Try again in a minute.',
  videoWontShare: 'That video couldn’t be shared. Check your signal and try again.',
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

// ---------------------------------------------------------------------------------------- Messenger and Instagram

/**
 * Where a Messenger or Instagram reply is. Both say "Seen" once the customer has opened it, as their own apps do;
 * Instagram never says "Delivered", only "Seen".
 */
export function socialDeliveryWords(state: DeliveryState): string | null {
  return state === 'read' ? 'Seen' : deliveryWords(state);
}

/**
 * Why a Messenger or Instagram reply didn't arrive, in words a person can act on. The worker files Meta's refusal
 * under one of these codes; anything else says what Meta said.
 */
export function socialFailureHelp(
  item: Pick<ThreadItemFacts, 'errorCode' | 'errorMessage' | 'channel'>,
): string {
  const name =
    item.channel && isSocialChannel(item.channel) ? SOCIAL_CHANNEL_NAMES[item.channel] : 'Meta';
  switch (item.errorCode) {
    case 'window_closed':
      return `They last wrote more than a day ago, so ${name} didn’t let it through. You can reply as soon as they write again.`;
    case 'human_agent':
      return `${name} only lets a person answer this late. Send it yourself from the conversation, and it goes.`;
    case 'account':
      return `The connection to ${name} stopped working. An owner or admin can connect it again in Settings → Facebook & Instagram.`;
    case 'unavailable':
      return `This person can’t get messages on ${name} right now. They may have blocked the business or closed their account.`;
    case 'rate_limit':
      return `${name} asked HandsFreeOS to slow down. Try again in a minute.`;
    case 'attachment':
      return `${name} couldn’t take one of the files. Try a smaller one, or a photo instead.`;
    case 'too_long':
      return `${name} took only part of this reply. Shorten it and send it again.`;
    case 'partial':
      return `Only part of this reply reached them on ${name}. Send it again and the rest goes, without what already went.`;
    case 'unreachable':
      return `HandsFreeOS couldn’t reach ${name} to send this. Send it again in a minute.`;
    default:
      return item.errorMessage || `${name} didn’t deliver this reply.`;
  }
}

/**
 * On the phone, in place of a Messenger or Instagram message with no words or photos: a post, reel or story they
 * shared, or a message they took back. The phone's copy keeps neither, so it says where to see it.
 */
export const SOCIAL_NOT_ON_PHONE =
  'Something the phone can’t show yet, like a post they shared. Open this conversation on the web to see it.';

/** What a Messenger or Instagram message shows besides its words and files. */
export interface SocialLines {
  /** Things they shared that aren't files we keep: "Shared a post", with Meta's link while it works. */
  readonly shared: readonly {
    readonly label: string;
    readonly url: string | null;
    readonly title: string | null;
  }[];
  /** "Replied to your story", "Replied to a message". */
  readonly replyTo: string | null;
  /** "Tapped Get Started". */
  readonly postback: string | null;
  /** "Sent from Facebook": the business wrote it in Facebook's or Instagram's own inbox. */
  readonly elsewhere: string | null;
  /** "Edited", beside the time. */
  readonly edited: string | null;
  /** In place of the bubble, when they took it back. */
  readonly unsent: string | null;
  /** Files Meta said it carried that haven't reached HandsFreeOS (still copying, or its link stopped working). */
  readonly missingFiles: string | null;
}

export function socialLinesOf(
  item: Pick<
    ThreadItemFacts,
    'channel' | 'direction' | 'media' | 'social' | 'editedAt' | 'unsentAt'
  >,
  customerFirstName: string | null,
): SocialLines | null {
  if (!item.channel || !isSocialChannel(item.channel)) return null;
  const s = item.social ?? {};
  const who = customerFirstName ?? 'They';
  const files = s.files ?? [];
  const missing = item.unsentAt ? 0 : Math.max(0, files.length - item.media.length);
  return {
    shared: (s.shared ?? []).map((x) => ({
      label: SOCIAL_SHARED_WORDS[x.type] ?? 'Shared something',
      url: x.url,
      title: x.title,
    })),
    replyTo: s.replyTo?.story
      ? 'Replied to your story'
      : s.replyTo?.mid
        ? 'Replied to a message'
        : null,
    postback: s.postback
      ? `Tapped ${s.postback.title ? `“${s.postback.title}”` : 'a button'}`
      : null,
    elsewhere: s.elsewhere ? SOCIAL_SENT_ELSEWHERE[item.channel] : null,
    edited: item.editedAt && !item.unsentAt ? 'Edited' : null,
    unsent: item.unsentAt ? `${who} took back this message.` : null,
    missingFiles:
      missing > 0
        ? `${missing === 1 ? (SOCIAL_SHARED_WORDS[files[files.length - 1]!] ?? 'Sent a file') : `Sent ${missing} files`}. It hasn’t reached HandsFreeOS yet; open ${SOCIAL_CHANNEL_NAMES[item.channel]} to see it.`
        : null,
  };
}
