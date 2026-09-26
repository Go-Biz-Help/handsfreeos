'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';

/**
 * Matomo analytics for the web app (site 5 in gobizhelp.matomo.cloud; handsfreeos.com is 3, the phone app 4): which
 * screens the people running a business open, and how often. Only on app.handsfreeos.com, so local runs, the
 * Playwright specs, Vercel previews and a business's own domain (M17) count nothing.
 *
 * What it sends is picked on purpose, because the app is full of other people's customers:
 * - **Only our own users' screens** (`TRACKED`). The pages a business's customers open — a booking page, an invoice,
 *   a form — are the business's, and their links are the key to them (`/i/<token>`), so Matomo isn't even loaded
 *   there.
 * - **The route, not the address.** Every id becomes `:id` and the query string is dropped, so a search box's
 *   `?q=Dale Ramsey` stays here and a report reads "customers/people/:id" rather than one line per customer.
 * - **Who, by account id alone.** A signed-in person's screens carry their account id (Supabase Auth's `sub`) as
 *   Matomo's User ID, never their name or email, so their visits from different computers join up; the phone app
 *   sends the same id. Signing out starts a new visit, as Matomo asks, so whoever signs in next isn't counted as them.
 * - **No link tracking.** A download link can be a signed file address, and an outlink a payment page's session.
 * - **No heatmaps, session recordings, form or media tracking**, whatever the Matomo account has switched on: the
 *   first two copy what is on the screen, form tracking reports each field, and a voicemail's player carries its file's
 *   address.
 */
const MATOMO_URL = 'https://gobizhelp.matomo.cloud/';
const MATOMO_SCRIPT = 'https://cdn.matomo.cloud/gobizhelp.matomo.cloud/matomo.js';
const SITE_ID = '5';
const HOST = 'app.handsfreeos.com';

const TRACKED = [
  '/app',
  '/onboarding',
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  '/delete-account',
];

declare global {
  interface Window {
    _paq?: unknown[][];
  }
}

/** `/app/w/9f1c…/customers/people/4b2e…` → `/app/w/:id/customers/people/:id`. Route names are lowercase words. */
function routeOf(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment === '' || /^[a-z][a-z-]*$/.test(segment) ? segment : ':id'))
    .join('/');
}

function tracked(path: string): boolean {
  return TRACKED.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Where the first screen came from: our own pages by route only, anybody else's by their address alone. */
function firstReferrer(): string {
  try {
    const from = new URL(document.referrer);
    return from.host === HOST ? `https://${HOST}${routeOf(from.pathname)}` : from.origin;
  } catch {
    return '';
  }
}

/** Matomo's own snippet, run the first time a counted screen opens. */
function load(paq: unknown[][]) {
  paq.push(['setTrackerUrl', `${MATOMO_URL}matomo.php`]);
  paq.push(['setSiteId', SITE_ID]);
  paq.push(['HeatmapSessionRecording::disable']);
  paq.push(['FormAnalytics::disableFormAnalytics']);
  paq.push(['MediaAnalytics::disableMediaAnalytics']);
  const script = document.createElement('script');
  script.async = true;
  script.src = MATOMO_SCRIPT;
  document.head.appendChild(script);
}

/**
 * The signed-in account's id, or null. Read from the sign-in saved in the browser, so it is right on the first screen
 * after signing in or out.
 */
async function accountId(): Promise<string | null> {
  const { data } = await supabaseBrowser().auth.getSession();
  return data.session?.user.id ?? null;
}

/** Counts a page view each time the route changes; the App Router never reloads the page. */
export function Matomo() {
  const path = usePathname();
  const last = useRef<string | null>(null);
  const lastAccount = useRef<string | null>(null);

  useEffect(() => {
    if (window.location.host !== HOST || !path || !tracked(path)) return;
    const route = routeOf(path);
    const url = `https://${HOST}${route}`;
    if (url === last.current) return;
    let open = true;
    // Counting a screen is never worth an error: without the sign-in, it's counted without the id.
    void accountId()
      .catch(() => null)
      .then((account) => {
        // Moved on while the sign-in was read: the next screen is counted instead.
        if (!open) return;
        if (!window._paq) load((window._paq = []));
        const paq = window._paq!;
        // Signed out, or in as somebody else, since the last screen: this one starts a new visit.
        const newVisit = lastAccount.current !== null && lastAccount.current !== account;
        if (account) paq.push(['setUserId', account]);
        else if (newVisit) paq.push(['resetUserId']);
        if (newVisit) paq.push(['appendToTrackingUrl', 'new_visit=1']);
        paq.push(['setReferrerUrl', last.current ?? firstReferrer()]);
        paq.push(['setCustomUrl', url]);
        paq.push(['setDocumentTitle', route]);
        paq.push(['trackPageView']);
        if (newVisit) paq.push(['appendToTrackingUrl', '']);
        last.current = url;
        lastAccount.current = account;
      });
    return () => {
      open = false;
    };
  }, [path]);

  return null;
}
