/**
 * Practice businesses (Admin → Try onboarding, 20261027027400): HandsFreeOS admins go through every onboarding as a
 * brand-new customer would, in a business made just for it, and nothing in it is kept. What the screens say, once for
 * the web (the phone shows a practice business like any other, with its tag), and what they work out.
 */

/** How long a practice business lasts before the worker deletes it on its own (the owner's pick 2a). */
export const PRACTICE_HOURS = 24;
/** The most practice businesses one person has going at once (the database's limit too). */
export const PRACTICE_MOST = 5;

/**
 * The onboardings on Admin → Try onboarding, in the page's order. `ready` ones start now; the rest say they're
 * coming, so the page shows the whole plan.
 */
export const PRACTICE_FLOWS = [
  {
    key: 'new_business',
    title: 'New business, start to finish',
    blurb:
      'Sign up, pick a founding spot and pay, then the guided setup and Home, as a brand-new customer sees it.',
    ready: true,
  },
  {
    key: 'offer_link',
    title: 'From an offer link',
    blurb:
      'The same, starting from a link: $497 a year or $97 a month, a trial or discount code, an affiliate’s link, or the website’s “Try it on your business”.',
    ready: true,
  },
  {
    key: 'addon',
    title: 'An add-on’s setup',
    blurb:
      'Turning on an add-on and setting it up, in a business that’s ready. Every add-on is offered, the ones still being built too.',
    ready: true,
  },
  {
    key: 'main_offer',
    title: 'The Main offer builder',
    blurb:
      'Building and scoring the main offer with the AI, in a business that’s ready with Content Creator on.',
    ready: true,
  },
  {
    key: 'agency',
    title: 'An agency setting up a client',
    blurb:
      'An agency adds a client’s business and sets it up, hands it to the owner, then you take the owner’s part from the invitation email.',
    ready: true,
  },
  {
    key: 'invite',
    title: 'Joining from a team invite',
    blurb:
      'You’re invited to a business that’s ready: the invitation email, joining, and the business as a new teammate sees it.',
    ready: true,
  },
  {
    key: 'affiliate',
    title: 'Signing up as an affiliate',
    blurb:
      'The website’s affiliate link: making an account, then the application. Nothing is sent to HandsFreeOS.',
    ready: true,
  },
] as const satisfies readonly { key: string; title: string; blurb: string; ready: boolean }[];

export type PracticeFlow = (typeof PRACTICE_FLOWS)[number]['key'];
/** The flows that start now. */
export const PRACTICE_READY_FLOWS = PRACTICE_FLOWS.filter((f) => f.ready).map((f) => f.key);

export const PRACTICE_WORDS = {
  title: 'Try onboarding',
  intro:
    'Go through an onboarding exactly as a new customer would, in a practice business made just for it. The screens and the AI are real. Nothing else leaves HandsFreeOS.',
  pretended: [
    'Paying is a stand-in page: no card is charged and no founding spot is used.',
    'The business number is pretend: nothing is bought, and no texts or calls go out.',
    'Connecting Stripe, Square, Google, Outlook, Facebook or Zoom stops at a page saying it’s pretended.',
    'Email goes only to you, marked [Practice].',
    'An invitation into a practice business comes to you, and you can accept it whoever it was for.',
  ],
  kept: (hours: number) =>
    `Each practice business is deleted for good when you press End practice, or ${hours} hours after it starts.`,
  start: 'Start',
  starting: 'Starting…',
  coming: 'Coming next',
  running: 'Your practice businesses',
  none: 'None going right now.',
  open: 'Open',
  end: 'End practice',
  ending: 'Ending…',
  ended: 'Deleted. It’s gone from your list.',
  tag: 'Practice',
  /** The banner across every page of a practice business. */
  banner: (endsIn: string) =>
    `Practice business. Nothing here is kept, and it’s deleted ${endsIn}. Payments, numbers, texts and connections are pretended; email goes only to you.`,
  endAsk: (name: string) =>
    `End practice and delete ${name} for good? Everything in it goes, and it can’t be brought back.`,
  endYes: 'Delete it',
  endNo: 'Keep going',
  // The practice sign-up and first screen, before the business exists.
  signUpNote:
    'Practice sign-up: no login is made and nothing is sent. Type anything; any 6-digit code works.',
  codeNote: 'Practice: nothing was sent. Type any 6 digits.',
  businessNote: 'Practice: this makes a practice business, owned by you, deleted after.',
  // The stand-in checkout.
  payTitle: 'Practice checkout',
  payNote:
    'This is where the Stripe page would be. No card is charged and no founding spot is used.',
  payCard: 'Card',
  payButton: (price: string) => `Pay ${price}`,
  trialButton: (days: number) => `Start my ${days}-day free trial`,
  paying: 'Paying…',
  back: 'Back to the plans',
  tooMany: (most: number) =>
    `You have ${most} practice businesses going, the most at once. End one below to start another.`,
  // Starting the onboardings that begin in a business made here.
  businessName: 'Business name',
  kind: 'Kind of business',
  addon: 'Add-on',
  agencyName: 'Agency name',
  clientName: 'Client’s business name',
  role: 'Join as',
  roles: { member: 'Member', admin: 'Admin' } as const,
  startingAddon: (name: string) => `Turning on ${name}…`,
  addonSlow: (name: string) =>
    `${name} is still being set up. Turn it on from Add-ons if it doesn’t show as on in a minute.`,
  /** A practice business you were invited to and haven't joined yet. */
  waiting: 'Invitation sent to your email. Open it to join.',
  invitedSent: (email: string) =>
    `The invitation is on its way to ${email}, marked [Practice]. Open it to join the business.`,
  // From an offer link.
  linkPlan: 'Plan on the link',
  linkPlans: {
    none: 'None (the plan page’s pick)',
    yearly: '$497 a year',
    monthly: '$97 a month',
  } as const,
  linkCode: 'Trial or discount code',
  linkRef: 'Affiliate’s code',
  linkBusiness: 'Business typed on the website',
  linkHint: 'Each is optional. Leave them all empty for the website’s plain sign-up link.',
  /** On the practice sign-up, saying what the link carried. */
  linkNote: (parts: readonly string[]) => `From an offer link: ${parts.join(', ')}.`,
  linkNoteRef: (ref: string) =>
    `${ref}’s affiliate link (a real sign-up credits the business to them; practice credits nobody)`,
  linkNotePlan: (plan: string) => `the ${plan} plan`,
  linkNoteCode: (code: string) => `the code ${code}`,
  linkNoteBusiness: (name: string) => `“${name}” typed on the website`,
  // The affiliate application.
  affiliateNote:
    'Practice application: nothing is sent to HandsFreeOS, and no affiliate is made. In real life staff look at it on Admin → Affiliates.',
  affiliateSent:
    'Practice: this is what an applicant sees once they send it. Nothing was saved, so this page starts over if you open it again.',
  affiliateAgain: 'Start the application again',
} as const;

/** When a practice business goes, from now: "in 23 hours", "in 40 minutes", "within the hour". */
export function practiceEndsIn(endsAt: string | Date, now: number = Date.now()): string {
  const ms = new Date(endsAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'within the hour';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return minutes <= 1 ? 'in a minute' : `in ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'in an hour' : `in ${hours} hours`;
}
