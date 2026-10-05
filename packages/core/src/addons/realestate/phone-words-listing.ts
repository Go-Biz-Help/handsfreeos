/**
 * Real Estate's words on the phone for the listing (round six, boards 87–89): its facts and what the MLS said, its
 * photos, the description, the price, marketing, open houses, the seller's net, showings and a duty's vendor. What the
 * web already says comes from core's own words (`listing.ts`, `feed.ts`, `homes.ts`, `showings.ts`, `net.ts`,
 * `vendors.ts`), so both apps say the same; these are the phone's own. Fair housing checks stay on the server, so the
 * phone says they check with signal (boards 87 and 88). Browser-safe.
 */
import type { ListingFactKey } from './homes';

/** "4 bedrooms", "2,140 sq ft": a fact as a sentence says it. */
export function factPhrase(key: ListingFactKey, words: string): string {
  switch (key) {
    case 'beds':
      return `${words} ${words === '1' ? 'bedroom' : 'bedrooms'}`;
    case 'baths':
      return `${words} ${words === '1' ? 'bathroom' : 'bathrooms'}`;
    case 'sqft':
      return `${words} sq ft`;
    case 'lot_sqft':
      return `a ${words} sq ft lot`;
    case 'year_built':
      return `built in ${words}`;
    case 'hoa_monthly_cents':
      return `an HOA of ${words} a month`;
    case 'garage_spaces':
      return `${words} garage ${words === '1' ? 'space' : 'spaces'}`;
    case 'property_type':
      return `a ${words.toLowerCase()}`;
    default:
      return words;
  }
}

/** A listing's page opened on a buyer deal. */
export const RE_LISTING_ONLY = (deal: string) =>
  `${deal} is a buyer deal, so it has no listing. Open the listing’s own deal.`;

/** Board 87, first and last panels: the facts with where each came from, and what the MLS said. */
export const RE_FACTS_WORDS = {
  title: 'Facts',
  differs: (mls: string, kept: string) =>
    `The MLS says ${mls}; you have ${kept}. Fix it on the MLS or here.`,
  mlsSays: (words: string) => `the MLS says ${words}`,
  none: 'No facts yet. Add them here, or ask the seller in their portal from the web.',
  change: 'Change a fact',
  changeTitle: 'Change a fact',
  which: 'Which',
  value: 'What it is',
  save: 'Save',
  saveWhy: 'Changing a fact needs signal.',
  saved: 'Saved.',
  notANumber: (label: string) => `Enter ${label.toLowerCase()} as a number.`,
  /** What the MLS said, kept as it said it. */
  mlsTitle: 'MLS status',
  mlsSaid: 'What the MLS has said',
  matches: 'Matches',
  differsBadge: 'Differs',
  checked: (time: string) => `checked ${time}`,
  status: (words: string) => `Status: ${words}`,
  price: (words: string) => `Price: ${words}`,
  fact: (label: string, words: string) => `${label}: ${words}`,
  priceMatches: 'matches',
  youHave: (words: string) => `you have ${words}`,
  notLooked: 'Not looked up on the MLS yet.',
  checkAgain: 'Check again',
  checkWhy: 'Asking the MLS again needs signal.',
  asked: 'Asked. What the MLS says arrives in a minute or two.',
} as const;

/** Board 87, second panel: the listing's photos, in order. */
export const RE_PHOTOS_WORDS = {
  title: 'Photos',
  count: (n: number) => (n === 1 ? '1 photo' : `${n} photos`),
  cover: 'Cover',
  none: 'No photos yet. Take them on the spot; they upload when there’s signal.',
  take: 'Take photos',
  takeMore: 'Take another',
  library: 'Choose from your photos',
  note: 'Photos taken with no signal upload when it comes back. Order and cover save the same way.',
  /** One photo's sheet. */
  photo: (n: number) => `Photo ${n}`,
  makeCover: 'Make it the cover',
  earlier: 'Move earlier',
  later: 'Move later',
  hidden: 'Not on the listing’s page',
  waitingOne: 'Waiting to upload. You can order it once it has.',
  added: 'Added. It uploads when there’s signal.',
} as const;

/** Board 87, third panel: the description's live words and every version. */
export const RE_DESCRIPTION_WORDS = {
  title: 'Description',
  live: (version: number) => `Live · version ${version}`,
  working: (version: number) => `Version ${version} · being worked on`,
  fairHousing: 'Fair housing: checks with signal',
  none: 'No description yet. Write one with signal: the AI drafts it from the facts, and fair housing checks it.',
  versions: 'Versions',
  version: (version: number, live: boolean) => `Version ${version}${live ? ' · live' : ''}`,
  okd: (seller: string) => `${seller} OK’d it in the portal`,
  letThrough: 'Let through without the seller',
  ai: 'AI draft',
  person: 'Written by hand',
  drafting: 'Being written…',
  noWords: 'No words yet.',
  write: 'Write a new version',
  writeWhy: 'Writing a version needs signal (the AI and the fair-housing check).',
  asked: 'Asked. The new version arrives in a minute or two.',
} as const;

/** Board 88, first panel: the price, its history, and a change waiting on the seller. */
export const RE_PRICE_WORDS = {
  title: 'Price',
  asking: 'Asking',
  since: (day: string, days: number, showings: number) =>
    `Since ${day} · ${days === 1 ? '1 day' : `${days} days`} · ${showings === 1 ? '1 showing' : `${showings} showings`}`,
  noPrice:
    'No list price yet. Enter it under Key dates; a change after that goes to the seller to sign off.',
  asked: (seller: string) => `A change ${seller} is asked about`,
  lower: (price: string) => `Lower to ${price}`,
  raise: (price: string) => `Raise to ${price}`,
  waitingOn: (seller: string) => `Waiting on ${seller}`,
  askedIn: (day: string, seller: string) => `Asked ${day} in ${seller}’s portal`,
  history: 'History',
  listed: (day: string) => `Listed ${day}`,
  changed: (day: string, how: string | null) => `Changed ${day}${how ? ` · ${how}` : ''}`,
  signedBy: (name: string) => `${name} signed it`,
  letThrough: 'let through without the seller',
  withdrawn: (day: string) => `Withdrawn · asked ${day}`,
  waitingRow: (day: string) => `Asked ${day} · waiting`,
  change: 'Change the price',
  changeTitle: 'Change the price',
  newPrice: 'New price',
  why: 'Why (the seller sees it)',
  whyHint: 'With the showing feedback',
  ask: (seller: string) => `Ask ${seller}`,
  sent: (seller: string) => `Asked. It’s in ${seller}’s portal to sign off.`,
  note: 'Asking the seller reaches the seller’s portal; with no signal it waits and asks again after 30 minutes.',
  enterPrice: 'Enter the new price, like 479,000.',
  same: 'That’s the price already. Enter a different one.',
} as const;

/** Board 88, second panel: what's out and what's ready. */
export const RE_MARKETING_WORDS = {
  title: 'Marketing',
  live: 'Live on the MLS',
  liveLine: (day: string, number: string) => `${day} · #${number}`,
  notLive: 'Not live on the MLS yet',
  markLive: 'Mark it live on the MLS',
  markTitle: 'Live on the MLS',
  markAbout:
    'Once it’s live, the listing’s page, the flyer, posts and open house sign-ins can go out.',
  mlsNumber: 'MLS number',
  mlsHint: '4821937',
  liveOn: 'Live since',
  today: 'Today',
  yesterday: 'Yesterday',
  markWhy: 'Marking it live needs signal.',
  mark: 'Mark it live',
  marked: 'Marked live on the MLS.',
  flyer: 'Flyer',
  flyerReady: 'Ready · QR to the listing page',
  flyerReadyNoPage: 'Ready',
  page: 'Listing page',
  pageStates: {
    none: 'Not made yet',
    draft: 'Ready to publish',
    published: 'Published',
    taken_down: 'Taken down',
  } as Readonly<Record<string, string>>,
  post: (n: number) => `Post ${n}`,
  postLine: 'Ready · fair housing checks with signal',
  postsDrafting: 'Posts being written…',
  posts: 'Social posts',
  noPosts: 'None written yet',
  write: 'Write posts',
  note: 'Writing a post needs signal; the list reads anywhere.',
  writeWhy: 'Writing a post needs signal (the AI and the fair-housing check).',
  asked: 'Asked. The posts arrive in a minute or two.',
} as const;

/** Board 88, third panel: hosting an open house, and those signed in. */
export const RE_OPEN_HOUSE_WORDS = {
  title: 'Open house',
  titleMany: 'Open houses',
  card: (when: string) => `Open house · ${when}`,
  hosting: (name: string, n: number) => `${name.split(/\s+/)[0]} hosting · ${n} signed in`,
  noHost: (n: number) => `${n} signed in`,
  handTo: 'Hand the phone to a visitor',
  signedIn: 'Signed in',
  hasAgent: (sms: boolean) => `Has an agent: no${sms ? ' · texts OK' : ''}`,
  agent: (name: string | null) => (name ? `Agent: ${name}` : 'Has an agent'),
  noVisitors: 'Nobody has signed in yet.',
  others: 'Others',
  states: { planned: 'Planned', cancelled: 'Cancelled', done: 'Done' } as Readonly<
    Record<string, string>
  >,
  none: 'No open houses planned.',
  checkIn: 'Check in',
  about: (street: string) => `Open house at ${street}`,
  /** Planning one (`?plan=1`). */
  plan: 'Plan an open house',
  planTitle: 'Plan an open house',
  day: 'Day',
  starts: 'Starts',
  length: 'How long',
  hours: (n: number) => (n === 1 ? '1 hour' : `${n} hours`),
  planIt: 'Plan it',
  planWhy: 'Planning an open house needs signal: it goes on the calendar.',
  planned: 'Planned. It’s on the calendar.',
} as const;

/**
 * The sign-in sheet on the phone, handed to a visitor (board 88): the public page's own words, so a visitor reads
 * the same on the agent's phone as on the sign-in page. It works with no signal; each sign-in waits on the phone.
 */
export const RE_VISITOR_WORDS = {
  welcome: (street: string) => `Welcome to ${street}`,
  when: (when: string, host: string | null) =>
    `Open house · ${when}${host ? ` · with ${host}` : ''}`,
  first: 'First name',
  last: 'Last name',
  email: 'Email',
  phone: 'Phone',
  withAgent: 'Are you working with an agent?',
  yes: 'Yes',
  no: 'No',
  agentName: 'Their name and brokerage (optional)',
  signIn: 'Sign in',
  needs: 'Enter your first name, and an email or a phone number.',
  /** As the sign-in page refuses one, said before the visitor walks off: the phone may have no signal. */
  badEmail: 'That doesn’t look like an email address.',
  thanks: (first: string) => `Thanks, ${first}!`,
  enjoy: 'You’re signed in. Enjoy the home.',
  next: 'Next visitor',
  handBack: 'Done, hand it back',
  equal: (business: string) => `${business} · Equal Housing Opportunity`,
} as const;

/** Board 88, last panel: what the seller walks away with, offer by offer. */
export const RE_NET_WORDS = {
  title: 'Net sheet',
  offer: (buyers: string, price: string) => `${buyers} offer · ${price}`,
  atList: (price: string) => `At the list price · ${price}`,
  nets: (seller: string | null) => (seller ? `${seller} nets` : 'The seller nets'),
  noOffer: 'No offers and no list price yet, so there’s nothing to work out.',
  estimate: 'An estimate, not a settlement statement.',
  note: 'Worked out on the phone with the same figures as the web; a new estimate saves with no signal.',
  change: 'Change the figures',
  changeTitle: 'The figures',
  payoff: 'Mortgage payoff',
  fee: 'Listing fee',
  feePct: '%',
  feeAmount: '$',
  title_: 'Title and escrow',
  tax: 'Transfer tax (%)',
  taxName: 'Transfer tax',
  other: 'Other costs',
  otherNote: 'What the other costs are',
  save: 'Save',
  saved: 'Saved. The estimates use these figures now.',
  bad: (what: string) => `Enter ${what.toLowerCase()} as an amount, like 3,850.`,
  badPct: (what: string) => `Enter ${what.toLowerCase()} as a percent, like 3 or 2.5.`,
} as const;

/** Board 89, first two panels: requests to answer, what's coming up and what buyers said. */
export const RE_SHOWING_WORDS = {
  title: 'Showings',
  asked: 'Asked, waiting',
  coming: 'Coming up',
  said: 'What buyers said',
  liked: (words: string) => `Liked: ${words}`,
  didnt: (words: string, interest: string) => `Didn’t: ${words} · ${interest}`,
  none: 'No showings yet. Buyers’ agents ask from the listing’s page, or ShowingTime’s emails bring them in.',
  yes: 'Yes',
  another: 'Another time',
  no: 'No',
  answerNote: 'Answering waits on the phone and asks again after 30 minutes.',
  today: (time: string) => `Today ${time}`,
  /** One request. */
  requestTitle: 'Showing request',
  buyers: 'Buyers',
  getIn: 'How they get in',
  getInWords: (hours: number) =>
    `Lockbox code, sent ${hours === 1 ? '1 hour' : `${hours} hours`} before`,
  feedback: 'Feedback',
  feedbackWords: (hours: number) => `Asked ${hours === 1 ? '1 hour' : `${hours} hours`} after`,
  never: 'The lockbox code is never shown until it’s sent.',
  confirm: 'Yes, confirm it',
  offerAnother: 'Offer another time',
  anotherTitle: 'Offer another time',
  anotherHint: 'Thursday after 6 works for Maria',
  anotherWhat: 'What to offer',
  sendIt: 'Send',
  confirmed: 'Confirmed. The agent hears once it sends, with the access instructions before it.',
  declined: 'Declined. The agent hears once it sends.',
  offered: 'Sent. The agent hears once it sends.',
  checkIn: 'Check in',
  about: (street: string) => `Showing at ${street}`,
  /** Adding one by hand. */
  add: 'Add a showing',
  addTitle: 'Add a showing',
  agentName: 'Their agent',
  brokerage: 'Brokerage',
  phone: 'Phone',
  when: 'When',
  at: 'At',
  addIt: 'Add',
  added: 'Added.',
  sayWho: 'Say whose showing it is.',
} as const;

/** Board 89, last panel: picking a vendor on a duty. */
export const RE_DUTY_VENDOR_WORDS = {
  title: 'Pick a vendor',
  on: (duty: string, deal: string) => `On “${duty}” · ${deal}`,
  approved: 'Approved',
  lastUsed: (day: string) => `last used ${day}`,
  notHere: 'not listed for this area',
  quote: 'Quote',
  quoteHint: '$475',
  appointment: 'Appointment',
  notBooked: 'Not booked yet. Book it on the calendar, on the deal.',
  use: (name: string) => `Use ${name}`,
  picked: (name: string) => `${name} picked.`,
  pickedBadge: 'Picked',
  none: (service: string | null) =>
    `No approved vendor does ${service ? service.toLowerCase() : 'this'} yet. Add one in Vendors; an owner or admin approves them.`,
  noService: 'This duty doesn’t need a vendor.',
  everyOne: 'Give the client every vendor that fits, not only one, and say any disclosure.',
  pickWhy: 'Picking a vendor needs signal.',
  badQuote: 'Enter the quote as an amount, like 475.',
  notOnPhone: 'This duty isn’t on this phone. Its deal may have ended, or you may not be on it.',
} as const;
