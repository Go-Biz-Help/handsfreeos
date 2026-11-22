/**
 * Which pages of a business's website are its privacy policy and its terms, from the addresses a walk of the site
 * came across (texting approval's question on the policy and terms; the owner's pick 10a, 2026-11-22: "When their site
 * has one, we hand it back whole"). The walk is the one "What's on your site now" already makes for forms, so finding
 * them opens nothing more.
 *
 * **By the address alone,** which is how sites name these pages: `/privacy`, `/privacy-policy`, `/legal/terms`,
 * `/terms-and-conditions`. Only the last part of the address is read, and every word in it has to be one a policy's
 * address uses, so `/blog/why-privacy-matters` and a clinic's `/conditions` aren't taken for one.
 *
 * It's a first guess the business sees and can change, never a check: the checks before a registration goes read the
 * page itself (`preflight.ts`).
 *
 * Browser-safe.
 */

/** The site's own privacy policy and terms, when it has them. One page can be both. */
export interface PolicyPages {
  readonly privacy: string | null;
  readonly terms: string | null;
}

/** Words that say nothing either way: "our", "policy", "legal". */
const PLAIN = new Set([
  'policy',
  'policies',
  'notice',
  'statement',
  'legal',
  'and',
  'our',
  'the',
  'of',
  'website',
  'site',
  'page',
]);
const PRIVACY = new Set(['privacy', 'cookie', 'cookies', 'data', 'protection']);
const TERMS = new Set([
  'terms',
  'tos',
  'conditions',
  'service',
  'services',
  'use',
  'sale',
  'sales',
  'general',
  'user',
  'agreement',
]);
/** What "conditions" needs beside it to be terms rather than what a clinic treats. */
const OF_WHAT = ['use', 'sale', 'sales', 'service', 'services', 'general'];

/** The words of an address's last part ("/legal/Privacy-Policy.html" gives privacy, policy), and how deep it is. */
function lastPart(address: string): { words: string[]; depth: number } | null {
  let path: string;
  try {
    path = decodeURIComponent(new URL(address).pathname);
  } catch {
    return null;
  }
  const parts = path.split('/').filter(Boolean);
  const last = parts.at(-1);
  if (!last) return null;
  const name = last.toLowerCase().replace(/\.(html?|php|aspx?)$/, '');
  return { words: name.split(/[^a-z0-9]+/).filter(Boolean), depth: parts.length };
}

export function policyPagesAmong(addresses: readonly string[]): PolicyPages {
  type Found = { url: string; depth: number };
  let privacy: Found | null = null;
  let terms: Found | null = null;
  // The shallowest wins, then the shortest: /privacy before /es/privacy, the first seen when they tie.
  const better = (a: Found, b: Found | null) =>
    !b || a.depth < b.depth || (a.depth === b.depth && a.url.length < b.url.length);
  for (const url of addresses) {
    const part = lastPart(url);
    if (!part || part.words.length === 0 || part.words.length > 6) continue;
    const { words, depth } = part;
    if (!words.every((w) => PLAIN.has(w) || PRIVACY.has(w) || TERMS.has(w))) continue;
    const found = { url, depth };
    if (words.includes('privacy') && better(found, privacy)) privacy = found;
    const isTerms =
      words.includes('terms') ||
      words.includes('tos') ||
      (words.includes('conditions') && OF_WHAT.some((w) => words.includes(w))) ||
      (words.includes('user') && words.includes('agreement'));
    if (isTerms && better(found, terms)) terms = found;
  }
  return { privacy: privacy?.url ?? null, terms: terms?.url ?? null };
}

/**
 * Whether two addresses are the same page, however each was typed: with or without https://, www. or a slash at the
 * end. A policy handed back whole is kept under the address it was made for (`registration.record_policy`), and is
 * only shown, or sent to a web person, while the registration still names that page.
 */
export function samePolicyPage(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const key = (raw: string | null | undefined): string | null => {
    const typed = raw?.trim();
    if (!typed) return null;
    try {
      const url = new URL(/^https?:\/\//i.test(typed) ? typed : `https://${typed}`);
      let path = url.pathname;
      while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      return `${url.host.toLowerCase().replace(/^www\./, '')}${path}${url.search}`;
    } catch {
      return null;
    }
  };
  const one = key(a);
  return one !== null && one === key(b);
}

/**
 * What the look at a site found, in a sentence or two, for the question on the privacy policy and terms: which of the
 * two the site has, and so which are the business's own and which we wrote. `site` is the site as the business knows
 * it ("lonestarhvac.com"). Said once here, so the web and the phone say the same.
 */
export function policyPagesSummary(found: PolicyPages, site: string): string {
  const back = 'handed back below, whole, with the part about texts added';
  if (found.privacy && found.terms)
    return `We found your privacy policy and your terms on ${site}, so we’re using yours. Each one is ${back}.`;
  if (found.privacy)
    return `We found your privacy policy on ${site}, so we’re using it. It’s ${back}. We didn’t find terms there, so we wrote those for you.`;
  if (found.terms)
    return `We found your terms on ${site}, so we’re using them. They’re ${back}. We didn’t find a privacy policy there, so we wrote one for you.`;
  return `We didn’t find a privacy policy or terms on ${site}, so we wrote both for you. If yours are on a page we missed, pick “I already have my own” and give its address.`;
}
