/**
 * What the composer says, the same on the web and the phone (M10): why a text or an email can't go (and what the box
 * says then), who it writes to, the From line, photos going to the customer's files, a text's length, quiet hours and
 * their question, and what sending did. Browser-safe.
 */
import { formatClock } from '../messaging/quiet-hours';
import { smsSegments } from '../messaging/sms';
import { heldWhen } from './time';

/** A sentence with a word or two in bold: plain text, or `{ strong }`. */
export type WordPart = string | { readonly strong: string };

/** Why texting can't happen here (conversation.get's `canText.reason`, and the phone's own reading). */
export type CanTextReason =
  'no_number' | 'not_ready' | 'opted_out' | 'no_phone' | 'email_channel' | 'chat_channel';

export interface CanText {
  readonly ok: boolean;
  readonly reason: CanTextReason | null;
}

/**
 * Whether a text can go out in a conversation, from what the phone's copy knows: the conversation's channel, the
 * business's number, whether the number opted out or the customer said no to texts. The server's own check also knows
 * whether the carriers approved texting (`not_ready`), which the copy doesn't hold; a text refused for that says so
 * where it was sent.
 */
export function canTextOf(facts: {
  readonly channel: 'sms' | 'email' | 'chat';
  readonly hasActiveNumber: boolean;
  readonly optedOut: boolean;
  readonly personSmsConsent: string | null;
  readonly messagingReady?: boolean;
}): CanText {
  if (facts.channel === 'email') return { ok: false, reason: 'email_channel' };
  if (facts.channel === 'chat') return { ok: false, reason: 'chat_channel' };
  if (!facts.hasActiveNumber) return { ok: false, reason: 'no_number' };
  if (facts.messagingReady === false) return { ok: false, reason: 'not_ready' };
  if (facts.optedOut || facts.personSmsConsent === 'opted_out')
    return { ok: false, reason: 'opted_out' };
  return { ok: true, reason: null };
}

/**
 * Texting from another channel's thread (an email thread's Text switch) goes to the customer's text thread: it needs
 * their mobile number and the business's number, and the server has the last word there.
 */
export function crossChannelCanText(
  threadChannel: 'sms' | 'email' | 'chat',
  inThread: CanText,
  phoneDisplay: string,
  fromNumber: string | null,
): CanText {
  if (threadChannel === 'sms') return inThread;
  if (!phoneDisplay) return { ok: false, reason: 'no_phone' };
  if (!fromNumber) return { ok: false, reason: 'no_number' };
  return { ok: true, reason: null };
}

export interface ComposerNote {
  readonly tone: 'danger' | 'info' | 'warning';
  readonly icon: 'alert' | 'clock' | 'phone' | 'mail';
  readonly parts: readonly WordPart[];
  /** What the box says while the note shows. */
  readonly placeholder: string;
  /** A link after the words, where the note has one ("See status"). */
  readonly link?: 'texting_status';
  /** A button beside the note, where the note offers one. */
  readonly action?: { readonly kind: 'email' | 'edit_person'; readonly label: string };
}

/** The note that replaces the box when texting can't happen, and the box's placeholder then. */
export function textNote(
  reason: CanTextReason | null,
  facts: {
    /** "Mike", or null for a number nobody has linked. */
    readonly firstName: string | null;
    /** The registration in review, for "In review since Sep 3, usually 1 to 3 weeks." */
    readonly inReviewSince?: string | null;
    readonly tollFree?: boolean;
    /** The desktop composer offers Email beside "Texting is off" when the customer has an address. */
    readonly offerEmail?: boolean;
  },
): ComposerNote | null {
  const who = facts.firstName ?? 'this number';
  switch (reason) {
    case 'opted_out':
      return {
        tone: 'danger',
        icon: 'alert',
        parts: [
          `Texting is off for ${who}. They can text `,
          { strong: 'START' },
          ' to turn it back on.',
        ],
        placeholder: `You can’t text ${who} right now`,
        ...(facts.offerEmail ? { action: { kind: 'email' as const, label: 'Email' } } : {}),
      };
    case 'not_ready': {
      const since = facts.inReviewSince ?? null;
      return {
        tone: 'info',
        icon: 'clock',
        parts: [
          `Texting turns on when the carriers approve your registration.${since ? ` In review since ${since},` : ''}${since ? ` usually ${facts.tollFree ? 'a few days' : '1 to 3 weeks'}.` : ''} Calls already work.`,
        ],
        placeholder: 'Texting isn’t on yet',
        link: 'texting_status',
      };
    }
    case 'no_phone':
      return {
        tone: 'warning',
        icon: 'alert',
        parts: [`Add a mobile number to text ${who}.`],
        placeholder: `No mobile number for ${who}`,
      };
    case 'no_number':
      return {
        tone: 'info',
        icon: 'phone',
        parts: [
          'Texting starts once the business has a number. An owner or admin sets it up in Settings → Texting & calls.',
        ],
        placeholder: 'Texting isn’t set up yet',
      };
    default:
      return null;
  }
}

/** "See status", after the note while the carriers review texting. */
export const TEXTING_STATUS_LINK = 'See status';

/** Why email to this customer can't go out: no address, or the address is stopped (bounced, spam, by hand). */
export function emailNote(
  canEmail: { readonly ok: boolean; readonly reason?: string | null },
  facts: {
    readonly to: string | null;
    readonly suppressedReason: string | null;
    readonly firstName: string | null;
    /** The web can open the customer's details from the note. */
    readonly canEditPerson?: boolean;
  },
): ComposerNote | null {
  if (canEmail.ok) return null;
  const first = facts.firstName;
  const who = first ?? 'them';
  if (canEmail.reason === 'no_email')
    return {
      tone: 'warning',
      icon: 'mail',
      parts: [`Add an email address to email ${who}.`],
      placeholder: `No email address for ${who}`,
    };
  const address = { strong: facts.to ?? '' };
  const why = facts.suppressedReason;
  return {
    tone: 'danger',
    icon: 'mail',
    parts:
      why === 'spam_complaint'
        ? [address, ' marked an email as spam, so we stopped sending to it.']
        : why === 'manual'
          ? [
              'Email to ',
              address,
              ' is stopped. An owner or admin can unblock it in Settings → Email.',
            ]
          : [
              address,
              ` bounced, so we stopped sending to it. ${first ? `Fix the address on ${first}’s record and send again.` : 'Fix the address and send again.'}`,
            ],
    placeholder: `Email to ${who} is stopped`,
    ...(facts.canEditPerson && first && why !== 'manual'
      ? { action: { kind: 'edit_person' as const, label: `Edit ${first}’s details` } }
      : {}),
  };
}

/** A website chat whose visitor was blocked: replies can't reach them. */
export const CHAT_BLOCKED_NOTE: ComposerNote = {
  tone: 'warning',
  icon: 'alert',
  parts: ['This visitor is blocked from the website chat, so replies can’t reach them.'],
  placeholder: 'This visitor is blocked',
};

/** What the box says: why it's off, or who it writes to. */
export function composerPlaceholder(facts: {
  readonly mode: 'sms' | 'email' | 'chat';
  readonly off: boolean;
  readonly note: ComposerNote | null;
  readonly firstName: string | null;
  readonly phoneDisplay: string;
  /** The phone's rounded box says "Reply by email…". */
  readonly compact: boolean;
}): string {
  if (facts.off)
    return (
      facts.note?.placeholder ??
      (facts.mode === 'email' ? 'Email isn’t available' : 'Texting isn’t available')
    );
  if (facts.mode === 'chat') return `Reply to ${facts.firstName ?? 'them'} in the chat…`;
  if (facts.mode === 'email') return facts.compact ? 'Reply by email…' : 'Write your email…';
  return `Text ${facts.firstName ?? facts.phoneDisplay}…`;
}

/** Switching the composer to a channel the customer has no address for. */
export function switchRefusal(
  to: 'sms' | 'email',
  facts: { readonly personId: string | null; readonly firstName: string | null },
): string {
  if (to === 'email')
    return facts.personId
      ? `There’s no email address for ${facts.firstName ?? 'them'} yet`
      : 'There’s no email address for this number yet';
  return `There’s no mobile number for ${facts.firstName ?? 'them'} yet`;
}

/** "Photos you send are saved to Mike’s files too." */
export const photosSavedLine = (firstName: string | null): string =>
  `Photos you send are saved to ${firstName ? `${firstName}’s` : 'their'} files too.`;

/** Characters, the per-text limit and how many texts it becomes: "132 / 160 · 1 text", or the photos it carries. */
export function segmentCounterLabel(text: string, photos = 0): string {
  if (photos > 0) return `${photos === 1 ? '1 photo' : `${photos} photos`} · 1 picture message`;
  if (!text) return '160 characters per text';
  const s = smsSegments(text);
  const single = s.encoding === 'gsm7' ? 160 : 70;
  const parts = Math.max(1, s.segments);
  const limit = parts === 1 ? single : parts * s.perSegment;
  return `${s.units} / ${limit} · ${parts} ${parts === 1 ? 'text' : 'texts'}`;
}

/** "From Lone Star HVAC & Roofing · (713) 555-0100": where a text goes from. */
export const textFromLine = (fromNumber: string, businessName?: string | null): string =>
  `From ${businessName ? `${businessName} · ` : ''}${fromNumber}`;

/** "From office@lonestarhvac.com", or a connected mailbox "From dale@gmail.com (Gmail)". */
export const emailFromLabel = (address: string, provider?: string | null): string =>
  provider ? `From ${address} (${provider})` : `From ${address}`;

/** Where the other channel's messages go: "Texts go to (713) 555-0142 and get their own thread in the inbox." */
export function crossChannelLine(mode: 'sms' | 'email', to: string): string {
  return mode === 'email'
    ? `Emails go to ${to} and get their own thread in the inbox.`
    : `Texts go to ${to} and get their own thread in the inbox.`;
}

/** "Re: Your quote" (once, however long the thread). */
export function replySubject(subject: string | null | undefined): string | null {
  const s = subject?.trim();
  if (!s) return null;
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** The subject a new email goes out under when none was written. */
export function emailSubjectOf(
  typed: string,
  fallbacks: { readonly defaultDisplayName?: string | null; readonly businessName?: string | null },
): string {
  return (
    typed.trim() || fallbacks.defaultDisplayName || fallbacks.businessName || 'A message for you'
  );
}

/** Quiet hours, where the business is. */
export interface QuietFacts {
  readonly quiet: boolean;
  /** HH:MM. */
  readonly localTime: string;
  /** HH:MM, while quiet hours are on. */
  readonly endsAt: string | null;
}

/** The desktop composer's line: "It’s 9:40 PM where the business is. Quiet hours end at 8:00 AM." */
export function quietLine(q: QuietFacts): string {
  return `It’s ${formatClock(q.localTime)} where the business is.${q.endsAt ? ` Quiet hours end at ${formatClock(q.endsAt)}.` : ''}`;
}

/** The phone's strip over the thread: "Quiet hours until 8:00 AM". */
export function quietStrip(q: QuietFacts): string {
  return `Quiet hours${q.endsAt ? ` until ${formatClock(q.endsAt)}` : ' are on'}`;
}

/** The quiet-hours question before a text goes: send now, or when quiet hours end. */
export function quietQuestion(
  q: QuietFacts,
  who: string,
): {
  readonly title: string;
  readonly body: string;
  /** One line, beside the desktop composer's buttons. */
  readonly inline: string;
  readonly later: string;
  readonly laterLong: string;
  readonly now: string;
  readonly keep: string;
  readonly keepShort: string;
} {
  const ends = q.endsAt ? formatClock(q.endsAt) : null;
  const time = formatClock(q.localTime);
  return {
    title: `It’s ${time}, inside quiet hours`,
    body: `Send this text to ${who} now, or ${ends ? `at ${ends} ` : ''}when quiet hours end?`,
    inline: `It’s ${time}, inside quiet hours. Send now, or${ends ? ` at ${ends}` : ''} when quiet hours end?`,
    later: ends ? `Send at ${ends}` : 'Send when quiet hours end',
    laterLong: ends ? `Send at ${ends} when quiet hours end` : 'Send when quiet hours end',
    now: 'Send now',
    keep: 'Keep it as a draft',
    keepShort: 'Keep as draft',
  };
}

/** The Send button: "Send text", "Send…" in quiet hours, "Send email", or "Send" in a website chat. */
export function sendLabel(mode: 'sms' | 'email' | 'chat', quiet: boolean, off: boolean): string {
  if (mode === 'email') return 'Send email';
  if (mode === 'chat') return 'Send';
  return quiet && !off ? 'Send…' : 'Send text';
}

/** What sending did, for the toast. */
export const SENT_WORDS = {
  /** A text held until quiet hours end. */
  held: (who: string, scheduledFor: string, now = new Date()) =>
    `Held. It goes to ${who} ${heldWhen(scheduledFor, now)}, when quiet hours end. You can cancel it in the thread.`,
  textElsewhere: (to: string) => `Text sent to ${to}. Texts have their own thread in the inbox.`,
  emailElsewhere: (to: string) => `Email sent to ${to}. Email has its own thread in the inbox.`,
  reopened: 'Sent. The conversation is open again.',
} as const;

export const COMPOSER_WORDS = {
  text: 'Text',
  email: 'Email',
  websiteChat: 'Website chat',
  chatReplies: 'Replies show in their chat window',
  repliesHere: 'Replies come back to this thread.',
  enterSends: 'Enter sends · Shift+Enter adds a line',
  addingFile: 'Adding the file…',
  addingPhoto: 'Adding the photo…',
  attachPhoto: 'Attach a photo',
  attachFile: 'Attach a file',
  attachPhotoOrFile: 'Attach a photo or file',
  attach: 'Attach',
  addCustomerForPhotos: 'Add them as a customer to send photos',
  subject: 'Subject',
  to: 'To',
  cc: 'Cc',
} as const;

/**
 * A reply written on the phone that hasn't reached HandsFreeOS, under its bubble (the Inbox canvas's "A text written
 * with no signal"): when it goes on its own, or what it waits for.
 */
export const PENDING_REPLY_WORDS = {
  /** "Waiting for signal — sends by 10:42 AM". */
  waiting: (goesBy: string) => `Waiting for signal — sends by ${goesBy}`,
  sending: 'Sending…',
  you: 'You',
  photo: 'Sends once its photo is uploaded',
  photos: 'Sends once its photos are uploaded',
  retry: 'Couldn’t reach HandsFreeOS. It tries again soon.',
  stillSend: 'Still send?',
  stillSendBody: (kind: 'text' | 'email') =>
    `A${kind === 'email' ? 'n email' : ' text'} that waits more than 30 minutes checks with you first.`,
  sendNow: 'Send now',
  edit: 'Edit',
  discard: 'Discard',
  discarded: 'Discarded. Nothing was sent.',
  notSent: 'Not sent.',
  askedFirst: 'HandsFreeOS asks something first.',
  doItAnyway: 'Send it anyway',
  /** Above the composer while the phone has no signal. */
  offline: (mode: 'sms' | 'email' | 'chat') =>
    `${mode === 'email' ? 'Emails' : mode === 'chat' ? 'Replies' : 'Texts'} written with no signal go out on their own within 30 minutes. After that, the phone asks first.`,
} as const;

/** The composer's photo choices on the phone. */
export const PHOTO_CHOICE_WORDS = {
  title: 'Add a photo',
  camera: 'Take a photo',
  library: 'Choose from your photos',
  remove: (n: number) => `Remove photo ${n}`,
  noCamera: 'Allow HandsFreeOS to use the camera in Settings to take photos.',
} as const;
