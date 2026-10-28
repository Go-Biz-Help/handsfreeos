/**
 * The affiliate terms (20261027014500, HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md part 5): the version that counts,
 * where they're read, and the words that ask for them. Browser-safe.
 *
 * The terms themselves are the website's page (`apps/site/src/app/affiliates/terms`). When they change in a way that
 * matters, change {@link AFFILIATE_TERMS_VERSION} to the day they're published, and that page's date with it: every
 * affiliate agrees again before they make a code or set up payouts. Their link keeps crediting businesses meanwhile.
 */
import { AFFILIATE_SITE } from './words';

/** The terms that count now, by the day they were published. Matches the website's terms page. */
export const AFFILIATE_TERMS_VERSION = '2026-10-28';

/** Where they're read. */
export const AFFILIATE_TERMS_URL = `${AFFILIATE_SITE}/affiliates/terms`;

/** Whether somebody agreed to the terms that count now. */
export const affiliateTermsCurrent = (version: string | null | undefined): boolean =>
  version === AFFILIATE_TERMS_VERSION;

export const AFFILIATE_TERMS_WORDS = {
  /** The box on the application. */
  agree: 'I’ve read the affiliate terms and agree to them',
  read: 'Read the affiliate terms',
  /** The card an affiliate sees before their link, when they haven't agreed to the terms that count now. */
  title: 'Agree to the affiliate terms',
  first:
    'Before your link and codes show here, read the affiliate terms. They say what you earn, how you’re paid, and how to tell people about HandsFreeOS.',
  changed:
    'The affiliate terms changed. Read them and agree to keep making codes and getting paid. Your link keeps working meanwhile.',
  accept: 'I agree',
  accepted: 'Thanks. Your link is below.',
  /** Staff's line on one affiliate's page. */
  agreedOn: (when: string) => `Agreed to the terms ${when}`,
  agreedOld: (when: string) => `Agreed to older terms ${when}, not the current ones yet`,
  notAgreed: 'Hasn’t agreed to the terms yet',
} as const;
