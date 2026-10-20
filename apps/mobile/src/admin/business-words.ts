import { deskSectionLabel, DESK_WALLET_STAGES, type DeskSectionKey } from '@hfos/core';

/**
 * What the phone's Businesses, Health and Getting started say that the web's /admin needs no words for: a toast once a
 * change has gone, a page a role doesn't open (the web's menu leaves it out, and its address answers with the refusal
 * page), and pulling down where the web says refresh. What both say is core's `support/business-words.ts` and
 * `support/health-words.ts`.
 */
export const DESK_BUSINESS_PHONE_WORDS = {
  /** A section this support person's role doesn't open, reached from an old link. */
  notYourRole: (section: DeskSectionKey) =>
    `Your support role doesn’t open ${deskSectionLabel(section)}. Ask a support admin if you need it.`,
  movedTo: (stage: keyof typeof DESK_WALLET_STAGES) =>
    `Moved to ${DESK_WALLET_STAGES[stage].label.toLowerCase()}`,
  creditPutOn: 'Credit put on',
  aiUnreadable: 'Couldn’t read which AI is answering. Pull down to try again in a minute.',
  aiReading: 'Reading which AI is answering…',
  /** Under the quick look: the business's own screen, for its people, tickets and changes. */
  openBusiness: 'Open the business',
} as const;
