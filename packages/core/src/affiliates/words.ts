/**
 * The affiliate program's words and links (20261027014000), said once for the web, the phone and the worker's emails.
 * Browser-safe: no runtime imports.
 */
import type {
  AffiliateCommissionKind,
  AffiliateReferralHow,
  AffiliateStatus,
} from '../schemas/affiliates';

/** The website an affiliate's link opens. The website keeps the code (`?ref=`) for {@link AFFILIATE_CLICK_DAYS} days. */
export const AFFILIATE_SITE = 'https://handsfreeos.com';
/** The link's own word: `handsfreeos.com/?ref=<code>`. */
export const AFFILIATE_REF_PARAM = 'ref';
/** How long a click counts before sign-up (decision 4). The database checks it too (private.affiliate_note_signup). */
export const AFFILIATE_CLICK_DAYS = 90;
/** How many months of a business's payments earn its affiliate their share (decision 2). */
export const AFFILIATE_MONTHS = 12;
/** How long a share waits, in case of a refund, before it's paid out (decision 8). */
export const AFFILIATE_WAIT_DAYS = 30;

/** An affiliate's link. */
export const affiliateLink = (code: string): string =>
  `${AFFILIATE_SITE}/?${AFFILIATE_REF_PARAM}=${encodeURIComponent(code)}`;

/** A share in basis points as people say it: 4000 → "40%", 3750 → "37.5%". */
export function affiliateRateWords(rateBp: number): string {
  const pct = rateBp / 100;
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(2))}%`;
}

/** A percent typed as people type it ("40", "37.5%") as basis points, or null when it isn't a share. */
export function affiliatePercentToBp(typed: string): number | null {
  const n = Number(typed.trim().replace(/%$/, ''));
  if (typed.trim() === '' || !Number.isFinite(n) || n <= 0 || n > 100) return null;
  return Math.round(n * 100);
}

/** Where an affiliate stands, as staff read it on Admin → Affiliates. */
export const AFFILIATE_STATUS_WORDS: Readonly<Record<AffiliateStatus, string>> = {
  applied: 'Waiting for a decision',
  approved: 'Active',
  turned_down: 'Turned down',
  paused: 'Paused',
  ended: 'Ended',
};

/** How a business came to be an affiliate's. */
export const AFFILIATE_HOW_WORDS: Readonly<Record<AffiliateReferralHow, string>> = {
  link: 'Their link',
  code: 'Their code',
  by_hand: 'Set by hand',
};

/** What the affiliate reads on their own page about where they stand. */
export const AFFILIATE_MINE_WORDS: Readonly<Record<AffiliateStatus, string>> = {
  applied:
    'Thanks for applying. We read every application and email you when we’ve decided, usually within a few days.',
  approved:
    'You’re in. Share your link: each business that signs up through it earns you your share of every plan payment in its first 12 months.',
  turned_down: 'We can’t take you on as an affiliate right now.',
  paused:
    'Your affiliate link is paused, so it doesn’t credit new businesses for now. Write to us if you’d like to know why.',
  ended: 'Your time as a HandsFreeOS affiliate has ended. Thank you for everyone you sent our way.',
};

/** What an affiliate has earned (20261027014200), on their own page and staff's. */
export const AFFILIATE_EARNINGS_WORDS = {
  earned: 'Earned',
  waiting: `Waiting ${AFFILIATE_WAIT_DAYS} days`,
  ready: 'Ready to pay',
  onItsWay: (amount: string) => `${amount} is on its way to the bank.`,
  paid: 'Paid',
  help: `Each share waits ${AFFILIATE_WAIT_DAYS} days in case of a refund, then it’s ready for the next monthly payout. A refund takes back the same share of what went back, from the next payout if it was already paid.`,
} as const;

/** One share earned, taken back or given back, as staff read it. */
export const AFFILIATE_COMMISSION_WORDS: Readonly<
  Record<AffiliateCommissionKind, (business: string, base: string, rate: string) => string>
> = {
  earned: (business, base, rate) => `${rate} of ${base} from ${business}`,
  taken_back: (business, base, rate) => `${rate} of a ${base} refund to ${business}, taken back`,
  given_back: (business, base, rate) =>
    `${rate} of a ${base} refund to ${business}, given back: the refund failed`,
};

/** A business that closed its account for good, where its name was. */
export const AFFILIATE_CLOSED_BUSINESS = 'A business that closed its account';

/** Admin → Affiliates and a business's Affiliate block under Admin → Businesses. */
export const AFFILIATE_ADMIN_WORDS = {
  title: 'Affiliates',
  intro: `People who sell HandsFreeOS with their own link. Each business that signs up through it within ${AFFILIATE_CLICK_DAYS} days of the click earns them their share of every plan payment in its first ${AFFILIATE_MONTHS} months.`,
  everyone: 'Share for everyone',
  everyoneHelp:
    'What each affiliate earns of every plan payment, unless you give them their own. A change counts for payments from now on.',
  percent: 'Percent',
  percentProblem: 'Type a percent between 0.01 and 100, like 40.',
  save: 'Save',
  saved: 'Saved',
  waiting: 'Applications',
  noneWaiting: 'No applications waiting.',
  approve: 'Approve',
  turnDown: 'Turn down',
  turnDownTitle: (name: string) => `Turn down ${name}?`,
  turnDownBody:
    'They get a short email saying we can’t take them on right now, and may apply again in 30 days.',
  affiliates: 'Affiliates',
  noneYet: 'Nobody yet. Approved applications show here.',
  applied: (when: string) => `Applied ${when}`,
  decided: (when: string, by: string | null) => `Decided ${when}${by ? ` by ${by}` : ''}`,
  wantsCode: (code: string) => `Wants the link code “${code}”`,
  share: 'Share',
  ownShare: 'Their own share',
  everyones: (rate: string) => `Everyone’s (${rate})`,
  useEveryones: 'Use everyone’s',
  setOwn: 'Give them their own',
  clicks30: 'Clicks, 30 days',
  clicks: (last30: number, all: number) =>
    `${last30} ${last30 === 1 ? 'click' : 'clicks'} in the last 30 days, ${all} in all`,
  businesses: 'Businesses',
  businessCount: (n: number) => `${n} ${n === 1 ? 'business' : 'businesses'}`,
  status: 'Status',
  link: 'Their link',
  pitch: 'How they’ll share it',
  links: 'Their pages',
  pause: 'Pause',
  pauseTitle: (name: string) => `Pause ${name}?`,
  pauseBody:
    'Their link stops crediting new businesses until you bring them back. The businesses they already sent stay theirs.',
  resume: 'Bring back',
  end: 'End the partnership',
  endTitle: (name: string) => `End ${name}’s partnership?`,
  endBody:
    'Their link stops crediting new businesses, for good, and they can’t be brought back. What they already earned stays theirs.',
  cancel: 'Cancel',
  code: 'Link code',
  changeCode: 'Change the link code',
  codeHelp: 'Their old link stops working at once, so tell them first.',
  theirBusinesses: 'Businesses they sent',
  noBusinesses: 'No businesses yet.',
  credited: (how: string, when: string) => `${how}, ${when}`,
  markedBy: (name: string) => `set by ${name}`,
  clicksByDay: 'Clicks by day',
  noClicks: 'No clicks yet.',
  earned: 'Earned',
  earnings: 'What they’ve earned',
  businessEarned: (amount: string) => `${amount} earned`,
  shares: 'Each share',
  noShares: 'Nothing earned yet. A share shows here when a business they sent pays for its plan.',
  payable: (when: string) => `free to pay ${when}`,
  allAffiliates: 'All affiliates',
  /** A business's page under Admin → Businesses. */
  block: {
    title: 'Affiliate',
    explain:
      'Who sold this business HandsFreeOS. They earn their share of its plan payments in its first 12 months.',
    none: 'Not credited to any affiliate.',
    creditedTo: (name: string, code: string) => `Credited to ${name} (${code})`,
    change: 'Change',
    pick: 'Credit it to',
    nobody: 'Nobody',
    save: 'Save',
    noChoices: 'There are no approved affiliates to credit it to.',
  },
} as const;

/** The person's own affiliate page in the web app. */
export const AFFILIATE_PAGE_WORDS = {
  title: 'Sell HandsFreeOS',
  intro: (rate: string) =>
    `Earn ${rate} of every plan payment from each business you send, for its first ${AFFILIATE_MONTHS} months. Share your link: when somebody signs up through it within ${AFFILIATE_CLICK_DAYS} days of clicking, their business is yours.`,
  apply: 'Apply',
  saveChanges: 'Save changes',
  name: 'Your name',
  code: 'Your link code',
  codeHelp: (link: string) => `Your link will be ${link}`,
  codeShape: 'Letters, digits and dashes, like your name',
  pitch: 'How will you share HandsFreeOS?',
  pitchPlaceholder: 'My newsletter for plumbers, my YouTube channel, the businesses I coach…',
  links: 'Your website or social pages',
  linksPlaceholder: 'One a line',
  livesInUs: 'I live in the US',
  usOnly: 'For now we pay affiliates in the US only, straight to a US bank account.',
  yourApplication: 'Your application',
  yourLink: 'Your link',
  yourShare: 'Your share',
  yourShareLine: (rate: string) =>
    `${rate} of every plan payment, for each business’s first ${AFFILIATE_MONTHS} months`,
  clicks: 'Clicks',
  clicksLine: (last30: number, all: number) =>
    `${last30} in the last 30 days, ${all} in all. A click counts once a browser, for each link.`,
  signUps: 'Sign-ups',
  signUpsLine: (n: number, paying: number) =>
    `${n} ${n === 1 ? 'business' : 'businesses'} signed up through you${n ? `, ${paying} paying` : ''}.`,
  earnings: 'What you’ve earned',
  payingBusinesses: 'Businesses that pay',
  noPaying:
    'None yet. When a business you sent pays for its plan, it shows here with what it earned you.',
  payingLine: (earned: string, since: string | null) =>
    since ? `${earned} earned, paying since ${since}` : `${earned} earned`,
  copyLink: 'Copy your link',
  copied: 'Copied your link',
  sent: 'Thanks, your application is in',
  saved: 'Saved your application',
  applyAgainFrom: (date: string) => `You can apply again from ${date}.`,
  backToApp: 'Back to HandsFreeOS',
} as const;
