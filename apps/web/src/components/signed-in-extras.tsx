'use client';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';

/**
 * The two things the root layout runs for the people who use HandsFreeOS and never for their customers: the clock
 * check (./clock-check.tsx) and the app's own analytics (./matomo.tsx).
 *
 * Both read the sign-in kept in the browser, so both bring the whole sign-in client with them: 61 KB zipped, 237 KB
 * for a phone to read, a third again on top of a booking page's own code. They sat in the root layout, so every
 * booking page, form, invoice, estimate and chat window downloaded it and then did nothing with it: nobody is signed
 * in there, and analytics never loads on a customer's page (the speed audit, Nov 2026).
 *
 * Here they load on their own, after the page, and only off the customers' pages. Neither draws anything a page is
 * read with, so nothing is missing from the page as it arrives. `e2e/booking.spec.ts` holds a booking page to it.
 */
const ClockCheck = dynamic(() => import('./clock-check').then((m) => m.ClockCheck), { ssr: false });
const Matomo = dynamic(() => import('./matomo').then((m) => m.Matomo), { ssr: false });

/**
 * The pages a business's customers open, by their first part: booking, the chat window, a document to sign, an
 * estimate, a form, a time to hold, an invoice, the business's privacy policy and terms, a webinar's link, managing
 * a booking, unsubscribing, sending a video in, and a time that opened up. None of them signs anyone in. A page that
 * might (a customer's portal, a call's link, an add-on's own pages) isn't here, and keeps both.
 */
const CUSTOMER_PAGES = [
  '/book',
  '/chat',
  '/d',
  '/e',
  '/f',
  '/hold',
  '/i',
  '/legal',
  '/live',
  '/m',
  '/u',
  '/v',
  '/w',
];

export const isCustomerPage = (path: string): boolean =>
  CUSTOMER_PAGES.some((p) => path === p || path.startsWith(`${p}/`));

export function SignedInExtras() {
  const path = usePathname();
  if (isCustomerPage(path)) return null;
  return (
    <>
      <ClockCheck />
      <Matomo />
    </>
  );
}
