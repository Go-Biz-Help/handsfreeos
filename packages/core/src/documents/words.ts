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

/** The colours of a badge, as the web's and the phone's badges both name them. */
export type DocumentTone = 'pending' | 'ok' | 'danger' | 'gray' | 'accent';

/** A document's state as a badge: out, finishing (everyone signed, the copy being made), signed, or closed. */
export function documentBadge(
  status: DocumentStatus,
  finishing = false,
): { readonly label: string; readonly tone: DocumentTone } {
  if (finishing) return { label: 'Making the signed copy', tone: 'accent' };
  const tone: Record<DocumentStatus, DocumentTone> = {
    out: 'pending',
    completed: 'ok',
    declined: 'danger',
    voided: 'gray',
    expired: 'gray',
  };
  return { label: DOCUMENT_STATUS_LABELS[status], tone: tone[status] };
}

export const SIGNER_STATUSES = ['waiting', 'sent', 'opened', 'signed', 'declined'] as const;
export type SignerStatus = (typeof SIGNER_STATUSES)[number];

export const SIGNER_STATUS_LABELS: Readonly<Record<SignerStatus, string>> = {
  waiting: 'Not their turn yet',
  sent: 'Sent',
  opened: 'Opened',
  signed: 'Signed',
  declined: 'Declined',
};

export const SIGNER_STATUS_TONES: Readonly<Record<SignerStatus, DocumentTone>> = {
  waiting: 'gray',
  sent: 'pending',
  opened: 'accent',
  signed: 'ok',
  declined: 'danger',
};

/**
 * A signer's status in words. `waiting` is "not their turn" only while someone at a lower position still has to
 * sign; a signer whose turn it is waits only for their link to go out.
 */
export function signerStatusLabel(
  signer: {
    readonly status: SignerStatus;
    readonly position: number;
    readonly inPerson?: boolean;
  },
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
  if (ahead) return SIGNER_STATUS_LABELS.waiting;
  return signer.inPerson ? 'Signs with you in person' : 'Link on its way';
}

/**
 * Whether it's this signer's turn: they're still to sign, at the lowest position of those who are (core's
 * `signersUp`, for the screens), on a document still out.
 */
export function signerIsUp(
  signer: { readonly id: string; readonly kind: string; readonly status: SignerStatus },
  signers: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: SignerStatus;
    readonly position: number;
  }[],
): boolean {
  if (signer.kind !== 'signer' || signer.status === 'signed' || signer.status === 'declined')
    return false;
  const left = signers.filter((s) => s.kind === 'signer' && s.status !== 'signed');
  if (!left.length) return false;
  const first = Math.min(...left.map((s) => s.position));
  return left.some((s) => s.id === signer.id && s.position === first);
}

export const DOCUMENT_STEP_KINDS = [
  'prepared',
  'sent',
  'reminded',
  'in_person',
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
  in_person: 'Handed over to sign in person',
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
 * One step of the proof trail in words, as the document's page and the proof page say it: how a link went ("Link sent
 * by text"), who handed it over in person ("Handed over to sign in person by Sam Lee"), and what their portal did
 * ("Opened from their portal").
 */
export function documentStepText(step: {
  readonly kind: DocumentStepKind;
  readonly channel: string | null;
  readonly detail?: Readonly<Record<string, unknown>> | null;
}): string {
  const label = DOCUMENT_STEP_LABELS[step.kind];
  const by = step.detail?.['by'];
  if (step.kind === 'in_person') return typeof by === 'string' && by ? `${label} by ${by}` : label;
  if (step.channel === 'portal') {
    if (step.kind === 'opened') return 'Opened from their portal';
    if (step.kind === 'code_checked') return 'Code not needed: signed in to their portal';
  }
  const channel =
    step.channel && step.channel in DOCUMENT_CHANNEL_LABELS
      ? DOCUMENT_CHANNEL_LABELS[step.channel as keyof typeof DOCUMENT_CHANNEL_LABELS]
      : null;
  return (step.kind === 'sent' ||
    step.kind === 'reminded' ||
    step.kind === 'code_sent' ||
    step.kind === 'copy_sent') &&
    channel
    ? `${label} by ${channel}`
    : label;
}

/**
 * "I agree to sign electronically" (answer 16a), word for word as the signer sees it and as it's kept with their
 * signature: ESIGN and UETA ask that they agree to sign this way, can have a paper copy, and can say no.
 */
export function consentWording(business: string): string {
  return `I agree to sign this document electronically, and that my electronic signature counts the same as signing it by hand. I can download a copy once everyone has signed, ask ${business} for a paper copy at any time, or decline instead of signing.`;
}

/** A day filled in on a document, as the page shows it and the signed copy prints it: "October 28, 2026". */
export function documentDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[3])}, ${m[1]}` : day;
}
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

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
  // Sign now, on the team's phone or tablet (answer 13a).
  handTitle: (signer: string) => `Hand this to ${signer}`,
  handBody: (a: { by: string | null; business: string; document: string }) =>
    `${a.by ? `${a.by} from ${a.business}` : a.business} asked you to sign “${a.document}” here, on this device.`,
  handStart: (first: string) => `I’m ${first}. Start`,
  handBack: (by: string | null) => (by ? `Hand it back to ${by}` : 'Hand it back'),
  handBackBody: 'You’re done here. The rest is for them.',
  backToDocument: 'Back to the document',
  // From their portal (answer 10b).
  backToPortal: 'Back to your portal',
} as const;

/** The team's screens for Documents, as the web and the phone both say it. */
export const DOCUMENT_SCREEN_WORDS = {
  title: 'Documents',
  sent: 'Sent',
  templates: 'Templates',
  allStates: 'All',
  send: 'Send a document',
  makeTemplateFirst: 'Make a template first',
  nothingSent: 'Nothing sent yet',
  nothingSentBody:
    'Send a contract or agreement to a customer and they sign it online. You see every step here.',
  noneHere: 'None here',
  noneHereBody: 'No documents are in that state.',
  older: 'Show older ones',
  inUse: 'In use',
  archived: 'Archived',
  noTemplates: 'No templates yet',
  nothingArchived: 'Nothing archived',
  nothingArchivedBody: 'Templates you archive wait here, and can be restored.',
  askForTemplates: 'An owner or admin makes the templates. Ask them for the one you need.',
  ready: 'Ready to send',
  notReady: 'Not ready yet',
  out: (n: number) => `${n} out for signing`,
  pages: (n: number) => (n === 1 ? '1 page' : `${n} pages`),
  fields: (n: number) => (n === 1 ? '1 field' : `${n} fields`),
  noPdf: 'No PDF yet',
  // One document.
  remind: 'Remind',
  reminded: 'Reminder on its way.',
  void: 'Void',
  voidTitle: (name: string) => `Void “${name}”?`,
  voidBody:
    'Its links stop working and everyone on it is told. What’s been signed so far is kept. To fix something, void it, then send it again.',
  voidReason: 'Why (they see this)',
  voidReasonExample: 'The start date was wrong. A corrected copy is on its way.',
  keepOut: 'Keep it out',
  voidIt: 'Void it',
  voided: 'Voided. Its links don’t open it anymore, and the signers are told.',
  openSigned: 'Open the signed copy',
  download: 'Download',
  sendAgain: 'Send it again',
  whoSigns: 'Who signs',
  whatHappened: 'What happened',
  getsCopy: 'Gets a copy',
  signNow: 'Sign now',
  copyLink: 'Copy their link',
  shareLink: 'Send their link',
  linkCopied: (name: string) =>
    `${name}’s link is copied. It opens the document as them, so only send it to them.`,
  about: 'About',
  sentAt: (when: string, by: string | null) => `Sent ${when}${by ? ` by ${by}` : ''}`,
  outOfTimeOn: (day: string) => `Out of time ${day}`,
  everyoneSigned: (when: string) => `Everyone signed ${when}`,
  voidedNote: (when: string, reason: string | null) =>
    `Voided ${when}${reason ? `: ${reason}` : '.'}`,
  declinedNote: (who: string | null, when: string, reason: string | null) =>
    `${who ?? 'A signer'} declined ${when}${reason ? `: ${reason}` : '.'}`,
  expiredNote: (when: string) => `Ran out of time ${when} before everyone signed.`,
  completedNote:
    'The signed copy is on their Files, locked, with a proof page at the end. Everyone who signed or gets a copy was sent it.',
  signedAt: (when: string) => `Signed ${when}`,
  openedAt: (when: string) => `Opened ${when}`,
  linkSentAt: (when: string, reminders: number) =>
    `Sent ${when}${reminders ? `, ${reminders} ${reminders === 1 ? 'reminder' : 'reminders'}` : ''}`,
  // Sending one.
  template: 'Template',
  pickOne: 'Pick one',
  noTemplateReady:
    'No template is ready to send yet. An owner or admin makes them under Documents → Templates.',
  whoFor: 'Who it’s for',
  change: 'Change',
  fillingIn: 'Filling it in…',
  name: 'What it’s called',
  nameHint: 'On their email and text, and on their Files.',
  pickTeam: 'Pick someone on your team',
  pickSigner: (role: string) => `Pick who signs as ${role}.`,
  inPerson: 'With you now.',
  inPersonBody:
    'No link goes to them: they sign on your phone or computer with Sign now on the document.',
  copies: 'Gets a signed copy',
  copyCustomer: 'A customer',
  copyTeam: 'Someone on your team',
  takeOffCopies: (name: string) => `Take ${name} off the copies`,
  filledIn: 'Filled in before it goes',
  filledInBody:
    'Your part, and what HandsFreeOS filled in for them. They can change what’s theirs before they sign.',
  noteAndSettings: 'The note and the settings',
  note: 'Note with the link',
  noteExample: 'Here’s the agreement we talked about. Let me know if you have questions.',
  sendIt: 'Send it',
  sentOne: 'Sent. Their link is on its way.',
  sentMany: 'Sent. Each signer gets their own link.',
  // The settings a template keeps, and a document going out can change.
  whoSignsWhen: 'Who signs when',
  inOrder: 'One after another',
  together: 'All at once',
  askCode: 'Ask for a code',
  askCodeBody: 'A 6-digit code by text or email before they can open it.',
  reminders: 'Send reminders',
  firstAfter: 'First after (days)',
  thenEvery: 'Then every (days)',
  expireDays: 'Out of time after (days)',
  /** The phone's own words, where the phone does a thing its own way. */
  phone: {
    needsSignal: 'Documents need signal. They show here again once you’re back on.',
    templatesOnWeb: 'Make and change templates on the web for now.',
    pickTemplate: 'Pick a template',
    searchCustomers: 'Search by name, number or street',
    nobody: (typed: string) => `Nobody here matches “${typed}”.`,
    customerTitle: 'Documents',
    signNowTitle: (name: string) => `Hand your phone to ${name}?`,
    signNowBody:
      'Their signing page opens here. When they’re done, they tap Back to the document and hand it back.',
    signNowLocks: 'The app locks again when the page closes, so only you can open it.',
    signNowGo: 'Open it for them',
    pagesOnWeb: 'See the pages on the web',
    share: 'Share the signed copy',
    fileShareFailed: 'This phone can’t save or share files.',
    datePlaceholder: 'YYYY-MM-DD',
  },
} as const;

/**
 * Where the phone's Sign now comes back to: the signing page's way back (`#back=`), in the app's own scheme. Nothing on
 * the phone opens it as a screen; it closes the signing page the phone opened, and the app locks.
 */
export const PHONE_HAND_BACK = 'handsfreeos://documents/handed-back';

/** The Send screen's query for who a document is about (`?person=`…). */
export const SEND_ABOUT_PARAM = {
  person: 'person',
  company: 'company',
  lead: 'lead',
  custom_record: 'record',
} as const;

/**
 * Sending a corrected one again (answer 15a), from a voided, declined or out-of-time document: the Send screen's query
 * (`template=…&from=…&person=…`), or null when it can't go again (it's still out, it was signed, or its template is
 * gone).
 */
export function sendAgainQuery(doc: {
  readonly id: string;
  readonly status: DocumentStatus;
  readonly templateId: string | null;
  readonly about: { readonly kind: keyof typeof SEND_ABOUT_PARAM; readonly id: string } | null;
}): string | null {
  if (!doc.templateId || doc.status === 'out' || doc.status === 'completed') return null;
  const about = doc.about ? `&${SEND_ABOUT_PARAM[doc.about.kind]}=${doc.about.id}` : '';
  return `template=${doc.templateId}&from=${doc.id}${about}`;
}

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
    'Signed electronically through HandsFreeOS. Each signer opened their own private link, their portal, or the business’s device handed to them in person, agreed to sign electronically, and signed. The times are in the business’s time zone.',
} as const;

/** A customer's documents in their portal (answer 10b). */
export const PORTAL_DOCUMENT_WORDS = {
  title: 'Documents',
  homeTitle: 'Documents to sign',
  homeToSign: (n: number) =>
    n === 1 ? '1 document is ready for you to sign.' : `${n} documents are ready for you to sign.`,
  none: 'Nothing to sign yet. When there’s something, it shows here and we’ll email or text you.',
  sign: 'Sign it',
  open: 'Open',
  toSign: 'Ready for you to sign',
  notYet: 'Not your turn yet',
  signedWaiting: 'You signed. Waiting for the others',
  completed: 'Signed by everyone',
  copy: 'You get a copy',
  declined: 'Declined',
  expired: 'Ran out of time',
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
