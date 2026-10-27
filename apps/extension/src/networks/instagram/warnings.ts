/**
 * Instagram's warnings, as its pages word them (decision 25): read on its own pages by its site (./site.ts) and on its
 * own Accounts Center by ../accounts-center/pages.ts, so the two never disagree. Kept apart from the site so Accounts
 * Center's reader loads only these.
 */

/** A block on the account, whatever else the page says. */
export const INSTAGRAM_BLOCKS: readonly RegExp[] = [
  /\baction blocked\b/i,
  /\bwe restrict certain activity\b/i,
  /\byour account (has been|was|is) (temporarily )?(locked|restricted|suspended|disabled)\b/i,
  /\bwe suspect automated behaviou?r\b/i,
  /\bsuspicious (login|activity)\b/i,
];

/**
 * Instagram slowing the person down ("Try Again Later", "We limit how often…"): its block on its own pages. On its
 * Accounts Center, the same words beside a name or a username are its answer about that instead
 * (../accounts-center/pages.ts).
 */
export const INSTAGRAM_LATER: readonly RegExp[] = [
  /\btry again later\b/i,
  /\bwe limit how often\b/i,
];

/** Instagram asking the person to confirm it's them: theirs to answer (on Accounts Center, `askingHere` reads it). */
export const INSTAGRAM_CHECKS: readonly RegExp[] = [
  /\b(confirm|verify) (it['’]s you|your identity|your account)\b/i,
  /\bhelp us confirm\b/i,
];

/** Every one of Instagram's warnings, as its own pages read them. */
export const INSTAGRAM_WARNINGS: readonly RegExp[] = [
  ...INSTAGRAM_BLOCKS,
  ...INSTAGRAM_LATER,
  ...INSTAGRAM_CHECKS,
];
