/**
 * The founding offers on the support desk (0091), said and decided once for the web's /admin/founding and the phone's:
 * the offers and their caps, the applications waiting on a decision, and who holds a seat.
 *
 * **The cap is enforced by the database, not here.** Nothing in this file decides whether an approval will work:
 * "seats left" is shown rather than used to disable anything, and the refusal comes back from Postgres as a sentence.
 * The offers open one after another by themselves (0092); these words only report it.
 *
 * **A free seat is on the moment staff say so,** by approving an application or by giving one to any business, and
 * it stays on until somebody revokes it. Only a paid seat is held behind a link, because it waits on a payment.
 *
 * **The $497 seat is paid by the year** (20261027009500): renewed on its own, charged to the card it was paid with.
 * A refused card is not tried again; the business pays that year with another card, and the seat stays on until
 * staff decide. A seat staff give is a gift and is never charged.
 *
 * **First come, first served** (20261027012700): a business that signs up picks a spot and pays for it before it sets
 * up, $497 a year or $97 a month, renewed on its own. The plan page's words, and the phone's "finish on the web", are
 * `FOUNDING_PICK_WORDS`.
 */

import { formatUtcDate } from '../crm/format';

export type FoundingOfferStatus = 'draft' | 'open' | 'closed';

/** What the words need of an offer (`platform.founding`'s `offers`). */
export interface FoundingOfferFacts {
  readonly offerId: string;
  readonly name: string;
  readonly status: FoundingOfferStatus;
  readonly seatCap: number;
  readonly claimed: number;
  readonly remaining: number;
  readonly priceCents: number;
  readonly billing: 'once' | 'yearly' | 'monthly';
  readonly opensAfterOfferId: string | null;
  readonly opensAfterCount: number | null;
  readonly openedAt: string | null;
}

/** What the words need of an application. */
export interface FoundingApplicationFacts {
  readonly status: string;
  readonly contactName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly industry: string | null;
  readonly createdAt: string;
}

/** What the words need of a seat (a grant). */
export interface FoundingSeatFacts {
  readonly status: 'reserved' | 'active' | 'revoked' | 'expired';
  readonly offerId: string;
  readonly reservedAt: string;
  readonly expiresAt: string | null;
  readonly activatedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokeReason: string;
  readonly graceEndsAt: string | null;
  readonly checkoutStatus: string | null;
  readonly checkoutProblem: string;
  /** A seat paid by the year: the end of the year paid for. */
  readonly paidThrough?: string | null;
  /** False once the business stopped it renewing. */
  readonly renewing?: boolean;
  /** The last renewal the card refused, until it is paid with another card. */
  readonly renewalProblem?: string | null;
}

/** "Oct 3", in the reader's own zone; a dash for a date that isn't there. */
export const foundingDay = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';

/** "Oct 19, 2027": a year away needs its year. In UTC, the way the renewal is charged. */
export const foundingLongDay = (iso: string | null): string =>
  iso ? formatUtcDate(new Date(iso)) : '—';

/** "Free", "$497". */
export const foundingPrice = (cents: number): string =>
  cents === 0 ? 'Free' : `$${(cents / 100).toFixed(0)}`;

/** "/month", "/year", or nothing for a seat paid once. */
export const foundingPer = (billing: FoundingOfferFacts['billing']): string =>
  billing === 'monthly' ? '/month' : billing === 'yearly' ? '/year' : '';

/** "$497 a year", "$97 a month", "$497 once", "Free": a price in words, for a sentence. */
export const foundingPriceWords = (
  cents: number,
  billing: FoundingOfferFacts['billing'],
): string =>
  cents === 0
    ? 'Free'
    : `${foundingPrice(cents)} ${billing === 'monthly' ? 'a month' : billing === 'yearly' ? 'a year' : 'once'}`;

export const FOUNDING_WORDS = {
  title: 'Founding offers',

  // An offer's card.
  /** After the number left: "3 of 25 left". */
  ofLeft: (seatCap: number) => ` of ${seatCap} left`,
  opened: (iso: string) => `Opened ${foundingDay(iso)}.`,
  replaced: (name: string) =>
    `Off the website since ${name} opened. A seat that frees up here is for somebody already waiting — approve them below.`,
  paidNote:
    'Bought at Stripe Checkout, from the plan page a new business sees after signing up (or an old claim link). The seat turns on when Stripe says the money is in.',
  renewsNote: (billing: 'yearly' | 'monthly') =>
    `Renews each ${billing === 'monthly' ? 'month' : 'year'} on its own, charged to the card they paid with. They can stop it renewing. A seat you give is never charged.`,
  seats: 'Seats',
  save: 'Save',
  capHint: (claimed: number) =>
    `Raising this opens seats at once. It cannot go below the ${claimed} already out.`,

  // The queue and the seats.
  waiting: 'Waiting on you',
  noneWaiting: 'Nothing to read. Applications land here.',
  waitlistedTag: ' · waitlisted',
  approve: 'Approve',
  decline: 'Decline',
  seatsOut: 'Seats out',
  noSeatsOut: 'Nobody holds a seat yet.',
  revoke: 'Revoke',
  givenBack: 'Seats given back',
  undo: 'Undo',
  /** On a seat that's held but not on, or that lapsed: put it on their workspace now, for good. */
  turnOn: 'Turn it on',

  // Giving a seat to any business, applied or not.
  give: 'Give a seat',
  giveTitle: 'Give a founding seat',
  giveDescription:
    'Pick any business. Its workspace goes on the founding plan straight away, with the starting credit, and keeps it until you revoke it. No application or link needed.',
  offer: 'Offer',
  noOfferOpen: 'No founding offer is open. Open one above first.',
  giving: 'Turning it on…',
  giveSeat: 'Give the seat',

  // The claim link, shown once.
  issuedTitle: (business: string) => `Send ${business} their link`,
  issuedDescription:
    'This is the only time it is shown. Copy it into an email to them now — once this closes, it cannot be seen again, and a new one means approving again.',
  copyLink: 'Copy the claim link',
  copiedLink: 'Copied the claim link',
  linkWorks: (until: string) =>
    `It works once, for an owner or admin of their business, until ${foundingDay(until)}.`,
  sentIt: 'I’ve sent it',

  // Approving.
  approveTitle: (business: string) => `Approve ${business}`,
  /** A free seat: on at once. */
  approveFreeDescription:
    'Their workspace goes on the founding plan straight away, with the starting credit. It stays theirs until you revoke it.',
  /** A paid seat: held until they pay. */
  approveDescription:
    'This takes a seat straight away and holds it for them. You get a claim link back — it is shown once and never again, so send it before you close this.',
  theirBusiness: 'Their business',
  theirsHint: (email: string) => `The businesses ${email} runs here.`,
  noneTheirsHint: (email: string) =>
    `Nobody who signed up with ${email} runs a business here yet. Ask them to sign up with that email, or search for their business.`,
  pickOne: 'Pick one',
  another: 'Search for another business…',
  searchBusinesses: 'Search businesses',
  searchPlaceholder: 'Type a business or workspace name',
  noBusiness: 'No business has that name.',
  business: 'Business',
  notTheirsHint: (email: string) =>
    `Nobody there signed up with ${email}, so make sure it’s theirs.`,
  whyThem: 'Why them',
  whyThemHint: 'Only we ever see this.',
  cancel: 'Cancel',
  approving: 'Taking a seat…',
  approveAndHold: 'Approve and hold a seat',
  approveAndTurnOn: 'Approve and turn it on',

  // Revoking.
  revokeTitle: (business: string | null) =>
    `Take the seat back from ${business ?? 'this business'}`,
  revokeDescription:
    'The seat frees up immediately and you can approve somebody else today. They keep working normally through their notice period, and are told when it ends.',
  why: 'Why',
  whyHint: 'Kept forever. Write it for whoever has to explain this later.',
  revoking: 'Revoking…',
  revokeSeat: 'Revoke the seat',
} as const;

/** The offers a seat can be given from: the ones that have opened. The monthly spots are seats too (20261027012700). */
export const foundingGivableOffers = <O extends Pick<FoundingOfferFacts, 'billing' | 'status'>>(
  offers: readonly O[],
): O[] => offers.filter((o) => o.status !== 'draft');

/** Which offer Give starts on: the first one taking people, else the first there is. */
export const foundingFirstOffer = (
  offers: readonly Pick<FoundingOfferFacts, 'offerId' | 'status'>[],
): string => (offers.find((o) => o.status === 'open') ?? offers[0])?.offerId ?? '';

/**
 * Whether a seat in this offer is paid for: approving holds it behind a payment rather than turning it on, and its
 * row has no one-press Turn it on, since that would give a $497 seat away. Give a seat still can, on purpose.
 */
export const foundingOfferIsPaid = (
  offerId: string,
  offers: readonly Pick<FoundingOfferFacts, 'offerId' | 'priceCents'>[],
): boolean => (offers.find((o) => o.offerId === offerId)?.priceCents ?? 0) > 0;

/** "Free · open", "$497/year · draft", "$97/month · draft": an offer's price and where it stands. */
export const foundingOfferPriceLine = (
  offer: Pick<FoundingOfferFacts, 'priceCents' | 'billing' | 'status'>,
): string => `${foundingPrice(offer.priceCents)}${foundingPer(offer.billing)} · ${offer.status}`;

/** What an offer's card says about it, beyond its name and price. */
export function foundingOfferCard(
  offer: FoundingOfferFacts,
  offers: readonly FoundingOfferFacts[],
): {
  /** How full it is, 0 to 100. */
  readonly pct: number;
  /** "Opens by itself when …": a draft that another offer opens. */
  readonly opens: string | null;
  /** "Opened Oct 3.", when it isn't waiting to open by itself. */
  readonly opened: string | null;
  /** A later founding offer is open, so this one is off the website. */
  readonly replaced: string | null;
  /** A paid seat is bought at Stripe Checkout. */
  readonly paid: boolean;
  /** A seat paid by the month or the year renews on its own: what to say about it, or null. */
  readonly renews: string | null;
  /** The one button that moves it: Close, or Open (Open now for one that would open by itself). */
  readonly action: { readonly status: 'open' | 'closed'; readonly label: string };
} {
  const after = offers.find((o) => o.offerId === offer.opensAfterOfferId);
  // The same rule as the view's `superseded`: a later founding offer is open, so this one is off the website.
  const replacedBy = offers.find(
    (o) => o.opensAfterOfferId === offer.offerId && o.billing !== 'monthly' && o.status !== 'draft',
  );
  const line = after ? (offer.opensAfterCount ?? after.seatCap) : null;
  return {
    pct: offer.seatCap > 0 ? Math.min(100, (offer.claimed / offer.seatCap) * 100) : 0,
    opens:
      offer.status === 'draft' && after && line !== null
        ? `Opens by itself when ${after.name} ${
            offer.opensAfterCount === null ? 'is full' : `has ${line} seats out`
          } — ${Math.min(after.claimed, line)} of ${line} now.`
        : null,
    opened:
      offer.status === 'draft' && after && line !== null
        ? null
        : offer.openedAt
          ? FOUNDING_WORDS.opened(offer.openedAt)
          : null,
    replaced: replacedBy ? FOUNDING_WORDS.replaced(replacedBy.name) : null,
    paid: offer.priceCents > 0,
    renews:
      offer.priceCents > 0 && (offer.billing === 'yearly' || offer.billing === 'monthly')
        ? FOUNDING_WORDS.renewsNote(offer.billing)
        : null,
    action:
      offer.status === 'open'
        ? { status: 'closed', label: 'Close' }
        : { status: 'open', label: offer.status === 'draft' && after ? 'Open now' : 'Open' },
  };
}

/** The applications waiting on a decision, the seats out, and the seats given back. */
export function foundingQueueParts<
  A extends { readonly status: string },
  G extends { readonly status: string },
>(queue: {
  readonly applications: readonly A[];
  readonly grants: readonly G[];
}): { readonly pending: A[]; readonly held: G[]; readonly gone: G[] } {
  return {
    pending: queue.applications.filter((a) => a.status === 'pending' || a.status === 'waitlisted'),
    held: queue.grants.filter((g) => g.status === 'reserved' || g.status === 'active'),
    gone: queue.grants.filter((g) => g.status === 'revoked' || g.status === 'expired'),
  };
}

/** "Dale Ramsey · dale@… · 512… · HVAC · Oct 3": who applied, and when. */
export const foundingApplicationLine = (a: FoundingApplicationFacts): string =>
  `${a.contactName} · ${a.email}${a.phone ? ` · ${a.phone}` : ''}${
    a.industry ? ` · ${a.industry}` : ''
  } · ${foundingDay(a.createdAt)}`;

/** A seat that's out: approved and waiting to be taken up (and maybe being paid for), or in use. */
export const foundingSeatLine = (g: FoundingSeatFacts): string =>
  `${g.offerId} · ${
    g.status === 'reserved'
      ? `approved ${foundingDay(g.reservedAt)}, not taken up — expires ${foundingDay(g.expiresAt)}`
      : `using it since ${foundingDay(g.activatedAt)}`
  }${
    g.status === 'reserved' && (g.checkoutStatus === 'pending' || g.checkoutStatus === 'open')
      ? ' · paying now'
      : ''
  }${foundingYearLine(g)}`;

/** " · paid through Oct 19, 2027, renews": a seat paid by the year, and whether it goes on. Empty otherwise. */
export const foundingYearLine = (g: Pick<FoundingSeatFacts, 'paidThrough' | 'renewing'>): string =>
  g.paidThrough
    ? ` · paid through ${foundingLongDay(g.paidThrough)}${g.renewing ? ', renews' : ', not renewing'}`
    : '';

/** A seat given back: never taken up, or taken back, and how long they keep working. */
export const foundingGivenBackLine = (g: FoundingSeatFacts): string =>
  `${
    g.status === 'expired'
      ? `never taken up · expired ${foundingDay(g.expiresAt)}`
      : `revoked ${foundingDay(g.revokedAt)} · ${g.revokeReason}`
  }${g.graceEndsAt ? ` · still working until ${foundingDay(g.graceEndsAt)}` : ''}`;

/**
 * What needs a person on a seat, or null: money in with no seat on (refund it at Stripe or find them a seat), or a
 * renewal the card refused (they pay it with another card; the seat stays on until you decide).
 */
export const foundingSeatProblem = (g: FoundingSeatFacts): string | null =>
  g.checkoutStatus === 'paid' && g.checkoutProblem
    ? g.checkoutProblem
    : g.renewalProblem && (g.status === 'active' || g.status === 'reserved')
      ? `The renewal was refused: ${g.renewalProblem} They can pay it with another card from Settings → Usage & balance. The seat stays on until you revoke it.`
      : null;

/** Where a seat can go: a workspace, standing for the business it belongs to. A seat is the business's. */
export interface FoundingPickable {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly label: string;
}

/** "Search for another business…" among the choices: for somebody who signed up with a different email. */
export const FOUNDING_ANOTHER = 'another';

/** "Lone Star HVAC · in Lone Star Group", or just the workspace's name when the business has the same one. */
export const foundingBusinessLabel = (workspace: string, business: string): string =>
  business && business !== workspace ? `${workspace} · in ${business}` : workspace;

/** The businesses run, as owner or admin, by whoever signed up with the email they applied with. */
export const foundingTheirBusinesses = (application: {
  readonly theirBusinesses: readonly {
    readonly workspaceId: string;
    readonly workspaceName: string;
    readonly organizationId: string;
    readonly organizationName: string;
    readonly role: string;
  }[];
}): FoundingPickable[] =>
  application.theirBusinesses.map((b) => ({
    workspaceId: b.workspaceId,
    organizationId: b.organizationId,
    label: `${foundingBusinessLabel(b.workspaceName, b.organizationName)} · ${b.role}`,
  }));

/** What Approve starts on: the one business they run when there's one, nothing picked for several, else a search. */
export const foundingFirstChoice = (theirs: readonly FoundingPickable[]): string =>
  theirs.length === 1 ? (theirs[0]?.workspaceId ?? '') : theirs.length ? '' : FOUNDING_ANOTHER;

/** Where a claim link opens, on the web. Its token is shown once and kept only as a hash. */
export const foundingClaimPath = (claimToken: string): string => `/founding/${claimToken}`;

// ---------- one business's seat, on its page under /admin/businesses ----------

/** What the block needs of the seat a business holds, or held last (`platform.founding.business`'s `seat`). */
export interface FoundingBusinessSeatFacts extends FoundingSeatFacts {
  readonly offerName: string;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
}

export const FOUNDING_BUSINESS_WORDS = {
  title: 'Founding seat',
  explain:
    'Any business here can be given a founding seat, whether or not it applied. It covers one workspace, and stays until you revoke it.',
  none: 'No founding seat.',
  give: 'Give a founding seat',
  giveTitle: (business: string) => `Give ${business} a founding seat`,
  giveDescription:
    'It goes on this workspace straight away, with the starting credit, and stays until you revoke it. A seat you give is never charged, even a yearly one.',
  offer: 'Offer',
  whyThem: FOUNDING_WORDS.whyThem,
  whyThemHint: FOUNDING_WORDS.whyThemHint,
  cancel: FOUNDING_WORDS.cancel,
  giving: FOUNDING_WORDS.giving,
  giveSeat: FOUNDING_WORDS.giveSeat,
  revoke: FOUNDING_WORDS.revoke,
  undo: FOUNDING_WORDS.undo,
  allSeats: 'All founding seats',
  /** No offer has opened, so there is nothing to give from yet. */
  noneOpen: 'No founding offer is open yet. Open one under Founding offers first.',
} as const;

/** The offers a seat can be given from today, with why the others can't. */
export function foundingBusinessGivable<O extends FoundingOfferFacts>(
  offers: readonly O[],
): { readonly offers: O[]; readonly first: string } {
  const open = foundingGivableOffers(offers).filter((o) => o.status === 'open');
  return { offers: open, first: open[0]?.offerId ?? '' };
}

/**
 * The block's one line about the seat: "Founding Partner · on Lone Star HVAC since Oct 3", "on Bayou Plumbing, this
 * business's other workspace", "revoked Oct 3 · …". Null when the business never had one.
 */
export function foundingBusinessSeatLine(
  seat: FoundingBusinessSeatFacts | null,
  workspaceId: string,
): string | null {
  if (!seat) return null;
  const where =
    seat.workspaceId && seat.workspaceId !== workspaceId
      ? ` · on ${seat.workspaceName ?? 'another workspace'}, this business’s other workspace`
      : '';
  const state =
    seat.status === 'active'
      ? `since ${foundingDay(seat.activatedAt)}${foundingYearLine(seat)}`
      : seat.status === 'reserved'
        ? `approved ${foundingDay(seat.reservedAt)}, not taken up — expires ${foundingDay(seat.expiresAt)}`
        : foundingGivenBackLine(seat);
  return `${seat.offerName} · ${state}${where}`;
}

/** Whether the business holds a seat now: then it can be revoked, not given another. */
export const foundingBusinessHolds = (seat: Pick<FoundingSeatFacts, 'status'> | null): boolean =>
  seat?.status === 'active' || seat?.status === 'reserved';

// ---------- the business's own plan, on Settings → Usage & balance ----------

/** What the card needs of `founding.mine`. */
export interface FoundingPlanFacts {
  readonly plan: string | null;
  readonly status: string | null;
  readonly priceCents: number;
  readonly paidThrough: string | null;
  readonly renewing: boolean;
  readonly renewalProblem: string | null;
}

/**
 * Only a spot that renews, paid by the month or the year, has anything to show or change here. A seat paid once, or
 * one staff gave, has no date and no price.
 */
export const foundingPlanRenews = (p: FoundingPlanFacts): boolean =>
  p.paidThrough !== null && p.priceCents > 0 && p.status !== 'canceled';

export const FOUNDING_PLAN_WORDS = {
  title: 'Your founding spot',
  /** "$497 a year for HandsFreeOS itself. Texts, calls and AI come out of your balance." The `monthly` plan is $97 a month. */
  price: (cents: number, plan: string | null) =>
    `${foundingPriceWords(cents, plan === 'monthly' ? 'monthly' : 'yearly')} for HandsFreeOS itself. Texts, calls and AI come out of your balance.`,
  renews: (iso: string, cents: number) =>
    `Paid through ${foundingLongDay(iso)}. It renews then for ${foundingPrice(cents)}, charged to the card you paid with.`,
  stopped: (iso: string) =>
    `Paid through ${foundingLongDay(iso)}, and set not to renew. Your spot goes back then, and nothing more is charged.`,
  refused: (problem: string) =>
    `Your renewal didn’t go through: ${problem} Pay it with another card to keep your founding price. Your spot stays on meanwhile.`,
  stop: 'Stop renewing',
  stopTitle: 'Stop your founding spot renewing?',
  stopDescription: (iso: string) =>
    `It stays on until ${foundingLongDay(iso)}, and then the spot goes back. Nothing more is charged. You can change your mind until then.`,
  stopConfirm: 'Stop renewing',
  stopping: 'Stopping…',
  keep: 'Keep it renewing',
  cancel: 'Cancel',
  pay: 'Pay with another card',
  paying: 'Getting the payment page ready…',
} as const;

// ---------- picking a spot, straight after signing up (20261027012700) ----------

/** What the plan page needs of an offer (`founding.counts`'s `offers`). */
export interface FoundingPickOffer {
  readonly offerId: string;
  readonly name: string;
  readonly status: FoundingOfferStatus;
  readonly priceCents: number;
  readonly seatCap: number;
  readonly remaining: number;
  readonly billing: FoundingOfferFacts['billing'];
  readonly superseded: boolean;
}

/**
 * The spots a business can buy, in the order staff set (`founding.counts` reads them by `sort`, the order the website
 * shows them in too): open, with a price, and not replaced by a later offer. A full one stays on the list, marked, so
 * nobody wonders where it went.
 */
export const foundingPickable = <O extends FoundingPickOffer>(offers: readonly O[]): O[] =>
  offers.filter((o) => o.status === 'open' && o.priceCents > 0 && !o.superseded);

/** Which one the page starts on: the one the website's button named, if it can be bought, else the first with room. */
export const foundingPickFirst = (
  offers: readonly FoundingPickOffer[],
  wanted: string | null,
): string => {
  const open = offers.filter((o) => o.remaining > 0);
  return (
    open.find((o) => o.offerId === wanted || o.billing === wanted)?.offerId ??
    open[0]?.offerId ??
    ''
  );
};

export const FOUNDING_PICK_WORDS = {
  title: 'Pick your founding spot',
  sub: (business: string) =>
    `${business} is ready to set up once you’ve picked a spot and paid. First come, first served.`,
  /** "37 of 100 left". */
  left: (remaining: number, seatCap: number) =>
    `${remaining.toLocaleString('en-US')} of ${seatCap.toLocaleString('en-US')} spots left`,
  full: 'All taken',
  per: (billing: FoundingOfferFacts['billing']) =>
    billing === 'monthly' ? 'a month' : billing === 'yearly' ? 'a year' : 'once',
  renews: (billing: FoundingOfferFacts['billing']) =>
    billing === 'monthly'
      ? 'Renews each month on the same card.'
      : billing === 'yearly'
        ? 'Renews each year on the same card.'
        : 'Paid once.',
  pay: (cents: number) => `Pay ${foundingPrice(cents)}`,
  paying: 'Getting the payment page ready…',
  fine: 'You pay on Stripe’s secure page, and your spot is held for an hour while you do. Stop it renewing any time in Settings → Usage & balance. Texts, calls and AI are billed for what you use.',
  noneLeft:
    'Every founding spot is taken for now. Email support@handsfreeos.com and we’ll tell you when more open.',
  notYours: (business: string) =>
    `Only an owner of ${business} can pick its plan. Ask them to sign in and pick one, then come back.`,
  signOut: 'Sign out',

  // The phone never sells: it sends a business that still has to set up to the web, with no price and no link.
  phoneTitle: 'Finish setting up on the web',
  phoneBody: (business: string) =>
    `${business} isn’t ready on the phone yet. Sign in to HandsFreeOS on a computer to finish setting it up, then come back here.`,
  phoneCheck: 'Check again',
  phoneOther: 'Open another business',
} as const;
