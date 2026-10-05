/**
 * Reading ShowingTime's emails (round five, step 8): what a listing agent's ShowingTime account emails them about a
 * showing (asked for, confirmed, cancelled, and the feedback), read into the same showings our own page makes.
 *
 * ShowingTime has no API for this, so its notification emails are read by their labels ("Address:", "Showing
 * Agent:", "Interest Level:"). What's read is never trusted on its own: each showing it makes or changes is marked
 * to be checked by a person, and an email that isn't one of these is left in the Inbox as it is.
 */
import type { PriceFeel, ShowingFeedback } from '@hfos/core/addons/realestate/showings';

export interface ShowingTimeEmail {
  readonly kind: 'requested' | 'confirmed' | 'cancelled' | 'feedback';
  /** The home's address as the email gives it. */
  readonly address: string;
  /** The local day (YYYY-MM-DD) and clock ('HH:MM', 24-hour) it starts and ends, in the business's time zone. */
  readonly date: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly agentName: string | null;
  readonly brokerage: string | null;
  readonly agentEmail: string | null;
  readonly agentPhone: string | null;
  /** ShowingTime's own number for the showing, when the email gives it. */
  readonly reference: string | null;
  readonly feedback: ShowingFeedback | null;
}

/** Whether an email is ShowingTime's: from its domain, or saying so. */
export function isShowingTimeEmail(from: string | null, subject: string | null): boolean {
  return (
    /@([a-z0-9-]+\.)*showingtime\.com\s*>?$/i.test((from ?? '').trim()) ||
    /\bshowingtime\b/i.test(subject ?? '')
  );
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** "Friday, October 9, 2026" or "10/9/2026" as YYYY-MM-DD. */
export function dateOf(text: string): string | null {
  const long = /([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(text);
  if (long) {
    const month = MONTHS.findIndex((m) => m.startsWith(long[1]!.toLowerCase().slice(0, 3)));
    if (month >= 0)
      return `${long[3]}-${String(month + 1).padStart(2, '0')}-${long[2]!.padStart(2, '0')}`;
  }
  const short = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(text);
  if (short) {
    const year = short[3]!.length === 2 ? `20${short[3]}` : short[3];
    return `${year}-${short[1]!.padStart(2, '0')}-${short[2]!.padStart(2, '0')}`;
  }
  return null;
}

/** "2:00 PM" as "14:00". */
export function clockOf(text: string): string | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (m[3]!.toLowerCase() === 'p') hour += 12;
  return `${String(hour).padStart(2, '0')}:${m[2] ?? '00'}`;
}

/** The value after a label, on its own line: "Showing Agent: Ana Ruiz". */
function field(text: string, ...labels: string[]): string | null {
  for (const label of labels) {
    const m = new RegExp(`^\\s*${label}\\s*[:\\-]\\s*(.+?)\\s*$`, 'im').exec(text);
    if (m?.[1]) return m[1].slice(0, 300);
  }
  return null;
}

const priceOf = (v: string | null): PriceFeel | null => {
  if (!v) return null;
  if (/too high|high|over/i.test(v)) return 'high';
  if (/too low|low|under|bargain/i.test(v)) return 'low';
  if (/right|fair|accurate|on target|about/i.test(v)) return 'right';
  return null;
};

/** "4", "4/5", "4 out of 5", "Very interested". */
const interestOf = (v: string | null): number | null => {
  if (!v) return null;
  const n = /(\d)(?:\s*(?:\/|out of|of)\s*5)?/.exec(v);
  if (n) return Math.min(5, Math.max(1, Number(n[1])));
  if (/very interested|high/i.test(v)) return 5;
  if (/somewhat|moderate|maybe/i.test(v)) return 3;
  if (/not interested|none|low/i.test(v)) return 1;
  return null;
};

/** What a ShowingTime email says, or null when it isn't one of its showing emails. */
export function readShowingTimeEmail(
  subject: string | null,
  body: string | null,
): ShowingTimeEmail | null {
  const s = subject ?? '';
  const text = (body ?? '').replace(/\r/g, '');
  const kind: ShowingTimeEmail['kind'] | null = /feedback/i.test(s)
    ? 'feedback'
    : /cancel/i.test(s)
      ? 'cancelled'
      : /confirm|approved/i.test(s)
        ? 'confirmed'
        : /request/i.test(s)
          ? 'requested'
          : null;
  if (!kind) return null;
  const address =
    field(text, 'Address', 'Property', 'Listing Address', 'Listing') ??
    /(?:for|at)\s+(\d+\s+[^,\n]+(?:,[^\n]+)?)$/i.exec(s)?.[1] ??
    null;
  if (!address) return null;
  const when = field(text, 'Date and Time', 'Showing Time', 'When') ?? '';
  const dateLine = field(text, 'Date', 'Showing Date') ?? when;
  const timeLine = field(text, 'Time') ?? when;
  const [fromText, toText] = timeLine.split(/\s+(?:-|–|to)\s+/);
  const feedback: ShowingFeedback | null =
    kind === 'feedback'
      ? {
          interest: interestOf(field(text, 'Interest Level', 'Interest', 'Buyer Interest')),
          liked: field(text, 'What did your buyers like', 'Liked', 'Likes', 'Positives'),
          pause: field(
            text,
            'What gave them pause',
            'Concerns',
            'Dislikes',
            'Negatives',
            'Comments',
          ),
          price: priceOf(field(text, 'Price', 'Price Opinion', 'Pricing')),
        }
      : null;
  return {
    kind,
    address,
    date: dateOf(dateLine) ?? dateOf(s),
    from: fromText ? clockOf(fromText) : null,
    to: toText ? clockOf(toText) : null,
    agentName: field(text, 'Showing Agent', 'Buyer Agent', 'Buyer’s Agent', 'Agent Name', 'Agent'),
    brokerage: field(text, 'Agent Company', 'Brokerage', 'Office', 'Company'),
    agentEmail: field(text, 'Agent Email', 'Email')?.replace(/^mailto:/i, '') ?? null,
    agentPhone: field(text, 'Agent Phone', 'Phone', 'Mobile'),
    reference: field(text, 'Showing ID', 'Showing Number', 'Confirmation Number', 'Reference'),
    feedback,
  };
}
