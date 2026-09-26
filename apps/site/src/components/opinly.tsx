import Script from 'next/script';

/**
 * Opinly's pixel: which campaign, post or link brought somebody here, and whether they went on to apply for a
 * founding seat (`founding-form.tsx` sends that as a `generate_lead`). Page views, clicks and route changes it
 * counts by itself.
 *
 * The key is Opinly's publishable one. It can only write events — it reads nothing and reaches nothing else — so it
 * is made to sit in public HTML, and it lives here rather than in the environment this site keeps empty. `/privacy`
 * says what it records; keep the two in step.
 */
const KEY = 'pk-4URAEI_KUurk_6J8t-fX_Hg2OjhEeT1fjYPs4h5'; // gitleaks:allow — publishable, write-only

export function OpinlyPixel() {
  return (
    <Script
      id="opinly-pixel"
      strategy="afterInteractive"
      src="https://static.opinly.ai/p.js"
      data-key={KEY}
    />
  );
}
