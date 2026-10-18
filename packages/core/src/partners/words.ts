/**
 * What a partner reads on their own page in the business's portal (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage
 * 2c), and how a client they sent is named there: by first name and last initial, never more.
 *
 * Browser-safe.
 */

/** "Maria L.", "Maria", or null when the client was deleted. */
export function clientShortName(
  firstName: string | null | undefined,
  lastInitial: string | null | undefined,
): string | null {
  const first = firstName?.trim();
  if (!first) return null;
  const initial = lastInitial?.trim().charAt(0).toUpperCase();
  return initial ? `${first} ${initial}.` : first;
}

export const PARTNER_PAGE_WORDS = {
  menu: 'Partner',
  title: 'Your partnership',
  homeCard: (business: string) =>
    `You’re a partner of ${business}. See your link, the clients you’ve sent and what you’ve earned.`,
  share: (rate: string) =>
    `You earn ${rate} of what each client you send pays in their first 12 months.`,
  status: {
    paused: (business: string) =>
      `${business} paused your partnership. Payments from now on don’t earn you a share until it’s back on. What you’ve earned is kept.`,
    ended: (business: string) =>
      `Your partnership with ${business} has ended. What you earned is kept.`,
  },
  terms: {
    title: 'Your terms',
    first: 'Read and accept the terms to get your link.',
    changed: (business: string) =>
      `${business} changed its terms since you accepted them. Read them again and accept them to keep sharing your link.`,
    accept: 'I accept these terms',
    accepted: (date: string) => `You accepted these terms on ${date}.`,
    done: 'Terms accepted.',
  },
  link: {
    title: 'Your link',
    about:
      'Share it with people who could use the business. Whoever books through it becomes your client.',
    copy: 'Copy link',
    copied: 'Link copied.',
    none: (business: string) =>
      `${business} isn’t taking bookings online yet, so there’s no link to share. Ask them about it.`,
  },
  earnings: {
    title: 'What you’ve earned',
    earned: 'Earned',
    waiting: 'Waiting 30 days',
    payable: 'Free to pay out',
    held: 'Held by a dispute',
    paying: 'On its way',
    paid: 'Paid you',
    about:
      'Each share is free to pay out 30 days after the client pays, so a refund never has to come back from you. A share on a payment the client’s bank is disputing waits until that’s settled.',
  },
  clients: {
    title: 'Your clients',
    empty: 'Nobody has booked through your link yet.',
    deleted: 'A client',
    viaLink: 'Booked through your link',
    byHand: 'Added by the business',
    until: (date: string) => `Earning you a share until ${date}`,
    notYet: 'Earning you a share once they first pay',
  },
} as const;
