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
} as const;

/** A full date and time, in the reader's own zone: "Sep 30, 9:41 AM". */
export const whenWords = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** A date alone, as the web writes a sign-up: in the reader's own zone and format. */
export const dayWords = (iso: string): string => new Date(iso).toLocaleDateString();
