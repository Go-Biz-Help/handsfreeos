/**
 * What the business reads about its partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2d): Settings →
 * Partners, a partner's own page there, and the Partner card on a customer's page. The web and the phone say the
 * same thing. A partner's own page in the portal has its words in ./words.ts.
 *
 * Browser-safe.
 */
import type { PartnerStatus } from '../schemas/partners';

const clients = (n: number) => (n === 1 ? '1 client' : `${n} clients`);

export const PARTNERS_WORDS = {
  menu: 'Partners',
  about:
    'People who send you customers for a share of what each one pays in their first 12 months. Each partner has a link of their own, and a page in your portal with what they’ve earned.',
  status: {
    active: 'Active',
    paused: 'Paused',
    ended: 'Ended',
  } satisfies Record<PartnerStatus, string>,
  earnings: {
    earned: 'Earned',
    waiting: 'Waiting 30 days',
    payable: 'Free to pay out',
    held: 'Held by a dispute',
    about:
      'Each share is free to pay out 30 days after the client pays, so a refund never has to come back from the partner. Payments taken in a test mode are shown but never count.',
  },

  /** Settings → Partners: how partners are paid. */
  settings: {
    title: 'How partners are paid',
    share: 'Their share',
    shareHint:
      'What a partner earns of each payment from a client they sent, in that client’s first 12 months. A partner can have their own on their page.',
    smallestPayout: 'Smallest payout',
    smallestPayoutHint:
      'A partner owed less than this has it carried to the next month. $25 at most, $1 at least.',
    calendar: 'The calendar their links book',
    calendarFirst: 'The first that takes bookings',
    calendarHint: 'Whoever books through a partner’s link becomes that partner’s client.',
    noCalendar:
      'No calendar takes bookings on your booking page yet, so partners have no link to share. Make one public in Settings → Calendars.',
    saved: 'Saved.',
  },

  /** Settings → Partners: the terms partners accept. */
  terms: {
    title: 'Partner terms',
    hint: 'What partners read and accept on their page before they get their link. Change them, and every partner accepts them again before their link shows again.',
    placeholder:
      'How and when you pay partners, what counts and what doesn’t, and how either of you can end it.',
    save: 'Save the terms',
    saved: 'Terms saved. Your partners accept them on their page before their link shows again.',
    cleared: 'Terms cleared. Partners get their link without accepting any.',
    unsaved: 'Not saved yet.',
    none: 'No terms yet, so partners get their link without accepting any.',
    version: (n: number) => `Version ${n}`,
  },

  /** Settings → Partners: the list. */
  list: {
    title: 'Your partners',
    empty:
      'No partners yet. Make someone a partner from the Partners list in Social Outreach, or from their page under Customers.',
    clients,
    termsWaiting: 'Hasn’t accepted your terms yet',
    ownShare: (rate: string) => `${rate} (their own)`,
  },

  /** A partner's page, under Settings → Partners. */
  partner: {
    back: 'All partners',
    since: (date: string) => `Partner since ${date}`,
    openContact: 'Open their customer page',
    share: 'Their share',
    shareHint: (rate: string) =>
      `What they earn of each payment from a client they sent. Your share for partners is ${rate}.`,
    ownShare: 'Give them their own share',
    useYours: (rate: string) => `Use your share for partners (${rate})`,
    shareSaved: 'Their share is saved. Payments from now on earn it.',
    pause: 'Pause',
    resume: 'Bring them back',
    end: 'End the partnership',
    statusLine: {
      active: null,
      paused: (name: string) =>
        `${name} is paused. Payments from now on earn them nothing until you bring them back. What they earned is kept.`,
      ended: (name: string) =>
        `${name}’s partnership has ended. Payments from now on earn them nothing, and their link no longer shows on their page. What they earned is kept.`,
    } satisfies Record<PartnerStatus, ((name: string) => string) | null>,
    statusSaved: {
      active: (name: string) => `${name} is a partner again.`,
      paused: (name: string) => `${name} is paused.`,
      ended: (name: string) => `${name}’s partnership has ended.`,
    } satisfies Record<PartnerStatus, (name: string) => string>,
    endTitle: (name: string) => `End ${name}’s partnership?`,
    endBody:
      'Payments from now on earn them nothing, and their link no longer shows on their page. What they earned is kept, and you can bring them back.',
    endKeep: 'Keep them',
    link: 'Their link',
    linkHint: 'Whoever books through it becomes their client.',
    copy: 'Copy their link',
    copied: 'Link copied.',
    noLink:
      'No calendar takes bookings on your booking page yet, so there’s no link to share. Make one public in Settings → Calendars.',
    page: 'Their page',
    pageHint:
      'Their own page in your portal: their link, the clients they sent and what they’ve earned. They sign in with a code sent to their email.',
    send: 'Send their page',
    sendAgain: 'Send it again',
    sent: (email: string) => `Sent to ${email}.`,
    noEmail: (name: string) =>
      `${name} has no email address, so there’s nowhere to send their page. Add their email on their customer page first.`,
    termsAccepted: 'Accepted your latest terms.',
    termsWaiting: 'Hasn’t accepted your latest terms yet, so their page doesn’t show their link.',
    clients: {
      title: 'Their clients',
      empty: 'Nobody has booked through their link yet, and nobody’s marked as theirs.',
      viaLink: 'Booked through their link',
      byHand: 'Marked by hand',
      until: (date: string) => `Earning them a share until ${date}`,
      notYet: 'Earning them a share once they first pay',
    },
    commissions: {
      title: 'What they’ve earned',
      empty: 'Nothing yet. Each payment from a client of theirs earns them their share.',
      earned: (rate: string, base: string) => `${rate} of ${base} paid`,
      takenBack: (rate: string, base: string) => `${rate} of ${base} refunded or lost to a dispute`,
      invoice: (n: string) => `Invoice ${n}`,
      freeOn: (date: string) => `Free to pay out ${date}`,
      free: 'Free to pay out',
      test: 'Test payment: never counts',
      held: 'Held by a dispute',
    },
  },

  /** The Partner card on a customer's page. */
  card: {
    title: 'Partner',
    isPartner: (status: PartnerStatus) =>
      status === 'active'
        ? 'They’re one of your partners.'
        : status === 'paused'
          ? 'They’re one of your partners, paused for now.'
          : 'They were one of your partners. Their partnership has ended.',
    open: 'Open their partner page',
    make: 'Make them a partner',
    makeHint:
      'They get a link of their own, and earn a share of what each client they send pays in their first 12 months.',
    made: (name: string) =>
      `${name} is a partner now. Send them their page from Settings → Partners.`,
    sentBy: 'Sent by',
    nobody: 'Nobody',
    how: { link: 'Booked through their link', by_hand: 'Marked by hand' },
    earnedThem: (amount: string) => `Earned them ${amount} so far`,
    change: 'Change',
    pick: 'Pick the partner who sent them',
    saved: 'Saved.',
    noPartners: 'You have no other partners yet.',
  },
} as const;
