/**
 * Calls on the phone (M10): where a call's recording is kept, what the call sheet says while HandsFreeOS rings the
 * person's cell and connects the customer, and the words of My cell phone, the same on the web and the phone.
 * Browser-safe.
 */
import { formatPhone } from '../crm/phone';
import type { BridgeStatus } from '../messaging/bridge';

/** The storage bucket calls' recordings and texts' photos are kept in (only the worker writes to it). */
export const TELEPHONY_BUCKET = 'telephony';

/** The folder a call's recording is kept in: `<business>/calls/<call>/`. */
export function callRecordingFolder(workspaceId: string, callId: string): string {
  return `${workspaceId}/calls/${callId}`;
}

/**
 * Where a call's recording is kept: `voicemail.mp3` for a voicemail, `recording.mp3` for a whole call through someone's
 * own cell (the carrier's recordings are MP3; the stand-in carrier's WAV).
 */
export function callRecordingPath(
  workspaceId: string,
  callId: string,
  kind: 'voicemail' | 'recording',
  ext: 'mp3' | 'wav',
): string {
  return `${callRecordingFolder(workspaceId, callId)}/${kind}.${ext}`;
}

/** Which file in a call's folder is its recording, from the folder's file names. */
export function recordingFileIn(names: readonly string[], voicemail: boolean): string | null {
  const want = voicemail ? 'voicemail' : 'recording';
  return names.find((n) => n === `${want}.mp3` || n === `${want}.wav`) ?? null;
}

/** The statuses while the call can still be cancelled: the person's cell is ringing, or the customer's is. */
export const CANCELLABLE_BRIDGE: ReadonlySet<BridgeStatus> = new Set([
  'calling_cell',
  'calling_customer',
]);

/** Whether the call is over, one way or another (the sheet's button is Close then). */
export const bridgeOver = (status: BridgeStatus): boolean =>
  !['calling_cell', 'calling_customer', 'connected'].includes(status);

/** The call sheet's words for a call through the person's own cell. */
export function callSheetWords(facts: {
  readonly status: BridgeStatus;
  readonly customerName: string | null;
  /** The person's verified cell, E.164. */
  readonly cell: string | null;
  /** The business number both phones see, E.164. */
  readonly callerId: string | null;
  readonly businessName: string;
}): {
  /** Under the title while the cell rings: "Answer to be connected to Mike Johnson." */
  readonly hint: string | null;
  readonly cellLabel: string;
  readonly cell: string;
  /** "Mike sees". */
  readonly seesLabel: string;
  /** "Lone Star HVAC & Roofing’s number, (713) 555-0100". */
  readonly sees: string;
} {
  const who = facts.customerName?.trim() || null;
  const first = who && !/^[+(0-9]/.test(who) ? who.split(/\s+/)[0]! : null;
  const hint =
    facts.status === 'calling_cell'
      ? `Answer to be connected to ${who ?? 'the customer'}.`
      : facts.status === 'calling_customer'
        ? 'Their phone shows the business number.'
        : facts.status === 'connected'
          ? 'Hang up on your phone to end the call.'
          : facts.status === 'cell_unanswered'
            ? `${who ?? 'The customer'}’s phone never rang.`
            : null;
  return {
    hint,
    cellLabel: 'Your cell',
    cell: formatPhone(facts.cell),
    seesLabel: first ? `${first} sees` : 'They see',
    sees: `${facts.businessName}’s number, ${formatPhone(facts.callerId)}`,
  };
}

export const CALL_SHEET_WORDS = {
  cancel: 'Cancel',
  close: 'Close',
  done: 'Done',
  needsSignal: 'This needs signal.',
  starting: 'Calling your cell…',
  callAgain: 'Call again',
} as const;

// ----------------------------------------------------------------------------------------- My cell phone

/** "Verified Mon, Sep 21": when the person pressed 1, as the device reads the day. */
export function cellVerifiedOn(iso: string): string {
  const d = new Date(iso);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]!;
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][d.getMonth()]!;
  return `Verified ${weekday}, ${month} ${d.getDate()}`;
}

/** My cell phone's words. The web and the phone's own intro differ only where the canvas words them for each. */
export const MY_CELL_WORDS = {
  title: 'My cell phone',
  intro: {
    web: 'When you press Call in the app, HandsFreeOS rings this phone first, then connects the customer from the business number.',
    phone: 'When you press Call, HandsFreeOS rings this phone first, then connects the customer.',
  },
  numberLabel: 'Your cell number',
  placeholder: '(512) 555-0142',
  verify: 'Verify my cell',
  change: 'Change',
  cancel: 'Cancel',
  verified: 'Verified',
  waiting: 'Waiting for you to press 1…',
  notVerified: 'Not verified yet',
  enterNumber: 'Enter your cell number.',
  /** "We’ll call (512) 555-0142. Press 1 when you answer." */
  calling: (e164: string) => `We’ll call ${formatPhone(e164)}. Press 1 when you answer.`,
  /** "The call comes from Lone Star HVAC & Roofing’s number, (713) 555-0100. It only proves the phone is yours." */
  callsFrom: (businessName: string, businessNumber: string) =>
    `The call comes from ${businessName}’s number, ${formatPhone(businessNumber)}. It only proves the phone is yours.`,
  noNumber: (businessName: string) =>
    `${businessName} needs a business number before HandsFreeOS can call your cell. An owner or admin sets it up in Settings → Texting & calls.`,
  saveContact: (businessName: string, businessNumber: string) =>
    `Save ${formatPhone(businessNumber)}, ${businessName}’s number, as a contact on this phone. If your phone silences unknown callers, calls that connect you to customers could go to voicemail.`,
  isVerified: (e164: string) => `${formatPhone(e164)} is verified`,
  alreadyVerified: (e164: string) => `${formatPhone(e164)} is already verified`,
  /** Before a call, with no verified cell yet. */
  verifyFirst: (customerName: string | null) =>
    customerName
      ? `Verify your cell to call ${customerName}. HandsFreeOS rings it first, then connects them.`
      : 'Verify your cell to call customers. HandsFreeOS rings it first, then connects them.',
} as const;

/** The iPhone card after verifying: add the business number to Contacts so call screening doesn't silence it. */
export const CONTACT_CARD_WORDS = {
  title: (businessName: string) =>
    `Add ${businessName}’s number to your contacts so your iPhone doesn’t silence it`,
  titleAndroid: (businessName: string) =>
    `Add ${businessName}’s number to your contacts so your phone doesn’t silence it`,
  body: (businessNumber: string) =>
    `If your iPhone screens or silences unknown callers, calls from ${formatPhone(businessNumber)} could go to voicemail, including the ones that connect you to customers.`,
  bodyAndroid: (businessNumber: string) =>
    `If your phone screens or silences unknown callers, calls from ${formatPhone(businessNumber)} could go to voicemail, including the ones that connect you to customers.`,
  contactLine: (businessNumber: string) => `${formatPhone(businessNumber)} · the contact it adds`,
  add: 'Add to Contacts',
  added: (businessName: string) => `${businessName} is in your contacts`,
  noContactsApp: 'This phone has no contacts app to add it to.',
} as const;
