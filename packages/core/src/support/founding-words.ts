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
 */

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
  readonly billing: 'once' | 'monthly';
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
}

/** "Oct 3", in the reader's own zone; a dash for a date that isn't there. */
export const foundingDay = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';

/** "Free", "$497". */
export const foundingPrice = (cents: number): string =>
  cents === 0 ? 'Free' : `$${(cents / 100).toFixed(0)}`;

export const FOUNDING_WORDS = {
  title: 'Founding offers',

  // An offer's card.
  monthlyNote: 'The website shows this plan while it is open. No seat limit.',
  /** After the number left: "3 of 25 left". */
  ofLeft: (seatCap: number) => ` of ${seatCap} left`,
  opened: (iso: string) => `Opened ${foundingDay(iso)}.`,
  replaced: (name: string) =>
    `Off the website since ${name} opened. A seat that frees up here is for somebody already waiting — approve them below.`,
  paidNote:
    'Paid for at Stripe Checkout from the claim link. The seat turns on when Stripe says the money is in.',
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

/** The offers a seat can be given from: founding seats that have opened, never the monthly plan. */
export const foundingGivableOffers = <O extends Pick<FoundingOfferFacts, 'billing' | 'status'>>(
  offers: readonly O[],
): O[] => offers.filter((o) => o.billing === 'once' && o.status !== 'draft');

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

/** "Free · open", "$97/month · draft": an offer's price and where it stands. */
export const foundingOfferPriceLine = (offer: FoundingOfferFacts): string =>
  `${foundingPrice(offer.priceCents)}${offer.billing === 'monthly' ? '/month' : ''} · ${offer.status}`;

/** What an offer's card says about it, beyond its name and price. */
export function foundingOfferCard(
  offer: FoundingOfferFacts,
  offers: readonly FoundingOfferFacts[],
): {
  /** The monthly plan: no seats and no cap, so the card is only the switch for whether the website sells it. */
  readonly monthly: boolean;
  /** How full it is, 0 to 100. */
  readonly pct: number;
  /** "Opens by itself when …": a draft that another offer opens. */
  readonly opens: string | null;
  /** "Opened Oct 3.", when it isn't waiting to open by itself. */
  readonly opened: string | null;
  /** A later founding offer is open, so this one is off the website. */
  readonly replaced: string | null;
  /** A paid seat is paid for from the claim link. */
  readonly paid: boolean;
  /** The one button that moves it: Close, or Open (Open now for one that would open by itself). */
  readonly action: { readonly status: 'open' | 'closed'; readonly label: string };
} {
  const monthly = offer.billing === 'monthly';
  const after = offers.find((o) => o.offerId === offer.opensAfterOfferId);
  // The same rule as the view's `superseded`: a later founding offer is open, so this one is off the website.
  const replacedBy = offers.find(
    (o) => o.opensAfterOfferId === offer.offerId && o.billing === 'once' && o.status !== 'draft',
  );
  const line = after ? (offer.opensAfterCount ?? after.seatCap) : null;
  return {
    monthly,
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
    paid: !monthly && offer.priceCents > 0,
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
  }`;

/** A seat given back: never taken up, or taken back, and how long they keep working. */
export const foundingGivenBackLine = (g: FoundingSeatFacts): string =>
  `${
    g.status === 'expired'
      ? `never taken up · expired ${foundingDay(g.expiresAt)}`
      : `revoked ${foundingDay(g.revokedAt)} · ${g.revokeReason}`
  }${g.graceEndsAt ? ` · still working until ${foundingDay(g.graceEndsAt)}` : ''}`;

/** Money in, no seat on: somebody has to refund it at Stripe or find them a seat. Null when nothing's wrong. */
export const foundingSeatProblem = (g: FoundingSeatFacts): string | null =>
  g.checkoutStatus === 'paid' && g.checkoutProblem ? g.checkoutProblem : null;

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
