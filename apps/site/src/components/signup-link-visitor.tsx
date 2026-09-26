'use client';

/**
 * Carries the Opinly visitor id from handsfreeos.com to the sign-up page on app.handsfreeos.com.
 *
 * The two are different sites, so the pixel's id (kept in this site's own storage) cannot follow on its own.
 * Instead, the moment somebody goes for a sign-up link — a click, a middle-click, or the menu for "open in new
 * tab" — the id is added to it as `?oa=`. The sign-up form keeps it on the new account, and the worker sends the
 * sign-up and any purchase with it, so they are credited to the article or campaign that brought the person here.
 *
 * Done at that moment rather than when the page draws, because the pixel loads after the page and may not have
 * an id yet; and done once for every link, so a new "Start free" button needs nothing of its own.
 */
import { useEffect } from 'react';
import { urls } from '@/content/site';
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
  if (!id || url.searchParams.get('oa') === id) return;
  url.searchParams.set('oa', id);
  link.href = url.toString();
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
