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

/**
 * How our reader names itself to every website (the worker's `user-agent`), for the words that ask a host to let it
 * in. The worker's safe fetch sends exactly this.
 */
export const SITE_READER_AGENT = 'HandsFreeOS/1.0 (+https://handsfreeos.com)';

/** Letting HandsFreeOS in: what the business does at its host, and a message to send when the host has to do it. */
export interface RobotCheckAllow {
  /** Where to go and what to change, in a sentence or three. */
  readonly steps: string;
  /** Words to copy into a message to the host's support, when only they can change it. */
  readonly message: string | null;
}

/**
 * Letting our reader past a site's security for good (owner, 2026-11-20): the worker reads from fixed addresses
 * (`SITE_READER_IPS` on the worker, `fly ips allocate-egress`), and the business, whose site it is, allows them. That
 * is the site owner's own choice in the site's own settings, not a way round them. Null without the addresses: there
 * is nothing to allow yet, and the browser check or a screenshot does instead.
 *
 * SiteGround has no switch for its robot check (2026-11-20: its Site Tools list only blocks), so its support adds the
 * address. Cloudflare's free Bot Fight Mode ignores rules too, so its steps say to finish the check in the browser.
 */
export function robotCheckAllow(
  by: string | null,
  site: { readonly host: string; readonly ips: readonly string[] },
): RobotCheckAllow | null {
  const ips = site.ips.filter(Boolean);
  if (!ips.length) return null;
  const list = ips.join(', ');
  const message = `Hi, please let HandsFreeOS read my website ${site.host}. It’s the software I use for my business, and it reads my own pages to check them for my texting registration. It reads from ${ips.length === 1 ? 'this address' : 'these addresses'}: ${list}, and names itself “${SITE_READER_AGENT}”. Please allow ${ips.length === 1 ? 'it' : 'them'} through the robot check (the captcha). Thank you!`;
  switch (by) {
    case 'SiteGround':
      return {
        steps:
          'SiteGround has no switch for its robot check, so its support adds HandsFreeOS for you. In Site Tools, open Help and start a chat, then paste the message below. It usually takes a few minutes.',
        message,
      };
    case 'Cloudflare':
      return {
        steps: `In Cloudflare, open ${site.host}, then Security → WAF → Custom rules → Create rule. Pick “IP Source Address”, “is in”, and add ${list}. Under “Then take action”, pick Skip, tick every box, and Deploy. Cloudflare’s free Bot Fight Mode ignores rules like this one: if it’s on, finish the check on your site instead.`,
        message: null,
      };
    case 'Sucuri':
      return {
        steps: `In your Sucuri dashboard, open the firewall for ${site.host}, then Access Control → Allowlist IP, and add ${list}.`,
        message: null,
      };
    case 'Wordfence':
      return {
        steps: `In WordPress, open Wordfence → All Options → Advanced Firewall Options, add ${list} to “Allowlisted IP addresses that bypass all rules”, and Save.`,
        message: null,
      };
    case 'Imunify360':
      return {
        steps:
          'Imunify360 is run by your hosting company. Send them the message below and they’ll add HandsFreeOS to its allow list.',
        message,
      };
    default:
      return {
        steps:
          'Send the message below to whoever looks after your website’s security, usually your hosting company.',
        message,
      };
  }
}
