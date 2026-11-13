/**
 * A robot check: the page a website's host, or the firewall in front of it, shows a visitor it takes for a bot,
 * in place of the page that was asked for (2026-11-13, Full Spectrum's terms).
 *
 * **Why it matters.** Our server reads a business's own pages: its terms and privacy policy for the texting
 * registration, every page for Knowledge. Hosts such as SiteGround answer some of those reads with a tiny page
 * that only says "go here and run this code first". Read as the page itself, it looks like a page with no words,
 * a policy that never mentions texting, or a site with nothing on it, and the business is told something false.
 * A person in a browser gets past the check in a second, and so does a carrier's reviewer, so the page is fine:
 * we just never saw it. Every reader asks this first and says what really happened.
 *
 * **We never try to get past one.** The check is the site's to set. We say plainly that it stopped us, and the
 * business pastes the words or adds them by hand.
 *
 * Browser-safe and pure: the worker hands over what it got, and this says whether it was a robot check.
 */

/** What a reader got for one address. */
export interface PageAnswer {
  /** The status code, or null when nothing came back. */
  readonly status: number | null;
  readonly html: string;
  /** The response's headers, names in lower case, when the reader kept them. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RobotCheck {
  /** Who showed it, named the way its owner would know it ("SiteGround"), or null when the page doesn't say. */
  readonly by: string | null;
}

/**
 * The marks each service's check page carries. Only looked for on a page with almost no words of its own, so a
 * real page that happens to mention one (a blog post about Cloudflare) is never taken for a check.
 */
const PAGE_MARKS: readonly { readonly by: string; readonly mark: RegExp }[] = [
  // A 202 whose whole body is a refresh to /.well-known/sgcaptcha/?r=<the page>, and the challenge page it leads to.
  {
    by: 'SiteGround',
    mark: /\/\.well-known\/(?:sg)?captcha\/|<title>\s*Robot Challenge Screen\s*<\/title>/i,
  },
  {
    by: 'Cloudflare',
    mark: /<title>\s*(?:Just a moment\.\.\.|Attention Required! \| Cloudflare)\s*<\/title>|\/cdn-cgi\/challenge-platform\/h\/|window\._cf_chl_opt/i,
  },
  { by: 'Sucuri', mark: /Sucuri WebSite Firewall/i },
  { by: 'Imunify360', mark: /imunify360/i },
  { by: 'Wordfence', mark: /Your access to this site has been limited by the site owner/i },
  { by: 'Amazon Web Services', mark: /AwsWafIntegration|awsWafCookieDomainList/ },
  { by: 'DataDome', mark: /captcha-delivery\.com/i },
];

/** A check page has a line or two of its own words; a page with more than this is a real page. */
const MOST_WORDS = 1500;

/** The words a person would see, roughly: enough to tell a check page from a real one. */
const shownText = (html: string): string =>
  html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The robot check a reader got instead of the page, or null when it got the page (or nothing at all). */
export function robotCheck(answer: PageAnswer): RobotCheck | null {
  const header = (name: string) => answer.headers?.[name]?.toLowerCase() ?? '';
  // Said outright by the service, whatever the page looks like.
  if (header('cf-mitigated') === 'challenge') return { by: 'Cloudflare' };
  if (/^(challenge|captcha)$/.test(header('x-amzn-waf-action')))
    return { by: 'Amazon Web Services' };
  if (answer.status === null || !answer.html) return null;
  if (shownText(answer.html).length > MOST_WORDS) return null;
  const found = PAGE_MARKS.find((m) => m.mark.test(answer.html));
  return found ? { by: found.by } : null;
}

/** Who showed it, as a sentence names them: "your website’s security (SiteGround)". */
export const robotCheckWho = (check: RobotCheck): string =>
  check.by ? `your website’s security (${check.by})` : 'your website’s security';

/** The one-sentence why, for any message about a page that showed one. */
export const robotCheckWhy = (check: RobotCheck): string =>
  `${capitalize(robotCheckWho(check))} does this to keep bots out. People opening the page in a browser get past it.`;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
