import Script from 'next/script';
import { urls } from '@/content/site';

/**
 * Opinly's pixel: which campaign, post or link brought somebody here, and whether they went on to sign up and pay for
 * a founding spot (the worker reports those, joined to this visit by `signup-link-visitor.tsx`). Page views, clicks
 * and route changes it counts by itself. Like Matomo, it loads only on the live site, so `next dev` and Vercel
 * previews count nothing.
 *
 * The key is Opinly's publishable one. It can only write events — it reads nothing and reaches nothing else — so it
 * is made to sit in public HTML, and it lives here rather than in the environment this site keeps empty. `/privacy`
 * says what it records; keep the two in step.
 */
const KEY = 'pk-4URAEI_KUurk_6J8t-fX_Hg2OjhEeT1fjYPs4h5'; // gitleaks:allow — publishable, write-only
const SRC = 'https://static.opinly.ai/p.js';
const HOST = new URL(urls.site).host;

export function OpinlyPixel() {
  return (
    <Script id="opinly-pixel" strategy="afterInteractive">
      {`(function() {
  if (location.host !== '${HOST}') return;
  var s = document.createElement('script');
  s.async = true; s.src = '${SRC}'; s.setAttribute('data-key', '${KEY}');
  document.head.appendChild(s);
})();`}
    </Script>
  );
}
