/**
 * The words of Documents (docs/documents.md), shared by the web, the phone, the worker's links and the proof page.
 * Browser-safe. Plain words, short sentences, curly apostrophes.
 */
import type { DocumentFieldType } from './definition';

export const DOCUMENT_STATUSES = ['out', 'completed', 'declined', 'voided', 'expired'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_STATUS_LABELS: Readonly<Record<DocumentStatus, string>> = {
  out: 'Out for signing',
  completed: 'Signed',
  declined: 'Declined',
  voided: 'Voided',
  expired: 'Out of time',
};

export const SIGNER_STATUSES = ['waiting', 'sent', 'opened', 'signed', 'declined'] as const;
export type SignerStatus = (typeof SIGNER_STATUSES)[number];

export const SIGNER_STATUS_LABELS: Readonly<Record<SignerStatus, string>> = {
  waiting: 'Not their turn yet',
  sent: 'Sent',
  opened: 'Opened',
  signed: 'Signed',
  declined: 'Declined',
};

/**
 * A signer's status in words. `waiting` is "not their turn" only while someone at a lower position still has to
 * sign; a signer whose turn it is waits only for their link to go out.
 */
export function signerStatusLabel(
  signer: { readonly status: SignerStatus; readonly position: number },
  signers: readonly {
    readonly kind: string;
    readonly status: SignerStatus;
    readonly position: number;
  }[],
): string {
  if (signer.status !== 'waiting') return SIGNER_STATUS_LABELS[signer.status];
  const ahead = signers.some(
    (s) => s.kind === 'signer' && s.position < signer.position && s.status !== 'signed',
  );
  return ahead ? SIGNER_STATUS_LABELS.waiting : 'Link on its way';
}

export const DOCUMENT_STEP_KINDS = [
  'prepared',
  'sent',
  'reminded',
  'opened',
  'code_sent',
  'code_checked',
  'agreed',
  'signed',
  'declined',
  'voided',
  'expired',
  'completed',
  'copy_sent',
] as const;
export type DocumentStepKind = (typeof DOCUMENT_STEP_KINDS)[number];

/** Steps of one moment in the order they happen (agreeing, then signing): a sort after the time. */
export const compareSteps = (
  a: { readonly at: Date; readonly kind: string },
  b: { readonly at: Date; readonly kind: string },
): number =>
  a.at.getTime() - b.at.getTime() ||
  DOCUMENT_STEP_KINDS.indexOf(a.kind as DocumentStepKind) -
    DOCUMENT_STEP_KINDS.indexOf(b.kind as DocumentStepKind);

/** Each step of the proof trail, as the document's page and the proof page list it. */
export const DOCUMENT_STEP_LABELS: Readonly<Record<DocumentStepKind, string>> = {
  prepared: 'Prepared and sent',
  sent: 'Link sent',
  reminded: 'Reminder sent',
  opened: 'Opened',
  code_sent: 'Code sent',
  code_checked: 'Code checked',
  agreed: 'Agreed to sign electronically',
  signed: 'Signed',
  declined: 'Declined',
  voided: 'Voided',
  expired: 'Ran out of time',
  completed: 'Signed copy filed',
  copy_sent: 'Signed copy sent',
};

export const DOCUMENT_CHANNEL_LABELS = {
  email: 'email',
  sms: 'text',
  portal: 'their portal',
  page: 'the signing page',
} as const;

/**
 * "I agree to sign electronically" (answer 16a), word for word as the signer sees it and as it's kept with their
 * signature: ESIGN and UETA ask that they agree to sign this way, can have a paper copy, and can say no.
 */
export function consentWording(business: string): string {
  return `I agree to sign this document electronically, and that my electronic signature counts the same as signing it by hand. I can download a copy once everyone has signed, ask ${business} for a paper copy at any time, or decline instead of signing.`;
}

/** A day filled in on a document, as the page shows it and the signed copy prints it: "October 28, 2026". */
export function documentDay(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  return at.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** How long a 6-digit code works, and how many tries it gets. */
export const DOCUMENT_CODE_MINUTES = 10;
export const DOCUMENT_CODE_TRIES = 5;

const quoted = (name: string) => `“${name}”`;

/** What goes with each signer's link, by text and by email. */
export const DOCUMENT_MESSAGES = {
  linkText: (a: { business: string; document: string; url: string; message?: string | null }) =>
    `${a.business}: ${quoted(a.document)} is ready for you to sign.${a.message ? ` ${a.message}` : ''} ${a.url}`,
  linkSubject: (document: string) => `Please sign: ${document}`,
  linkEmail: (a: {
    business: string;
    document: string;
    url: string;
    message?: string | null;
    sender?: string | null;
  }) =>
    [
      `${a.sender ? `${a.sender} at ${a.business}` : a.business} sent you ${quoted(a.document)} to sign.`,
      ...(a.message ? ['', a.message] : []),
      '',
      `Open it here: ${a.url}`,
      '',
      'It takes a minute or two. You can read it all before you sign, or decline.',
    ].join('\n'),
  reminderText: (a: { business: string; document: string; url: string }) =>
    `${a.business}: a reminder that ${quoted(a.document)} is waiting for your signature. ${a.url}`,
  reminderSubject: (document: string) => `Reminder: please sign ${document}`,
  reminderEmail: (a: { business: string; document: string; url: string }) =>
    [
      `A reminder that ${quoted(a.document)} from ${a.business} is waiting for your signature.`,
      '',
      `Open it here: ${a.url}`,
    ].join('\n'),
  codeText: (a: { business: string; document: string; code: string }) =>
    `${a.code} is your code to open ${quoted(a.document)} from ${a.business}. It works for ${DOCUMENT_CODE_MINUTES} minutes.`,
  codeSubject: (document: string) => `Your code to open ${document}`,
  codeEmail: (a: { business: string; document: string; code: string }) =>
    [
      `Your code to open ${quoted(a.document)} from ${a.business} is ${a.code}.`,
      '',
      `It works for ${DOCUMENT_CODE_MINUTES} minutes. If you didn’t ask for it, you can ignore this email.`,
    ].join('\n'),
  doneText: (a: { business: string; document: string; url: string }) =>
    `${a.business}: everyone has signed ${quoted(a.document)}. Your copy: ${a.url}`,
  doneSubject: (document: string) => `Signed: ${document}`,
  doneEmail: (a: { business: string; document: string; url: string }) =>
    [
      `Everyone has signed ${quoted(a.document)} from ${a.business}.`,
      '',
      'Your signed copy is attached. You can also download it here:',
      a.url,
    ].join('\n'),
  voidedText: (a: { business: string; document: string; reason?: string | null }) =>
    `${a.business} took back ${quoted(a.document)}, so it doesn’t need signing anymore.${a.reason ? ` ${a.reason}` : ''}`,
  voidedSubject: (document: string) => `No longer needs signing: ${document}`,
  voidedEmail: (a: { business: string; document: string; reason?: string | null }) =>
    [
      `${a.business} took back ${quoted(a.document)}, so it doesn’t need signing anymore.`,
      ...(a.reason ? ['', a.reason] : []),
      '',
      'If they send a corrected copy, it comes with a new link.',
    ].join('\n'),
} as const;

/** What the person who sent it is told (bell and push, `document`). */
export const DOCUMENT_PUSH = {
  completed: (document: string) => ({
    title: `Signed: ${document}`,
    body: 'Everyone signed. The signed copy is on their Files, locked.',
  }),
  declined: (document: string, who: string, reason: string | null) => ({
    title: `Declined: ${document}`,
    body: reason ? `${who} declined: ${reason}` : `${who} declined to sign it.`,
  }),
  expired: (document: string) => ({
    title: `Out of time: ${document}`,
    body: 'Nobody finished signing it in time. Send it again if it’s still needed.',
  }),
} as const;

/** The signing page (`/d/<link>`). */
export const SIGNING_WORDS = {
  agree: 'I agree to sign electronically',
  start: 'Start',
  next: 'Next',
  finish: 'Finish and sign',
  decline: 'Decline to sign',
  declineReason: 'Tell them why (optional)',
  declineConfirm: 'Decline',
  declined: 'You declined to sign this. They’ve been told.',
  signed: 'Thanks. You’ve signed it.',
  signedWaiting: 'We’ll send you the signed copy once everyone has signed.',
  completed: 'Everyone has signed it.',
  download: 'Download the signed copy',
  draw: 'Draw',
  type: 'Type',
  clear: 'Clear',
  adopt: 'Use this signature',
  typeYourName: 'Type your name',
  codeAsk: (to: string) => `To keep it private, we’ll send a 6-digit code to ${to}.`,
  codeSend: 'Send the code',
  codeEnter: 'Enter the 6-digit code',
  codeCheck: 'Open the document',
  codeAgain: 'Send a new code',
  notYourTurn: 'It isn’t your turn to sign yet. We’ll send you a link when it is.',
  voided:
    'This document was taken back by the business, so this link doesn’t work anymore. If they send a corrected copy, it comes with a new link.',
  expired:
    'This document ran out of time, so it can’t be signed anymore. Ask the business to send it again.',
  gone: 'This link doesn’t work. It may be old, or cut short. Open the newest one you were sent.',
  stale: 'This link is out of date. Open the newest one you were sent.',
  closedDeclined:
    'Someone declined to sign this document, so it’s closed. Ask the business if it’s still needed.',
  copyOnly:
    'You’re getting a copy of this document. We’ll send it to you once everyone has signed.',
  agreeFirst: 'Tick the box above to start.',
  dateSigned: 'Filled in when you sign',
  noCodeRoute: (business: string) =>
    `We have no way to send you a code. Call ${business} and ask them to send it again.`,
  requiredLeft: (n: number) =>
    n === 1 ? '1 field left to fill in.' : `${n} fields left to fill in.`,
  poweredBy: 'Powered by HandsFreeOS',
} as const;

/** The proof page added to the end of every signed copy. */
export const PROOF_WORDS = {
  title: 'Proof of signing',
  document: 'Document',
  documentId: 'Document ID',
  business: 'Sent by',
  sent: 'Sent',
  completed: 'Everyone signed',
  original: 'The original PDF’s fingerprint (SHA-256)',
  signer: 'Signer',
  role: 'Signing as',
  contact: 'Reached at',
  linkSent: 'Link sent by',
  opened: 'Opened',
  codeChecked: 'Code checked',
  agreed: 'Agreed to sign electronically',
  signed: 'Signed',
  from: 'from',
  device: 'Device',
  consent: 'What each signer agreed to',
  footer:
    'Signed electronically through HandsFreeOS. Each signer opened their own private link, agreed to sign electronically, and signed. The times are in the business’s time zone.',
} as const;

/** What a field asks for when the template gave it no label. */
export const FIELD_PROMPTS: Readonly<Record<DocumentFieldType, string>> = {
  signature: 'Sign here',
  initials: 'Initial here',
  date_signed: 'Date signed',
  name: 'Your full name',
  email: 'Your email',
  phone: 'Your phone number',
  text: 'Fill this in',
  long_text: 'Fill this in',
  number: 'A number',
  date: 'A date',
  checkbox: 'Tick if it applies',
  choice: 'Pick one',
};
