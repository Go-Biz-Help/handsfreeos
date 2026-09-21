/**
 * What a carrier's reviewer will find when they go looking, checked before we make them look.
 *
 * `a2p.ts` decides everything that can be read off the form. This decides the rest: whether the website is
 * really there, whether the privacy policy really says the thing, whether the agreement box we promised is
 * really on a page that loads. Those are the three that cost a business a week, and none of them can be
 * answered without fetching something — so the worker does the fetching and this does the judging.
 *
 * **Split that way on purpose.** A verdict that lives in the worker is a verdict nothing can test without a
 * network; a verdict that lives here is a pure function of some text somebody downloaded. The worker hands
 * over what it got (or that it got nothing) and this says what it means, in words a business can act on.
 *
 * Browser-safe, so the wizard renders the results and the same rules can be described before running.
 */

/** The things worth going and looking at. Ids are stable: the wizard keys its rows on them. */
export type PreflightId = 'website' | 'policy' | 'opt_in_surface';

export interface PreflightCheck {
  readonly id: PreflightId;
  /** The row's name, as the business reads it. */
  readonly label: string;
  /** `blocker` failures stop the submit; `warning` failures are said and allowed. */
  readonly severity: 'blocker' | 'warning';
  readonly ok: boolean;
  /** What was found, or what was wrong and what to do. One or two sentences. */
  readonly detail: string;
  /** The address that was actually opened, when one was. */
  readonly url?: string | null;
}

/** What the worker managed to get for one address. */
export interface FetchedPage {
  readonly url: string;
  /** null when it could not be fetched at all (DNS, refused, timed out, blocked). */
  readonly status: number | null;
  /** The body as text, already cut to whatever the fetcher's limit was. Empty when nothing arrived. */
  readonly html: string;
  /** Where redirects ended up, when they went somewhere. */
  readonly finalUrl?: string | null;
  /** The fetcher's own reason, when it refused or failed before a response. */
  readonly error?: string | null;
}

// ---------- reading a page ----------

/**
 * A page's words, with the markup taken out.
 *
 * Deliberately crude: script and style bodies dropped, tags removed, entities for the few characters that
 * actually change a match put back, whitespace collapsed, lower-cased. A policy that only says the clause
 * inside an image is a policy a reviewer cannot read either.
 */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Does this page talk about text messages at all? A policy that never mentions them fails the review. */
export function mentionsTexting(text: string): boolean {
  return /\b(text messag|sms|mobile messag|text you|texting)/.test(text);
}

/**
 * Does the policy promise not to share the numbers?
 *
 * Matched on the promise rather than on our exact sentence, because a business pointing at a policy its
 * lawyer wrote will have said it differently — and a reviewer reading for the meaning would accept it. Both
 * halves are required: a page that says "we will not share your information" while never mentioning texting
 * is not a page that answers the question being asked.
 */
export function promisesNotToShare(text: string): boolean {
  const notShared =
    /\b(not|never)\b[^.]{0,80}\b(shared?|sold|sell|disclos)/.test(text) ||
    /\b(shared?|sold|sell|disclos)\w*\b[^.]{0,40}\bwith no\b/.test(text);
  const aboutNumbers = /\b(mobile|phone number|text messaging originator|sms|opt-in)/.test(text);
  return notShared && aboutNumbers;
}

/** Does this page carry a visible agreement box a reviewer could point at? */
export function showsConsentBox(html: string): boolean {
  const hasCheckbox = /type\s*=\s*["']?checkbox/i.test(html);
  const text = pageText(html);
  const saysTheWords = /\b(reply stop|not a condition|rates may apply)/.test(text);
  return hasCheckbox && saysTheWords;
}

// ---------- the verdicts ----------

const unreachable = (page: FetchedPage, what: string): string =>
  page.error
    ? `We could not open ${page.url} (${page.error}). ${what}`
    : `${page.url} answered ${page.status}. ${what}`;

/** Did the business's own website load, and is there something on it? */
export function checkWebsite(page: FetchedPage | null): PreflightCheck {
  const base = {
    id: 'website' as const,
    label: 'Your website opens',
    severity: 'blocker' as const,
  };
  if (!page)
    return {
      ...base,
      ok: false,
      detail: 'No website was given. A registration without one is turned down.',
      url: null,
    };
  if (page.status === null || page.status >= 400)
    return {
      ...base,
      ok: false,
      detail: unreachable(
        page,
        'A reviewer opens this address by hand, so it has to work before we send anything.',
      ),
      url: page.url,
    };
  const text = pageText(page.html);
  if (text.length < 200)
    return {
      ...base,
      ok: false,
      detail:
        'That address opens but there is almost nothing on it. A reviewer has to be able to tell what your business does.',
      url: page.finalUrl ?? page.url,
    };
  return {
    ...base,
    ok: true,
    detail: 'It opens and reads like a real business.',
    url: page.finalUrl ?? page.url,
  };
}

/** Does the privacy policy say the thing a reviewer is reading it for? */
export function checkPolicy(page: FetchedPage | null): PreflightCheck {
  const base = {
    id: 'policy' as const,
    label: 'Your privacy policy mentions texting',
    severity: 'blocker' as const,
  };
  if (!page)
    return {
      ...base,
      ok: false,
      detail: 'No privacy policy was found. Let us host one, or give us the address of yours.',
      url: null,
    };
  if (page.status === null || page.status >= 400)
    return {
      ...base,
      ok: false,
      detail: unreachable(page, 'The reviewer will follow this link and find the same thing.'),
      url: page.url,
    };
  const text = pageText(page.html);
  if (!mentionsTexting(text))
    return {
      ...base,
      ok: false,
      detail:
        'That policy never mentions text messages. Add the paragraph we gave you, or let us host a policy for you.',
      url: page.finalUrl ?? page.url,
    };
  if (!promisesNotToShare(text))
    return {
      ...base,
      ok: false,
      detail:
        'That policy mentions texting but does not say phone numbers are never shared. That exact promise is what the reviewer is looking for.',
      url: page.finalUrl ?? page.url,
    };
  return {
    ...base,
    ok: true,
    detail: 'It mentions texting and promises the numbers are not shared.',
    url: page.finalUrl ?? page.url,
  };
}

/**
 * Is the agreement box we told the carrier about actually on a page that loads?
 *
 * A warning rather than a blocker in one case only: consent taken in person has no page, and refusing to
 * submit because a page we never claimed exists is missing would be nonsense. Every other path claims a
 * URL in the description, and a claimed URL that does not load is the registration failing later instead.
 */
export function checkOptInSurface(
  page: FetchedPage | null,
  path: 'hosted' | 'own_site' | 'in_person',
): PreflightCheck {
  const base = {
    id: 'opt_in_surface' as const,
    label: 'Customers can agree somewhere we can show',
    severity: (path === 'in_person' ? 'warning' : 'blocker') as 'blocker' | 'warning',
  };
  if (path === 'in_person')
    return {
      ...base,
      ok: true,
      detail:
        'You take permission in person, so there is no page to check. Expect the reviewer to ask how you record it.',
      url: null,
    };
  if (!page)
    return {
      ...base,
      ok: false,
      detail:
        path === 'hosted'
          ? 'Nothing was set up yet. Go back a step and press "Set this up for me".'
          : 'No page was given to check. Tell us where on your site the agreement box is.',
      url: null,
    };
  if (page.status === null || page.status >= 400)
    return {
      ...base,
      ok: false,
      detail: unreachable(page, 'This is the address we are about to give the carrier.'),
      url: page.url,
    };
  if (!showsConsentBox(page.html))
    return {
      ...base,
      ok: false,
      detail:
        'That page opens, but we could not find a tick box with the agreement wording beside it. A reviewer looking for it would not find it either.',
      url: page.finalUrl ?? page.url,
    };
  return {
    ...base,
    ok: true,
    detail: 'The box is there and says what it has to.',
    url: page.finalUrl ?? page.url,
  };
}

/** True when something here would get the registration turned down. */
export const preflightBlocked = (checks: readonly PreflightCheck[]): boolean =>
  checks.some((c) => c.severity === 'blocker' && !c.ok);
