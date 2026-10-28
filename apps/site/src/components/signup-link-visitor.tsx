'use client';

/**
 * Carries the Opinly visitor id, and the affiliate link they came by, from handsfreeos.com to the sign-up page on
 * app.handsfreeos.com.
 *
 * The two are different sites, so the pixel's id (kept in this site's own storage) cannot follow on its own.
 * Instead, the moment somebody goes for a sign-up link — a click, a middle-click, or the menu for "open in new
 * tab" — the id is added to it as `?oa=`. The sign-up form keeps it on the new account, and the worker sends the
 * sign-up and any purchase with it, so they are credited to the article or campaign that brought the person here.
 *
 * Done at that moment rather than when the page draws, because the pixel loads after the page and may not have
 * an id yet; and done once for every link, so a new "Sign up" button needs nothing of its own. A link
 * that already says which spot to pick (`?plan=`) keeps it.
 *
 * An affiliate's code, kept by the proxy for 90 days (`lib/affiliate.ts`), goes along the same way as `?ref=` and
 * `?ref_at=`: the new account keeps them, and the business it makes is credited to that affiliate. A discount or
 * trial code's link goes as `?code=`, for the plan page to fill in.
 */
import { useEffect } from 'react';
import { urls } from '@/content/site';
import { CODE_COOKIE, CODE_PARAM, readRef, REF_COOKIE, REF_PARAM, refCode } from '@/lib/affiliate';
import { anonId } from '@/lib/opinly/pixel';

const SIGN_UP = new URL(urls.signUp);

function addVisitor(event: Event): void {
  const link = (event.target as Element | null)?.closest?.('a[href]');
  if (!(link instanceof HTMLAnchorElement)) return;
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    return;
  }
  if (url.origin !== SIGN_UP.origin || !url.pathname.startsWith(SIGN_UP.pathname)) return;
  const id = anonId();
  if (id) url.searchParams.set('oa', id);
  const ref = readRef(cookie(REF_COOKIE));
  if (ref) {
    url.searchParams.set(REF_PARAM, ref.code);
    url.searchParams.set(`${REF_PARAM}_at`, ref.clickedAt.toISOString());
  }
  const code = refCode(cookie(CODE_COOKIE));
  if (code) url.searchParams.set(CODE_PARAM, code);
  if (url.toString() !== link.href) link.href = url.toString();
}

function cookie(name: string): string | null {
  for (const part of document.cookie.split('; ')) {
    const eq = part.indexOf('=');
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

export function SignupLinkVisitor() {
  useEffect(() => {
    const events = ['click', 'auxclick', 'contextmenu'] as const;
    // Capture, so the address is changed before the browser (or Next's Link) acts on the click.
    for (const name of events) document.addEventListener(name, addVisitor, true);
    return () => {
      for (const name of events) document.removeEventListener(name, addVisitor, true);
    };
  }, []);
  return null;
}
