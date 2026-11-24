/**
 * Reading the forms on a page someone linked, so the form builder can make them (the Assistant's build_form with
 * fromLink; core's `forms/page-forms.ts` reads, this only fetches). The page is fetched as a visitor's browser would
 * ask for it, through the worker's safe fetch (never a private address), and the forms framed on it are opened too,
 * since a visitor sees those (a JotForm or a Google Form pasted into a page lands in a frame).
 *
 * What can't be read says why and what to do instead: a robot check, a page that wouldn't open, or a form the site
 * draws with code after the page loads, which a screenshot shows where a link can't.
 */
import {
  formsOnPage,
  framedAddresses,
  HfosError,
  PAGE_FORMS_MAX,
  robotCheck,
  type PageForm,
} from '@hfos/core';
import { SafeFetchError, type SafeFetch } from '../http/safe-fetch';

/** How long a page, and each form framed on it, may take. */
const PAGE_MS = 10_000;
/** A page's HTML kept: a big page builder's page fits. */
const PAGE_BYTES = 3_000_000;
/** The forms framed on a page that are opened. */
const FRAMES = 3;

/** What to send instead, when a link can't be read. */
const SCREENSHOT_INSTEAD = 'Send a screenshot of the form instead, with each dropdown opened.';
const OR_SCREENSHOT = 'or send a screenshot of the form instead, with each dropdown opened.';

export interface PageFormsRead {
  /** The page as it was reached, after any redirects. */
  readonly url: string;
  readonly forms: PageForm[];
}

/** The address as typed, made whole: "acme.com/quote" is https://acme.com/quote. Null when it isn't one. */
export function linkAddress(typed: string): string | null {
  const text = typed.trim();
  if (!text || /\s/.test(text)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.')) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

type Opened =
  | { readonly ok: true; readonly url: string; readonly html: string }
  | { readonly ok: false; readonly why: string };

async function open(fetchUrl: SafeFetch, url: string): Promise<Opened> {
  try {
    const res = await fetchUrl(url, { timeoutMs: PAGE_MS, maxBytes: PAGE_BYTES });
    const blocked = robotCheck({ status: res.status, html: res.body, headers: res.headers });
    if (blocked)
      return {
        ok: false,
        why: `That site showed a robot check${blocked.by ? ` from ${blocked.by}` : ''} instead of the page, so it couldn’t be read. ${SCREENSHOT_INSTEAD}`,
      };
    if (res.status >= 400)
      return {
        ok: false,
        why:
          res.status === 404 || res.status === 410
            ? `That page isn’t there (the site said ${res.status}). Check the link, ${OR_SCREENSHOT}`
            : `That site wouldn’t show the page (it said ${res.status}). ${SCREENSHOT_INSTEAD}`,
      };
    return { ok: true, url: res.finalUrl || url, html: res.body };
  } catch (e) {
    const code = e instanceof SafeFetchError ? e.code : 'network';
    return {
      ok: false,
      why:
        code === 'timeout'
          ? `That page took too long to open. Try again in a minute, ${OR_SCREENSHOT}`
          : code === 'blocked_address' || code === 'invalid_url' || code === 'not_https'
            ? `That link can’t be opened from HandsFreeOS. Send a public web address, ${OR_SCREENSHOT}`
            : `That page couldn’t be opened. Check the link and try again, ${OR_SCREENSHOT}`,
    };
  }
}

/**
 * The forms on the page at `typed` and on the forms framed there, numbered in that order. Refuses (`link_unreadable`)
 * when the page can't be read or has no form to read, saying why and what to send instead.
 */
export async function readPageForms(fetchUrl: SafeFetch, typed: string): Promise<PageFormsRead> {
  const address = linkAddress(typed);
  if (!address)
    throw HfosError.rule(
      'link_unreadable',
      400,
      'That doesn’t look like a web address. Send the whole link, like https://example.com/order-form.',
    );
  const page = await open(fetchUrl, address);
  if (!page.ok) throw HfosError.rule('link_unreadable', 422, page.why);
  const forms = formsOnPage(page.html, page.url);
  const frames = framedAddresses(page.html, page.url, FRAMES);
  const framed = await Promise.all(frames.map((url) => open(fetchUrl, url)));
  for (const frame of framed) {
    if (!frame.ok || forms.length >= PAGE_FORMS_MAX) continue;
    forms.push(...formsOnPage(frame.html, frame.url, forms.length + 1));
  }
  if (!forms.length)
    throw HfosError.rule(
      'link_unreadable',
      422,
      `No form could be read on that page. Some sites draw their forms with code after the page opens, which a link can’t show. ${SCREENSHOT_INSTEAD}`,
    );
  return { url: page.url, forms: forms.slice(0, PAGE_FORMS_MAX) };
}
