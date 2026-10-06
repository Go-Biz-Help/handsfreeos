/**
 * Reading a lockbox maker's "opened" emails (round seven, step 4): what SentriLock or Supra emails a listing agent
 * when someone opens the lockbox on their listing. Neither has an API without a partner agreement, so their
 * notification emails are read, by their labels ("Serial Number:", "Accessed By:") or, for a one-line notice, by
 * its sentence.
 *
 * Their wording isn't published: these follow the notices agents forward, and one real email from each is to be
 * checked before this ships (the plan's open question). An email that isn't one of these is left in the Inbox as is.
 */
import { clockOf, dateOf } from './showingtime';

export type LockboxVendor = 'sentrilock' | 'supra';

export interface LockboxEmail {
  readonly vendor: LockboxVendor;
  /** The home's address as the email gives it, when it does. */
  readonly address: string | null;
  readonly serial: string | null;
  /** The local day (YYYY-MM-DD) and clock ('HH:MM', 24-hour) it was opened, in the business's time zone. */
  readonly date: string | null;
  readonly clock: string | null;
  readonly openedBy: string | null;
  readonly company: string | null;
  readonly phone: string | null;
}

/** Which maker sent it: by its domain, or by what its subject says. Null for any other email. */
export function lockboxVendorOf(from: string | null, subject: string | null): LockboxVendor | null {
  const sender = (from ?? '').trim().toLowerCase();
  const about = (subject ?? '').toLowerCase();
  if (/@([a-z0-9-]+\.)*sentrilock\.com\s*>?$/.test(sender) || /\bsentrilock\b/.test(about))
    return 'sentrilock';
  if (
    /@([a-z0-9-]+\.)*(supraekey|suprasystems|supra-ekey|utcfs|carrier)\.(com|net)\s*>?$/.test(
      sender,
    ) ||
    /\b(supra|keybox|ekey)\b/.test(about)
  )
    return 'supra';
  return null;
}

/** The value after a label, on its own line: "Accessed By: Ana Ruiz". */
function field(text: string, ...labels: string[]): string | null {
  for (const label of labels) {
    const m = new RegExp(`^\\s*${label}\\s*[:#\\-]+\\s*(.+?)\\s*$`, 'im').exec(text);
    if (m?.[1]) return m[1].slice(0, 300);
  }
  return null;
}

const clean = (v: string | null, max: number) => {
  const t = v?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** Whether a notice says the lockbox was opened (not a low battery, a firmware update or a new code). */
const saysOpened = (text: string) =>
  /\b(accessed|opened|showing notification|access notification|keybox activity|was used)\b/i.test(
    text,
  ) &&
  !/\b(low battery|battery is low|firmware|shackle code changed|code (was )?changed)\b/i.test(text);

/** What an opened email says, or null when it isn't one (or says too little to place it). */
export function readLockboxEmail(
  from: string | null,
  subject: string | null,
  body: string | null,
): LockboxEmail | null {
  const vendor = lockboxVendorOf(from, subject);
  if (!vendor || !body) return null;
  const text = body.replace(/\r/g, '');
  if (!saysOpened(`${subject ?? ''}\n${text}`)) return null;

  let address = field(
    text,
    'Property Address',
    'Property',
    'Address',
    'Listing Address',
    'Location',
  );
  let serial = field(
    text,
    'Lockbox Serial Number',
    'Lockbox Serial #',
    'Lockbox Serial',
    'Serial Number',
    'Serial #',
    'KeyBox Serial #',
    'KeyBox Serial Number',
    'KeyBox #',
    'KeyBox',
    'S/N',
  );
  let openedBy = field(
    text,
    'Accessed By',
    'Opened By',
    'Showing Agent',
    'Agent Name',
    'Agent',
    'Name',
  );
  let company = field(text, 'Company', 'Office', 'Brokerage', 'Agency');
  const phone = field(text, 'Phone', 'Agent Phone', 'Mobile', 'Cell');
  const when = field(text, 'Date/Time', 'Date and Time', 'Access Time', 'Time', 'Date', 'When');

  // A one-line notice: "Your KeyBox (S/N 12345678) at 418 Cedar Hollow Dr was opened by Ana Ruiz of Hill Realty on
  // 10/5/2026 at 2:14 PM."
  const sentence =
    /(?:keybox|lockbox)\s*(?:\((?:s\/n|serial(?: #)?)\s*([A-Z0-9-]+)\)|#\s*([A-Z0-9-]+))?\s*(?:at|for)\s+(.+?)\s+was\s+(?:opened|accessed)\s+by\s+(.+?)(?:\s+(?:of|from|with)\s+(.+?))?\s+on\s+(.+?)(?:\.|$)/im.exec(
      text,
    );
  if (sentence) {
    serial ??= sentence[1] ?? sentence[2] ?? null;
    address ??= sentence[3] ?? null;
    openedBy ??= sentence[4] ?? null;
    company ??= sentence[5] ?? null;
  }
  const whenText = when ?? sentence?.[6] ?? `${subject ?? ''} ${text}`;
  const date = dateOf(whenText);
  const clock = clockOf(whenText);
  serial = serial ? (serial.match(/[A-Z0-9][A-Z0-9-]{3,}/i)?.[0] ?? null) : null;
  if (!serial && !address) return null;
  return {
    vendor,
    address: clean(address, 200),
    serial: clean(serial, 60),
    date,
    clock,
    openedBy: clean(openedBy, 120),
    company: clean(company, 120),
    phone: clean(phone, 40),
  };
}
