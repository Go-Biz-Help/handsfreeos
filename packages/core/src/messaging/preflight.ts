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
export type PreflightId = 'website' | 'policy' | 'terms' | 'opt_in_surface';

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

/** A name as it can be compared across a page: lower-case letters and digits only, company suffix off. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /\b(llc|l\.l\.c\.?|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|pc)\b\.?/g,
      ' ',
    )
    .replace(/[^a-z0-9]/g, '');
}

/** Does this text carry the business's name, in any of the ways it is known? "Go Biz Help" finds "GoBizHelp". */
export function namesBusiness(text: string, names: readonly string[]): boolean {
  const hay = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return names.some((raw) => {
    const key = nameKey(raw);
    if (key.length >= 3 && hay.includes(key)) return true;
    // "Lone Star HVAC & Roofing" also counts when the page says "Lone Star HVAC": the first two words.
    const words = raw.split(/\s+/).filter((w) => w.replace(/[^a-z0-9]/gi, '').length > 2);
    const two = nameKey(words.slice(0, 2).join(' '));
    return words.length >= 2 && two.length >= 6 && hay.includes(two);
  });
}

/** What the page's agreement box says and does, read the way a reviewer reads it. */
export interface ConsentBoxReading {
  /** A tick box was found beside the words about stopping texts. */
  readonly found: boolean;
  /** It is ticked before the customer touches it. */
  readonly preTicked: boolean;
  /** The form can't be sent without ticking it. */
  readonly required: boolean;
  /** The disclosures missing from beside it, in the words the wizard shows. */
  readonly missing: readonly string[];
  /** A link to the terms somewhere on the page. */
  readonly termsLink: boolean;
}

/** Blanks out script and style bodies, keeping every other character where it was. */
const withoutScripts = (html: string): string =>
  html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => ' '.repeat(m.length));

/**
 * Finds the agreement box and reads what is said beside it.
 *
 * **The box is the tick box nearest the words about stopping texts**, because a contact form has other boxes
 * ("Which services?") and those say nothing about texting. Then the stretch of page around it is read for
 * the disclosures a reviewer looks for: who is texting, how often, that rates may apply, STOP and HELP, and
 * a link to the privacy policy. The terms may be linked anywhere on the page.
 */
export function readConsentBox(html: string, names: readonly string[] = []): ConsentBoxReading {
  const clean = withoutScripts(html);
  const boxes = [...clean.matchAll(/<input\b[^>]*type\s*=\s*["']?checkbox[^>]*>/gi)].map((m) => ({
    at: m.index ?? 0,
    tag: m[0],
  }));
  const stops = [
    ...clean.matchAll(
      /\b(?:reply|text|send|texting)(?:\s|<[^>]+>|["'“”‘’])*stop\b|\bstop\b(?:\s|<[^>]+>)*(?:to\b|at any time)/gi,
    ),
  ].map((m) => m.index ?? 0);
  const termsLink =
    /<a\b[^>]*href\s*=\s*["'][^"']*(terms|conditions|tos\b)[^"']*["']/i.test(clean) ||
    /<a\b[^>]*>[^<]*\bterms\b[^<]*<\/a>/i.test(clean);
  const none: ConsentBoxReading = {
    found: false,
    preTicked: false,
    required: false,
    missing: [],
    termsLink,
  };
  if (!boxes.length || !stops.length) return none;

  // The box closest to a STOP: before it (a label after the box) or just after it (a label before the box).
  let best: { box: (typeof boxes)[number]; stop: number; distance: number } | null = null;
  for (const stop of stops)
    for (const box of boxes) {
      const distance = box.at <= stop ? stop - box.at : (box.at - stop) * 2;
      if (distance <= 6000 && (!best || distance < best.distance)) best = { box, stop, distance };
    }
  if (!best) return none;

  const from = Math.max(0, Math.min(best.box.at, best.stop) - 1500);
  const to = Math.min(clean.length, Math.max(best.box.at, best.stop) + 1500);
  const region = clean.slice(from, to);
  const text = pageText(region);
  const missing: string[] = [];
  if (names.length && !namesBusiness(text, names)) missing.push('your business name');
  if (!/\bhelp\b/.test(text)) missing.push('HELP for help');
  if (!/(rates may apply|data rates|msg\s*(&|and)\s*data|message\s*(&|and)\s*data)/.test(text))
    missing.push('that message and data rates may apply');
  if (
    !/(frequency|\bvar(y|ies)\b|how many (messages|texts)|up to \d+ (messages|msgs|texts)|\d+ (messages|msgs|texts) (a|per|each) (day|week|month))/.test(
      text,
    )
  )
    missing.push('how often you text (for example “how many messages you get varies”)');
  const privacyLink =
    /<a\b[^>]*href\s*=\s*["'][^"']*privacy[^"']*["']/i.test(region) ||
    /<a\b[^>]*>[^<]*privacy[^<]*<\/a>/i.test(region);
  if (!privacyLink) missing.push('a link to your privacy policy');

  const tag = best.box.tag;
  return {
    found: true,
    preTicked: /\schecked(?=[\s=/>])/i.test(tag),
    required: /\srequired(?=[\s=/>])/i.test(tag) || /\saria-required\s*=\s*["']?true/i.test(tag),
    missing,
    termsLink,
  };
}

/** Does this page carry a visible agreement box a reviewer could point at? */
export function showsConsentBox(html: string): boolean {
  return readConsentBox(html).found;
}

/** Joins the missing things the way a sentence lists them: "a, b and c". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ---------- the verdicts ----------

const unreachable = (page: FetchedPage, what: string): string =>
  page.error
    ? `We could not open ${page.url} (${page.error}). ${what}`
    : `${page.url} answered ${page.status}. ${what}`;

/**
 * Did the business's own website load, is there something on it, and is it this business's?
 *
 * `names` are the ways the business is known (its name and its legal name). A site that never says either
 * is a warning rather than a blocker: some sites put their name only in a logo, which a reviewer can see and
 * we can't.
 */
export function checkWebsite(
  page: FetchedPage | null,
  names: readonly string[] = [],
): PreflightCheck {
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
  const named = names.map((n) => n.trim()).filter(Boolean);
  if (named.length && !namesBusiness(text, named))
    return {
      ...base,
      severity: 'warning',
      ok: false,
      detail: `It opens, but we couldn’t find “${named[0]}” on it. A reviewer checks the site belongs to the business being registered, so put your business name on the page, in words rather than only in a logo.`,
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

/** Do the terms open, and do they cover the texts? */
export function checkTerms(page: FetchedPage | null): PreflightCheck {
  const base = {
    id: 'terms' as const,
    label: 'Your terms open',
    severity: 'blocker' as const,
  };
  if (!page)
    return {
      ...base,
      ok: false,
      detail:
        'No terms were found. Let us host them, or give us the address of yours in the privacy policy step.',
      url: null,
    };
  if (page.status === null || page.status >= 400)
    return {
      ...base,
      ok: false,
      detail: unreachable(page, 'The reviewer follows this link too, and will find the same.'),
      url: page.url,
    };
  const text = pageText(page.html);
  if (!mentionsTexting(text))
    return {
      ...base,
      severity: 'warning',
      ok: false,
      detail:
        'Your terms open but never mention text messages. Add a short section on them: what you text about, that how many varies, that rates may apply, and STOP and HELP.',
      url: page.finalUrl ?? page.url,
    };
  return {
    ...base,
    ok: true,
    detail: 'They open and cover your texts.',
    url: page.finalUrl ?? page.url,
  };
}

/** Pages that ask the visitor to sign in before showing anything: a reviewer never signs in. */
function asksToSignIn(page: FetchedPage): boolean {
  const text = pageText(page.html);
  return (
    /type\s*=\s*["']?password/i.test(page.html) ||
    /\b(sign in|log in|login) to (continue|view|access|see)\b|you need (permission|access)|request access/.test(
      text,
    )
  );
}

/**
 * Is the agreement box we told the carrier about actually on a page that loads?
 *
 * For consent taken in person there is no page, so `page` is the proof instead: a photo of the sign-up sheet
 * or the words said on the phone, shared so anyone can open it. Every other path claims a URL in the
 * description, and a claimed URL that does not load is the registration failing later instead.
 *
 * On a page, the box has to start empty, be optional, and carry the disclosures beside it (`readConsentBox`).
 * A missing link to the terms is a warning: they are often in the footer, where we look too.
 */
export function checkOptInSurface(
  page: FetchedPage | null,
  path: 'hosted' | 'own_site' | 'in_person',
  names: readonly string[] = [],
): PreflightCheck {
  const base = {
    id: 'opt_in_surface' as const,
    label:
      path === 'in_person'
        ? 'A reviewer can see how customers agree'
        : 'Customers can agree somewhere we can show',
    severity: 'blocker' as 'blocker' | 'warning',
  };
  if (path === 'in_person') {
    // In person, the page is the proof: a photo of the sign-up sheet, or the words said on the phone.
    if (!page)
      return {
        ...base,
        ok: false,
        detail:
          'Add a link to a photo of your sign-up sheet, or of the words you say on the phone, in the “How customers agree” step. The reviewer asks to see it.',
        url: null,
      };
    if (page.status === null || page.status >= 400)
      return {
        ...base,
        ok: false,
        detail: unreachable(
          page,
          'Share it so anyone with the link can open it, then check again.',
        ),
        url: page.url,
      };
    if (asksToSignIn(page))
      return {
        ...base,
        ok: false,
        detail:
          'That link asks people to sign in first, and a reviewer never signs in. Change its sharing to “Anyone with the link” and check again.',
        url: page.finalUrl ?? page.url,
      };
    return {
      ...base,
      severity: 'warning',
      ok: true,
      detail:
        'The link opens. Expect the reviewer to ask how you record each customer’s answer, and keep those records.',
      url: page.finalUrl ?? page.url,
    };
  }
  if (!page)
    return {
      ...base,
      ok: false,
      detail:
        path === 'hosted'
          ? 'Nothing was set up yet. Go back a step and press "Set this up for me".'
          : 'No page was given to check. Enter the address of the page with your tick box in the “How customers agree” step.',
      url: null,
    };
  if (page.status === null || page.status >= 400)
    return {
      ...base,
      ok: false,
      detail: unreachable(page, 'This is the address we are about to give the carrier.'),
      url: page.url,
    };
  const url = page.finalUrl ?? page.url;
  const box = readConsentBox(page.html, names);
  if (!box.found)
    return {
      ...base,
      ok: false,
      detail:
        'That page opens, but we could not find a tick box with the agreement wording beside it. A reviewer looking for it would not find it either. If your form sits inside a box from another service, give us that form’s own address instead.',
      url,
    };
  if (box.preTicked)
    return {
      ...base,
      ok: false,
      detail:
        'The tick box is already ticked when the page opens. Customers have to tick it themselves, so make it start empty.',
      url,
    };
  if (box.required)
    return {
      ...base,
      ok: false,
      detail:
        'The form can’t be sent without ticking the box. Agreeing to texts has to be optional, so make the box not required.',
      url,
    };
  if (box.missing.length)
    return {
      ...base,
      ok: false,
      detail: `The box is there, but beside it we couldn’t find ${listOf(box.missing)}. Add ${box.missing.length === 1 ? 'it' : 'them'} to the words next to the box.`,
      url,
    };
  if (!box.termsLink)
    return {
      ...base,
      severity: 'warning',
      ok: false,
      detail:
        'The box is there and says what it has to, but the page has no link to your terms. Add one beside the privacy policy link.',
      url,
    };
  return {
    ...base,
    ok: true,
    detail: 'The box is there, starts empty, is optional, and says what it has to.',
    url,
  };
}

/** True when something here would get the registration turned down. */
export const preflightBlocked = (checks: readonly PreflightCheck[]): boolean =>
  checks.some((c) => c.severity === 'blocker' && !c.ok);
